/**
 * Hook run display model — TUI `xai-grok-shell`'s `HookRunStatusDto` /
 * `HookRunEntryDto` (the parsing lives in `scrollback/hookRuns.ts`).
 *
 * Hook runs are not standalone scrollback rows: a run that succeeded leaves
 * no trace, a failed run gets one line, and a deny is annotated by the shell.
 */

/** Outcome of one hook run. `blocked` is a stop-gate verdict, not a failure. */
export type HookRunStatus =
  | { type: 'success'; elapsedMs?: number }
  | { type: 'skipped' }
  | { type: 'blocked'; detail: string; elapsedMs?: number }
  | { type: 'failed'; error: string; elapsedMs?: number }

/** One hook run, as the wire reports it. */
export type HookRun = {
  name: string
  status: HookRunStatus
  /** Truncated stdout/stderr the wire may attach to a run. Unused by the UI. */
  output?: string
}
