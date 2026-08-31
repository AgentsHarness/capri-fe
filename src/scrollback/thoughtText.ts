/**
 * ThinkingBlock body text: truncated preview + streaming tail.
 *
 * While a thought streams we render only the newest lines so per-flush
 * DOM cost stays flat as the body grows (full text lives in the store /
 * the block viewer). After finish, the truncated mode shows head +
 * "…" + tail (TUI render_truncated).
 */
import { Glyphs } from '../theme/glyphs'

/** ThinkingBlock truncated preview: head lines before "…" (TUI truncated view). */
export const THOUGHT_TRUNCATED_HEAD_LINES = 5
/** ThinkingBlock truncated preview: tail lines after "…" (TUI truncated_lines default = 3). */
export const THOUGHT_TRUNCATED_TAIL_LINES = 3

const THOUGHT_STREAM_TAIL_MAX_CHARS = 1600
const THOUGHT_STREAM_TAIL_MAX_LINES = 6
/** Line-start snap allowance near the char-window edge (chars). */
const THOUGHT_STREAM_TAIL_SNAP_PAD = 400

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
export function thoughtStreamTail(text: string): string | null {
  if (text.length <= THOUGHT_STREAM_TAIL_MAX_CHARS) return null
  const windowStart = text.length - THOUGHT_STREAM_TAIL_MAX_CHARS
  // Snap to a line start when the line begins near the window edge; a
  // line that starts much earlier (giant unwrapped paragraph) would blow
  // the char budget — hard-cut instead.
  const nl = text.lastIndexOf('\n', windowStart - 1)
  const start =
    nl !== -1 && windowStart - (nl + 1) <= THOUGHT_STREAM_TAIL_SNAP_PAD
      ? nl + 1
      : windowStart
  // Line-count cap: dense tails render at most MAX_LINES lines.
  let lines = 0
  for (let i = start; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++lines >= THOUGHT_STREAM_TAIL_MAX_LINES - 1) {
      return text.slice(i + 1)
    }
  }
  return text.slice(start)
}

/** Streaming thought body text: bounded tail, leading "…" when truncated. */
export function streamThoughtBody(text: string): string {
  const tail = thoughtStreamTail(text)
  return tail == null ? text : `${Glyphs.ellipsis}\n${tail}`
}
