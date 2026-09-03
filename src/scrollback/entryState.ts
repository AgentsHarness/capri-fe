/**
 * Per-entry fold / running / flash predicates.
 *
 * Shared by the main scrollback, mini timelines (BlockViewer), and accent
 * resolution so store ↔ renderer stay acyclic.
 */
import type { ScrollEntry, ToolCall } from '../api/types'
import { extractToolDetail, toolBodyOmitted } from './toolDetail'
import { thoughtDisplayMode } from './thoughtMode'
import { userIsFoldable } from './userText'
import { FINISH_FLASH_MS } from '../theme/wave'
import { Glyphs } from '../theme/glyphs'
import { hookGroupsHaveContent, toolHooksHaveContent } from './hookRuns'

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

export type ToolDisplayMode = 'collapsed' | 'truncated' | 'expanded'

type ToolModeLike = { displayMode?: ToolDisplayMode; expanded?: boolean }

/**
 * Effective display mode of a tool entry. Missing `displayMode` falls back
 * to the legacy `expanded` boolean — `true` meant the inline truncated
 * preview (TUI Truncated), `false` the header-only card.
 */
export function toolDisplayMode(e: ToolModeLike): ToolDisplayMode {
  return e.displayMode ?? (e.expanded ? 'truncated' : 'collapsed')
}

/**
 * Next mode on toggle (TUI block.next_fold_mode). Only three blocks get a
 * three-way cycle; everything else flips collapsed ↔ expanded:
 * - read (read.rs:443-448): Collapsed → Truncated → Collapsed.
 * - other/generic (other.rs:361-373): running 走 Truncated ↔ Expanded，
 *   完成后 Collapsed ↔ Expanded。
 * - default (block.rs:116): Collapsed → Expanded，其余 → Collapsed。
 */
export function nextToolFoldMode(
  kindName: string | undefined,
  current: ToolDisplayMode,
  running: boolean,
): ToolDisplayMode {
  if (kindName === 'read') return current === 'collapsed' ? 'truncated' : 'collapsed'
  if (kindName == null || kindName === 'generic') {
    if (running) return current === 'truncated' ? 'expanded' : 'truncated'
    return current === 'collapsed' ? 'expanded' : 'collapsed'
  }
  return current === 'collapsed' ? 'expanded' : 'collapsed'
}

export function entryExpanded(e: ScrollEntry): boolean {
  // Tool: anything past the header-only card counts as expanded（含旧数据
  // 的 expanded:true —— toolDisplayMode 归一后是 truncated 预览档）。
  if (e.kind === 'tool') return toolDisplayMode(e) !== 'collapsed'
  // Thought: only the fully-collapsed header counts as folded (truncated
  // and expanded both show body content).
  if (e.kind === 'thought') return thoughtDisplayMode(e) !== 'collapsed'
  if (e.kind === 'session_event') return !!e.open
  // LifecycleEventBlock default_display_mode = Collapsed.
  if (e.kind === 'lifecycle') return !!e.expanded
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
    // TUI: block.is_foldable() || hook_data.has_content().
    if (toolHooksHaveContent(e.hooks)) return true
    if (e.liteOmitted) return true
    if (!e.raw) return false
    return toolHasExpandableBody(e.raw, e.kindName, e.liteOmitted)
  }
  if (e.kind === 'thought') return !e.streaming && (!!e.text || !!e.liteOmitted)
  // Recap body, or a turn marker carrying stop-hook runs (TUI
  // SessionEventBlock::is_foldable).
  if (e.kind === 'session_event')
    return !!e.recap || hookGroupsHaveContent(e.stopHooks)
  if (e.kind === 'lifecycle') return true
  // 有待展开的内容（答案或错误）才可折叠；请求进行中无正文可看。
  if (e.kind === 'btw') return !e.streaming && (!!e.answer || !!e.error)
  if (e.kind === 'user') return userIsFoldable(e.text)
  if (e.kind === 'group_header') return true
  return false
}

export function toolHasExpandableBody(
  raw: ToolCall,
  kindName?: string,
  liteOmitted?: number,
): boolean {
  // lite 裁掉的正文仍然是正文：占位行必须能展开 / 开查看器，否则「查看」
  // 按钮会在补全前消失（宿主只裁内容，不改行数与状态）。
  if ((liteOmitted ?? 0) > 0 || toolBodyOmitted(raw)) return true
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
        // TUI search.rs:547-551: 恒可折（无 error 即可，哪怕零命中——
        // 展开能看到元数据/“(no results)”）。
        return !d.error
      case 'list_dir':
        // TUI list_dir.rs:223-228: 失败不可折。
        return !d.error && !!d.output
      case 'fetch':
        // TUI web_fetch.rs:321-323: error.is_none() && output.is_some()。
        return !d.error && !!d.output
      case 'web_search':
        // TUI web_search.rs:365-367: !error && content && !is_x_search
        // （FE 的 X search 变体由 toolDetail 标成 label 'X Search'）。
        return !d.error && !!d.content && d.label !== 'X Search'
      case 'use_tool':
        return d.args.length > 0 || !!d.output || !!d.error
      case 'search_tool':
        return d.results.length > 0 || !!d.error
      case 'generic':
        // TUI other.rs:349-355: 失败不可折，且仅 output 计入（input 不算）。
        return !d.error && !!d.output
      default:
        // 新增 detail kind 的兜底（与 catch 同款）：有正文即视为可展开。
        return !!(raw.rawOutput || raw.content || raw.rawInput)
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
    // 最小形态 = 仅行头（truncated 预览与全量正文都算展开）。
    return toolDisplayMode(e) === 'collapsed'
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
  if (e.kind === 'lifecycle') return !e.expanded
  // btw 同款：折叠 = 最小形态。
  if (e.kind === 'btw') return !e.open
  // group_header.collapse === expanded (synthetic); min fold = not expanded
  if (e.kind === 'group_header') return !e.collapse
  return false
}

/** Header-style blocks get collapsed bg_dark selection fill (scrollback_pane). */
export function isHeaderStyleBlock(e: ScrollEntry): boolean {
  return (
    e.kind === 'tool' ||
    e.kind === 'thought' ||
    e.kind === 'group_header' ||
    e.kind === 'lifecycle'
  )
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
    e.kind !== 'lifecycle' &&
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
