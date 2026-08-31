/**
 * Per-entry fold / running / flash predicates.
 *
 * Shared by the main scrollback, mini timelines (BlockViewer), and accent
 * resolution so store ↔ renderer stay acyclic.
 */
import type { ScrollEntry, ToolCall } from '../api/types'
import { extractToolDetail } from './toolDetail'
import { thoughtDisplayMode } from './thoughtMode'
import { userIsFoldable } from './userText'
import { FINISH_FLASH_MS } from '../theme/wave'
import { Glyphs } from '../theme/glyphs'

export function entryRunning(e: ScrollEntry): boolean {
  if (e.kind === 'assistant') return !!e.streaming
  if (e.kind === 'thought') return !!e.streaming
  if (e.kind === 'tool')
    return e.status === 'pending' || e.status === 'in_progress'
  if (e.kind === 'subagent' || e.kind === 'workflow' || e.kind === 'bg_task')
    return !!e.running
  if (e.kind === 'session_event') return !!e.streaming
  if (e.kind === 'btw') return !!e.streaming
  return false
}

export function entryFailed(e: ScrollEntry): boolean {
  if (e.kind === 'error') return true
  if (e.kind === 'tool')
    return e.status === 'failed' || e.status === 'error'
  if (e.kind === 'subagent')
    return e.status === 'failed' || e.status === 'cancelled'
  if (e.kind === 'workflow') return e.status === 'failed'
  if (e.kind === 'bg_task') return e.status === 'failed'
  if (e.kind === 'btw') return !!e.error
  return false
}

export function entryExpanded(e: ScrollEntry): boolean {
  if (e.kind === 'tool') return !!e.expanded
  // Thought: only the fully-collapsed header counts as folded (truncated
  // and expanded both show body content).
  if (e.kind === 'thought') return thoughtDisplayMode(e) !== 'collapsed'
  if (e.kind === 'session_event') return !!e.open
  // btw 折叠态由条目的 open 决定；askBtw 建条目时默认展开（FE 没有 TUI
  // 那块 inline panel，答案只在这条区块里）。
  if (e.kind === 'btw') return !!e.open
  // User defaults to collapsed when foldable (TUI default_display_mode).
  if (e.kind === 'user') {
    if (!userIsFoldable(e.text)) return true
    return !!e.expanded
  }
  // group_header.collapse === expanded state of the run
  if (e.kind === 'group_header') return !!e.collapse
  // execute-like: treat non-foldable as expanded for accent purposes
  return true
}

/** TUI BlockContent::is_foldable — can cycle collapse/expand. */
export function entryFoldable(e: ScrollEntry): boolean {
  if (e.kind === 'tool') {
    // Match TUI: only foldable when there is expanded body content.
    if (!e.raw) return false
    return toolHasExpandableBody(e.raw, e.kindName)
  }
  if (e.kind === 'thought') return !e.streaming && !!e.text
  if (e.kind === 'session_event') return !!e.recap
  // 有待展开的内容（答案或错误）才可折叠；请求进行中无正文可看。
  if (e.kind === 'btw') return !e.streaming && (!!e.answer || !!e.error)
  if (e.kind === 'user') return userIsFoldable(e.text)
  if (e.kind === 'group_header') return true
  return false
}

export function toolHasExpandableBody(
  raw: ToolCall,
  kindName?: string,
): boolean {
  try {
    const d = extractToolDetail(raw, kindName)
    switch (d.kind) {
      case 'read':
        return !!(d.content || d.error || d.media)
      case 'execute':
        return !!(d.output || d.error)
      case 'edit':
        return d.lines.length > 0 || !!d.error
      case 'search':
        return (
          d.fileMatches.length > 0 ||
          d.filePaths.length > 0 ||
          d.matchCount > 0 ||
          !!d.error
        )
      case 'list_dir':
        return !!(d.output || d.error)
      case 'fetch':
        return !!(d.output || d.error || d.statusCode != null)
      case 'web_search':
        return !!(d.content || d.citations.length || d.error)
      case 'use_tool':
        return d.args.length > 0 || !!d.output || !!d.error
      case 'search_tool':
        return d.results.length > 0 || !!d.error
      case 'generic':
        return d.inputArgs.length > 0 || !!d.output || !!d.error
    }
  } catch {
    return !!(raw.rawOutput || raw.content || raw.rawInput)
  }
}

/**
 * At minimum fold mode (Collapsed) — or running tools/thoughts that sit at
 * their collapse mode while streaming (expandable_indicator_running).
 */
export function entryAtMinFold(e: ScrollEntry): boolean {
  if (e.kind === 'tool') {
    if (!e.expanded) return true
    // running + still "collapsed header" feel: indicator while running even if auto-open later
    const running = e.status === 'pending' || e.status === 'in_progress'
    return running && !e.expanded
  }
  if (e.kind === 'thought') {
    if (e.streaming) return false // live body visible; not at min fold chrome
    return thoughtDisplayMode(e) === 'collapsed'
  }
  if (e.kind === 'user') {
    if (!userIsFoldable(e.text)) return false
    return !e.expanded
  }
  if (e.kind === 'session_event') return !e.open
  // btw 同款：折叠 = 最小形态。
  if (e.kind === 'btw') return !e.open
  // group_header.collapse === expanded (synthetic); min fold = not expanded
  if (e.kind === 'group_header') return !e.collapse
  return false
}

/** Header-style blocks get collapsed bg_dark selection fill (scrollback_pane). */
export function isHeaderStyleBlock(e: ScrollEntry): boolean {
  return e.kind === 'tool' || e.kind === 'thought' || e.kind === 'group_header'
}

/**
 * Expandable indicator: replace ◆ with › when (selected|hovered) + foldable
 * + at min fold (paint_expandable_indicator — select + hover share this).
 */
export function expandableGlyph(e: ScrollEntry, active: boolean): string | null {
  if (!active) return null
  if (!entryFoldable(e)) return null
  if (!entryAtMinFold(e)) return null
  if (
    e.kind !== 'tool' &&
    e.kind !== 'thought' &&
    e.kind !== 'session_event' &&
    e.kind !== 'btw' &&
    e.kind !== 'subagent' &&
    e.kind !== 'workflow' &&
    e.kind !== 'bg_task' &&
    e.kind !== 'group_header' &&
    e.kind !== 'user'
  ) {
    return null
  }
  return Glyphs.chevron
}

/** Whether an entry is inside its finish-flash window (needs clock ticks). */
export function entryFlashActive(e: ScrollEntry, now: number): boolean {
  if (e.kind !== 'tool' && e.kind !== 'thought') return false
  const fa = e.finishedAt
  return fa != null && now - fa < FINISH_FLASH_MS
}
