import type { SessionInfo } from '../../api/types'

/**
 * 会话完成（回合跑完）的转移判定——完成提醒的唯一判据。
 *
 * 输入是前后两份 `sessions` 名册：`status.busy` 由 true 变 false 的会话
 * 即「这一轮跑完了」。任何写 `sessions` 的路径（roster 行级补丁、全量
 * 刷新、会话列表轮询）都会产生新的数组，订阅方据此统一触发提醒，不再
 * 由某一条拉取路径自己维护快照。
 *
 * 只比较两份都存在的会话：从名册消失（删除 / 换 host）不是用户想被提醒
 * 的"跑完了"。快照首次建立（prev 为空）也不会误报。
 */
export function completedSessionIds(
  prev: SessionInfo[],
  next: SessionInfo[],
): string[] {
  if (prev.length === 0 || next.length === 0) return []
  const before = busySnapshot(prev)
  const out: string[] = []
  for (const s of next) {
    if (before.get(s.sessionId) === true && !isBusy(s)) out.push(s.sessionId)
  }
  return out
}

/** id → 是否 busy；缺失 `status` 视为不忙（host 只在有活动时带 status）。 */
export function busySnapshot(sessions: SessionInfo[]): Map<string, boolean> {
  const out = new Map<string, boolean>()
  for (const s of sessions) out.set(s.sessionId, isBusy(s))
  return out
}

function isBusy(s: SessionInfo): boolean {
  return s.status?.busy === true
}
