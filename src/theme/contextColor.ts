/**
 * Context-usage urgency color — TUI context_bar `default_breakpoints`
 * ladder (xai-grok-pager/src/views/context_bar.rs): a continuous blend
 * through text_primary → accent_user → warning → accent_error at the
 * breakpoints 0 / 50 / 65 / 75 / 85 / 95.
 *
 * Implemented with `color-mix()` over the theme CSS variables so both
 * palettes (groknight / wave) follow the active theme, matching the
 * TUI's quantized lerp semantics without hard-coded RGB.
 *
 * `pct` is the already-clamped usage percentage (callers clamp to
 * [0, 100] — values outside the ladder simply land on the end colors).
 */
export function contextUrgencyColor(pct: number): string {
  const FG = 'var(--color-gn-fg)'
  const USER = 'var(--color-gn-accent-user)'
  const WARN = 'var(--color-gn-warning)'
  const ERROR = 'var(--color-gn-accent-error)'
  // color-mix(in srgb, A x%, B) = x% of A + (100−x)% of B; t ∈ [0,1] moves A→B.
  const mix = (a: string, b: string, t: number) =>
    `color-mix(in srgb, ${a} ${Math.round((1 - t) * 100)}%, ${b})`
  if (pct <= 0) return FG
  if (pct <= 50) return mix(FG, USER, pct / 50)
  if (pct <= 65) return USER
  if (pct <= 75) return mix(USER, WARN, (pct - 65) / 10)
  if (pct <= 85) return WARN
  if (pct <= 95) return mix(WARN, ERROR, (pct - 85) / 10)
  return ERROR
}
