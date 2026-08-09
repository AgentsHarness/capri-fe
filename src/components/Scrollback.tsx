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
import { mergeLiveText } from '../scrollback/liveText'

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
        const parts: string[] = []
        if (d.insertions || d.deletions) {
          parts.push(`+${d.insertions}/−${d.deletions}`)
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
 * Scrollback render window: entries beyond this many are not mounted
 * (DOM bound — long live sessions and large history loads would otherwise
 * grow the list unboundedly). Older entries stay in the store; scrolling
 * up expands the window one page at a time (and host history paging when
 * the local window is fully expanded). Applies in both live and history
 * modes.
 */
const MAX_RENDER_ENTRIES = 100

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
 * hover. Absolutely positioned (pointer-events-none) so the wider hover
 * form never reflows the message content — it covers it, as in the TUI.
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
      className={`pointer-events-none absolute text-[11px] leading-none text-gn-gray ${className}`}
      style={{ right: shiftRight ? 20 : 8 }}
    >
      <span className="group-hover:hidden">{formatPromptTime(ts)}</span>
      <span className="hidden group-hover:inline">{formatPromptTimeFull(ts)}</span>
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

  // Thought body preview: cap at 4 lines with internal scroll; keep the
  // newest line visible while streaming (full text lives in the viewer).
  const localBodyRef = useRef<HTMLDivElement>(null)
  const bodyRef = streamBodyRef ?? localBodyRef
  const thoughtStreaming = e.kind === 'thought' ? e.streaming : false
  // Additive: base entry text + liveStream delta (see mergeLiveText).
  const thoughtText =
    e.kind === 'thought' ? mergeLiveText(e.text, liveText) : undefined
  useEffect(() => {
    // 主 scrollback：固定由父组件统一做（合并的流式滚动 effect，每帧
    // 一次布局读写）；迷你 scrollback 没有 streamBodyRef，条目自己固定。
    if (!thoughtStreaming || streamBodyRef) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thoughtStreaming, thoughtText, streamBodyRef, bodyRef])
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
        <div className="group relative min-w-0 sm:pr-9">
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
                : 'gn-no-scrollbar mt-1 min-h-[1.2em] max-h-[6.5em] overflow-y-auto border-l pl-3 text-[12.5px] leading-relaxed'
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
      ? toolHeaderExtra(e.raw, e.kindName, failed)
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
            className="cursor-zoom-in"
            title="double-click or enter for full view"
          >
            <ToolDetail raw={e.raw} kindName={e.kindName} full={false} />
          </div>
        ) : null}
      </EntryShell>
    )
  }

  if (e.kind === 'error') {
    return (
      <EntryShell {...shell}>
        <div className="flex items-start gap-1.5 py-0.5 text-[13px] leading-[1.35]">
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
        <div className={`flex items-center gap-1.5 ${dense ? 'py-0' : 'py-[2px]'} text-[13px] leading-[1.35]`}>
          <Bullet color={bullet.color} animated={bullet.animated} />
          <span className="font-bold" style={{ color: bullet.color }}>
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
        <div className={`flex items-center gap-1.5 ${dense ? 'py-0' : 'py-[2px]'} text-[13px] leading-[1.35]`}>
          <Bullet color={bullet.color} animated={bullet.animated} />
          <span className="font-bold" style={{ color: bullet.color }}>
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
          <span className="font-bold" style={{ color: bullet.color }}>
            Task
          </span>
          <span className="text-gn-muted">{verb}:</span>
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
  '  /\\  /\\___ _ __ _ __   ___  ___ ___ ',
  ' / /_/ / _ \\ \'__| \'_ \\ / _ \\/ __/ __|',
  '/ __  /  __/ |  | | | |  __/\\__ \\__ \\',
  '\\/ /_/ \\___|_|  |_| |_|\\___||___/___/',
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

export function Scrollback() {
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
  const historyPrependedAt = useChatStore((s) => s.historyPrependedAt)
  const historyAnchorId = useChatStore((s) => s.historyAnchorId)
  const toggleGroupExpansion = useChatStore((s) => s.toggleGroupExpansion)
  const loadMoreHistory = useChatStore((s) => s.loadMoreHistory)
  const bottomRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  // ── Scroll-up paging gates (see maybeLoadOlderHistory) ──────────
  const topPageArmedRef = useRef(true)
  const topPageCooldownRef = useRef(0)
  // Touch gesture tracking (swipe down = scroll up toward older history).
  const touchStartYRef = useRef<number | null>(null)
  const touchYRef = useRef<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // History-switch loading indicator: same braille spinner as the
  // composer turn-status line (TUI glyphs.rs), ~7.5fps. The overlay
  // stays mounted permanently (pointer-events-none); opacity is toggled
  // by class so the 300 ms transition plays for BOTH the fade-in and
  // the fade-out — a conditionally mounted element would never paint
  // its starting opacity before the first frame, so the fade would
  // be skipped.
  const loadingVisible = historyLoading && entries.length === 0
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  useEffect(() => {
    if (!loadingVisible) return
    const t = window.setInterval(
      () => setSpinnerFrame((v) => (v + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    )
    return () => window.clearInterval(t)
  }, [loadingVisible])
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
  // The last user prompt whose top has scrolled past the viewport top is
  // pinned as a sticky header; it switches as you scroll. Tracked via
  // scroll position against the user entries' container-space tops.
  // Uses the render window (entries outside it have no DOM elements).
  // ── Render window (live + history) ───────────────────────────────
  // Bounded at MAX_RENDER_ENTRIES so large sessions / history pages keep
  // the DOM flat (the store keeps every entry). Scrolling to the top grows
  // the window one page at a time via maybeLoadOlderHistory; once the
  // local window covers the store, host history paging continues.
  const [renderLimit, setRenderLimit] = useState(MAX_RENDER_ENTRIES)
  // Anchor for the local-prepend scroll restore (mirrors historyPrependedAt).
  const [expandAnchorId, setExpandAnchorId] = useState<string | null>(null)
  // New session / history switch → window back to the default cap.
  useEffect(() => {
    setRenderLimit(MAX_RENDER_ENTRIES)
    setExpandAnchorId(null)
  }, [historyLoadedAt])
  const renderEntries = useMemo(
    () =>
      entries.length <= renderLimit
        ? entries
        : entries.slice(-renderLimit),
    [entries, renderLimit],
  )
  const truncatedCount = entries.length - renderEntries.length
  const userById = useMemo(() => {
    const m = new Map<string, ScrollEntry>()
    for (const e of renderEntries) if (e.kind === 'user') m.set(e.id, e)
    return m
  }, [renderEntries])
  const userEls = useRef<Map<string, HTMLElement>>(new Map())
  const [pinnedId, setPinnedId] = useState<string | null>(null)

  const updatePinned = useCallback(() => {
    const box = boxRef.current
    const els = userEls.current
    if (!box || els.size === 0) {
      setPinnedId(null)
      return
    }
    let pinned: string | null = null
    // sticky.rs: pin the last prompt with y_virtual < scroll_offset; at the
    // very top (scrollTop 0) nothing is pinned.
    if (box.scrollTop > 0) {
      const boxTop = box.getBoundingClientRect().top
      for (const [id, el] of els) {
        // Entry top in the container's coordinate space (scroll-independent).
        const top = el.getBoundingClientRect().top - boxTop + box.scrollTop
        if (top < box.scrollTop) pinned = id
        else break // entries are in document order
      }
    }
    setPinnedId(pinned)
  }, [])

  // Cache user entry elements (rebuilt on entry changes; positions shift on
  // history prepend / expand-collapse / resize, so recompute the pin then).
  useEffect(() => {
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
  }, [userById, updatePinned, historyPrependedAt])

  useEffect(() => {
    const onResize = () => updatePinned()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [updatePinned])

  // rAF-throttled pinned-header recompute: onScroll fires per frame during
  // streaming, and getBoundingClientRect per user entry forces layout.
  const pinnedRaf = useRef<number | null>(null)
  const scheduleUpdatePinned = useCallback(() => {
    if (pinnedRaf.current != null) return
    pinnedRaf.current = requestAnimationFrame(() => {
      pinnedRaf.current = null
      updatePinned()
    })
  }, [updatePinned])

  useEffect(
    () => () => {
      if (pinnedRaf.current != null) cancelAnimationFrame(pinnedRaf.current)
    },
    [],
  )

  const pinnedUser = pinnedId ? (userById.get(pinnedId) ?? null) : null

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
  // height — MAX_RENDER_ENTRIES caps the DOM, no content-visibility
  // placeholders — so scrollIntoView lands exactly at the tail).
  // `auto` behavior keeps it instant (no smooth animation restart per
  // flush, same as before).
  //
  // Entries / row-count changes re-run via React effect. liveStream text
  // growth must NOT re-render Scrollback — subscribe outside React and
  // pin the bottom / thought body from refs only.
  const pinStreamScroll = useCallback(() => {
    if (followRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'auto' })
    }
    const bodyEl = streamBodyRef.current
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight
  }, [])
  useEffect(() => {
    pinStreamScroll()
  }, [entries, displayRows.length, pinStreamScroll])
  useEffect(() => {
    return useChatStore.subscribe((s, prev) => {
      if (s.liveStream?.text === prev.liveStream?.text) return
      pinStreamScroll()
    })
  }, [pinStreamScroll])

  // History load: always re-follow the bottom (scrollback was reset)
  useEffect(() => {
    if (!historyLoadedAt) return
    followRef.current = true
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [historyLoadedAt])

  // Older page prepended: restore the scroll anchor (previously first row).
  // Cooldown: the anchor restore itself fires a scroll event at the top,
  // which must not instantly chain the next page — the user gets one page
  // per gesture, with the next scroll-up re-triggering after the cooldown.
  useEffect(() => {
    if (!historyPrependedAt || !historyAnchorId) return
    topPageCooldownRef.current = Date.now() + TOP_PAGE_COOLDOWN_MS
    boxRef.current
      ?.querySelector(`[data-entry-id="${historyAnchorId}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'auto' })
  }, [historyPrependedAt, historyAnchorId])

  // Local truncation page prepended: restore the scroll anchor exactly
  // like the host-history path above (same cooldown, one page per visit
  // to the top region).
  useEffect(() => {
    if (!expandAnchorId) return
    topPageCooldownRef.current = Date.now() + TOP_PAGE_COOLDOWN_MS
    boxRef.current
      ?.querySelector(`[data-entry-id="${expandAnchorId}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'auto' })
    setExpandAnchorId(null)
  }, [expandAnchorId])

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
   * Disarmed on trigger; re-armed when the user scrolls away from the top
   * (onScroll) or when a paging attempt finishes (effect above), so a
   * single gesture can never chain pages.
   */
  const maybeLoadOlderHistory = useCallback(() => {
    const box = boxRef.current
    if (!box) return
    if (!topPageArmedRef.current) return
    if (Date.now() < topPageCooldownRef.current) return
    topPageArmedRef.current = false
    // Live-mode truncation first: the older entries are still in the
    // store — grow the render window one page and restore the anchor so
    // the view doesn't jump (new rows land above the previously first
    // row). Re-armed immediately like the host-path loading-finish
    // re-arm; the cooldown keeps repeated top visits to one page each.
    if (truncatedCount > 0) {
      const anchorId = renderEntries[0]?.id
      followRef.current = false
      setRenderLimit((v) => v + MAX_RENDER_ENTRIES)
      setExpandAnchorId(anchorId ?? null)
      topPageArmedRef.current = true
      return
    }
    if (!historyHasMore || historyLoadingMore) return
    // Browsing older history: never yank the view back to the bottom on
    // prepend, even if the follow flag was left armed (e.g. wheel-up at
    // the very top with no prior scroll event).
    followRef.current = false
    const firstEl = box.querySelector('[data-entry-id]')
    void loadMoreHistory(firstEl?.getAttribute('data-entry-id') ?? undefined)
  }, [historyHasMore, historyLoadingMore, loadMoreHistory, renderEntries, truncatedCount])

  // Scroll selected into view
  useEffect(() => {
    if (!selectedId || focusMode !== 'scrollback') return
    const el = boxRef.current?.querySelector(`[data-entry-id="${selectedId}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId, focusMode, displayRows])

  return (
    <div
      ref={boxRef}
      className="gn-scroll relative flex-1 overflow-y-auto overscroll-contain outline-none"
      data-scrollback-box=""
      tabIndex={0}
      role="listbox"
      aria-label="Scrollback"
      data-focus={focusMode === 'scrollback' ? 'scrollback' : 'prompt'}
      onScroll={(e) => {
        const t = e.currentTarget
        const dist = t.scrollHeight - t.scrollTop - t.clientHeight
        followRef.current = dist < 80
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
        // Wheel-up fallback for content that does not overflow: at
        // scrollTop 0 no scroll events fire, so catch the gesture here
        // (trackpad two-finger up / mouse wheel up = older history).
        if (e.deltaY < 0 && boxRef.current && boxRef.current.scrollTop <= 0) {
          maybeLoadOlderHistory()
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
      {/* Fade-in wrapper for freshly loaded history content — see the
          contentVisible layout effect above. transition-opacity is applied
          ONLY in the visible state: dropping to opacity-0 must be instant
          (no 100→0 transition), so the hidden frame actually recalc+paint
          and the restore then plays a real 0→100 fade. */}
      <div
        className={`${
          contentVisible ? 'transition-opacity duration-300 opacity-100' : 'opacity-0'
        }`}
      >
      {(historyHasMore || historyLoadingMore) && entries.length > 0 && (
        // Clickable fallback: when content doesn't overflow there is no
        // scrollbar, so scroll-to-top never fires. Tapping the hint loads
        // the next older page the same way the near-top scroll path does.
        <button
          type="button"
          disabled={historyLoadingMore}
          onClick={(ev) => {
            ev.stopPropagation()
            maybeLoadOlderHistory()
          }}
          className="mx-auto block w-full py-1.5 text-center text-[11px] text-gn-gutter select-none transition-colors hover:text-gn-muted disabled:cursor-default disabled:hover:text-gn-gutter"
          title={
            historyLoadingMore
              ? undefined
              : '点击或向上滚动加载更早历史'
          }
        >
          {historyLoadingMore
            ? '加载更早历史…'
            : '↑ 点击或向上滚动加载更早历史'}
        </button>
      )}
      <div
        aria-hidden={!loadingVisible}
        className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 select-none transition-opacity duration-300 ${
          loadingVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <span className="text-[15px] leading-none text-gn-muted">
          {SPINNER_FRAMES[spinnerFrame]}
        </span>
        <span className="text-[12.5px] text-gn-muted">加载会话…</span>
      </div>
      <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} py-3`}>
        {/* TUI sticky prompt header (sticky.rs): the last user prompt
            scrolled past the top, collapsed to 3 lines; switches as you
            scroll. Solid band covers entries passing underneath. */}
        {pinnedUser?.kind === 'user' && (
          <div
            className="group relative sticky top-0 z-10 mb-2 font-ui text-[13.5px] leading-[1.35] text-gn-fg select-none"
            style={{ backgroundColor: 'var(--color-gn-bg-highlight)' }}
          >
            <div className="flex items-start gap-1.5 px-2.5 py-[11px]">
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
                {collapseUserText(pinnedUser.text, USER_COLLAPSED_MAX_LINES).text}
              </div>
              <PromptTime ts={pinnedUser.ts} className="top-[14.5px]" />
            </div>
          </div>
        )}
        {truncatedCount > 0 && (
          // Clickable like the host-history hint: same page-expansion path
          // as scrolling up at the top (maybeLoadOlderHistory).
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation()
              maybeLoadOlderHistory()
            }}
            className="mx-auto block w-full py-1.5 text-center text-[11px] text-gn-gutter select-none transition-colors hover:text-gn-muted"
            title="更早内容仍保留在会话中 · 向上滑动或点击加载更多"
          >
            已截断 {truncatedCount} 条更早内容 · 向上滑动或点击加载
          </button>
        )}
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
