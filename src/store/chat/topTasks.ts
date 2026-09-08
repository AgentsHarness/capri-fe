import type { DetachedTask } from '../../api/types'

// 顶栏运行中任务的唯一来源是 agent 的活动注册表（x.ai/task/list，见
// actions/liveTasks.ts 的 syncLiveTasks）——注册表认识的任务才杀得掉。
// 宿主的 updates.jsonl + lsof 探活不再往顶栏塞行：它分不清任务属于当前
// grok 进程、上一代进程还是另一个客户端（TUI），"看得到却杀不掉"正是之前
// 那枚「恢复」徽章的由来。探活结果减去注册表已知部分后由宿主打标为
// detached 返回，这里只把它渲染成状态条上的一次性提示。

/** 探活轮询间隔：detached 提示靠它，注册表刷新由 syncLiveTasks 承担。 */
export const TOP_TASK_POLL_MS = 10_000
export let topTaskTimer: ReturnType<typeof window.setInterval> | null = null

/** Normalize one host `detached` entry（wire 形状沿用 TaskEvent）. */
export function parseDetachedTask(src: Record<string, unknown>): DetachedTask | null {
  const taskId = typeof src.taskId === 'string' ? src.taskId : ''
  if (!taskId) return null
  const monitor =
    typeof src.monitorDescription === 'string' ? src.monitorDescription : undefined
  const description = typeof src.description === 'string' ? src.description : undefined
  const command = typeof src.command === 'string' ? src.command : undefined
  const pid = typeof src.pid === 'number' && src.pid > 0 ? src.pid : undefined
  return {
    taskId,
    ...(command ? { command } : {}),
    ...(description ? { description } : {}),
    ...(monitor ? { monitorDescription: monitor } : {}),
    ...(typeof src.outputFile === 'string' ? { outputFile: src.outputFile } : {}),
    ...(pid ? { pid } : {}),
  }
}

/** 游离进程集合签名：只有集合变化才重新提示一次。 */
export function detachedSignature(tasks: DetachedTask[]): string {
  return tasks
    .map((t) => t.taskId)
    .sort()
    .join(',')
}

/**
 * Fold one probe result into the store.
 *
 * `runningProbeTaskIds` is raw data (every task the host's open-fd probe
 * still sees alive) and always tracks the probe: the history replay uses it
 * to drop the dangling "Task started" row of a task that has no completion,
 * which is exactly the row the top strip represents instead. It must not
 * follow the hint's dismissed state, or dismissing the hint would bring that
 * dangling row back.
 *
 * `detachedHintKey` is the set signature the hint was last *accounted for*
 * with — shown, or dismissed via dismissDetachedHint. Receiving the same set
 * again therefore leaves the hint as it is (a dismissed hint does not
 * reappear); any change, including the set emptying out, replaces it.
 */
export function applyDetachedProbe(
  get: () => {
    detachedTasks: DetachedTask[]
    detachedHintKey: string | null
    runningProbeTaskIds: string[]
  },
  set: (patch: {
    detachedTasks: DetachedTask[]
    detachedHintKey: string
    runningProbeTaskIds: string[]
  }) => void,
  aliveIds: string[],
  raw: unknown[],
): void {
  const tasks = raw
    .map((e) => parseDetachedTask(e as Record<string, unknown>))
    .filter((t): t is DetachedTask => t !== null)
  const sig = detachedSignature(tasks)
  const sameAlive = sameIdSet(aliveIds, get().runningProbeTaskIds)
  if (sig === get().detachedHintKey && sameAlive) return
  set({
    detachedTasks: sig === get().detachedHintKey ? get().detachedTasks : tasks,
    detachedHintKey: sig,
    runningProbeTaskIds: aliveIds,
  })
}

/** Order-insensitive id-set equality (both sides are deduped by the caller). */
function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every((id) => setB.has(id))
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
