/**
 * Tool header extras — path/target + dim suffix matching TUI
 * collapsed_line (range, match count, entry count, exit, …).
 */
import type { ToolCall } from '../api/types'
import { extractToolDetail } from './toolDetail'

export type ToolHeaderExtra = { target: string; suffix?: string }

export function toolHeaderExtra(
  raw: ToolCall,
  kindName: string | undefined,
  failed: boolean,
  mergedRaws?: ToolCall[],
): ToolHeaderExtra | null {
  try {
    const d = extractToolDetail(raw, kindName)
    switch (d.kind) {
      case 'read': {
        let suffix = ''
        if (d.lineStart != null && d.lineEnd != null) {
          if (d.totalLines != null && d.totalLines > d.lineEnd - d.lineStart + 1) {
            suffix = ` (${d.lineStart}-${d.lineEnd} of ${d.totalLines})`
          } else {
            suffix = ` (${d.lineStart}-${d.lineEnd})`
          }
        }
        if (d.empty) suffix += ' (empty)'
        if (d.media === 'image') suffix += ' (image)'
        if (d.media === 'pdf') suffix += ' (pdf)'
        return { target: d.path, suffix: suffix || undefined }
      }
      case 'execute':
        return {
          target: d.description || d.command || raw.title || '',
          suffix: d.error && failed ? ` (${d.error})` : undefined,
        }
      case 'edit': {
        // Merged same-file edits (collapsed_edit_blocks): sum the stats.
        let ins = d.insertions
        let del = d.deletions
        for (const r of mergedRaws ?? []) {
          const x = extractToolDetail(r, kindName)
          if (x.kind === 'edit') {
            ins += x.insertions
            del += x.deletions
          }
        }
        const parts: string[] = []
        if (ins || del) {
          parts.push(`+${ins}/−${del}`)
        }
        return {
          target: d.path,
          suffix: parts.length ? ` (${parts.join(' ')})` : undefined,
        }
      }
      case 'search': {
        let summary = ''
        if (d.matchCount === 0) summary = ' (no matches)'
        else if (d.outputMode === 'files') {
          summary =
            d.matchCount === 1 ? ' (1 file)' : ` (${d.matchCount} files)`
        } else if (d.fileMatches.length > 1) {
          summary = ` (${d.matchCount} matches in ${d.fileMatches.length} files)`
        } else if (d.matchCount === 1) summary = ' (1 match)'
        else summary = ` (${d.matchCount} matches)`
        const target =
          d.pattern === '.' && d.glob
            ? d.glob
            : d.pattern
              ? `"${d.pattern}"`
              : raw.title || ''
        return { target, suffix: summary }
      }
      case 'list_dir': {
        const n = d.entryCount
        const suffix =
          !failed && n > 0
            ? ` (${n} entr${n === 1 ? 'y' : 'ies'})`
            : undefined
        return { target: d.path, suffix }
      }
      case 'fetch':
        return {
          target: d.url,
          suffix:
            d.statusCode != null ? ` (${d.statusCode})` : undefined,
        }
      case 'web_search':
        return { target: d.query }
      case 'use_tool':
        return { target: d.toolName }
      default:
        return null
    }
  } catch {
    return null
  }
}
