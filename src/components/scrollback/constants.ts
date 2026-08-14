/** Pause between scroll-up page loads (also shields the anchor-restore
 *  scroll event from chaining the next page immediately). */
export const TOP_PAGE_COOLDOWN_MS = 400
/** Touch swipe distance (px) that counts as a scroll-up gesture. */
export const TOUCH_UP_SWIPE_PX = 8

/** Hover bg for collapsed header-style: blend(bg_base, bg_dark, 0.5). */
export const HOVER_BG =
  'color-mix(in srgb, var(--color-gn-bg-dark) 50%, var(--color-gn-bg-base))'
