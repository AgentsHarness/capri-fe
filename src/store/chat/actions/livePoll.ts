import { transport } from '../../../api/client'
import type { ChatState, SetState } from '../types'
import {
  captureAsyncScope,
  isAsyncScopeCurrent,
} from '../globals'
import { applyDetachedProbe, clearTopTaskTimer, setTopTaskTimer, TOP_TASK_POLL_MS } from '../topTasks'

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
    await get().syncLiveTasks(sessionId)
    if (!isAsyncScopeCurrent(get, scope)) return
    try {
      const r = await transport.sessionRunningTasks(sessionId, cwd)
      if (!isAsyncScopeCurrent(get, scope)) return
      applyDetachedProbe(get, set, aliveIds(r.events), r.detached ?? [])
    } catch {
      // Transient offline — keep the last known state.
    }
  },

  startTopTaskPolling: (sessionId, cwd) => {
    get().stopTopTaskPolling()
    setTopTaskTimer(window.setInterval(() => {
      void get().refreshRunningTasks(sessionId, cwd)
    }, TOP_TASK_POLL_MS))
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
