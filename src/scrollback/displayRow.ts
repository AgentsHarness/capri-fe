/**
 * Display-row → ScrollEntry (synthetic group_header for accent / shell).
 * Shared by the main scrollback and mini timelines.
 */
import type { ScrollEntry } from '../api/types'
import type { DisplayRow } from './verbGroup'

export function displayRowToEntry(row: DisplayRow): ScrollEntry {
  if (row.type === 'entry') return row.entry
  // Synthetic group_header entry for accent / shell rendering
  return {
    id: row.id,
    kind: 'group_header',
    count:
      row.span.kind.type === 'verb'
        ? row.span.kind.members
        : row.span.kind.hidden,
    collapse: row.span.expanded,
    label: row.label.text,
    verbRun:
      row.family === 'verb'
        ? {
            running: row.label.running,
            failed: row.label.failed,
            verb: row.label.text,
          }
        : undefined,
  }
}
