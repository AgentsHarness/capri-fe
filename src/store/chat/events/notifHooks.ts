/**
 * `hook_execution` / `hook_annotation` notifications (TUI
 * `app/acp_handler/session_notification.rs`'s `HookExecution` / `HookAnnotation`
 * arms).
 *
 * Both carriers land here: live as the host's typed `hook_execution` event
 * (which `handleChatEvent` normalizes into a session_notification) and history
 * replay straight from the stored `_x.ai/session/update` envelope.
 */
import type { ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import type { WireEvent } from './wire'
import { appendEntry } from '../entries'
import { parseHookExecution } from '../../../scrollback/hookRuns'
import {
  hookRoutingOf,
  hookRoutingPatch,
  routeHookBatch,
  withTurnTerminalMarker,
} from '../hookRouting'
import { turnIsLive } from '../turnStatus'

export function handleNotifHooks(
  set: SetState,
  get: () => ChatState,
  ev: WireEvent,
  tag: string,
  fields: Record<string, unknown>,
): boolean {
  switch (tag) {
    // A hook's own prose line (e.g. "⚠ `run_terminal_command` blocked by hook
    // `global/probe:pre_tool_use[0].hooks[0]`: …"). The TUI pushes it as a
    // SessionEvent::HookAnnotation row — the agent's sentence verbatim, NOT
    // attached to the tool block.
    case 'hook_annotation': {
      const msg = typeof fields.message === 'string' ? fields.message : ''
      // TUI `SessionEvent::HookAnnotation` is not in `is_warning_banner()`, so
      // it renders as plain muted session-event chrome with no accent rail —
      // even though the agent's own text starts with a ⚠ / ↩ glyph.
      if (msg.trim()) appendEntry(set, { kind: 'session_event', text: msg })
      return true
    }
    case 'hook_execution': {
      // 多会话广播（host withSid 约定）：别的会话的 hook 批次不进本视图。
      if (ev.sessionId && ev.sessionId !== get().sessionId) return true
      const batch = parseHookExecution(fields)
      // Empty / all-skipped batches render nothing: the agent's sender drops
      // them, but history stored by an older shell can still carry them.
      if (!batch) return true
      const res = routeHookBatch(get().entries, hookRoutingOf(get()), batch, {
        turnActive: turnIsLive(get()),
        currentPromptId: get().currentPromptId,
        // TUI `meta.is_replay || loading_replay`: stop batches stay as
        // lifecycle rows in arrival order, never fold into a later marker.
        // Replay events carry the host-normalized `msgSeq` (live ones do
        // not), so the gate is per-batch — a load-more window no longer
        // demotes live stop batches that arrive while older history
        // replays. `historyLoading` (session-switch snapshot window, where
        // live events are buffered) keeps the global gate, like the TUI's
        // `loading_replay`.
        isReplay: get().historyLoading || ev.msgSeq != null,
      })
      set({ entries: res.entries, ...hookRoutingPatch(res.routing) })
      return true
    }
    default:
      return false
  }
}

/**
 * Append a turn-terminal marker, folding the held turn-end hook batches into
 * it (`stop  [hooks: 2]` right-aligned on the marker line, per-hook detail on
 * expand). Every marker site routes through here — `finalizeTurn`, the
 * failed / cancelled rails and history replay — so a turn's hook summary
 * always rests on the same row as the turn's outcome. A stash that provably
 * belongs to another turn is emitted above the marker as lifecycle rows.
 */
export function appendTurnMarker(
  set: SetState,
  get: () => ChatState,
  marker: Extract<ScrollEntry, { kind: 'session_event' }>,
  endingPromptId?: string,
): void {
  const tail = withTurnTerminalMarker(hookRoutingOf(get()), marker, endingPromptId)
  set((s) => ({
    entries: [...s.entries, ...tail.entries],
    ...hookRoutingPatch(tail.routing),
  }))
}
