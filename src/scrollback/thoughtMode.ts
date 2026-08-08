/**
 * ThinkingBlock display modes — TUI xai-grok-pager ThinkingBlock three-state
 * (thinking.rs): Collapsed (header only) / Truncated (default: header +
 * "…" + last-N-lines preview) / Expanded (full body).
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
 * Missing `displayMode` → 'truncated' (TUI default; replay compat);
 * legacy `open: true` maps to 'expanded'.
 */
export function thoughtDisplayMode(e: ThoughtLike): ThoughtDisplayMode {
  return e.displayMode ?? (e.open === true ? 'expanded' : 'truncated')
}

/**
 * Click/space cycle (TUI toggle_fold on thinking blocks): collapsed →
 * truncated → expanded → truncated. From collapsed the first click reveals
 * the truncated preview; further clicks toggle truncated ↔ expanded.
 */
export function nextThoughtMode(m: ThoughtDisplayMode): ThoughtDisplayMode {
  if (m === 'collapsed') return 'truncated'
  if (m === 'truncated') return 'expanded'
  return 'truncated'
}

/** →-step (expand): collapsed → truncated → expanded. */
export function thoughtModeStepUp(m: ThoughtDisplayMode): ThoughtDisplayMode {
  if (m === 'collapsed') return 'truncated'
  return 'expanded'
}

/** ←-step (collapse): expanded → truncated → collapsed. */
export function thoughtModeStepDown(m: ThoughtDisplayMode): ThoughtDisplayMode {
  if (m === 'expanded') return 'truncated'
  return 'collapsed'
}
