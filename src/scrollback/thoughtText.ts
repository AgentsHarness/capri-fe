/**
 * ThinkingBlock body text: truncated preview + streaming tail.
 *
 * While a thought streams the inline preview keeps a bounded rolling
 * buffer: it grows for several chunks, then trims in coarse blocks. That
 * gives the scroll container real height changes to animate instead of a
 * fixed-size tail being replaced every chunk. Full text lives in the store
 * / block viewer. After finish, the truncated mode shows head + "…" + tail
 * (TUI render_truncated).
 */
import { Glyphs } from '../theme/glyphs'

/** ThinkingBlock truncated preview: head lines before "…" (TUI truncated view). */
export const THOUGHT_TRUNCATED_HEAD_LINES = 5
/** ThinkingBlock truncated preview: tail lines after "…" (TUI truncated_lines default = 3). */
export const THOUGHT_TRUNCATED_TAIL_LINES = 3

/** Visible lines in the streaming/expanded Thought body (fePrefs.thoughtLines). */
export const THOUGHT_LINES_MIN = 1
export const THOUGHT_LINES_MAX = 20
/** Default stays at the pre-setting four-line activity area. */
export const THOUGHT_LINES_DEFAULT = 4

/** Clamp a stored/user-supplied visible-line count to the supported range. */
export function clampThoughtLines(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return THOUGHT_LINES_DEFAULT
  }
  return Math.min(THOUGHT_LINES_MAX, Math.max(THOUGHT_LINES_MIN, Math.round(value)))
}

const THOUGHT_STREAM_TAIL_MAX_CHARS = 1600
export const THOUGHT_STREAM_TAIL_MAX_LINES = 6
/** Line-start snap allowance near the char-window edge (chars). */
const THOUGHT_STREAM_TAIL_SNAP_PAD = 400

/**
 * Inline streaming preview keeps a much larger rolling buffer than the old
 * fixed-line tail. The buffer grows for a while, then trims in coarse
 * blocks. This gives the scroll container real height changes to animate
 * (a fixed-size tail was replaced every chunk, which looked like a jump).
 */
export const THOUGHT_STREAM_WINDOW_MAX_CHARS = 8000
export const THOUGHT_STREAM_WINDOW_KEEP_CHARS = 4000
export const THOUGHT_STREAM_WINDOW_BLOCK_CHARS = 2000

/**
 * Rolling text window for the inline preview. The start advances only on
 * `BLOCK`-sized boundaries, so most chunks stay inside the same window and
 * scroll with the browser; a trim happens once per block instead of once
 * per line.
 */
export function thoughtStreamWindow(text: string): {
  text: string
  start: number
} {
  if (text.length <= THOUGHT_STREAM_WINDOW_MAX_CHARS) {
    return { text, start: 0 }
  }
  const rawStart =
    Math.floor(
      (text.length - THOUGHT_STREAM_WINDOW_KEEP_CHARS) /
        THOUGHT_STREAM_WINDOW_BLOCK_CHARS,
    ) * THOUGHT_STREAM_WINDOW_BLOCK_CHARS
  if (rawStart <= 0) return { text, start: 0 }
  const nl = text.indexOf('\n', rawStart)
  const start = nl >= 0 ? nl + 1 : rawStart
  return { text: text.slice(start), start }
}

/**
 * ThinkingBlock truncated preview (TUI render_truncated): the first
 * THOUGHT_TRUNCATED_HEAD_LINES lines, "…", then the last
 * THOUGHT_TRUNCATED_TAIL_LINES lines. Short bodies (≤ head+tail) show whole.
 */
export function truncatedThoughtLines(text: string): string[] {
  const all = text.split('\n')
  const cap = THOUGHT_TRUNCATED_HEAD_LINES + THOUGHT_TRUNCATED_TAIL_LINES
  if (all.length <= cap) return all
  return [
    ...all.slice(0, THOUGHT_TRUNCATED_HEAD_LINES),
    Glyphs.ellipsis,
    ...all.slice(-THOUGHT_TRUNCATED_TAIL_LINES),
  ]
}

/**
 * Streaming ThinkingBlock body: while the thought flows, render only the
 * TAIL of the accumulated text (newest lines) instead of the full body.
 * Null = whole text fits in the budget (render verbatim).
 */
export function thoughtStreamTail(
  text: string,
  maxLines = THOUGHT_STREAM_TAIL_MAX_LINES,
): string | null {
  // The char window scales with the line budget so a 20-line activity area
  // can actually keep 20 lines of dense output in the DOM.
  const lineCap = Math.max(2, Math.floor(maxLines))
  const maxChars = Math.max(
    THOUGHT_STREAM_TAIL_MAX_CHARS,
    Math.ceil((THOUGHT_STREAM_TAIL_MAX_CHARS * lineCap) / THOUGHT_STREAM_TAIL_MAX_LINES),
  )
  if (text.length <= maxChars) return null
  const windowStart = text.length - maxChars
  // Snap to a line start when the line begins near the window edge; a
  // line that starts much earlier (giant unwrapped paragraph) would blow
  // the char budget — hard-cut instead.
  const nl = text.lastIndexOf('\n', windowStart - 1)
  const start =
    nl !== -1 && windowStart - (nl + 1) <= THOUGHT_STREAM_TAIL_SNAP_PAD
      ? nl + 1
      : windowStart
  // Line-count cap: keep the LAST lineCap lines of the window (scanning
  // forward from the window start used to retain every line after the first
  // five, which could leave well over the intended cap for short lines).
  const windowText = text.slice(start)
  const lines = windowText.split('\n')
  return lines.length <= lineCap ? windowText : lines.slice(-lineCap).join('\n')
}

/** Streaming thought body text: bounded tail, leading "…" when truncated. */
export function streamThoughtBody(text: string): string {
  const tail = thoughtStreamTail(text)
  return tail == null ? text : `${Glyphs.ellipsis}\n${tail}`
}
