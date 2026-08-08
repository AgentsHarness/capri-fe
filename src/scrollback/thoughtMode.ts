/**
 * ThinkingBlock display modes — TUI xai-grok-pager ThinkingBlock three-state
 * (thinking.rs): Collapsed (header only) / Truncated (header + "…" +
 * last-N-lines preview) / Expanded (full body).
 *
 * The FE defaults to **Collapsed** (header only — the pre-Truncated
 * behavior; the truncated preview is opt-in via displayMode and not part
 * of the default click cycle).
 *
 * Shared by the chat store (toggle/fold logic) and the scrollback renderer
 * (and verb-group packing) — lives in its own module so store ↔ scrollback
 * imports stay acyclic.
 */

export type ThoughtDisplayMode = 'collapsed' | 'truncated' | 'expanded'

/** Structural subset of the thought ScrollEntry (avoids the union type). */
type ThoughtLike = { open?: boolean; displayMode?: ThoughtDisplayMode }

/**
 * Effective display mode of a thought entry.
 * Missing `displayMode` → 'collapsed' (header only — FE default; replay
 * compat); legacy `open: true` maps to 'expanded'.
 */
export function thoughtDisplayMode(e: ThoughtLike): ThoughtDisplayMode {
  return e.displayMode ?? (e.open === true ? 'expanded' : 'collapsed')
}

/**
 * Click/space cycle (TUI toggle_fold on thinking blocks): collapsed ↔
 * expanded. The truncated preview mode is not in the default cycle — the
 * first click expands to the full body, the next collapses to the header.
 */
export function nextThoughtMode(m: ThoughtDisplayMode): ThoughtDisplayMode {
  if (m === 'collapsed') return 'expanded'
  return 'collapsed'
}

/** →-step (expand): any mode → expanded. */
export function thoughtModeStepUp(_m: ThoughtDisplayMode): ThoughtDisplayMode {
  return 'expanded'
}

/** ←-step (collapse): any mode → collapsed. */
export function thoughtModeStepDown(_m: ThoughtDisplayMode): ThoughtDisplayMode {
  return 'collapsed'
}
