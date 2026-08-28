/**
 * The `@` token under the caret, if any — an `@` at word start (text
 * start or after whitespace) with the query = chars between it and the
 * caret. Word-anchored so emails (`foo@bar`) never trigger the picker,
 * and chip labels can't be part of a token (the caret is clamped to chip
 * edges, and a token directly after a chip label isn't `@`-anchored).
 */
export function atTokenAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  let i = caret - 1
  while (i >= 0 && !/\s/.test(text[i])) i--
  const start = i + 1
  if (start >= caret) return null
  if (text[start] !== '@') return null
  if (start > 0 && !/\s/.test(text[start - 1])) return null
  return { start, query: text.slice(start + 1, caret) }
}
