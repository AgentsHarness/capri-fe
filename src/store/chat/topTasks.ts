import type { TaskTimelineEvent, TopTask } from '../../api/types'
import type { ChatState, SetState } from './types'

/**
 * Top-strip liveness poll: TUI-owned background tasks emit no events to
 * this host (their task_completed goes to the TUI's own pager), so the
 * restored strip converges via the host probe — drop dead tasks, pick up
 * newly started ones. One cheap lsof-backed HTTP call per tick.
 */
export const TOP_TASK_POLL_MS = 10_000
export let topTaskTimer: ReturnType<typeof window.setInterval> | null = null

/**
 * Merge a host probe result into the top task strip: drop tasks no
 * longer alive (the strip only holds running tasks), add newly alive
 * ones — skipping tasks already tracked as live scrollback rows
 * (bgTaskIndex) or already in the strip.
 */
export function applyTopTaskProbe(
  get: () => ChatState,
  set: SetState,
  events: TaskTimelineEvent[],
): void {
  const s = get()
  const seen = new Set(s.topTasks.map((t) => t.taskId))
  const alive = new Set<string>()
  const added: TopTask[] = []
  for (const ev of events) {
    if (ev.kind !== 'task_backgrounded' || !ev.taskId) continue
    alive.add(ev.taskId)
    if (s.bgTaskIndex[ev.taskId] || seen.has(ev.taskId)) continue
    seen.add(ev.taskId)
    const command = typeof ev.command === 'string' ? ev.command : undefined
    const monitor =
      typeof ev.monitorDescription === 'string' ? ev.monitorDescription : undefined
    added.push({
      taskId: ev.taskId,
      title:
        monitor ||
        (typeof ev.description === 'string' ? ev.description : undefined) ||
        command ||
        `Task ${ev.taskId.slice(0, 8)}`,
      command,
      isMonitor: !!monitor,
      restored: true,
      outputFile: typeof ev.outputFile === 'string' ? ev.outputFile : undefined,
    })
  }
  const topTasks = s.topTasks.filter((t) => alive.has(t.taskId))
  if (added.length > 0 || topTasks.length !== s.topTasks.length) {
    set({ topTasks: [...topTasks, ...added] })
  }
}

export function clearTopTaskTimer(): void {
  if (topTaskTimer != null) {
    window.clearInterval(topTaskTimer)
    topTaskTimer = null
  }
}

export function setTopTaskTimer(id: ReturnType<typeof window.setInterval>): void {
  topTaskTimer = id
}
