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
  /**
   * Scheduled-task (/loop) prompt prefix — TUI UserPromptBlock::cron uses
   * U+21BB (↻). Rendered as plain text (no SVG path) via IconGlyph fallback.
   */
  cronPrompt: '\u21BB',
} as const

/**
 * TUI braille spinner frames (xai-grok-pager-render/glyphs.rs).
 * Used by the turn-status line (busy) and history sidebar (active).
 */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'] as const

/** Spinner cadence — ~7.5 fps, matches TUI turn_status. */
export const SPINNER_INTERVAL_MS = 133

/**
 * TUI idle watcher pulse frames (glyphs.rs monitor_icon_frames):
 * `○ ◎ ◉ ◎` — the concentric-circle "breath" leading the still-running
 * cue. Exactly 1 column per frame so the label never shifts.
 */
export const MONITOR_PULSE_FRAMES = ['○', '◎', '◉', '◎'] as const

/**
 * Monitor pulse cadence — half the turn spinner's rate (~3.75 fps),
 * matching TUI turn_status MONITOR_PULSE_DIVISOR (8 ticks vs 4).
 */
export const MONITOR_PULSE_INTERVAL_MS = 266

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
