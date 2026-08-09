/**
 * Live-stream text merge for scrollback / block viewer.
 *
 * `liveStream.text` is a **delta/suffix** buffer for the matching entry —
 * not a full replacement of `entry.text`. Correct display text is always:
 *
 *   entryBaseText + (liveStream matching this entry ? liveStream.text : '')
 *
 * Store shapes that both work under this additive formula:
 * - Assistant historically: entry.text `''` + liveStream full in-flight text
 * - Thought today: entry may hold the first chunk + liveStream later chunks
 * - Seal/flush: `entry.text += liveStream.text` then clear liveStream
 *
 * NEVER use `liveText ?? e.text` (that drops the base when liveText is set
 * and would double-drop or drop first-chunk text for the thought shape).
 */
export function mergeLiveText(
  baseText: string,
  liveText: string | null | undefined,
): string {
  return baseText + (liveText ?? '')
}
