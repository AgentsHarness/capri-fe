import type { ScheduledTask } from '../../api/types'
import type { ChatState, SetState } from './types'
import { nid } from './ids'
import { nonBlankStr, wireTaskId } from './util'

// ── scheduled tasks (/loop) ───────────────────────────────────────
// Both SSE carriers (session_notification tag + standalone event) route
// through these helpers keyed by taskId, so dual delivery never dupes.

/**
 * Normalize a scheduled-task payload into store shape. Accepts the host
 * contract envelope (`task: { taskId, prompt, interval, nextFireAt }`),
 * a flat fields object (snake_case / camelCase), or a standalone event
 * object carrying `task`.
 */
export function parseScheduledTask(src: Record<string, unknown> | undefined): ScheduledTask | null {
  if (!src || typeof src !== 'object') return null
  const o = src as Record<string, unknown>
  const inner =
    o.task && typeof o.task === 'object' && !Array.isArray(o.task)
      ? (o.task as Record<string, unknown>)
      : o
  const taskId = wireTaskId(inner.task_id, inner.taskId)
  if (!taskId) return null
  const prompt =
    (typeof inner.prompt === 'string' && inner.prompt) ||
    (typeof inner.description === 'string' && inner.description) ||
    ''
  let interval = typeof inner.interval === 'string' ? inner.interval : ''
  if (!interval && typeof inner.interval_secs === 'number' && inner.interval_secs > 0) {
    interval = `${inner.interval_secs}s`
  }
  if (!interval) {
    // The agent's wire payload calls the schedule human_schedule — the
    // host normalizes it to `interval`, but tolerate the raw shape too.
    interval =
      (typeof inner.human_schedule === 'string' && inner.human_schedule) ||
      (typeof inner.humanSchedule === 'string' && inner.humanSchedule) ||
      ''
  }
  const nextRaw = inner.next_fire_at ?? inner.nextFireAt
  return {
    taskId,
    prompt,
    interval,
    ...(nextRaw != null && nextRaw !== '' ? { nextFireAt: String(nextRaw) } : {}),
  }
}

/** Upsert a scheduled task by taskId (create or replace). */
export function upsertScheduledTask(set: SetState, task: ScheduledTask | null): void {
  if (!task || !task.taskId) return
  set((s) => {
    if (s.scheduledTasks.some((t) => t.taskId === task.taskId)) {
      return {
        scheduledTasks: s.scheduledTasks.map((t) =>
          t.taskId === task.taskId ? { ...t, ...task } : t,
        ),
      }
    }
    return { scheduledTasks: [...s.scheduledTasks, task] }
  })
}

/** Remove a scheduled task by taskId (idempotent). */
export function removeScheduledTask(set: SetState, taskId: string): void {
  if (!taskId) return
  set((s) => ({
    scheduledTasks: s.scheduledTasks.filter((t) => t.taskId !== taskId),
  }))
}

/** scheduled_task_fired — update ONLY nextFireAt (when the event carries it). */
export function updateScheduledTaskFire(set: SetState, taskId: string, nextFireAt: unknown): void {
  if (!taskId || nextFireAt == null || nextFireAt === '') return
  set((s) => ({
    scheduledTasks: s.scheduledTasks.map((t) =>
      t.taskId === taskId ? { ...t, nextFireAt: String(nextFireAt) } : t,
    ),
  }))
}

export function handleTaskBackgrounded(
  get: () => ChatState,
  set: SetState,
  fields: Record<string, unknown>,
): void {
  const id = wireTaskId(fields.task_id, fields.taskId)
  if (!id) return
  // A LIVE task_backgrounded for a top-strip (restored) task: it is now
  // a genuine live scrollback row — drop it from the top strip and
  // create the entry below.
  if (get().topTasks.some((t) => t.taskId === id)) {
    set({ topTasks: get().topTasks.filter((t) => t.taskId !== id) })
  }
  if (get().bgTaskIndex[id]) return // already tracked

  const command = nonBlankStr(fields.command)
  const monitor =
    nonBlankStr(fields.monitor_description) ?? nonBlankStr(fields.monitorDescription)
  // Wire field is `description` (tool description); notif_description was a
  // mistaken name and never arrives on the wire.
  const description = nonBlankStr(fields.description)
  const outputFile = nonBlankStr(fields.output_file) ?? nonBlankStr(fields.outputFile)
  // Legacy / reparented monitors bake "[monitor] <desc>" into command.
  const monitorPrefix = command?.startsWith('[monitor] ')
    ? nonBlankStr(command.slice('[monitor] '.length))
    : undefined

  const title =
    monitor ??
    monitorPrefix ??
    description ??
    command ??
    `Task ${id.slice(0, 8)}`

  // When title is a human description, keep the raw command as secondary detail.
  const detail =
    command && command !== title && !monitorPrefix ? command : undefined

  const eid = nid()
  set((s) => ({
    bgTaskIndex: { ...s.bgTaskIndex, [id]: eid },
    entries: [
      ...s.entries,
      {
        id: eid,
        kind: 'bg_task',
        title,
        status: 'started',
        running: true,
        taskId: id,
        command: command ?? undefined,
        outputFile,
        detail,
        output: '',
        isMonitor: !!monitor || !!monitorPrefix,
      },
    ],
  }))
}

/** task_completed — settle a bg_task entry (finish flash). */
export function handleTaskCompleted(
  get: () => ChatState,
  set: SetState,
  fields: Record<string, unknown>,
): void {
  // Envelope: {task_snapshot: {task_id, …}} (possibly nested in update).
  const snap = (fields.task_snapshot as Record<string, unknown> | undefined) ?? {}
  const id = wireTaskId(snap.task_id, snap.taskId, fields.task_id, fields.taskId)
  if (!id) return
  // A live completion for a top-strip (restored) task: it is over —
  // remove it from the strip (the orphan row below records the event).
  if (get().topTasks.some((t) => t.taskId === id)) {
    set({ topTasks: get().topTasks.filter((t) => t.taskId !== id) })
  }
  const entryId = get().bgTaskIndex[id]
  const snapOut = typeof snap.output === 'string' ? snap.output : undefined
  const snapCmd =
    nonBlankStr(snap.display_command) ??
    nonBlankStr(snap.displayCommand) ??
    nonBlankStr(snap.command)
  const snapDesc = nonBlankStr(snap.description)
  const failed =
    snap.explicitly_killed === true ||
    snap.explicitlyKilled === true ||
    (typeof snap.exit_code === 'number' && snap.exit_code !== 0) ||
    (typeof snap.exitCode === 'number' && snap.exitCode !== 0) ||
    (typeof snap.signal === 'string' && snap.signal.length > 0)
  const status = failed ? ('failed' as const) : ('completed' as const)

  // Page-boundary history: task_completed can land without the matching
  // task_backgrounded (it was in an older, not-yet-loaded page). TUI still
  // shows the row from the live registry / orphan scan — create one here.
  if (!entryId) {
    const title =
      snapDesc || snapCmd || `Task ${id.slice(0, 8)}`
    const eid = nid()
    set((s) => ({
      bgTaskIndex: { ...s.bgTaskIndex, [id]: eid },
      entries: [
        ...s.entries,
        {
          id: eid,
          kind: 'bg_task' as const,
          title,
          status,
          running: false,
          taskId: id,
          command: snapCmd,
          output: snapOut ?? '',
          finishedAt: Date.now(),
          detail:
            snapCmd && snapCmd !== title ? snapCmd : undefined,
        },
      ],
    }))
    return
  }

  set({
    entries: get().entries.map((e) =>
      e.id === entryId && e.kind === 'bg_task'
        ? {
            ...e,
            status,
            running: false,
            finishedAt: Date.now(),
            output:
              snapOut != null && snapOut.length >= (e.output?.length ?? 0)
                ? snapOut
                : e.output,
            command: snapCmd || e.command,
          }
        : e,
    ),
  })
}
