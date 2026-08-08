import type { TodoItem } from '../store/chat'

/**
 * Inline SVG check mark (glyphPaths checkMark path) — pure SVG, no font
 * glyph dependency. `inline-block` 1em SVG keeps the line height exact and
 * centers visually. Exported so the goal/todo chips in StatusChips render
 * the same mark.
 */
export function CheckMarkIcon() {
  return (
    <svg viewBox="0 0 1 1" className="block h-[1em] w-[1em]" aria-hidden>
      <path
        d="M0.17 0.51 L0.4 0.72 L0.83 0.3"
        stroke="currentColor"
        strokeWidth={0.09}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Inline SVG ballot X (glyphPaths ballotX path) — same fallback fix as ✓. */
function BallotXIcon() {
  return (
    <svg viewBox="0 0 1 1" className="block h-[1em] w-[1em]" aria-hidden>
      <path
        d="M0.26 0.26 L0.74 0.74 M0.74 0.26 L0.26 0.74"
        stroke="currentColor"
        strokeWidth={0.09}
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * Status mark for one todo item (TUI todo pane glyphs). Shared so the
 * scrollback plan block renders the same marks as the badge panel.
 */
export function TodoMark({ status }: { status: TodoItem['status'] }) {
  switch (status) {
    case 'completed':
      return (
        <span className="text-gn-green">
          <CheckMarkIcon />
        </span>
      )
    case 'in_progress':
      return <span className="text-gn-yellow">▶</span>
    case 'cancelled':
      return (
        <span className="text-gn-muted">
          <BallotXIcon />
        </span>
      )
    default:
      return <span className="text-gn-muted">□</span>
  }
}
