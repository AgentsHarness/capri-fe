import { transport } from '../../../api/client'
import type { ChatState, SetState } from '../types'
import {
  captureAsyncScope,
  isAsyncScopeCurrent,
} from '../globals'
import { applyDetachedProbe, clearTopTaskTimer, hasLiveRunningWork, setTopTaskTimer, TOP_TASK_POLL_MS, topTaskTimer } from '../topTasks'

/** 探活存活集：只取 taskId，作为历史回放跳过悬空 started 行的依据。 */
function aliveIds(events: { taskId?: string }[] | undefined): string[] {
  return (events ?? []).map((e) => e.taskId ?? '').filter(Boolean)
}

/**
 * Running-task refresh. Two independent sources, deliberately split:
 *  - the top strip comes from the agent's live registry (syncLiveTasks) —
 *    only tasks this agent process owns, i.e. the only ones killable here;
 *  - the host's updates.jsonl + lsof probe feeds the DETACHED hint only
 *    (processes still running that this agent does not know).
 */
export function livePollActions(set: SetState, get: () => ChatState) {
  return {
  prefetchRunningTasks: async (sessionId, cwd) => {
    const scope = captureAsyncScope(get, sessionId, cwd)
    // The registry is authoritative for the strip and must land BEFORE the
    // history replay: replayUpdates skips the "Task started" row of any task
    // the strip already shows (that state lives at the top only).
    await get().syncLiveTasks(sessionId)
    if (!isAsyncScopeCurrent(get, scope)) return
    try {
      const r = await transport.sessionRunningTasks(sessionId, cwd)
      if (!isAsyncScopeCurrent(get, scope)) return
      applyDetachedProbe(get, set, aliveIds(r.events), r.detached ?? [])
    } catch {
      // Offline / host without the endpoint — the registry view still stands.
    }
  },

  refreshRunningTasks: async (sessionId, cwd) => {
    const scope = captureAsyncScope(get, sessionId, cwd)
    // 这一轮开始时是否有活可盯：收口只在「本轮开始和结束都没有活」时停。
    // 只看结束态会把本轮注册表刚补出来的行算成"没有活"，而重启轮询的
    // 三个钩子（subagent_spawned / task_backgrounded / background_tasks）
    // 都要求事件先到、行已存在（handleTaskBackgrounded 对已跟踪的任务提前
    // 返回），纯注册表路径就再也没有收口来源。
    let sawLiveWork = hasLiveRunningWork(get())
    await get().syncLiveTasks(sessionId)
    if (!isAsyncScopeCurrent(get, scope)) return
    if (hasLiveRunningWork(get())) sawLiveWork = true
    // 轮询路径不在回放窗口内，拉到即折进（会话重建链路走 defer，见
    // loadHistoryWithTaskProbe / continueSession）。
    const subagentRows = await get().syncLiveSubagents(sessionId)
    if (subagentRows.length > 0 || hasLiveRunningWork(get())) sawLiveWork = true
    try {
      const r = await transport.sessionRunningTasks(sessionId, cwd)
      if (!isAsyncScopeCurrent(get, scope)) return
      applyDetachedProbe(get, set, aliveIds(r.events), r.detached ?? [])
    } catch {
      // Transient offline — keep the last known state.
    }
    // 收口：这一轮开始和结束都没有可盯的活（任务收口、子代理 finish、
    // 游离提示被清空）才停定时器——本轮刚发现或刚收口的活还留一轮观察
    // 窗口。缺这一步的话，一个跑过后台任务的会话在空闲后仍会每 10 秒
    // 同时问三个接口，直到用户切走会话为止；反过来，只看结束态会让
    // 注册表补出的行失去唯一的收口来源。
    if (!sawLiveWork && !hasLiveRunningWork(get())) get().stopTopTaskPolling()
  },

  startTopTaskPolling: (sessionId, cwd) => {
    get().stopTopTaskPolling()
    setTopTaskTimer(window.setInterval(() => {
      void get().refreshRunningTasks(sessionId, cwd)
    }, TOP_TASK_POLL_MS))
  },

  /**
   * 有新活出现时确保轮询在跑（幂等）。
   *
   * 轮询会在没有可盯的活时自己停（见 refreshRunningTasks 的收口）。之后
   * 来的任务 / 子代理必须把它重新点起来，否则第一次收口之后，这条会话的
   * 运行态就再也没有收口来源了（finish 事件可能丢）。
   */
  ensureTopTaskPolling: () => {
    const s = get()
    if (topTaskTimer != null || !s.sessionId || !s.cwd) return
    if (!hasLiveRunningWork(s)) return
    s.startTopTaskPolling(s.sessionId, s.cwd)
  },

  stopTopTaskPolling: () => {
    clearTopTaskTimer()
  },

  /** Dismiss the detached-process hint until that set changes again. */
  dismissDetachedHint: () => {
    // Keep detachedHintKey: the next probe reports the same set, which then
    // counts as already accounted for and must not reopen the hint.
    set({ detachedTasks: [] })
  },
  } satisfies Partial<ChatState>
}
