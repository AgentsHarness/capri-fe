import { transport } from '../../../api/client'
import type { ChatState, SetState } from '../types'
import {
  applyTopTaskProbe,
  clearTopTaskTimer,
  setTopTaskTimer,
  TOP_TASK_POLL_MS,
} from '../topTasks'

export function livePollActions(set: SetState, get: () => ChatState) {
  return {
  replayRunningTasks: async (sessionId, cwd) => {
    try {
      const r = await transport.sessionRunningTasks(sessionId, cwd)
      applyTopTaskProbe(get, set, r.events ?? [])
    } catch {
      // Offline / host without the endpoint — history-only view still works.
    }
  },

  refreshTopTasks: async (sessionId, cwd) => {
    // Periodic liveness refresh: TUI-owned tasks emit no events to this
    // host, so the strip converges via the probe (drop dead, add new).
    try {
      const r = await transport.sessionRunningTasks(sessionId, cwd)
      applyTopTaskProbe(get, set, r.events ?? [])
    } catch {
      // Transient offline — keep the last known strip state.
    }
  },

  startTopTaskPolling: (sessionId, cwd) => {
    get().stopTopTaskPolling()
    setTopTaskTimer(window.setInterval(() => {
      void get().refreshTopTasks(sessionId, cwd)
    }, TOP_TASK_POLL_MS))
  },

  stopTopTaskPolling: () => {
    clearTopTaskTimer()
  },
  } satisfies Partial<ChatState>
}
