import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { planTodos, useChatStore } from '../store/chat'
import type { ScrollEntry } from '../api/types'
import { subagentMeta } from '../format'
import { Glyphs, SPINNER_FRAMES, SPINNER_INTERVAL_MS, toolHeader } from '../theme/glyphs'
import { thoughtDisplayMode } from '../scrollback/thoughtMode'
import {
  USER_COLLAPSED_MAX_LINES,
  collapseUserText,
  userIsFoldable,
} from '../scrollback/userText'
import { TodoMark } from './todoMark'
import { WorkspaceBar } from './TopBar'
import { DirectoryPickerModal } from './DirectoryPickerModal'
import {
  ICON_COL_CLASS,
  DENSE_ROW_CLASS,
  HEADER_ROW_CLASS,
  ACCENT_W_PX,
  ACCENT_GAP_PX,
  CONTENT_COLUMN_CLASS,
  COLUMN_PAD_X_CLASS,
} from '../theme/layout'
import { FINISH_FLASH_MS } from '../theme/wave'
import { IconGlyph } from './IconGlyph'
import {
  displayRowKey,
  groupingSignature,
  isDensePackableRow,
  projectDisplayRows,
  scanGroups,
  spanContaining,
  type DisplayRow,
  type GroupSpan,
} from '../scrollback/verbGroup'
import { AccentRail } from './AccentRail'
import {
  Accents,
  resolveAccent,
  resolveBullet,
  type AccentResolveOpts,
} from '../theme/accents'
import { SelectionBox } from './SelectionBox'
import { Markdown } from './Markdown'
import { ToolDetail } from './ToolDetail'
import { Ansi } from './Ansi'
import { extractToolDetail } from '../scrollback/toolDetail'
import { uiBool } from '../store/settings'
import { mergeLiveText } from '../scrollback/liveText'
import {
  UserMessageNav,
  userMessagePreview,
  type UserMessageNavItem,
} from './UserMessageNav'

/**
 * Scrollback — Grok Build TUI block model:
 * selection (j/k), ←/→ collapse/expand, full accent matrix
 * (tool families, finish flash, pending freeze, per-row wave).
 */

/** Header path/target + dim suffix matching TUI collapsed_line extras. */
function toolHeaderExtra(
  raw: import('../api/types').ToolCall,
  kindName: string | undefined,
  failed: boolean,
  mergedRaws?: import('../api/types').ToolCall[],
): { target: string; suffix?: string } | null {
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

function entryRunning(e: ScrollEntry): boolean {
  if (e.kind === 'assistant') return !!e.streaming
  if (e.kind === 'thought') return !!e.streaming
  if (e.kind === 'tool')
    return e.status === 'pending' || e.status === 'in_progress'
  if (e.kind === 'subagent' || e.kind === 'workflow' || e.kind === 'bg_task')
    return !!e.running
  if (e.kind === 'session_event') return !!e.streaming
  return false
}

function entryFailed(e: ScrollEntry): boolean {
  if (e.kind === 'error') return true
  if (e.kind === 'tool')
    return e.status === 'failed' || e.status === 'error'
  if (e.kind === 'subagent')
    return e.status === 'failed' || e.status === 'cancelled'
  if (e.kind === 'workflow') return e.status === 'failed'
  if (e.kind === 'bg_task') return e.status === 'failed'
  return false
}

/** ThinkingBlock truncated preview: head lines before "…" (TUI truncated view). */
const THOUGHT_TRUNCATED_HEAD_LINES = 5
/** ThinkingBlock truncated preview: tail lines after "…" (TUI truncated_lines default = 3). */
const THOUGHT_TRUNCATED_TAIL_LINES = 3
/** Pause between scroll-up page loads (also shields the anchor-restore
 *  scroll event from chaining the next page immediately). */
const TOP_PAGE_COOLDOWN_MS = 400
/** Touch swipe distance (px) that counts as a scroll-up gesture. */
const TOUCH_UP_SWIPE_PX = 8
/**
 * ThinkingBlock truncated preview (TUI render_truncated): the first
 * THOUGHT_TRUNCATED_HEAD_LINES lines, "…", then the last
 * THOUGHT_TRUNCATED_TAIL_LINES lines. Short bodies (≤ head+tail) show whole.
 */
function truncatedThoughtLines(text: string): string[] {
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
 * TAIL of the accumulated text (newest lines) instead of the full body —
 * per-flush DOM/text cost stays flat as the thought grows (the full text
 * lives in the store / the dblclick viewer). Null = whole text fits in
 * the budget (render verbatim).
 */
const THOUGHT_STREAM_TAIL_MAX_CHARS = 1600
const THOUGHT_STREAM_TAIL_MAX_LINES = 6
/** Line-start snap allowance near the char-window edge (chars). */
const THOUGHT_STREAM_TAIL_SNAP_PAD = 400

function thoughtStreamTail(text: string): string | null {
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
function streamThoughtBody(text: string): string {
  const tail = thoughtStreamTail(text)
  return tail == null ? text : `${Glyphs.ellipsis}\n${tail}`
}

function entryExpanded(e: ScrollEntry): boolean {
  if (e.kind === 'tool') return !!e.expanded
  // Thought: only the fully-collapsed header counts as folded (truncated
  // and expanded both show body content).
  if (e.kind === 'thought') return thoughtDisplayMode(e) !== 'collapsed'
  if (e.kind === 'session_event') return !!e.open
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
function entryFoldable(e: ScrollEntry): boolean {
  if (e.kind === 'tool') {
    // Match TUI: only foldable when there is expanded body content.
    if (!e.raw) return false
    return toolHasExpandableBody(e.raw, e.kindName)
  }
  if (e.kind === 'thought') return !e.streaming && !!e.text
  if (e.kind === 'session_event') return !!e.recap
  if (e.kind === 'user') return userIsFoldable(e.text)
  if (e.kind === 'group_header') return true
  return false
}

function toolHasExpandableBody(
  raw: import('../api/types').ToolCall,
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
function entryAtMinFold(e: ScrollEntry): boolean {
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
  // group_header.collapse === expanded (synthetic); min fold = not expanded
  if (e.kind === 'group_header') return !e.collapse
  return false
}

/** Header-style blocks get collapsed bg_dark selection fill (scrollback_pane). */
function isHeaderStyleBlock(e: ScrollEntry): boolean {
  return e.kind === 'tool' || e.kind === 'thought' || e.kind === 'group_header'
}

/**
 * Expandable indicator: replace ◆ with › when (selected|hovered) + foldable
 * + at min fold (paint_expandable_indicator — select + hover share this).
 */
function expandableGlyph(e: ScrollEntry, active: boolean): string | null {
  if (!active) return null
  if (!entryFoldable(e)) return null
  if (!entryAtMinFold(e)) return null
  if (
    e.kind !== 'tool' &&
    e.kind !== 'thought' &&
    e.kind !== 'session_event' &&
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

/** Hover bg for collapsed header-style: blend(bg_base, bg_dark, 0.5). */
const HOVER_BG =
  'color-mix(in srgb, var(--color-gn-bg-dark) 50%, var(--color-gn-bg-base))'

function accentOpts(
  e: ScrollEntry,
  selected: boolean,
  pendingFreeze: boolean,
  now: number,
  hovered = false,
  inGroup = false,
): AccentResolveOpts {
  const base: AccentResolveOpts = {
    kind: e.kind,
    running: entryRunning(e),
    failed: entryFailed(e),
    expanded: entryExpanded(e),
    selected,
    hovered,
    pendingFreeze,
    now,
    inGroup,
  }

  if (e.kind === 'tool') {
    return {
      ...base,
      kindName: e.kindName,
      finishedAt: e.finishedAt,
    }
  }
  if (e.kind === 'thought') {
    return { ...base, finishedAt: e.finishedAt }
  }
  if (e.kind === 'subagent') {
    return { ...base, subagentStatus: e.status }
  }
  if (e.kind === 'workflow') {
    return { ...base, workflowStatus: e.status }
  }
  if (e.kind === 'bg_task') {
    return { ...base, bgTaskStatus: e.status }
  }
  if (e.kind === 'session_event') {
    return {
      ...base,
      sessionEvent: { recap: e.recap, warning: e.warning },
    }
  }
  if (e.kind === 'group_header') {
    return {
      ...base,
      groupHeader: e.verbRun
        ? {
            variant: 'verb',
            running: e.verbRun.running,
            failed: e.verbRun.failed,
          }
        : { variant: 'truncation' },
    }
  }
  return base
}

/**
 * TUI gap rule (recompute_gap_after): gap=0 between consecutive collapsed
 * groupable rows; gap=1 otherwise. Dense packable = tool/thought/subagent/
 * group_header one-liners that participate in dense runs.
 */
/**
 * TUI gap rule (recompute_gap_after): gap=0 between consecutive collapsed
 * groupable rows; gap=1 otherwise. Dense packable = tool/thought/subagent/
 * group_header one-liners that participate in dense runs.
 * （实现移入 src/scrollback/verbGroup.ts——与迷你 scrollback 共用。）
 */

/** 条目外壳：accent 竖条 + 选区/悬浮框 + 内容列（主 scrollback 与迷你
 *  scrollback 共用；hover/选中由调用方传入，mini 用组件内局部状态）。 */
export function EntryShell({
  e,
  selected,
  hovered,
  onHover,
  children,
  onSelect,
  pendingFreeze,
  now,
  /** Row sits inside a group span (expanded verb / truncation tail). */
  inGroup = false,
  /** This row is dense-packable (collapsed groupable). */
  dense = false,
  /** Next display row is also dense → gap_after = 0. */
  denseNext = false,
  /** Previous display row is dense → no top margin. */
  densePrev = false,
  /**
   * Full-bleed block background (user prompt band). Spans accent + content
   * so the elevated strip matches TUI BlockBackground::Light + accent_bg.
   */
  bandBg,
}: {
  e: ScrollEntry
  selected: boolean
  hovered: boolean
  onHover: (h: boolean) => void
  children: React.ReactNode
  onSelect: () => void
  pendingFreeze: boolean
  now: number
  inGroup?: boolean
  dense?: boolean
  denseNext?: boolean
  densePrev?: boolean
  bandBg?: string
}) {
  // Accent color follows hover/selected; height follows content only.
  const opts = accentOpts(e, selected, pendingFreeze, now, hovered, inGroup)
  const paint = resolveAccent(opts)

  const collapsed = !entryExpanded(e)
  // Selected collapsed tool/thought: full bg_dark
  const selectedBg = selected && isHeaderStyleBlock(e) && collapsed
  // Hover pre-select (skip when selected — selection wins): half-blend bg
  const hoverBg =
    hovered && !selected && isHeaderStyleBlock(e) && collapsed

  // Selection wins over hover frame (render_entry_hover skips selected)
  const showFrame = selected || hovered
  const frameVariant = selected ? 'selected' : 'hover'

  // Spacing: dense↔dense gap=0; otherwise leave a small prose gap
  // User prompts get vpad (has_vpad_for) — slightly more air than dense tools.
  const isUser = e.kind === 'user'
  const mt = dense && densePrev ? 'mt-0' : dense ? 'mt-0' : isUser ? 'mt-2' : 'mt-1.5'
  const mb = dense && denseNext ? 'mb-0' : dense ? 'mb-0' : isUser ? 'mb-2' : 'mb-1.5'
  const py = dense ? 'py-0' : isUser ? 'py-0' : 'py-[2px]'
  const contentPy = dense ? 'py-0' : isUser ? 'py-0' : 'py-0.5'

  return (
    <div
      data-entry-id={e.id}
      data-dense={dense ? '1' : undefined}
      data-streaming={'streaming' in e && e.streaming ? '1' : undefined}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      // Tracks: accent + gap + content. Selection compact height === entry;
      // accent is self-stretch max-h-full so it never exceeds the frame.
      className={`relative grid ${mt} ${mb} ${py}`}
      style={{
        gridTemplateColumns: `${ACCENT_W_PX}px 1fr`,
        columnGap: ACCENT_GAP_PX,
        backgroundColor: bandBg
          ? bandBg
          : selectedBg
            ? 'var(--color-gn-bg-dark)'
            : hoverBg
              ? HOVER_BG
              : undefined,
      }}
    >
      {showFrame && (
        // Taller frame (OUTSET_Y) wraps the block; accent centers in 选区.
        <SelectionBox variant={frameVariant} />
      )}
      <AccentRail paint={paint} />
      <div className={`min-w-0 ${contentPy}`}>{children}</div>
    </div>
  )
}

/** @deprecated Prefer importing ICON_COL_CLASS from theme/layout */
export { ICON_COL_CLASS }

export function Bullet({
  color,
  animated,
  glyph = Glyphs.diamondFilled,
  className = '',
}: {
  color: string
  animated?: boolean
  glyph?: string
  className?: string
}) {
  return (
    <IconGlyph glyph={glyph} color={color} animated={animated} className={className} />
  )
}

/** TUI prompt timestamp (scrollback_pane show_timestamps): "20:31". */
function formatPromptTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** TUI hover expansion: "08/06 20:31:45". */
function formatPromptTimeFull(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * TUI right-aligned message timestamp overlay (scrollback_pane
 * show_timestamps): short form always, expands to "HH:MM:SS | Mon D" on
 * hover of the time area itself (not the whole entry — hovering the row
 * never expands it). Absolutely positioned so the wider hover form never
 * reflows the message content — it covers it, as in the TUI.
 *
 * Hard-won constraints (verified empirically in Chrome):
 * - The swap is driven by the OUTER span's own :hover via the custom
 *   .gn-pt classes (index.css) — NOT group-hover:, whose :is(:where(.group)
 *   :hover *) matches ANY .group ancestor, so the entry row's group class
 *   would expand the time on any row hover.
 * - The outer span's width is pinned to the FULL form's width
 *   (w-[17ch], text-right): an absolutely-positioned span shrinks to
 *   width 0 when both children are display:none, collapsing the hover
 *   target and the full form's box (flicker/vanish). Fixed width keeps
 *   the box — and the :hover on it — stable across the swap.
 * Parent needs `group relative`; `className` supplies the top offset and
 * `shiftRight` clears a right-edge chevron (12px), keeping the same 8px
 * base margin from the edge in both cases.
 */
function PromptTime({
  ts,
  className = '',
  shiftRight = false,
}: {
  ts?: number
  className?: string
  shiftRight?: boolean
}) {
  // /timestamps toggle (TUI scrollback_pane show_timestamps) — one gate
  // here covers every PromptTime call site.
  const showTimestamps = useChatStore((s) => s.showTimestamps)
  if (!showTimestamps || ts == null) return null
  return (
    <span
      aria-hidden
      className={`gn-pt absolute w-[17ch] text-right text-[11px] leading-none text-gn-gray ${className}`}
      style={{ right: shiftRight ? 20 : 8 }}
    >
      <span className="gn-pt-short">{formatPromptTime(ts)}</span>
      <span className="gn-pt-full">{formatPromptTimeFull(ts)}</span>
    </span>
  )
}

/** 迷你 scrollback（子代理弹窗）注入的局部动作。缺省取主 store 动作——
 *  主 scrollback 行为不变；mini 条目不在主 entries 里，折叠/选中/查看器
 *  用组件内局部状态（任务 1：弹窗复用主渲染体系、不接主 store 选择器）。 */
export type EntryViewActions = {
  /** 工具行折叠切换（默认主 store toggleTool）。 */
  toggleTool?: (id: string) => void
  /** 思考行折叠切换（默认主 store toggleThought）。 */
  toggleThought?: (id: string) => void
  /** 用户行折叠切换（默认主 store toggleUser）。 */
  toggleUser?: (id: string) => void
  /** 全文弹窗查看器（mini 双击不弹主 viewer——条目不在主 entries）。 */
  openViewer?: (id: string) => void
  /** 行选中（mini 局部选中；默认主 store selectEntry）。 */
  selectEntry?: (id: string) => void
}

type EntryViewProps = {
  e: ScrollEntry
  selected: boolean
  pendingFreeze: boolean
  now: number
  dense?: boolean
  denseNext?: boolean
  densePrev?: boolean
  inGroup?: boolean
  /** 迷你 scrollback 局部动作（见 EntryViewActions）。 */
  actions?: EntryViewActions
  /**
   * 迷你 scrollback 折叠覆盖（工具/用户 expanded、思考 displayMode 由
   * 弹窗局部状态决定，不写回 store）。渲染前合并进条目；主 scrollback
   * 不传 → 恒为 undefined，行为与 memo 比较完全不变。
   */
  patch?: Partial<ScrollEntry>
  /**
   * 主 scrollback 的合并流式滚动固定：流式思考期间挂到思考 body 元素上，
   * 由父组件统一固定（每帧一次布局读写）；迷你 scrollback 不传 → 条目
   * 自己固定。恒为稳定引用（useRef 对象），memo 比较只做引用相等。
   */
  streamBodyRef?: { current: HTMLDivElement | null }
}

/**
 * Inline images for a conversation row. `size` selects the layout:
 * assistant rows get wide images (max 65%), user rows small thumbnails
 * (max-h-24, hover scale). Click opens the block viewer for the owning
 * entry — the full-size view with byte/mime meta lives there.
 */
function InlineImages({
  images,
  size,
  onOpen,
}: {
  images: Array<{ data: string; mimeType?: string }>
  size: 'assistant' | 'user'
  onOpen: () => void
}) {
  if (!images.length) return null
  return (
    <div
      className={`flex flex-wrap ${
        size === 'assistant' ? 'items-start gap-2' : 'items-end gap-1.5'
      }`}
    >
      {images.map((img, i) => (
        <img
          key={i}
          src={img.data}
          alt={img.mimeType ? `image (${img.mimeType})` : 'image'}
          loading="lazy"
          onClick={onOpen}
          title="点击放大查看"
          className={
            size === 'assistant'
              ? 'max-w-[65%] cursor-zoom-in rounded border border-gn-prompt-border'
              : 'max-h-24 max-w-[45%] cursor-zoom-in rounded border border-gn-prompt-border object-contain transition-transform duration-150 hover:scale-110'
          }
        />
      ))}
    </div>
  )
}

/** Whether an entry is inside its finish-flash window (needs clock ticks). */
function entryFlashActive(e: ScrollEntry, now: number): boolean {
  if (e.kind !== 'tool' && e.kind !== 'thought') return false
  const fa = e.finishedAt
  return fa != null && now - fa < FINISH_FLASH_MS
}

/**
 * Memo comparator: entries only re-render when their own data changes;
 * `now` clock ticks are ignored unless the entry is mid finish-flash
 * (the tick that expires the flash still re-renders via the prev check).
 */
function entryViewEqual(prev: EntryViewProps, next: EntryViewProps): boolean {
  return (
    prev.e === next.e &&
    prev.selected === next.selected &&
    prev.pendingFreeze === next.pendingFreeze &&
    prev.dense === next.dense &&
    prev.denseNext === next.denseNext &&
    prev.densePrev === next.densePrev &&
    prev.inGroup === next.inGroup &&
    // actions 由调用方保证稳定（主 scrollback 不传 → undefined 恒等；
    // mini 用 useMemo/useState setter 构造 → 引用稳定）。patch 同理。
    prev.actions === next.actions &&
    prev.patch === next.patch &&
    prev.streamBodyRef === next.streamBodyRef &&
    (prev.now === next.now ||
      (!entryFlashActive(prev.e, prev.now) && !entryFlashActive(next.e, next.now)))
  )
}

export const EntryView = memo(function EntryView({
  e: eProp,
  selected,
  pendingFreeze,
  now,
  dense = false,
  denseNext = false,
  densePrev = false,
  inGroup = false,
  actions,
  patch,
  streamBodyRef,
}: EntryViewProps) {
  // 迷你 scrollback 折叠覆盖：patch 合并进渲染条目（不写回 store）。
  const e = patch ? ({ ...eProp, ...patch } as ScrollEntry) : eProp
  // Live-stream delta/suffix for THIS entry only. Parent Scrollback does
  // not select liveStream — each row subscribes itself so chunk growth
  // re-renders only the streaming EntryView (selector returns undefined
  // for every other row → Object.is skip). Mini timelines without a
  // matching liveStream id also get undefined.
  // liveText is the store buffer only (not including e.text); display
  // always uses mergeLiveText(e.text, liveText) — additive.
  const liveText = useChatStore((s) =>
    s.liveStream?.entryId === eProp.id ? s.liveStream.text : undefined,
  )
  // 迷你 scrollback 局部动作覆盖（缺省主 store 动作——行为不变）。
  const storeToggleTool = useChatStore((s) => s.toggleTool)
  const storeToggleThought = useChatStore((s) => s.toggleThought)
  const storeToggleUser = useChatStore((s) => s.toggleUser)
  const storeOpenViewer = useChatStore((s) => s.openViewer)
  const storeSelectEntry = useChatStore((s) => s.selectEntry)
  const cancelSubagent = useChatStore((s) => s.cancelSubagent)
  const killTask = useChatStore((s) => s.killTask)
  const toggleTool = actions?.toggleTool ?? storeToggleTool
  const toggleThought = actions?.toggleThought ?? storeToggleThought
  const toggleUser = actions?.toggleUser ?? storeToggleUser
  const openViewer = actions?.openViewer ?? storeOpenViewer
  const selectEntry = actions?.selectEntry ?? storeSelectEntry
  const onSelect = () => selectEntry(e.id)
  // Distinguish single-click (fold) vs double-click (viewer): defer single
  // until after the double-click window so dblclick doesn't also toggle.
  const clickTimer = useRef<number | null>(null)
  const clearClickTimer = () => {
    if (clickTimer.current != null) {
      window.clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
  }
  useEffect(() => () => clearClickTimer(), [])
  const onHeaderClick = (action: () => void) => {
    clearClickTimer()
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null
      action()
    }, 220)
  }
  const onHeaderDblClick = () => {
    clearClickTimer()
    openViewer(e.id)
  }
  const [hovered, setHovered] = useState(false)
  const opts = accentOpts(e, selected, pendingFreeze, now, hovered)
  const bullet = resolveBullet(opts)
  // › on selected OR hover pre-select when collapsed foldable
  const caret = expandableGlyph(e, selected || hovered)
  const bulletGlyph = caret ?? undefined

  // Thought body preview: cap at 4 lines (max-h 6.5em == 4 lines @
  // leading-relaxed), overflow clipped — no internal scroll (the full
  // text lives in the viewer).
  const localBodyRef = useRef<HTMLDivElement>(null)
  const bodyRef = streamBodyRef ?? localBodyRef
  const thoughtStreaming = e.kind === 'thought' ? e.streaming : false
  // Additive: base entry text + liveStream delta (see mergeLiveText).
  const thoughtText =
    e.kind === 'thought' ? mergeLiveText(e.text, liveText) : undefined
  // 流式期间把思考 body 元素注册给父组件（父 effect 每帧固定一次；
  // 收口/卸载时父组件读到 null 即停止固定）。
  useEffect(() => {
    if (!streamBodyRef) return
    streamBodyRef.current = thoughtStreaming ? bodyRef.current : null
  }, [streamBodyRef, thoughtStreaming, e.id, bodyRef])
  const shell = {
    e,
    selected,
    hovered,
    onHover: setHovered,
    onSelect,
    pendingFreeze,
    now,
    dense,
    denseNext,
    densePrev,
    inGroup,
  }
  // One-line tool/thought chrome: center bullet with text (not baseline — ⌄/◆).
  // Icon col pins text-[13px] so em-box is stable across user/tool rows.
  // TUI has_vpad=false for dense tool rows.
  const rowBtn = dense ? DENSE_ROW_CLASS : HEADER_ROW_CLASS

  if (e.kind === 'user') {
    // UserPromptBlock: full-width bg_light band, accent_user ❯ prefix
    // (↻ for is_cron scheduled /loop fires), continuation indent, optional
    // collapse to 3 visual lines + " …".
    const foldable = userIsFoldable(e.text)
    const expanded = entryExpanded(e)
    const { text: body, truncated } = expanded
      ? { text: e.text, truncated: false }
      : collapseUserText(e.text, USER_COLLAPSED_MAX_LINES)
    // Selected prompts step up slightly (TUI selected → silver / stronger band)
    const band = selected
      ? 'color-mix(in srgb, var(--color-gn-bg-highlight) 70%, var(--color-gn-bg-hover))'
      : 'var(--color-gn-bg-highlight)'
    const lines = body.split('\n')
    // Collapse chevron sits at the right edge; the time overlay shifts left
    // of it so the two never cover each other.
    const chevronShown = foldable && (selected || hovered) && !expanded
    // TUI: is_bash → "$ " (command color), is_cron → "↻  ", else prompt_arrow.
    // Shell-mode submissions carry the isShell marker from the store's send().
    const isShell = (e as { isShell?: boolean }).isShell === true
    const prefixGlyph = isShell ? '$' : e.isCron ? Glyphs.cronPrompt : Glyphs.promptArrow
    const prefixColor = isShell
      ? 'var(--color-gn-cyan)'
      : 'var(--color-gn-accent-user)'
    return (
      <EntryShell {...shell} bandBg={band}>
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation()
            onHeaderClick(() => {
              onSelect()
              if (foldable) toggleUser(e.id)
            })
          }}
          onDoubleClick={(ev) => {
            ev.stopPropagation()
            ev.preventDefault()
            onHeaderDblClick()
          }}
          className="group relative flex w-full min-w-0 items-start gap-1.5 py-[11px] text-left font-ui text-[13.5px] leading-[1.35]"
          title={
            isShell
              ? 'shell command · click fold · dblclick / enter view'
              : e.isCron
                ? 'scheduled task · click fold · dblclick / enter view'
                : 'click fold · dblclick / enter view'
          }
        >
          {/* Same icon column as tool/thought bullets so ❯ / ↻ / ◆ / › line up.
              Icon box is 1.2em@13px = 15.6px; first text line is 13.5px×1.35 ≈ 18.2px.
              mt-[1.5px] centers prefix on the first line (items-start keeps multiline top-aligned). */}
          <Bullet
            color={prefixColor}
            glyph={prefixGlyph}
            className={`mt-[1.5px] ${isShell ? 'font-mono' : ''}`}
          />
          <div className="min-w-0 flex-1 text-gn-fg">
            {lines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-words">
                {/* Icon sits in a sibling column (flex gap); continuations already
                    share the first line's text start — no extra indent (TUI uses
                    prefix-width spaces only when prefix is inline on each line). */}
                {line || (i < lines.length - 1 ? '\u00A0' : '')}
              </div>
            ))}
            {truncated && foldable && (
              <span className="sr-only"> (collapsed, expand with →)</span>
            )}
          </div>
          {/* TUI right-aligned prompt time (scrollback_pane show_timestamps);
              absolute overlay: hover expansion never reflows the message. */}
          <PromptTime ts={e.ts} className="top-[14.5px]" shiftRight={chevronShown} />
          {chevronShown && (
            <span
              className="ml-1 shrink-0 self-start text-[12px] text-gn-gray-dim"
              aria-hidden
            >
              {Glyphs.chevron}
            </span>
          )}
        </button>
        {/* User-sent images (echoed back / attached): thumbnails under the
            prompt text, aligned with the text column (icon col + gap). */}
        {e.images?.length ? (
          <div className="pb-2 pl-[22px]">
            <InlineImages
              images={e.images}
              size="user"
              onOpen={() => openViewer(e.id)}
            />
          </div>
        ) : null}
      </EntryShell>
    )
  }

  if (e.kind === 'assistant') {
    // liveText = liveStream delta/suffix for this entry only (not a full
    // replacement). Additive merge works for both store shapes:
    // entry.text '' + live full stream, or base + later chunks in liveStream.
    const displayText = mergeLiveText(e.text, liveText)
    // Prefer liveText presence for settle-on-flush; also keep plain-text
    // path while e.streaming (e.g. mid-tool after live cleared into entry).
    const streamActive = liveText != null || !!e.streaming
    return (
      <EntryShell {...shell}>
        {/* Reserve the short-form time's width (TUI ts_reserved=10 cols; sm:
            only — the time itself is hidden on mobile) so text never runs
            under it; the hover expansion still overlays content by design. */}
        <div
          className="group relative min-w-0 sm:pr-9"
          title="dblclick / enter · view"
          onDoubleClick={(ev) => {
            ev.stopPropagation()
            ev.preventDefault()
            onHeaderDblClick()
          }}
        >
          <Markdown source={displayText} streaming={streamActive} />
          {/* Agent-embedded images render below the text. */}
          {e.images?.length ? (
            <div className="mt-1.5">
              <InlineImages
                images={e.images}
                size="assistant"
                onOpen={() => openViewer(e.id)}
              />
            </div>
          ) : null}
          {/* TUI right-aligned message time; tool/thought blocks get none.
              Hidden on mobile (sm: = desktop), unlike user prompt times. */}
          <PromptTime ts={e.ts} className="top-[3.5px] hidden sm:inline" />
        </div>
      </EntryShell>
    )
  }

  if (e.kind === 'image') {
    // Standalone image entry (no open assistant / user row to attach to):
    // centered large image + mimeType caption; click → fullscreen viewer.
    return (
      <EntryShell {...shell}>
        <figure className="flex flex-col items-center gap-1 py-1.5">
          <img
            src={e.data}
            alt={e.mimeType ? `image (${e.mimeType})` : 'image'}
            loading="lazy"
            onClick={() => openViewer(e.id)}
            title="点击放大查看"
            className="max-h-[55vh] w-auto max-w-full cursor-zoom-in rounded border border-gn-prompt-border object-contain"
          />
          {e.mimeType ? (
            <figcaption className="font-mono text-[11px] text-gn-muted">
              {e.mimeType}
            </figcaption>
          ) : null}
        </figure>
      </EntryShell>
    )
  }

  if (e.kind === 'thought') {
    const mode = thoughtDisplayMode(e)
    // 流式思考展开正文（live 可见），收口后按 displayMode 折叠/展开——
    // 主 scrollback 与子代理弹窗共用同一行为。
    const showBody = e.streaming || mode !== 'collapsed'
    // Truncated (default after finish): header + head/tail preview, no
    // internal scroll (the tail must stay visible). Streaming/expanded:
    // full body in a capped scroll container.
    const truncated = mode === 'truncated' && !e.streaming
    return (
      <EntryShell {...shell}>
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation()
            if (e.streaming) {
              onSelect()
              return
            }
            onHeaderClick(() => toggleThought(e.id))
          }}
          onDoubleClick={(ev) => {
            ev.stopPropagation()
            ev.preventDefault()
            onHeaderDblClick()
          }}
          className={rowBtn}
          title="click fold · dblclick / enter view"
        >
          <Bullet
            color={bullet.color}
            animated={bullet.animated && !caret}
            glyph={bulletGlyph}
          />
          {e.streaming ? (
            <span className="font-bold" style={{ color: Accents.thinkingDefault }}>
              Thinking{Glyphs.ellipsis}
            </span>
          ) : (
            <>
              <span className="font-bold text-gn-muted">Thought</span>
              {e.elapsed && (
                <span className="text-gn-muted"> for {e.elapsed}</span>
              )}
            </>
          )}
        </button>
        {showBody && (
          <div
            ref={bodyRef}
            className={
              truncated
                ? 'mt-1 border-l pl-3 text-[12.5px] leading-relaxed'
                : 'mt-1 min-h-[1.2em] max-h-[6.5em] overflow-hidden border-l pl-3 text-[12.5px] leading-relaxed'
            }
            style={{ borderColor: 'color-mix(in srgb, var(--color-gn-gray-dim) 40%, transparent)' }}
          >
            {thoughtText ? (
              <div className="italic text-gn-muted whitespace-pre-wrap break-words">
                {/* thoughtText = e.text + liveStream delta（additive merge）。 */}
                {e.streaming
                  ? streamThoughtBody(thoughtText)
                  : truncated
                    ? truncatedThoughtLines(thoughtText).join('\n')
                    : thoughtText}
                {e.streaming && (
                  <span
                    className="ml-0.5 inline-block h-[0.9em] w-[0.4em] translate-y-[1px] animate-pulse align-text-bottom"
                    style={{ backgroundColor: Accents.thinkingDefault, opacity: 0.6 }}
                  />
                )}
              </div>
            ) : e.streaming ? (
              <div className="text-[12px] text-gn-gutter italic">
                reasoning{Glyphs.ellipsis}
              </div>
            ) : null}
          </div>
        )}
      </EntryShell>
    )
  }

  if (e.kind === 'tool') {
    const running = e.status === 'pending' || e.status === 'in_progress'
    const failed = e.status === 'failed' || e.status === 'error'
    const { verb } = toolHeader(e.kindName, running)
    const verbColor = failed
      ? Accents.error
      : e.expanded
        ? 'var(--color-gn-fg)'
        : Accents.gray
    const targetColor =
      e.expanded && !failed ? 'var(--color-gn-path)' : Accents.gray
    const detailColor = 'var(--color-gn-muted)'

    // TUI header suffixes: range / match count / entry count / exit etc.
    const headerExtra = e.raw
      ? toolHeaderExtra(e.raw, e.kindName, failed, e.mergedRaws)
      : null

    return (
      <EntryShell {...shell}>
        <button
          type="button"
          onClick={(ev: ReactMouseEvent) => {
            ev.stopPropagation()
            // Single click: inline fold (TUI ←/→)
            onHeaderClick(() => toggleTool(e.id))
          }}
          onDoubleClick={(ev) => {
            ev.stopPropagation()
            ev.preventDefault()
            // Double click: fullscreen viewer (TUI Enter / OpenBlockViewer)
            onHeaderDblClick()
          }}
          className={rowBtn}
          title="click fold · dblclick / enter view"
        >
          <Bullet
            color={bullet.color}
            animated={bullet.animated && !caret}
            glyph={bulletGlyph}
          />
          <span
            className="shrink-0 font-bold"
            style={{ color: verbColor }}
          >
            {verb}
          </span>
          <span
            className="min-w-0 truncate font-mono text-[12.5px] leading-[1.35]"
            style={{ color: targetColor }}
          >
            {headerExtra?.target ?? e.title}
          </span>
          {headerExtra?.suffix ? (
            <span
              className="min-w-0 truncate text-[12px] leading-[1.35]"
              style={{ color: detailColor }}
            >
              {headerExtra.suffix}
            </span>
          ) : null}
          {running && (
            <span className="ml-auto shrink-0 text-[10px] text-gn-cyan tabular-nums">
              {Glyphs.ellipsis}
            </span>
          )}
        </button>
        {/* Inline expand = TUI Truncated preview; full body via Enter/dblclick. */}
        {e.expanded && e.raw ? (
          <div
            onDoubleClick={(ev) => {
              ev.stopPropagation()
              openViewer(e.id)
            }}
            title="double-click or enter for full view"
          >
            <ToolDetail
              raw={e.raw}
              kindName={e.kindName}
              full={false}
              mergedRaws={e.mergedRaws}
            />
          </div>
        ) : null}
      </EntryShell>
    )
  }

  if (e.kind === 'error') {
    return (
      <EntryShell {...shell}>
        <div
          className="flex items-start gap-1.5 py-0.5 text-[13px] leading-[1.35]"
          title="dblclick / enter · view"
          onDoubleClick={(ev) => {
            ev.stopPropagation()
            ev.preventDefault()
            onHeaderDblClick()
          }}
        >
          <Bullet color={Accents.error} glyph={Glyphs.ballotX} />
          <div className="whitespace-pre-wrap break-words" style={{ color: Accents.error }}>
            {e.text}
          </div>
        </div>
      </EntryShell>
    )
  }

  if (e.kind === 'status') {
    // /session-info (and other multiline status payloads): render as a
    // read-only monospace text block — the TUI pushes a plain text block
    // into the scrollback. Single-line status rows keep the centered dim
    // one-liner.
    if (e.text.includes('\n')) {
      return (
        <div
          data-entry-id={e.id}
          className="px-4 py-1.5 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words text-gn-muted"
        >
          {e.text}
        </div>
      )
    }
    return (
      <div className="px-4 py-1 text-center text-[11px] text-gn-muted" data-entry-id={e.id}>
        {e.text}
      </div>
    )
  }

  if (e.kind === 'plan') {
    // TUI todo pane: plan updates render as a structured todo list
    // (status mark + content), not the raw wire JSON.
    const items = planTodos(e.entries).items
    return (
      <EntryShell {...shell}>
        <div
          title="dblclick / enter · view"
          onDoubleClick={(ev) => {
            ev.stopPropagation()
            ev.preventDefault()
            onHeaderDblClick()
          }}
        >
          <div className="mb-1 text-[12px] font-bold" style={{ color: Accents.plan }}>
            Plan
          </div>
          {items.length === 0 ? (
            <div className="text-[11px] text-gn-muted">（空计划）</div>
          ) : (
            <div className="space-y-[2px]">
              {items.map((t, i) => (
                <div key={t.id ?? i} className="flex items-start gap-2 text-[12.5px] leading-snug">
                  <span className="mt-[1px] shrink-0 font-mono text-[11px]" aria-hidden>
                    <TodoMark status={t.status} />
                  </span>
                  <span
                    className={`min-w-0 flex-1 break-words ${
                      t.status === 'completed' || t.status === 'cancelled'
                        ? 'text-gn-muted'
                        : 'text-gn-fg'
                    }`}
                  >
                    {t.content}
                  </span>
                  {t.priority && (
                    <span className="shrink-0 text-[10px] text-gn-gutter">{t.priority}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </EntryShell>
    )
  }

  if (e.kind === 'subagent') {
    const label =
      e.status === 'started'
        ? 'Agent'
        : e.status === 'completed'
          ? 'Agent done'
          : e.status === 'cancelled'
            ? 'Agent cancelled'
            : 'Agent failed'
    return (
      <EntryShell {...shell}>
        <div
          className={`flex items-center gap-1.5 ${dense ? 'py-0' : 'py-[2px]'} text-[13px] leading-[1.35]`}
          title="dblclick / enter · view subagent"
          onDoubleClick={(ev) => {
            ev.stopPropagation()
            ev.preventDefault()
            onHeaderDblClick()
          }}
        >
          <Bullet color={bullet.color} animated={bullet.animated} />
          <span
            className="shrink-0 whitespace-nowrap font-bold"
            style={{ color: bullet.color }}
          >
            {label}
          </span>
          <span className="min-w-0 truncate font-mono text-[12.5px] text-gn-muted">
            {e.title}
          </span>
          {(e.persona || e.role || e.model) && (
            <span className="shrink-0 text-[11px] text-gn-gutter">
              {subagentMeta(e.persona, e.role, e.model)}
            </span>
          )}
          {e.detail && (
            <span className="text-[11px] text-gn-gutter truncate">{e.detail}</span>
          )}
          {e.running && e.subagentId && (
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation()
                void cancelSubagent(e.subagentId!)
              }}
              className="ml-auto shrink-0 rounded border border-gn-red/40 px-1.5 py-0.5 text-[10.5px] text-gn-red hover:bg-gn-diff-del-bg"
              title="x.ai/subagent/cancel"
            >
              cancel
            </button>
          )}
        </div>
      </EntryShell>
    )
  }

  if (e.kind === 'workflow') {
    const label =
      e.status === 'running'
        ? 'Workflow'
        : e.status === 'done'
          ? 'Workflow done'
          : e.status === 'failed'
            ? 'Workflow failed'
            : e.status === 'paused'
              ? 'Workflow paused'
              : 'Workflow cancelled'
    return (
      <EntryShell {...shell}>
        <div
          className={`flex items-center gap-1.5 ${dense ? 'py-0' : 'py-[2px]'} text-[13px] leading-[1.35]`}
          title="dblclick / enter · view workflow"
          onDoubleClick={(ev) => {
            ev.stopPropagation()
            ev.preventDefault()
            onHeaderDblClick()
          }}
        >
          <Bullet color={bullet.color} animated={bullet.animated} />
          <span
            className="shrink-0 whitespace-nowrap font-bold"
            style={{ color: bullet.color }}
          >
            {label}
          </span>
          <span className="min-w-0 truncate font-mono text-[12.5px] text-gn-muted">
            {e.title}
          </span>
        </div>
      </EntryShell>
    )
  }

  if (e.kind === 'bg_task') {
    // TUI: "Task started: {description|command}" — bold "Task", name is primary.
    // Double-click / Enter → block viewer with live stdout (TUI OpenBlockViewer).
    // Dense-aware inner padding: dense rows pack at 0 gap like tool rows
    // (EntryShell dense spacing), so consecutive task rows don't leave an
    // uneven 4px seam (visible in history pairs: started + completed).
    const verb =
      e.status === 'started'
        ? 'started'
        : e.status === 'completed'
          ? 'completed'
          : 'failed'
    return (
      <EntryShell {...shell}>
        <div
          className={`flex cursor-pointer items-center gap-1.5 ${dense ? 'py-0' : 'py-[2px]'} text-[13px] leading-[1.35]`}
          title="dblclick / enter · view stdout"
          onDoubleClick={(ev) => {
            ev.stopPropagation()
            ev.preventDefault()
            onHeaderDblClick()
          }}
        >
          <Bullet color={bullet.color} animated={bullet.animated} />
          <span
            className="shrink-0 whitespace-nowrap font-bold"
            style={{ color: bullet.color }}
          >
            Task
          </span>
          <span className="shrink-0 whitespace-nowrap text-gn-muted">{verb}:</span>
          <span className="min-w-0 truncate font-mono text-[12.5px] text-gn-fg">
            {e.title}
          </span>
          {e.detail && (
            <span className="text-[11px] text-gn-gutter truncate" title={e.detail}>
              {e.detail}
            </span>
          )}
          {e.running && e.taskId && (
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation()
                void killTask(e.taskId!)
              }}
              className="ml-auto shrink-0 rounded border border-gn-red/40 px-1.5 py-0.5 text-[10.5px] text-gn-red hover:bg-gn-diff-del-bg"
              title="x.ai/task/kill"
            >
              kill
            </button>
          )}
        </div>
      </EntryShell>
    )
  }

  if (e.kind === 'session_event') {
    // Recap events are two-part (TUI session_event recap_output): bold
    // "Recap" header + muted summary body, foldable via `open` (←/→).
    // Default expanded: the full summary renders with line breaks
    // (pre-wrap); collapsing is a keyboard-only action. Warning events
    // keep the warning text color AND get the warning accent rail
    // (resolveAccent sessionEvent.warning).
    return (
      <EntryShell {...shell}>
        <div className="flex items-start gap-1.5 py-[2px] text-[13px] leading-[1.35]">
          {(e.recap || e.streaming) && (
            <Bullet color={bullet.color} animated={bullet.animated} />
          )}
          {e.recap ? (
            <div className="min-w-0">
              {entryExpanded(e) && e.text ? (
                <>
                  <div
                    className="text-[12.5px] font-bold leading-[1.35]"
                    style={{ color: Accents.gray }}
                  >
                    Recap
                  </div>
                  <div className="mt-0.5 text-[12.5px] leading-[1.45] whitespace-pre-wrap break-words text-gn-muted">
                    {e.text}
                  </div>
                </>
              ) : (
                <div className="flex min-w-0 items-baseline gap-0 text-[12.5px] leading-[1.35]">
                  <span className="shrink-0 font-bold" style={{ color: Accents.gray }}>
                    Recap
                  </span>
                  {e.text.trim() ? (
                    <span className="min-w-0 truncate text-gn-muted">
                      {' '}
                      {e.text.split('\n')[0].trim()}
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          ) : (e as { ansi?: boolean }).ansi ? (
            // Raw command output (`!` shell exec) — render ANSI-colored.
            <span className="font-mono text-[12px] whitespace-pre-wrap break-words">
              <Ansi text={e.text} />
            </span>
          ) : (
            <span
              className="text-[12.5px] whitespace-pre-wrap break-words"
              style={{
                color: e.warning ? Accents.warning : Accents.gray,
              }}
            >
              {e.text}
            </span>
          )}
        </div>
      </EntryShell>
    )
  }

  if (e.kind === 'credit_limit') {
    return (
      <EntryShell {...shell}>
        <div className="text-[13px] font-bold py-1" style={{ color: Accents.warning }}>
          {e.text}
        </div>
      </EntryShell>
    )
  }

  if (e.kind === 'group_header') {
    const label =
      e.label ||
      (e.collapse
        ? `${e.count} tool calls & thoughts`
        : e.verbRun
          ? `${e.verbRun.verb || 'Ran'} ${e.count}`
          : `${e.count} more`)
    return (
      <EntryShell {...shell}>
        <div className="flex items-center gap-1.5 py-[2px] text-[13px] leading-[1.35]">
          <Bullet
            color={bullet.color}
            animated={bullet.animated}
            glyph={Glyphs.diamondDotted}
          />
          <span
            className="font-bold"
            style={{ color: 'var(--color-gn-gray)' }}
          >
            {label}
          </span>
        </div>
      </EntryShell>
    )
  }

  return null
}, entryViewEqual)

/** 显示行 key（实现移入 verbGroup.ts，主/迷你 scrollback 共用）。 */

function displayRowToEntry(row: DisplayRow): ScrollEntry {
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

/** "Agents" 与 "Herness" 两段字符画（空状态居中 logo）。figlet「lean」风格，
 *  纯 ASCII 字符（_ / \ |），各平台等宽字体里对齐稳定。构建时去掉每行尾随
 *  空格并把每行补齐到同一宽度（保持字母原有左对齐），由外层居中。 */
const buildBlock = (rows: string[]) => {
  const trimmed = rows.map((l) => l.trimEnd())
  const w = Math.max(...trimmed.map((l) => l.length))
  return trimmed.map((l) => l.padEnd(w)).join('\n')
}
const AGENTS_ART = buildBlock([
  '  _                    _       ',
  '  /_\\   __ _  ___ _ __ | |_ ___ ',
  ' //_\\\\ / _` |/ _ \\ \'_ \\| __/ __|',
  '/  _  \\ (_| |  __/ | | | |_\\__ \\',
  '\\_/ \\_/\\__, |\\___|_| |_|\\__|___/',
  '       |___/                     ',
])
const HERNESS_ART = buildBlock([
  '  /\\  /\\__ _ _ __ _ __   ___  ___ ___ ',
  ' / /_/ / _` | \'__| \'_ \\ / _ \\/ __/ __|',
  '/ __  / (_| | |  | | | |  __/\\__ \\__ \\',
  '\\/ /_/ \\__,_|_|  |_| |_|\\___||___/___/',
  '                                     ',
])

/** 空状态：无活动会话时的引导。居中显示 AGENTS 字符画，下方是「选择工作目录」
 *  入口（点开弹出 DirectoryPickerModal，底层复用 `!` shell 通道）。目录不选
 *  则留空用宿主默认目录；没有"开始"按钮——发送消息即等于开始新对话。 */
function EmptyStatePicker() {
  const emptyCwd = useChatStore((s) => s.emptyCwd)
  const setEmptyCwd = useChatStore((s) => s.setEmptyCwd)
  const [picking, setPicking] = useState(false)
  return (
    <div className="flex h-full min-h-32 flex-col items-center justify-center px-4 pt-8 min-[481px]:pt-20">
      <div className="flex w-full justify-center">
        <div className="flex flex-col items-center">
          <pre className="select-none whitespace-pre font-mono text-[9px] leading-[1.05] text-gn-fg min-[481px]:text-[14px]">
            {AGENTS_ART}
          </pre>
        </div>
      </div>
      <div className="flex w-full justify-center">
        <div className="flex flex-col items-center">
          <pre className="select-none whitespace-pre font-mono text-[9px] leading-[1.05] text-gn-fg min-[481px]:text-[14px]">
            {HERNESS_ART}
          </pre>
        </div>
      </div>
      <div className="mt-6 select-none text-[13px] font-normal tracking-wide text-gn-muted/80">
        for Grok Build <span className="text-gn-gutter/60">1.0.0</span>
      </div>
      <div className="mt-6 text-center">
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="inline-flex items-center gap-1.5 text-[12px] text-gn-muted transition-colors hover:text-gn-fg"
          title="选择新会话的工作目录"
        >
          <svg
            viewBox="0 0 16 16"
            className="h-3.5 w-3.5 shrink-0"
            style={{ fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }}
            aria-hidden
          >
            <path d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3l1.5 2H13A1.5 1.5 0 0 1 14.5 6v6A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V4Z" />
          </svg>
          选择工作目录
        </button>
        {emptyCwd?.trim() ? (
          <div
            className="mx-auto mt-1.5 max-w-[300px] truncate font-mono text-[11px] text-gn-cyan"
            title={emptyCwd}
          >
            {emptyCwd}
          </div>
        ) : (
          <div className="mt-1.5 text-[11px] text-gn-gutter">
            发送消息即可从此工作目录开始新对话
          </div>
        )}
      </div>
      <DirectoryPickerModal
        open={picking}
        initial={emptyCwd}
        onClose={() => setPicking(false)}
        onPick={setEmptyCwd}
      />
    </div>
  )
}

export function Scrollback({ onOpenMcp }: { onOpenMcp?: () => void }) {
  const entries = useChatStore((s) => s.entries)
  // No active session (deleted the current one / fresh boot): show the
  // empty-state hint instead of a blank scrollback.
  const sessionId = useChatStore((s) => s.sessionId)
  // liveStream is NOT selected here — text growth must not re-render the
  // whole tree. Streaming EntryView rows subscribe themselves; auto-follow
  // uses useChatStore.subscribe (see effect below).
  const selectedId = useChatStore((s) => s.selectedId)
  const focusMode = useChatStore((s) => s.focusMode)
  const pending = useChatStore((s) => s.pending)
  const expandedGroups = useChatStore((s) => s.expandedGroups)
  const historyLoadedAt = useChatStore((s) => s.historyLoadedAt)
  const historyHasMore = useChatStore((s) => s.historyHasMore)
  const historyLoading = useChatStore((s) => s.historyLoading)
  const historyLoadingMore = useChatStore((s) => s.historyLoadingMore)
  const historyLoadError = useChatStore((s) => s.historyLoadError)
  const historyPrependedAt = useChatStore((s) => s.historyPrependedAt)
  const historyAnchorId = useChatStore((s) => s.historyAnchorId)
  const toggleGroupExpansion = useChatStore((s) => s.toggleGroupExpansion)
  const loadMoreHistory = useChatStore((s) => s.loadMoreHistory)
  const bottomRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  /** Fade wrapper around history rows — ResizeObserver target for stick-to-bottom. */
  const contentRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  // Last scrollTop seen, to tell "user scrolled UP" (unfollow, no matter
  // how small the distance — a sub-80px scroll must not keep following)
  // from "scrolled to the bottom" (re-follow).
  const lastScrollTopRef = useRef(0)
  /**
   * Prepend / 扩窗前的滚动快照。先 height-delta 稳住视口，再按新一轮
   * 是否装得进视口决定要不要对齐到新 user（见 settleFitOrKeep）。
   */
  const scrollSnapshotRef = useRef<{
    scrollHeight: number
    scrollTop: number
  } | null>(null)
  // Workspace bar 高度：ref 须在 align/settle 回调之前声明（避免 TDZ）。
  // state 仍用于 sticky top 样式；量高优先读 DOM。
  const [wsBarH, setWsBarH] = useState(37)
  const wsBarElRef = useRef<HTMLDivElement | null>(null)
  const wsBarRoRef = useRef<ResizeObserver | null>(null)
  /** 拍摄 prepend 前快照，并关掉 stick-to-bottom（避免 pinStreamScroll /
   *  ResizeObserver 在 entries 增长后把视口拽回底部）。 */
  const captureScrollSnapshot = useCallback(() => {
    const box = boxRef.current
    if (!box) return
    followRef.current = false
    scrollSnapshotRef.current = {
      scrollHeight: box.scrollHeight,
      scrollTop: box.scrollTop,
    }
  }, [])
  /** 把条目顶对齐到 workspace bar 下沿（阅读起点）。 */
  const alignEntryUnderBar = useCallback((box: HTMLElement, el: HTMLElement) => {
    const boxTop = box.getBoundingClientRect().top
    const barH = wsBarElRef.current?.getBoundingClientRect().height ?? 0
    box.scrollTop += el.getBoundingClientRect().top - boxTop - barH
    lastScrollTopRef.current = box.scrollTop
  }, [])
  /**
   * 扩窗后待处理的「新一轮」user。anchorId = 旧内容起点（新一轮终点），
   * 用于量高判断是否装进视口。
   */
  const pendingRevealRef = useRef<{
    targetId: string
    anchorId?: string | null
  } | null>(null)
  /**
   * height-delta 保持视口（新内容在上方时不跳）。快照缺失时尝试
   * anchor 顶对齐。
   */
  const restoreScrollAfterPrepend = useCallback((anchorId?: string | null) => {
    const box = boxRef.current
    if (!box) return false
    followRef.current = false
    const snap = scrollSnapshotRef.current
    scrollSnapshotRef.current = null
    if (snap) {
      box.scrollTop = snap.scrollTop + (box.scrollHeight - snap.scrollHeight)
      lastScrollTopRef.current = box.scrollTop
      return true
    }
    if (anchorId) {
      const anchor = box.querySelector(`[data-entry-id="${anchorId}"]`)
      if (anchor instanceof HTMLElement) {
        const boxTop = box.getBoundingClientRect().top
        box.scrollTop += anchor.getBoundingClientRect().top - boxTop
        lastScrollTopRef.current = box.scrollTop
        return true
      }
    }
    return false
  }, [])
  /**
   * 新一轮装进视口 → 顶对齐完整展示；超出视口 → 只 height-delta，不滚动不跳。
   * 必须在目标 DOM 已挂载后调用。
   */
  const settleFitOrKeep = useCallback(
    (
      box: HTMLElement,
      targetEl: HTMLElement,
      anchorId?: string | null,
    ): 'revealed' | 'kept' => {
      followRef.current = false
      // 先 height-delta 到「无跳跃」基线，再量高（量高依赖稳定后的布局）。
      const snap = scrollSnapshotRef.current
      scrollSnapshotRef.current = null
      if (snap) {
        box.scrollTop = snap.scrollTop + (box.scrollHeight - snap.scrollHeight)
        lastScrollTopRef.current = box.scrollTop
      }

      const barH =
        wsBarElRef.current?.getBoundingClientRect().height ?? wsBarH
      const available = Math.max(0, box.clientHeight - barH)
      const boxTop = box.getBoundingClientRect().top
      const yOf = (el: HTMLElement) =>
        el.getBoundingClientRect().top - boxTop + box.scrollTop
      const startY = yOf(targetEl)
      let endY = startY + targetEl.getBoundingClientRect().height
      if (anchorId) {
        const endEl = box.querySelector(`[data-entry-id="${anchorId}"]`)
        if (endEl instanceof HTMLElement) endY = yOf(endEl)
      }
      const turnHeight = Math.max(0, endY - startY)
      // 1px 容差：亚像素/边框不致误判为溢出。
      if (turnHeight <= available + 1) {
        alignEntryUnderBar(box, targetEl)
        return 'revealed'
      }
      // 超出：保持 height-delta 后的位置，视口不跳。
      return 'kept'
    },
    [alignEntryUnderBar, wsBarH],
  )
  // ── Scroll-up paging gates (see maybeLoadOlderHistory) ──────────
  const topPageArmedRef = useRef(true)
  const topPageCooldownRef = useRef(0)
  // Touch gesture tracking (swipe down = scroll up toward older history).
  const touchStartYRef = useRef<number | null>(null)
  const touchYRef = useRef<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // ── Sticky workspace-bar height (state/ref declared above) ─────
  // The WorkspaceBar (sticky top-0 inside this scroll container) is 37px
  // when idle but grows when the tasks bar is open / rows wrap on mobile.
  // The pinned user-prompt header sticks at `top: wsBarH` so it always
  // lands flush below the bar (a hardcoded 37px left it sliding under the
  // taller bar, covered by its z-30 background).
  // Callback ref: attaches the observer on mount (and re-attaches if the
  // element is ever remounted), disconnects on unmount — no effect-timing
  // dependency.
  const workspaceRef = useCallback((el: HTMLDivElement | null) => {
    if (wsBarElRef.current === el) return
    wsBarElRef.current = el
    wsBarRoRef.current?.disconnect()
    wsBarRoRef.current = null
    if (!el) return
    const report = (h: number) =>
      setWsBarH((prev) => (Math.abs(prev - h) < 0.5 ? prev : h))
    // Sync first measurement so the very first paint is already correct
    // (e.g. the tasks bar is open when the session loads).
    report(el.getBoundingClientRect().height)
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height
      if (h != null) report(h)
    })
    wsBarRoRef.current = ro
    ro.observe(el)
  }, [])
  // History-switch loading indicator: same braille spinner as the
  // composer turn-status line (TUI glyphs.rs), ~7.5fps. The overlay
  // stays mounted permanently (pointer-events-none); opacity is toggled
  // by class so the 300 ms transition plays for BOTH the fade-in and
  // the fade-out — a conditionally mounted element would never paint
  // its starting opacity before the first frame, so the fade would
  // be skipped.
  const loadingVisible = historyLoading && entries.length === 0
  // 加载失败：historyLoading 归 false 但未载入任何内容（continueSession
  // / loadHistory 失败且 timeline 为空）→ 同一覆盖层从"加载会话…"转为
  // "加载失败 + 原因"，点击列表中的会话行即重试（行保持选中态）。
  const loadFailedVisible =
    !historyLoading && historyLoadError != null && entries.length === 0
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  // Spin for initial session load overlay and for "加载上一轮…" on sticky.
  const spinnerActive = loadingVisible || historyLoadingMore
  useEffect(() => {
    if (!spinnerActive) return
    const t = window.setInterval(
      () => setSpinnerFrame((v) => (v + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    )
    return () => window.clearInterval(t)
  }, [spinnerActive])
  // Content fade-in after a history switch: the new entries render in
  // the same commit that bumps historyLoadedAt. A useLayoutEffect drops
  // the column to opacity 0 BEFORE the browser paints (full-opacity
  // content is never shown, so no 100→0 transition flash), then a single
  // rAF restores it and the 300 ms transition plays a real fade-in —
  // cross-fading with the loading overlay's fade-out instead of a pop.
  const [contentVisible, setContentVisible] = useState(true)
  useLayoutEffect(() => {
    if (historyLoadedAt == null) return
    setContentVisible(false)
    const raf = requestAnimationFrame(() => setContentVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [historyLoadedAt])

  // ── TUI sticky prompt header (scrollback/sticky.rs) ──────────────
  // 钉选 = 最后一条 top < scrollTop 的挂载 user（y_virtual < scroll_offset）。
  // 同 TUI compute_sticky_layout：scrollTop===0 不钉；完全划出后仍钉
  // 该条（读它下面的 assistant），直到下一条 user 的 top 越过视口顶才切换。
  // 切勿「完全划出 → 推进上一条」——会在长 assistant 中部把 sticky 钉错成
  // 更早的 prompt，并在上滑时误触发 loadMoreHistory。
  //
  // FE 是 absolute 叠层（非 TUI 渐进折叠 + content 偏移），额外两条：
  // - 下一条 user 顶进 sticky 条区域时立刻改钉为底下那条，避免旧 sticky 盖住它。
  // - 候选 user 部分划出但仍伸进 bar 下内容区时不钉，避免与 in-flow 正文叠字。
  //
  // 首页只拉最后 1 轮；上滑到顶 / 按钮 loadMoreHistory 加载上一轮。
  // DOM 全量挂载 entries（无渲染窗口上限）。
  //
  // Anchor for height-delta restore when host prepends tool-only pages.
  const [expandAnchorId, setExpandAnchorId] = useState<string | null>(null)
  useEffect(() => {
    setExpandAnchorId(null)
  }, [historyLoadedAt])
  const renderEntries = entries
  /**
   * 宿主加载上一轮：新内容 prepend 到 anchor 之前。
   *
   * - 目标 = prepend 段**第一条** user（新一轮开头；勿用 last-before-anchor）
   * - 新一轮高度 ≤ 视口 → 顶对齐完整展示
   * - 超出视口 → 只 height-delta，不滚动不跳
   * - 纯工具续翻页（无 user）→ 只 height-delta
   */
  const revealPrependedTurn = useCallback(
    (anchorId?: string | null): 'revealed' | 'pending' | 'kept' | 'noop' => {
      const box = boxRef.current
      if (!box) return 'noop'
      followRef.current = false

      // prepend 段 = entries[0, anchorIdx)；新一轮 user = 该段第一条 user。
      let targetId: string | null = null
      if (anchorId) {
        const anchorIdx = entries.findIndex((e) => e.id === anchorId)
        const end = anchorIdx >= 0 ? anchorIdx : entries.length
        for (let i = 0; i < end; i++) {
          if (entries[i].kind === 'user') {
            targetId = entries[i].id
            break
          }
        }
        // 本页无 user（工具流续翻）：只 height-delta。
        if (!targetId) {
          restoreScrollAfterPrepend(anchorId)
          pendingRevealRef.current = null
          return 'kept'
        }
      } else {
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].kind === 'user') {
            targetId = entries[i].id
            break
          }
        }
        targetId = targetId ?? entries[0]?.id ?? null
      }

      if (!targetId) {
        restoreScrollAfterPrepend(anchorId)
        return 'kept'
      }

      const el = box.querySelector(`[data-entry-id="${targetId}"]`)
      if (el instanceof HTMLElement) {
        pendingRevealRef.current = null
        return settleFitOrKeep(box, el, anchorId)
      }
      // DOM 未齐：保留 snap，下一帧再 settle。
      pendingRevealRef.current = { targetId, anchorId }
      return 'pending'
    },
    [entries, restoreScrollAfterPrepend, settleFitOrKeep],
  )
  const userById = useMemo(() => {
    const m = new Map<string, ScrollEntry>()
    for (const e of renderEntries) if (e.kind === 'user') m.set(e.id, e)
    return m
  }, [renderEntries])
  const userEls = useRef<Map<string, HTMLElement>>(new Map())
  // 当前 sticky 钉选：entry 为渲染内容。
  const [pinned, setPinned] = useState<{ entry: ScrollEntry; store: boolean } | null>(null)
  // 目录 rail active tick — 独立于 sticky 阈值（可读区顶 = bar 下沿）。
  const [navActiveId, setNavActiveId] = useState<string | null>(null)
  /** Rendered sticky band (for push/handoff height). */
  const stickyBandElRef = useRef<HTMLDivElement | null>(null)

  /**
   * TUI sticky.rs pin + push handoff, adapted for FE absolute overlay:
   *
   * 1. Candidate = last user with top < scrollTop (y_virtual < scroll_offset).
   * 2. If the next user has entered the sticky visual band, hand off immediately
   *    — sticky updates to that lower usermessage so the old pin never covers it.
   * 3. If the candidate is partially scrolled past (top < scrollTop) but its
   *    body still extends into the content area, clear pin — FE overlays instead
   *    of TUI gradual-collapse, so partial scroll would double the same prompt.
   *    Early handoff (top still ≥ scrollTop) is kept: sticky acts as the
   *    section header for the approaching message.
   */
  const updatePinned = useCallback(() => {
    const box = boxRef.current
    const els = userEls.current
    if (!box || els.size === 0) {
      setPinned((prev) => (prev == null ? prev : null))
      return
    }
    // TUI: scroll_offset == 0 → no pin.
    const scrollTop = box.scrollTop
    if (scrollTop <= 0) {
      setPinned((prev) => (prev == null ? prev : null))
      return
    }
    const boxTop = box.getBoundingClientRect().top
    const barH =
      wsBarElRef.current?.getBoundingClientRect().height ?? wsBarH
    // Collapsed sticky ≈ py-11×2 + 3 lines @ 13.5/1.35. Prefer live measure.
    const stickyH =
      stickyBandElRef.current?.offsetHeight ||
      11 * 2 + Math.ceil(13.5 * 1.35 * USER_COLLAPSED_MAX_LINES)

    type UserPos = { id: string; top: number; bottom: number }
    const list: UserPos[] = []
    for (const [id, el] of els) {
      const top = el.getBoundingClientRect().top - boxTop + scrollTop
      list.push({ id, top, bottom: top + el.offsetHeight })
    }

    // 1) Last user with y_virtual < scroll_offset (document order).
    let idx = -1
    for (let i = 0; i < list.length; i++) {
      if (list[i].top < scrollTop) idx = i
      else break
    }

    // 2) Push handoff: while a pin is active, if the next user top enters the
    //    sticky band → switch pin to that lower message immediately.
    //    (TUI sticky.rs next_naive_row <= header_with_gap; FE can't clip-push
    //    so we switch identity rather than paint old sticky over it.)
    if (idx >= 0 && idx + 1 < list.length) {
      const nextUser = list[idx + 1]
      const nextScreenTop = nextUser.top - scrollTop
      // Sticky paints in box viewport y ∈ [barH, barH + stickyH].
      if (nextScreenTop < barH + stickyH) {
        idx = idx + 1
      }
    }

    // 3) Self-overlap only when partially past: top already above viewport
    //    but body still in the content area under the band.
    if (idx >= 0) {
      const cur = list[idx]
      if (cur.top < scrollTop && cur.bottom > scrollTop + barH) {
        idx = -1
      }
    }

    const pinnedId = idx >= 0 ? list[idx].id : null
    const entry = pinnedId != null ? userById.get(pinnedId) : undefined
    const next = entry != null ? { entry, store: false as const } : null
    setPinned((prev) =>
      prev?.entry?.id === next?.entry?.id && prev?.store === next?.store ? prev : next,
    )
  }, [userById, wsBarH])

  /**
   * 目录 active：视口可读顶（workspace bar 下沿）附近最近 user。
   * 与 sticky 分离——sticky 保持 TUI top < scrollTop，这里不改钉选语义。
   */
  const updateNavActive = useCallback(() => {
    const box = boxRef.current
    const els = userEls.current
    if (!box || els.size === 0) {
      setNavActiveId((prev) => (prev == null ? prev : null))
      return
    }
    const scrollTop = box.scrollTop
    const boxTop = box.getBoundingClientRect().top
    const barH =
      wsBarElRef.current?.getBoundingClientRect().height ?? wsBarH
    const line = scrollTop + barH
    let lastAtOrAbove: string | null = null
    let firstId: string | null = null
    let lastId: string | null = null
    for (const [id, el] of els) {
      if (firstId == null) firstId = id
      lastId = id
      const top = el.getBoundingClientRect().top - boxTop + scrollTop
      if (top <= line) lastAtOrAbove = id
    }
    const dist = box.scrollHeight - box.scrollTop - box.clientHeight
    const next = dist < 4 ? lastId : (lastAtOrAbove ?? firstId)
    setNavActiveId((prev) => (prev === next ? prev : next))
  }, [wsBarH])

  // Cache user entry elements (rebuilt on entry changes; positions shift on
  // history prepend / expand-collapse / resize, so recompute the pin then).
  // useLayoutEffect: settle scroll FIRST so pin measurement sees the final
  // viewport.
  //
  // Host path (historyPrependedAt): 扩窗 + fit-or-keep（短轮展示 / 长轮不跳）。
  // Local path (expandAnchorId): 强制 height-delta（本地溢出分支）。
  // pendingRevealRef: 扩窗后 DOM 齐了再 settleFitOrKeep。
  // historyLoadedAt: 贴底后立刻量钉选（与 scroll 同帧，避免 rAF 读到旧 scrollTop）。
  const handledPrependedAtRef = useRef(0)
  const handledLoadedAtRef = useRef(0)
  useLayoutEffect(() => {
    let settled = false
    if (
      historyPrependedAt &&
      handledPrependedAtRef.current !== historyPrependedAt
    ) {
      handledPrependedAtRef.current = historyPrependedAt
      settled = true
      revealPrependedTurn(historyAnchorId)
    } else if (expandAnchorId) {
      settled = true
      restoreScrollAfterPrepend(expandAnchorId)
      setExpandAnchorId(null)
    } else if (pendingRevealRef.current) {
      const box = boxRef.current
      const pending = pendingRevealRef.current
      const el = box?.querySelector(`[data-entry-id="${pending.targetId}"]`)
      if (box && el instanceof HTMLElement) {
        pendingRevealRef.current = null
        settleFitOrKeep(box, el, pending.anchorId)
        settled = true
      }
    }
    // Session/history switch: pin to bottom BEFORE measuring sticky so the
    // first paint already has the correct pin (long last-turn markdown).
    if (historyLoadedAt && handledLoadedAtRef.current !== historyLoadedAt) {
      handledLoadedAtRef.current = historyLoadedAt
      followRef.current = true
      const box = boxRef.current
      if (box) {
        box.scrollTop = box.scrollHeight
        lastScrollTopRef.current = box.scrollTop
      }
    }
    if (settled) {
      // Gate paging before updatePinned: reveal lands near the top and
      // would otherwise immediately re-fire maybeLoadOlderHistory.
      const coolUntil = Date.now() + TOP_PAGE_COOLDOWN_MS
      topPageCooldownRef.current = coolUntil
      topPageArmedRef.current = false
    }
    const box = boxRef.current
    const map = new Map<string, HTMLElement>()
    if (box) {
      for (const id of userById.keys()) {
        const el = box.querySelector(`[data-entry-id="${id}"]`)
        if (el instanceof HTMLElement) map.set(id, el)
      }
    }
    userEls.current = map
    updatePinned()
    updateNavActive()
  }, [
    userById,
    updatePinned,
    updateNavActive,
    historyPrependedAt,
    historyAnchorId,
    historyLoadedAt,
    expandAnchorId,
    restoreScrollAfterPrepend,
    revealPrependedTurn,
    settleFitOrKeep,
    alignEntryUnderBar,
  ])

  useEffect(() => {
    const onResize = () => {
      updatePinned()
      updateNavActive()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [updatePinned, updateNavActive])

  // rAF-throttled pinned-header recompute: onScroll fires per frame during
  // streaming, and getBoundingClientRect per user entry forces layout.
  // Directory active reuses the same rAF; sticky threshold stays in updatePinned.
  const pinnedRaf = useRef<number | null>(null)
  const scheduleUpdatePinned = useCallback(() => {
    if (pinnedRaf.current != null) return
    pinnedRaf.current = requestAnimationFrame(() => {
      pinnedRaf.current = null
      updatePinned()
      updateNavActive()
    })
  }, [updatePinned, updateNavActive])

  useEffect(
    () => () => {
      if (pinnedRaf.current != null) cancelAnimationFrame(pinnedRaf.current)
    },
    [],
  )

  // store 为 true：未挂载，文案来自 store（工具空隙回退）；false：已挂载行。
  const pinnedUser = pinned?.entry ?? null
  const pinnedStore = pinned?.store ?? false

  /**
   * 点击 sticky 钉住的 user：滚到该条消息开头（顶对齐 workspace bar 下沿），
   * 从这条 prompt 起重新阅读。未挂载时先扩 render 窗口再滚。
   * 目录 rail 跳转复用同一路径；jump 已对齐时跳过 selectedId→scrollIntoView。
   */
  const [scrollToEntryId, setScrollToEntryId] = useState<string | null>(null)
  /** 目录 jump 已对齐过视口：跳过随后的 selectedId→scrollIntoView。 */
  const skipSelectScrollRef = useRef(false)
  const jumpToUserEntry = useCallback(
    (id: string) => {
      const box = boxRef.current
      if (!box) return
      followRef.current = false
      const align = (el: HTMLElement) => {
        const boxTop = box.getBoundingClientRect().top
        const barH =
          wsBarElRef.current?.getBoundingClientRect().height ?? wsBarH
        box.scrollTop +=
          el.getBoundingClientRect().top - boxTop - barH
        lastScrollTopRef.current = box.scrollTop
      }
      const el = box.querySelector(`[data-entry-id="${id}"]`)
      if (el instanceof HTMLElement) {
        align(el)
        scheduleUpdatePinned()
        return
      }
      // 全量 DOM 后仍找不到则等下一帧（刚 prepend 的极短窗口）。
      setScrollToEntryId(id)
    },
    [wsBarH, scheduleUpdatePinned],
  )
  useLayoutEffect(() => {
    if (!scrollToEntryId) return
    const box = boxRef.current
    const el = box?.querySelector(`[data-entry-id="${scrollToEntryId}"]`)
    if (box && el instanceof HTMLElement) {
      const boxTop = box.getBoundingClientRect().top
      const barH =
        wsBarElRef.current?.getBoundingClientRect().height ?? wsBarH
      box.scrollTop +=
        el.getBoundingClientRect().top - boxTop - barH
      lastScrollTopRef.current = box.scrollTop
    }
    setScrollToEntryId(null)
    updatePinned()
    updateNavActive()
  }, [scrollToEntryId, updatePinned, updateNavActive, wsBarH])

  // ── 分组缓存（groupingSignature）────────────────────────────
  // 流式 flush 只改文本、不改分组相关字段：签名命中时跳过全量 scanGroups，
  // span 与 header 行（含 label）直接复用——每帧主成本从 O(n) 分组扫描
  // 降到 O(n) 签名比对。签名/展开集变化（收口、工具状态、折叠切换、新
  // 条目…）时全量重扫并重建缓存。流式思考条目的 id 单独跟踪（合并滚动
  // 固定需要把它指给父组件的 streamBodyRef）。
  const spansCacheRef = useRef<{
    sig: string
    expanded: ReadonlySet<string>
    spans: GroupSpan[]
    headers: Map<GroupSpan, DisplayRow>
  } | null>(null)
  const streamingThoughtId = useMemo(() => {
    for (let i = renderEntries.length - 1; i >= 0; i--) {
      const e = renderEntries[i]
      if (e.kind === 'thought' && e.streaming) return e.id
    }
    return null
  }, [renderEntries])
  // 流式滚动固定（合并 effect）：流式思考 body 由 EntryView 注册到这里。
  const streamBodyRef = useRef<HTMLDivElement | null>(null)

  const { rows: displayRows, spans } = useMemo(() => {
    const sig = groupingSignature(renderEntries)
    const c = spansCacheRef.current
    if (c && c.expanded === expandedGroups && sig === c.sig) {
      // 分组结构未变（纯流式文本增长）：span 与 header 行（含 label）
      // 复用，跳过 scanGroups 与 label 重算。
      return {
        rows: projectDisplayRows(renderEntries, c.spans, true, c.headers),
        spans: c.spans,
      }
    }
    const spans = scanGroups(renderEntries, expandedGroups)
    const headers = new Map<GroupSpan, DisplayRow>()
    const rows = projectDisplayRows(renderEntries, spans, true, headers)
    spansCacheRef.current = { sig, expanded: expandedGroups, spans, headers }
    return { rows, spans }
  }, [renderEntries, expandedGroups])

  // Pending permission freezes running waves (is_pending_user_input)
  const pendingFreeze = pending.length > 0

  // Clock for finish-flash window (~50ms) while any entry is flashing.
  // Precise scheduling: one setTimeout at the earliest flash expiry instead
  // of a 50ms interval ticking the whole list — a flash window costs a
  // single re-render, not 20 per second.
  useEffect(() => {
    const now = Date.now()
    let next: number | null = null
    for (const e of entries) {
      if (e.kind !== 'tool' && e.kind !== 'thought') continue
      const fa = e.finishedAt
      if (fa != null && now - fa < FINISH_FLASH_MS) {
        const due = fa + FINISH_FLASH_MS
        if (next == null || due < next) next = due
      }
    }
    if (next == null) return
    const id = window.setTimeout(() => {
      setNow(Date.now())
    }, Math.max(1, next - now + 1))
    return () => window.clearTimeout(id)
  }, [entries])

  // Auto-follow only when near bottom (every mounted row is at real
  // height — full entry list mounted, no content-visibility
  // placeholders — so a direct scrollTop write lands exactly at the tail).
  //
  // Prefer `box.scrollTop = scrollHeight` over scrollIntoView: the latter
  // can race nested sticky headers / incomplete layout and is noisier with
  // intermediate scroll events. Sync lastScrollTopRef so onScroll does not
  // treat a programmatic jump as a user gesture.
  //
  // Entries / row-count changes re-run via React effect. liveStream text
  // growth must NOT re-render Scrollback — subscribe outside React and
  // pin the bottom / thought body from refs only. Async height growth
  // (sticky pin mount, mermaid, images, long markdown layout) is covered
  // by the content ResizeObserver below while follow is armed.
  //
  // Always schedule sticky recompute after programmatic scroll: browsers
  // often suppress the `scroll` event when scrollTop is written from a
  // ResizeObserver / layout-effect path. After history replay the last
  // assistant can grow for several frames (markdown / images / mermaid);
  // stick-to-bottom would re-pin the tail while sticky still thought the
  // user prompt was on-screen (first-frame short height → no pin).
  const scrollToBottom = useCallback(
    (force = false) => {
      const box = boxRef.current
      if (!box) return
      if (!force && !followRef.current) return
      box.scrollTop = box.scrollHeight
      lastScrollTopRef.current = box.scrollTop
      scheduleUpdatePinned()
    },
    [scheduleUpdatePinned],
  )
  const pinStreamScroll = useCallback(() => {
    scrollToBottom(false)
    const bodyEl = streamBodyRef.current
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight
  }, [scrollToBottom])
  // Content height changes:
  // - while following → re-pin bottom (session-switch after historyLoadedAt,
  //   late markdown/mermaid/image paint, streaming growth without entry churn)
  // - always → recompute sticky pin (RO scrollTop writes may not fire onScroll;
  //   late growth past the user row must flip pinned without a user gesture)
  // Sticky overlay is out-of-flow so it does not feed this observer
  // (no pin↔height loop).
  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (followRef.current) scrollToBottom(true)
      else scheduleUpdatePinned()
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [scrollToBottom, scheduleUpdatePinned])
  // 发送消息（新的 user 行落到末尾，含 `!` 直执行）→ 视口跳回最新位置。
  // TUI [ui] page_flip_on_send（默认 true）：把刚发的 prompt 钉到视口
  // 顶部，响应从新的一页开始；false 时直接回到底部。只看 id 变化，历史
  // prepend / 流式 flush 不触发；回放追加的 user 行（id ≠ lastSentPromptId）
  // 走普通回底。
  const lastSentPromptId = useChatStore((s) => s.lastSentPromptId)
  const lastUserEntryIdRef = useRef<string | null>(null)
  useEffect(() => {
    const last = entries[entries.length - 1]
    if (last?.kind !== 'user') return
    if (lastUserEntryIdRef.current === last.id) return
    lastUserEntryIdRef.current = last.id
    followRef.current = true
    if (last.id === lastSentPromptId && uiBool('page_flip_on_send', true)) {
      const box = boxRef.current
      const el = box?.querySelector(
        `[data-entry-id="${last.id}"]`,
      ) as HTMLElement | null
      if (box && el) {
        // Prompt top aligns with the viewport top; follow stays armed so
        // streaming re-pins the bottom as content grows past the page.
        box.scrollTop +=
          el.getBoundingClientRect().top - box.getBoundingClientRect().top
        lastScrollTopRef.current = box.scrollTop
        return
      }
    }
    scrollToBottom(true)
  }, [entries, scrollToBottom, lastSentPromptId])
  useEffect(() => {
    pinStreamScroll()
  }, [entries, displayRows.length, pinStreamScroll])
  useEffect(() => {
    return useChatStore.subscribe((s, prev) => {
      if (s.liveStream?.text === prev.liveStream?.text) return
      pinStreamScroll()
    })
  }, [pinStreamScroll])

  // History load scroll-to-bottom + sticky measure lives in the userEls
  // layout effect above (must settle scroll BEFORE pin measurement; also
  // consumes historyLoadedAt so prepend/flush cannot re-yank to tail).

  // 宿主分页开始（含自动续翻中间页）：DOM 仍是旧内容时再拍一次快照。
  // 覆盖 sticky / 按钮 / 滚轮 漏拍，以及 loadMoreHistory 链式续翻
  // （中间页没有 maybeLoadOlderHistory 入口）。
  const prevLoadingMoreForSnapRef = useRef(historyLoadingMore)
  useLayoutEffect(() => {
    const was = prevLoadingMoreForSnapRef.current
    prevLoadingMoreForSnapRef.current = historyLoadingMore
    if (!was && historyLoadingMore) {
      // Only capture when we don't already have a gesture-time snapshot
      // (prefer the earlier, pre-any-loading-UI measurement).
      if (!scrollSnapshotRef.current) captureScrollSnapshot()
      else followRef.current = false
    }
  }, [historyLoadingMore, captureScrollSnapshot])

  // Re-arm after ANY paging attempt finishes (success or failure): a
  // failed fetch can be retried with the next gesture; a successful one
  // is gated by the prepend cooldown above.
  const prevLoadingMoreRef = useRef(historyLoadingMore)
  useEffect(() => {
    if (prevLoadingMoreRef.current && !historyLoadingMore) {
      topPageArmedRef.current = true
    }
    prevLoadingMoreRef.current = historyLoadingMore
  }, [historyLoadingMore])

  /**
   * Scroll-up paging gate: one page per visit to the top region.
   *
   * Gesture path (`explicit=false`): armed once per visit to the top;
   * re-armed when the user scrolls away (scrollTop≥80) or a host fetch
   * finishes. Cooldown blocks the post-prepend restore scroll from
   * chaining pages.
   *
   * Explicit path (`explicit=true`, button / sticky click): bypasses both
   * armed + cooldown. Critical when many tools are verb-collapsed and the
   * list barely (or doesn't) overflow — a prior gesture can leave
   * topPageArmed=false with no way to re-arm via scrollTop≥80, so click
   * and further wheel-up would silently no-op.
   *
   * Only disarm while a real host fetch is in flight. No-op returns
   * (nothing to load / already loading) keep or restore armed so the
   * next gesture still works.
   */
  const maybeLoadOlderHistory = useCallback((explicit = false) => {
    const box = boxRef.current
    if (!box) return
    if (!explicit) {
      if (!topPageArmedRef.current) return
      if (Date.now() < topPageCooldownRef.current) return
    }
    // 仅宿主历史分页（DOM 已全量挂载，无本地扩窗）。
    if (!historyHasMore || historyLoadingMore) {
      // Nothing started — do not leave the gate latched shut (especially
      // when content fits the viewport and scrollTop never reaches 80).
      topPageArmedRef.current = true
      return
    }
    // Host fetch: disarm only while a real request is in flight.
    // loadMoreHistory sets historyLoadingMore synchronously before its
    // first await; if it early-returns (race / missing session meta),
    // re-arm immediately — otherwise collapsed short lists (scrollTop
    // never reaches 80) stay permanently unable to page.
    topPageArmedRef.current = false
    captureScrollSnapshot()
    // Anchor = store head before prepend（见 sticky 触发器同款注释）。
    const storeHeadId = entries[0]?.id
    void loadMoreHistory(storeHeadId)
    if (!useChatStore.getState().historyLoadingMore) {
      topPageArmedRef.current = true
    }
  }, [
    historyHasMore,
    historyLoadingMore,
    loadMoreHistory,
    entries,
    captureScrollSnapshot,
  ])

  // Scroll selected into view — only when selection / focus changes.
  // Do NOT depend on displayRows: prepend would re-yank to a stale
  // selectedId while the user is paging older turns.
  useEffect(() => {
    if (!selectedId || focusMode !== 'scrollback') return
    if (skipSelectScrollRef.current) {
      skipSelectScrollRef.current = false
      return
    }
    const el = boxRef.current?.querySelector(`[data-entry-id="${selectedId}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId, focusMode])

  // User-message directory rail (TUI timeline). Active tick is independent
  // of sticky pin (updateNavActive); sticky keeps HEAD top < scrollTop.
  const userNavItems = useMemo((): UserMessageNavItem[] => {
    const out: UserMessageNavItem[] = []
    let turnIdx = 0
    for (const e of entries) {
      if (e.kind !== 'user') continue
      out.push({
        id: e.id,
        preview: userMessagePreview(e.text),
        turnIdx: turnIdx++,
      })
    }
    return out
  }, [entries])
  const selectEntry = useChatStore((s) => s.selectEntry)
  const onUserNavJump = useCallback(
    (id: string) => {
      // jump already aligns under the bar; skip the selection scroll effect.
      skipSelectScrollRef.current = true
      selectEntry(id)
      jumpToUserEntry(id)
    },
    [selectEntry, jumpToUserEntry],
  )

  return (
    // Outer relative shell so the user-message rail can float on the right
    // without scrolling with content. Inner box keeps HEAD sticky / paging.
    <div className="relative flex min-h-0 flex-1 flex-col">
    {/* Reserve the scrollbar gutter even when nothing overflows, so the
        centered content column stays pixel-aligned with the fixed bottom
        prompt area (App reserves the same gutter there). */}
    <div
      ref={boxRef}
      className="gn-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none"
      data-scrollback-box=""
      // overflow-anchor: none — browser scroll anchoring fights our manual
      // height-delta restore on prepend (double-apply → viewport jump).
      style={{ scrollbarGutter: 'stable', overflowAnchor: 'none' }}
      tabIndex={0}
      role="listbox"
      aria-label="Scrollback"
      data-focus={focusMode === 'scrollback' ? 'scrollback' : 'prompt'}
      onScroll={(e) => {
        const t = e.currentTarget
        const dist = t.scrollHeight - t.scrollTop - t.clientHeight
        // 用户滑动优先：scrollTop 变小且已离开底部 → 暂停跟随（哪怕只
        // 滚 1px）。关键：切换会话时内容变矮，浏览器会把 scrollTop 钳到
        // 新 max——也会出现 scrollTop 变小，但此时 dist≈0，不能当作用户
        // 上滑，否则 follow 被误关，historyLoadedAt 钉底 effect 之后的
        // 流式/高度增长就不再贴底。滚回真正底部（dist<4）才恢复跟随。
        const prevTop = lastScrollTopRef.current
        lastScrollTopRef.current = t.scrollTop
        if (t.scrollTop < prevTop && dist >= 4) {
          followRef.current = false
        } else if (dist < 4) {
          followRef.current = true
        }
        scheduleUpdatePinned()
        // Near the top of a loaded history: fetch the next older page.
        // Re-arm when the user scrolls away from the top region so one
        // visit to the top loads exactly one page (no cascade).
        if (t.scrollTop < 80) {
          maybeLoadOlderHistory()
        } else {
          topPageArmedRef.current = true
        }
      }}
      onWheel={(e) => {
        // Wheel-up near top: page older history. Also when scrollTop===0
        // (no overflow → no scroll events) so a trackpad flick still loads.
        // Use the same 80px top band as onScroll — collapsed tool runs
        // often leave only a few px of headroom; requiring scrollTop<=0
        // missed those.
        if (e.deltaY < 0) {
          const top = boxRef.current?.scrollTop ?? 0
          if (top < 80) maybeLoadOlderHistory()
        }
      }}
      onTouchStart={(e) => {
        const y = e.touches[0]?.clientY ?? null
        touchStartYRef.current = y
        touchYRef.current = y
      }}
      onTouchMove={(e) => {
        const y = e.touches[0]?.clientY
        if (y != null) touchYRef.current = y
      }}
      onTouchEnd={() => {
        const start = touchStartYRef.current
        const end = touchYRef.current
        touchStartYRef.current = null
        touchYRef.current = null
        // Finger dragged down = scroll up (older history); with no
        // scrollbar this gesture is the only way to page.
        if (
          start != null &&
          end != null &&
          end > start + TOUCH_UP_SWIPE_PX &&
          boxRef.current &&
          boxRef.current.scrollTop <= 0
        ) {
          maybeLoadOlderHistory()
        }
      }}
    >
      {/* Workspace + git status bar — sticky header of the scrollback. Sits
          outside the fade-in wrapper so it's always present while history
          content cross-fades in; the scrollback body scrolls under it.
          会话切换加载中（historyLoading）只有栏内内容（branch/cwd/状态
          芯片）淡出，栏本身保持常驻可见：旧会话数据不属于新会话，但
          背景条不消失（与加载覆盖层同节奏：加载开始内容同步淡出、
          加载完毕与内容区一起淡入）。栏常驻还让 ResizeObserver 全程
          连续测量 wsBarH，钉住的用户提示头始终与栏底齐平。 */}
      <WorkspaceBar
        onOpenMcp={onOpenMcp}
        topRef={workspaceRef}
        fadeHidden={historyLoading}
      />
      {/* Fade-in wrapper for freshly loaded history content — see the
          contentVisible layout effect above. transition-opacity is applied
          ONLY in the visible state: dropping to opacity-0 must be instant
          (no 100→0 transition), so the hidden frame actually recalc+paint
          and the restore then plays a real 0→100 fade. */}
      <div
        ref={contentRef}
        className={`${
          contentVisible ? 'transition-opacity duration-300 opacity-100' : 'opacity-0'
        }`}
      >
      {(historyHasMore || historyLoadingMore) && entries.length > 0 && (
        // Clickable fallback: when content doesn't overflow there is no
        // scrollbar, so scroll-to-top never fires. Tapping the hint loads
        // the next older host page the same way the near-top scroll path does.
        <button
          type="button"
          disabled={historyLoadingMore}
          onClick={(ev) => {
            ev.stopPropagation()
            // Explicit click: never swallowed by the prepend cooldown.
            maybeLoadOlderHistory(true)
          }}
          className="mx-auto block w-full py-1.5 text-center text-[11px] text-gn-gutter select-none transition-colors hover:text-gn-muted disabled:cursor-default disabled:hover:text-gn-gutter"
          title={
            historyLoadingMore
              ? undefined
              : historyLoadError
                ? historyLoadError
                : '点击或向上滚动加载更早历史'
          }
        >
          {historyLoadingMore ? (
            '加载上一轮…'
          ) : historyLoadError ? (
            <span className="text-gn-red">{historyLoadError} · 点击重试</span>
          ) : (
            '↑ 点击或向上滚动加载上一轮'
          )}
        </button>
      )}
      <div
        aria-hidden={!loadingVisible && !loadFailedVisible}
        className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 select-none transition-opacity duration-300 ${
          loadingVisible || loadFailedVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {loadFailedVisible ? (
          <>
            <span className="shrink-0 text-[12.5px] font-semibold text-gn-red">
              加载失败
            </span>
            <span
              className="min-w-0 max-w-[65%] truncate text-[12.5px] text-gn-muted"
              title={historyLoadError}
            >
              {historyLoadError}
            </span>
          </>
        ) : (
          <>
            <span className="text-[15px] leading-none text-gn-muted">
              {SPINNER_FRAMES[spinnerFrame]}
            </span>
            <span className="text-[12.5px] text-gn-muted">加载会话…</span>
          </>
        )}
      </div>
      <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} py-3`}>
        {/* TUI sticky prompt header (sticky.rs): last user prompt scrolled
            past the top, collapsed to 3 lines; switches as you scroll.
            Zero-height sticky shell + absolute band = no layout shift when
            the pin mounts/unmounts (in-flow clone used to push all rows and
            jitter against pin-threshold / scroll-follow).
            */}
        <div
          className="pointer-events-none sticky z-10 h-0 overflow-visible"
          style={{ top: wsBarH }}
          aria-hidden={pinnedUser?.kind !== 'user' && !historyLoadingMore}
        >
          {(pinnedUser?.kind === 'user' || historyLoadingMore) && (
            <div
              ref={stickyBandElRef}
              data-sticky-prompt=""
              className="pointer-events-auto absolute inset-x-0 top-0 font-ui text-[13.5px] leading-[1.35] text-gn-fg select-none"
              style={{
                backgroundColor: 'var(--color-gn-bg-highlight)',
              }}
            >
              {pinnedUser?.kind === 'user' && (
                <button
                  type="button"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    jumpToUserEntry(pinnedUser.id)
                  }}
                  className="group relative flex w-full min-w-0 cursor-pointer items-start gap-1.5 px-2.5 py-[11px] text-left transition-colors hover:brightness-110"
                  title="点击跳转到此消息开头"
                >
                  <span
                    className="mt-[1.5px] shrink-0"
                    style={{
                      color: (pinnedUser as { isShell?: boolean }).isShell
                        ? 'var(--color-gn-cyan)'
                        : 'var(--color-gn-accent-user)',
                    }}
                  >
                    <IconGlyph
                      glyph={
                        (pinnedUser as { isShell?: boolean }).isShell
                          ? '$'
                          : pinnedUser.isCron
                            ? Glyphs.cronPrompt
                            : Glyphs.promptArrow
                      }
                      color={
                        (pinnedUser as { isShell?: boolean }).isShell
                          ? 'var(--color-gn-cyan)'
                          : 'var(--color-gn-accent-user)'
                      }
                    />
                  </span>
                  <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                    {/* store 回退：提示这条 prompt 在可见列表上方。 */}
                    {pinnedStore ? `${Glyphs.ellipsis} ` : ''}
                    {collapseUserText(pinnedUser.text, USER_COLLAPSED_MAX_LINES).text}
                  </div>
                  <PromptTime ts={pinnedUser.ts} className="top-[14.5px]" />
                </button>
              )}
              {/* 上滑加载上一轮：就地显示加载中（不依赖顶部按钮是否在视口内）。
                  仅在无钉选用户消息时显示——sticky 钉着用户消息时不得把
                  消息显示成「正在加载上一轮」（加载态由顶部按钮承担）。 */}
              {historyLoadingMore && pinnedUser?.kind !== 'user' && (
                <div className="flex items-center gap-1.5 px-2.5 py-[11px] text-[11.5px] text-gn-muted">
                  <span className="text-[13px] leading-none">
                    {SPINNER_FRAMES[spinnerFrame]}
                  </span>
                  <span>加载上一轮…</span>
                </div>
              )}
            </div>
          )}
        </div>
        {entries.length === 0 && !sessionId && !historyLoading && (
          // Empty state — current session was deleted (or nothing active):
          // a plain blank scrollback reads as a hang, so show the workspace
          // picker instead.
          <EmptyStatePicker />
        )}
        {displayRows.map((row, i) => {
          const dense = isDensePackableRow(row)
          const densePrev = i > 0 && isDensePackableRow(displayRows[i - 1])
          const denseNext =
            i < displayRows.length - 1 && isDensePackableRow(displayRows[i + 1])
          if (row.type === 'group_header') {
            return (
              <GroupHeaderView
                key={displayRowKey(row)}
                row={row}
                selected={row.id === selectedId && focusMode === 'scrollback'}
                pendingFreeze={pendingFreeze}
                now={now}
                onToggle={() => toggleGroupExpansion(row.span.anchorId)}
                dense={dense}
                densePrev={densePrev}
                denseNext={denseNext}
              />
            )
          }
          return (
            <EntryView
              key={displayRowKey(row)}
              e={row.entry}
              selected={row.entry.id === selectedId && focusMode === 'scrollback'}
              pendingFreeze={pendingFreeze}
              now={now}
              inGroup={spanContaining(spans, row.index) != null}
              dense={dense}
              densePrev={densePrev}
              denseNext={denseNext}
              streamBodyRef={
                row.entry.kind === 'thought' && row.entry.id === streamingThoughtId
                  ? streamBodyRef
                  : undefined
              }
            />
          )
        })}
        </div>
      </div>
      <div ref={bottomRef} />
    </div>
    <UserMessageNav
      items={userNavItems}
      activeId={navActiveId}
      onJump={onUserNavJump}
      scrollParentRef={boxRef}
    />
    </div>
  )
}

type GroupHeaderViewProps = {
  row: Extract<DisplayRow, { type: 'group_header' }>
  selected: boolean
  pendingFreeze: boolean
  now: number
  onToggle: () => void
  dense?: boolean
  denseNext?: boolean
  densePrev?: boolean
  /** 迷你 scrollback 局部选中（缺省主 store selectEntry）。 */
  selectRow?: (id: string) => void
}

/** Group headers have no finish-flash — `now` clock ticks never re-render. */
function groupHeaderEqual(
  prev: GroupHeaderViewProps,
  next: GroupHeaderViewProps,
): boolean {
  return (
    prev.row === next.row &&
    prev.selected === next.selected &&
    prev.pendingFreeze === next.pendingFreeze &&
    prev.onToggle === next.onToggle &&
    prev.dense === next.dense &&
    prev.denseNext === next.denseNext &&
    prev.densePrev === next.densePrev &&
    prev.selectRow === next.selectRow
  )
}

export const GroupHeaderView = memo(function GroupHeaderView({
  row,
  selected,
  pendingFreeze,
  now,
  onToggle,
  dense = true,
  denseNext = false,
  densePrev = false,
  selectRow,
}: GroupHeaderViewProps) {
  const storeSelectEntry = useChatStore((s) => s.selectEntry)
  const selectEntry = selectRow ?? storeSelectEntry
  const e = displayRowToEntry(row)
  const [hovered, setHovered] = useState(false)
  const shell = {
    e,
    selected,
    hovered,
    onHover: setHovered,
    onSelect: () => selectEntry(row.id),
    pendingFreeze,
    now,
    dense,
    denseNext,
    densePrev,
  }
  const opts = accentOpts(e, selected, pendingFreeze, now, hovered)
  const bullet = resolveBullet(opts)
  // › when collapsed group is selected/hovered
  const caret =
    !row.span.expanded && (selected || hovered) ? Glyphs.chevron : null
  // Expanded verb header uses ⌄ on hover (TUI point_down)
  const glyph =
    caret ||
    (row.span.expanded && (selected || hovered)
      ? Glyphs.chevronDown
      : Glyphs.diamondDotted)

  return (
    <EntryShell {...shell}>
      <button
        type="button"
        onClick={(ev) => {
          ev.stopPropagation()
          selectEntry(row.id)
          onToggle()
        }}
        className="flex w-full items-center gap-1.5 text-left py-0 text-[13px] leading-[1.35]"
      >
        <Bullet
          color={bullet.color}
          animated={bullet.animated && !caret}
          glyph={glyph}
        />
        <span
          className="min-w-0 truncate font-bold leading-[1.35]"
          style={{
            color: row.label.failed
              ? Accents.error
              : row.label.running
                ? Accents.running
                : 'var(--color-gn-gray)',
          }}
        >
          {row.label.text}
        </span>
      </button>
    </EntryShell>
  )
}, groupHeaderEqual)
