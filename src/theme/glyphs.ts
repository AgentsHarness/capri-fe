/**
 * UI glyphs.
 *
 * Icons (◆ ◇ ◈ ✗ ✓ › ‹ ⌄ ❯ and "$") are rendered as inline SVG by
 * IconGlyph — the values below are stable *keys* into the path registry
 * (glyphPaths.ts), not font characters, so rendering is identical on every
 * platform. Text-only glyphs (… · ❙) are inline characters with universal
 * font coverage.
 */
export const Glyphs = {
  // ── SVG icons (IconGlyph renders via ICON_PATHS) ───────────────────
  promptArrow: '❯',
  diamondFilled: '◆',
  diamondHollow: '◇',
  diamondDotted: '◈',
  ballotX: '✗',
  checkMark: '✓',
  /** Expandable indicator when selected + collapsed (paint_expandable_indicator). */
  chevron: '›',
  chevronLeft: '‹',
  /** Expanded verb-group header collapse affordance. */
  chevronDown: '⌄',
  // ── Text-only inline characters ────────────────────────────────────
  ellipsis: '…',
  middleDot: '·',
  /** Tooltip for the CSS short-tick rail. */
  collapsedAccent: '❙',
} as const

/**
 * Tool header verbs matching VerbGroupKind::verb + individual tool headers.
 */
export function toolHeader(
  kind: string | undefined,
  running: boolean,
): { verb: string; pathish: boolean } {
  const k = (kind || 'other').toLowerCase()
  if (k === 'read' || k === 'file') return { verb: running ? 'Reading' : 'Read', pathish: true }
  if (k === 'edit' || k === 'write' || k === 'create')
    return { verb: running ? 'Editing' : 'Edit', pathish: true }
  if (k === 'delete') return { verb: running ? 'Deleting' : 'Deleted', pathish: true }
  if (k === 'move' || k === 'rename') return { verb: running ? 'Moving' : 'Moved', pathish: true }
  if (k === 'search' || k === 'grep' || k === 'glob')
    return { verb: running ? 'Searching' : 'Searched', pathish: false }
  if (k === 'execute' || k === 'bash' || k === 'shell' || k === 'run' || k === 'command')
    return { verb: running ? 'Running' : 'Run', pathish: false }
  if (k === 'fetch' || k === 'webfetch')
    return { verb: running ? 'Fetching' : 'Fetched', pathish: false }
  if (k === 'websearch' || k === 'web_search')
    return { verb: running ? 'Searching' : 'Searched', pathish: false }
  if (k === 'list_dir' || k === 'listdir' || k === 'ls')
    return { verb: running ? 'Listing' : 'Listed', pathish: true }
  if (k === 'think' || k === 'thinking')
    return { verb: running ? 'Thinking' : 'Thought', pathish: false }
  if (k === 'mcp' || k === 'use_tool')
    return { verb: running ? 'Calling' : 'Called', pathish: false }
  return { verb: running ? 'Running' : 'Ran', pathish: false }
}
