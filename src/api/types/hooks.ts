/**
 * Hook execution display model — TUI
 * `scrollback/blocks/tool/hook.rs` (HookRunStatus / HookRunEntry /
 * ToolCallHookData) port.
 *
 * Hook runs are NOT standalone scrollback rows: pre/post_tool_use runs ride
 * on the tool-call row they gated, turn-end (`stop` family) runs fold into the
 * turn-terminal marker line, and every other lifecycle event gets its own
 * `lifecycle` row.
 */

/** Outcome of one hook run. `blocked` is a stop-gate verdict, not a failure. */
export type HookRunStatus =
  | { type: 'success'; elapsedMs?: number }
  | { type: 'skipped' }
  | { type: 'blocked'; detail: string; elapsedMs?: number }
  | { type: 'failed'; error: string; elapsedMs?: number }

/** One hook run line in the expanded detail (TUI HookRunEntry). */
export type HookRun = {
  name: string
  status: HookRunStatus
  /** Truncated stdout/stderr the wire may attach to a run. */
  output?: string
}

/** A named batch of runs (turn-end groups on a marker, lifecycle rows). */
export type HookGroup = {
  /** Wire `event_name` (e.g. `stop`, `session_start`). */
  event: string
  runs: HookRun[]
  /** Prompt turn the batch belonged to (TUI batch_prompt_id). */
  promptId?: string
}

/** Hook runs attached to a tool-call row, split by execution phase. */
export type ToolHookData = {
  pre?: HookRun[]
  post?: HookRun[]
}

/** TUI HookRunCounts — skipped runs are never counted. */
export type HookCounts = { success: number; blocked: number; failed: number }

/**
 * One rendered piece of a hook summary. `tone` maps to the theme accents in
 * the view layer (the model stays render-free so it is unit-testable).
 */
export type HookSuffixPart = {
  text: string
  tone: 'muted' | 'success' | 'blocked' | 'error'
  /** TUI `Modifier::BOLD` — stop-hook event names on the marker summary. */
  bold?: boolean
}
