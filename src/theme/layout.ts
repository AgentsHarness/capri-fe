/**
 * Shared layout metrics for scrollback + composer.
 *
 * Content column is **centered** (`mx-auto max-w-[960px]`). Horizontal chrome
 * inside each entry is relative to that column — not a fixed viewport x.
 *
 * ```
 *   │sel│ accent │ gap │ icon │ text …
 *   └───┘    ▲
 *    same left edge
 * ```
 *
 * - Selection box left edge === accent left edge (no left overhang).
 * - Icon columns share one track (accent + gap after column origin).
 */

/** Accent rail width (TUI accent col is 1 cell; web uses a thin 3px rail). */
export const ACCENT_W_PX = 3

/** Gap between accent rail and icon/content column. */
export const ACCENT_GAP_PX = 12

/**
 * Offset from the centered column's content box to the icon column left edge.
 * = ACCENT_W + ACCENT_GAP (no extra shell pad on the entry itself).
 */
export const ICON_COL_INSET_PX = ACCENT_W_PX + ACCENT_GAP_PX // 15

/**
 * Shared class for scrollback / composer / approval column.
 * Centering via mx-auto — do not use a fixed viewport marginLeft.
 * Literal max-w so Tailwind can see the class at build time.
 */
export const CONTENT_COLUMN_CLASS = 'mx-auto w-full max-w-[960px]'

/**
 * Outer horizontal padding on the centered column (sm).
 * Selection + accent sit at the content edge inside this pad.
 * Must exceed SelectionBox's OUTSET_X_PX (12px) on sm+, so the selection
 * rail never sits flush against the container edge when the centered
 * column fills a container narrower than max-w (e.g. the block viewer).
 */
export const COLUMN_PAD_X_CLASS = 'px-4 sm:px-5'

/**
 * Fixed icon column — TUI is 1 cell + trailing space; web uses a centered
 * em-box so ◆ / ❯ / › / ⌄ / $ share the same optical mid-line.
 * font-size is pinned to 13px so parent text-[13.5px] rows do not widen the col.
 */
export const ICON_COL_CLASS =
  'inline-flex h-[1.2em] w-[1.25em] shrink-0 items-center justify-center text-[13px] leading-none select-none'

/** Dense tool/thought header row chrome. */
export const DENSE_ROW_CLASS =
  'flex w-full items-center gap-1.5 text-left py-0 text-[13px] leading-[1.35]'
/** Non-dense header row (min touch target on mobile). */
export const HEADER_ROW_CLASS =
  'flex w-full items-center gap-1.5 text-left min-h-9 sm:min-h-0 py-[2px] text-[13px] leading-[1.35]'

/**
 * Composer body pad-left after absolute │ borders so ❯ sits on the icon track.
 * Matches EntryShell: accent(3) + gap(12) from the chrome content edge.
 */
export const COMPOSER_BODY_PAD_LEFT_PX = ICON_COL_INSET_PX

/**
 * Left inset of a row's *text* column: one icon column (1.25em at the pinned
 * 13px = 16.25px) plus the 6px gap after it. That is where the tool header
 * target, the `$ command` line, and any other bullet-led row start — nested
 * blocks (hook runs under a tool row) pad to the same value so their left edge
 * lines up with the text above them instead of with the icon track.
 */
export const DETAIL_TEXT_PAD_CLASS = 'pl-[22.25px]'

/** `DETAIL_TEXT_PAD_CLASS` + one nested icon column (16px) + its 4px gap. */
export const DETAIL_SUB_TEXT_PAD_CLASS = 'pl-[42.25px]'

/**
 * Shared action button: no outer border, rounded hover / selected fill.
 * Use for chrome, modal footers, retries.
 */
export function btnClass(
  opts: {
    on?: boolean
    tone?: 'default' | 'muted' | 'primary' | 'danger'
    size?: 'chrome' | 'md' | 'sm'
  } = {},
): string {
  const { on = false, tone = 'default', size = 'md' } = opts
  const pad =
    size === 'chrome'
      ? 'inline-flex items-center gap-1 rounded px-2 py-0.5 min-h-8'
      : size === 'sm'
        ? 'inline-flex items-center justify-center gap-1 rounded px-2 py-0.5 text-[11px]'
        : 'inline-flex items-center justify-center gap-1 rounded px-3 py-1.5 min-h-8 text-[12.5px]'
  const fill = on
    ? tone === 'danger'
      ? 'bg-gn-diff-del-bg text-gn-red'
      : tone === 'primary'
        ? 'bg-gn-bg-highlight text-gn-cyan'
        : 'bg-gn-bg-highlight text-gn-fg'
    : tone === 'danger'
      ? 'text-gn-red hover:bg-gn-diff-del-bg'
      : tone === 'primary'
        ? 'text-gn-cyan hover:bg-gn-bg-highlight'
        : tone === 'muted'
          ? 'text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
          : 'text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg'
  return `${pad} ${fill} disabled:cursor-not-allowed disabled:opacity-40`
}

/** Top-bar chrome (theme / mcp / git / ext / usage / settings). */
export function chromeBtnClass(on = false): string {
  return btnClass({ on, tone: 'muted', size: 'chrome' })
}

/**
 * 附图缩略图的固定盒子（composer 贴图行与队列编辑弹窗共用）：等宽等高，
 * object-cover 铺满整格（超出的一边裁掉，不留黑边），点开走全屏预览看原图。
 */
export const IMAGE_THUMB_CLASS =
  'h-20 w-20 rounded border border-gn-prompt-border bg-gn-bg-dark object-cover'
