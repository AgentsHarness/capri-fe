import type { ScheduledTask, TopTask } from '../../api/types'
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

/**
 * scheduled_task_deleted 的删除原因取值：事件顶层 → params → rawParams
 * （都没有时 "unknown"）。宿主已把 reason 归一化到顶层，回退链用于
 * 旧宿主 / 其他生产者的载荷。
 */
export function scheduledTaskDeleteReason(
  top: unknown,
  params?: Record<string, unknown>,
  rawParams?: Record<string, unknown>,
): string {
  const r =
    (typeof top === 'string' && top.trim()) ||
    (typeof params?.reason === 'string' && params.reason.trim()) ||
    (typeof rawParams?.reason === 'string' && rawParams.reason.trim())
  return r || 'unknown'
}

/** 删除原因 → 可见提示文案；unknown/缺失 → 定时任务已移除。 */
export function scheduledTaskDeletedText(reason: string): string {
  switch (reason) {
    case 'expired':
      return '定时任务已过期'
    case 'completed':
      return '定时任务已完成'
    case 'deleted':
      return '定时任务已删除'
    case 'shutdown':
      return '定时任务已暂停（会话关闭时清理，任务仍在，恢复会话后重新生效）'
    default:
      return '定时任务已移除'
  }
}

export function handleTaskBackgrounded(
  get: () => ChatState,
  set: SetState,
  fields: Record<string, unknown>,
): void {
  const id = wireTaskId(fields.task_id, fields.taskId)
  if (!id) return
  // A LIVE task_backgrounded for a task already in the top strip (it came
  // from the registry sync): it is now a genuine live scrollback row — drop
  // the strip row and create the entry below.
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

/**
 * Settle a task the agent could not kill (`x.ai/task/kill` → not_found /
 * already_exited, or it exited while we were not tracking it). No
 * task_completed will ever arrive for it, so finish the row here: the top
 * strip drops it and the scrollback row loses its running state. Mirrors
 * the TUI's NotFound branch (turn.rs handle_bg_task_killed), which likewise
 * removes the stale pane row instead of leaving a "running" accent that no
 * longer corresponds to anything this process can control.
 */
export function settleUntrackedTask(
  get: () => ChatState,
  set: SetState,
  taskId: string,
): void {
  if (!taskId) return
  const s = get()
  const entryId = s.bgTaskIndex[taskId]
  const patch: Partial<ChatState> = {
    topTasks: s.topTasks.filter((t) => t.taskId !== taskId),
  }
  if (entryId) {
    patch.entries = s.entries.map((e) =>
      e.id === entryId && e.kind === 'bg_task' && e.running
        ? { ...e, running: false, status: 'completed' as const, finishedAt: Date.now() }
        : e,
    )
    const idx = { ...s.bgTaskIndex }
    delete idx[taskId]
    patch.bgTaskIndex = idx
  }
  set(patch)
}

/**
 * kill 请求已发出、等待 task_completed 的瞬态文案。点亮在 actions/xai.ts
 * 的 killTask；熄灭在 handleTaskCompleted（任务结算即终态，不能再当成一个
 * 持续计时的阶段——状态行会在没有活动标签时按 statusText 计时）。
 */
export const TASK_KILL_STATUS_TEXT = '正在终止后台任务…'

/** 熄灭 kill 瞬态：只动自己点亮的那条文案，不碰 Cancelling…/Compacting… 等。 */
function clearTaskKillStatus(get: () => ChatState, set: SetState): void {
  const s = get()
  if (s.statusText !== TASK_KILL_STATUS_TEXT) return
  set({
    statusText:
      s.conn === 'busy' ? 'Waiting for response…' : s.awaitingNext ? '待处理' : '就绪',
  })
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
  // 用户点的 kill 走到了终点：熄灭那条「正在终止后台任务…」瞬态
  // （见 actions/xai.ts killTask）。不清会把它当成一个新阶段持续计时。
  if (snap.explicitly_killed === true || snap.explicitlyKilled === true) {
    clearTaskKillStatus(get, set)
  }
  // A live completion for a top-strip task: it is over —
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

export interface BackgroundTaskSnapshotRow {
  task_id?: string
  taskId?: string
  command?: string
  display_command?: string
  displayCommand?: string
  description?: string
  cwd?: string
  /** `bash` | `monitor`（xai-grok-tools TaskKind）。 */
  kind?: string
  status?: 'running' | 'completed' | 'failed'
  started_at?: string
  ended_at?: string
  output_file?: string
  outputFile?: string
  exit_code?: number
  exitCode?: number
}

/**
 * 顶栏任务行的统一字段推导。两个来源共用：`background_tasks` 全量快照
 * （sessionUpdate）与注册表轮询（x.ai/task/list，actions/liveTasks）——
 * 同一任务不能在两个写者之间换标题 / 丢 outputFile。
 */
export function topTaskFrom(src: {
  taskId?: string
  task_id?: string
  title?: string
  description?: string
  command?: string
  displayCommand?: string
  display_command?: string
  outputFile?: string
  output_file?: string
  isMonitor?: boolean
}): TopTask | null {
  const taskId = wireTaskId(src.taskId, src.task_id)
  if (!taskId) return null
  const command =
    nonBlankStr(src.display_command) ??
    nonBlankStr(src.displayCommand) ??
    nonBlankStr(src.command)
  const title =
    nonBlankStr(src.description) ??
    nonBlankStr(src.title) ??
    command ??
    `Task ${taskId.slice(0, 8)}`
  const outputFile = nonBlankStr(src.output_file) ?? nonBlankStr(src.outputFile)
  return {
    taskId,
    title,
    ...(command ? { command } : {}),
    ...(outputFile ? { outputFile } : {}),
    ...(src.isMonitor ? { isMonitor: true } : {}),
  }
}

/**
 * handleBackgroundTasks: SessionUpdate::BackgroundTasks 全量快照处理。
 *
 * 快照是当前会话后台任务集合的权威来源（membership = is_backgrounded 且
 * 归属本会话）：非截断快照整体替换 topTasks（`tasks: []` 即清空任务栏）；
 * `truncated`（32KiB 帧封顶）时只增/改，绝不据缺失删行。
 *
 * 与注册表轮询的分工：顶栏 running 集合由本快照权威替换，轮询只做增改
 * 纠偏（见 actions/liveTasks）；running 状态只存在于顶栏——快照不为
 * running 任务补滚动区条目（那会造出没有收口路径的僵尸行，running 行只
 * 由 task_backgrounded 产生），只为已存在的条目回填终态。
 */
export function handleBackgroundTasks(
  get: () => ChatState,
  set: SetState,
  fields: Record<string, unknown>,
): void {
  const rawTasks = Array.isArray(fields.tasks) ? fields.tasks : []
  const tasks: BackgroundTaskSnapshotRow[] = rawTasks.filter(
    (t): t is BackgroundTaskSnapshotRow => typeof t === 'object' && t !== null,
  )
  const truncated = fields.truncated === true
  const state = get()

  // 1. running 集合 → 顶栏。
  // 已有 bg_task 行（直播 task_backgrounded / 历史回放产生，索引在
  // bgTaskIndex）的任务不进顶栏：同一任务只能由「滚动区行」或「顶栏」之一
  // 承载（handleTaskBackgrounded 的既有不变式），否则 TopBar 的 running
  // 计数（行数 + topTasks 数）会把它算两次，而重放跳过 started 行后又只剩
  // 一份——直播与重放数量不一致。
  const snapshotRunningIds = new Set<string>()
  const snapshotTop: TopTask[] = []
  for (const t of tasks) {
    if ((t.status ?? 'running') !== 'running') continue
    const row = topTaskFrom({
      taskId: t.task_id ?? t.taskId,
      description: t.description,
      command: t.command,
      display_command: t.display_command,
      displayCommand: t.displayCommand,
      output_file: t.output_file,
      outputFile: t.outputFile,
      // 快照行带 kind（bash/monitor）；旧行/遗留前缀兜底。
      isMonitor: t.kind === 'monitor' || !!t.command?.startsWith('[monitor] '),
    })
    if (!row) continue
    snapshotRunningIds.add(row.taskId)
    if (state.bgTaskIndex[row.taskId]) continue
    snapshotTop.push(row)
  }
  const topTasks = truncated
    ? [
        ...state.topTasks.filter((t) => !snapshotRunningIds.has(t.taskId)),
        ...snapshotTop,
      ]
    : snapshotTop

  // 2. 终态回填：只落已存在的滚动区条目（started 行来自 task_backgrounded
  //    或历史回放），并把索引收口。
  let entries = state.entries
  const bgTaskIndex = { ...state.bgTaskIndex }
  for (const ft of tasks) {
    if (ft.status !== 'completed' && ft.status !== 'failed') continue
    const id = wireTaskId(ft.task_id, ft.taskId)
    const eid = id ? bgTaskIndex[id] : undefined
    if (!eid) continue
    entries = entries.map((e) =>
      e.id === eid && e.kind === 'bg_task' && e.running
        ? {
            ...e,
            running: false,
            status: ft.status === 'failed' ? ('failed' as const) : ('completed' as const),
            finishedAt: Date.now(),
          }
        : e,
    )
    delete bgTaskIndex[id]
  }

  set({ topTasks, entries, bgTaskIndex })
}
