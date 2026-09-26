/**
 * `hook_run_started` / `hook_execution` / `hook_annotation` notifications —
 * TUI `app/acp_handler/session_notification.rs`'s three hook arms, i.e. the
 * "silent on success, status row while a hook blocks the turn, one line on
 * failure" behavior.
 *
 * Both carriers land here: live as the host's typed event and history replay
 * straight from the stored `_x.ai/session/update` envelope.
 */
import type { ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import type { WireEvent } from './wire'
import { appendEntry } from '../entries'
import {
  failedHookLines,
  hookAnnotationKind,
  parseHookExecution,
} from '../../../scrollback/hookRuns'

/**
 * A batch stamped with another turn's prompt id: a late `stop_cancelled` /
 * `stop_failure` report can land after the next queued prompt started and
 * must not touch its phase (TUI `is_foreign_hook_batch`).
 */
function isForeignBatch(promptId: string | undefined, currentPromptId: string | undefined): boolean {
  return promptId != null && currentPromptId != null && promptId !== currentPromptId
}

/** The `(event, tool)` identity a batch is armed and ended by (TUI `HookBatchId`). */
function sameBatch(
  hook: NonNullable<ChatState['runningHook']>,
  eventName: string,
  toolName: string | undefined,
): boolean {
  return hook.eventName === eventName && hook.toolName === toolName
}

/**
 * The agent's clock at this update (`_meta.agentTimestampMs`): typed events
 * carry it at the top level (host `kMetaOut`), the generic/replay carrier
 * nests it under `params._meta`.
 */
function agentTimestampOf(ev: WireEvent): number | undefined {
  const read = (o: unknown): number | undefined => {
    if (!o || typeof o !== 'object') return undefined
    const v = (o as { agentTimestampMs?: unknown }).agentTimestampMs
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  return read((ev as { meta?: unknown }).meta) ?? read(ev.params?._meta)
}

export function handleNotifHooks(
  set: SetState,
  get: () => ChatState,
  ev: WireEvent,
  tag: string,
  fields: Record<string, unknown>,
): boolean {
  switch (tag) {
    case 'hook_run_started': {
      // 多会话归属已由分发层统一处理（events/sessionNotif.ts）。
      const eventName = typeof fields.event_name === 'string' ? fields.event_name : 'hook'
      const toolName = typeof fields.tool_name === 'string' ? fields.tool_name : undefined
      const count = typeof fields.count === 'number' ? fields.count : 1
      const promptId = typeof fields.prompt_id === 'string' ? fields.prompt_id : undefined
      // 批次开始的本地时刻：状态行只在批次活过 300ms 后才亮
      // （TUI HOOK_REVEAL_DELAY），计时从批次开始算 —— 慢 hook 显示完整
      // 等待，快 hook 一闪而过。agent 侧时间戳同时记下：开闸前就排队
      // 的正文不算「回合继续」（TUI chunk_predates_hook_batch）。
      const startedAtMs = agentTimestampOf(ev)
      set({
        runningHook: {
          eventName,
          toolName,
          count,
          promptId,
          startedAt: Date.now(),
          ...(startedAtMs != null ? { startedAtMs } : {}),
        },
      })
      return true
    }
    // A hook's own prose line (e.g. "`run_terminal_command` blocked by
    // global/probe: …"). The TUI pushes it as a SessionEvent row — the
    // agent's sentence verbatim, never attached to the tool block.
    case 'hook_annotation': {
      const msg = typeof fields.message === 'string' ? fields.message : ''
      // `kind: "tool_outcome"` marks a hook's verdict on the tool call above
      // it: the row takes the tool bullet so it reads as part of that call.
      // Everything else is plain muted chrome.
      if (msg.trim()) {
        appendEntry(set, {
          kind: 'session_event',
          text: msg,
          ...(hookAnnotationKind(fields.kind) === 'tool_outcome' ? { hookOutcome: true } : {}),
        })
      }
      return true
    }
    case 'hook_execution': {
      const batch = parseHookExecution(fields)
      // Empty / all-skipped batches render nothing: the agent's sender drops
      // them, but history stored by an older shell can still carry them.
      if (!batch) {
        set({ runningHook: null })
        return true
      }
      // Only the batch that armed the phase ends it — another tool's
      // pre_tool_use outcome says nothing about this gate (TUI
      // `clear_hooks_running`), and a foreign turn's batch leaves it alone.
      const hook = get().runningHook
      if (
        hook != null &&
        sameBatch(hook, batch.event, batch.toolName) &&
        !isForeignBatch(batch.promptId, get().currentPromptId)
      ) {
        set({ runningHook: null })
      }
      // One line per failed run. Success leaves no trace, and a deny is
      // already annotated by the shell, so neither renders here.
      for (const line of failedHookLines(batch)) {
        appendEntry(set, { kind: 'session_event', text: line, hookOutcome: true })
      }
      return true
    }
    default:
      return false
  }
}

/**
 * Append a turn-terminal marker. Every marker site routes through here —
 * `finalizeTurn`, the failed / cancelled rails and history replay — so a
 * turn's outcome always rests on the same row. Hook batches no longer fold
 * into the marker line (a successful run leaves no trace, and the turn's own
 * hooks are over by the time the marker appears), so this is a plain append;
 * it stays a named seam because all four sites share it.
 */
export function appendTurnMarker(
  set: SetState,
  _get: () => ChatState,
  marker: Extract<ScrollEntry, { kind: 'session_event' }>,
): void {
  set((s) => ({ entries: [...s.entries, marker] }))
}
