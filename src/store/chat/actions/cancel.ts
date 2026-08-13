import { transport } from '../../../api/localTransport'
import { usePromptQueue } from '../../promptQueue'
import type { ChatState, SetState } from '../types'
import { appendEntry } from '../entries'

export function cancelActions(set: SetState, get: () => ChatState) {
  return {
  cancel: async () => {
    await transport.cancel({ cancelSubagents: false }, get().sessionId)
  },

  /**
   * Cancel the running turn (panel options 1 / 3 / 4, Ctrl+C, and the
   * saved-preference fast path). Always cancels the turn; `cancelSubagents`
   * additionally cancels every running subagent ("Stop running" / "Always
   * stop"); `stopTasks` (legacy) kills running bg_tasks too; `clearQueue`
   * empties the composer's send queue. The panel closes either way.
   */
  cancelTurn: async (opts) => {
    set({ cancelPanelOpen: false })
    // TUI turn_status.rs: (TurnCancelling | CommandCancelling, _) →
    // "Cancelling…" in accent_error — shown until the host's `done`
    // / `cancelled` event seals the turn.
    set({ statusText: 'Cancelling…' })
    try {
      // Always send the flag explicitly: absent ⇒ agent default TRUE
      // (stops every running subagent), which would contradict the
      // "subagents keep running" semantics of the plain cancel path
      // (Ctrl+C / "Always continue" preference / send-now).
      await transport.cancel({ cancelSubagents: opts?.cancelSubagents === true }, get().sessionId)
    } catch (e) {
      appendEntry(set, {
        kind: 'error',
        text: `取消失败: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
    if (opts?.stopTasks) {
      const s = get()
      for (const e of s.entries) {
        if (e.kind === 'bg_task' && e.running && e.taskId) {
          void get().killTask(e.taskId)
        } else if (e.kind === 'subagent' && e.running && e.subagentId) {
          void get().cancelSubagent(e.subagentId)
        }
      }
      // Restored top-strip tasks are running by definition (host probe).
      for (const t of s.topTasks) {
        if (t.taskId) void get().killTask(t.taskId)
      }
    } else if (opts?.cancelSubagents) {
      const s = get()
      for (const e of s.entries) {
        if (e.kind === 'subagent' && e.running && e.subagentId) {
          void get().cancelSubagent(e.subagentId)
        }
      }
    }
    if (opts?.clearQueue) usePromptQueue.getState().clear()
  },

  /**
   * Shift+Tab mode cycle (TUI modes.rs): Normal → Plan → Auto →
   * Always-approve → Normal. Two dimensions — plan ∈ {off,on} × perm ∈
   * {ask,auto,always}: plan lives ONLY in the second slot; the plan·auto /
   * plan·always overlays exist only via /auto & /always while in plan mode
   * (Shift+Tab from an overlay leaves plan and advances the permission).
   * Each arm paints the banner AND the composer chip immediately
   * (TUI notices.rs + local flags), then persists to the host. Waiting
   * for setMode before set() made Shift+Tab feel lagged once the
   * always-approve chip was visible — the banner flipped, the chip didn't.
   */
  } satisfies Partial<ChatState>
}
