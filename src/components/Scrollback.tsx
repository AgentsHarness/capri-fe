import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useChatStore } from '../store/chat'
import type { ScrollEntry } from '../api/types'
import { Glyphs, toolHeader } from '../theme/glyphs'
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
  projectDisplayRows,
  scanGroups,
  spanContaining,
  type DisplayRow,
} from '../scrollback/verbGroup'
import {
  AccentRail,
  Accents,
  resolveAccent,
  resolveBullet,
  type AccentResolveOpts,
} from './AccentRail'
import { SelectionBox } from './SelectionBox'
import { Markdown } from './Markdown'
import { ToolDetail } from './ToolDetail'
import { extractToolDetail } from '../scrollback/toolDetail'

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

/** UserPromptBlock COLLAPSED_MAX_LINES. */
const USER_COLLAPSED_MAX_LINES = 3
/** Conservative content width for foldability estimate (TUI MIN_CONTENT_WIDTH). */
const USER_MIN_CONTENT_WIDTH = 60

/**
 * Estimate visual line count for a user prompt (wrap-aware, matches TUI
 * UserPromptBlock::is_foldable).
 */
function userVisualLines(text: string): number {
  let visual = 0
  const lines = text.split('\n')
  for (const line of lines) {
    const w = line.length
    visual += w === 0 ? 1 : Math.ceil(w / USER_MIN_CONTENT_WIDTH)
  }
  return visual || 1
}

function userIsFoldable(text: string): boolean {
  return userVisualLines(text) > USER_COLLAPSED_MAX_LINES
}

/**
 * Collapse user text to at most max visual lines, appending " …" when truncated
 * (UserPromptBlock::wrap_prompt_lines with max_lines).
 */
function collapseUserText(text: string, maxLines: number): { text: string; truncated: boolean } {
  const logical = text.split('\n')
  const out: string[] = []
  let visual = 0
  for (let i = 0; i < logical.length; i++) {
    const line = logical[i]
    const w = line.length
    const need = w === 0 ? 1 : Math.ceil(w / USER_MIN_CONTENT_WIDTH)
    if (visual + need > maxLines) {
      const remaining = maxLines - visual
      if (remaining <= 0) {
        // Mark last line with ellipsis
        if (out.length > 0) {
          const last = out[out.length - 1]
          out[out.length - 1] = last.replace(/\s*$/, '') + ' ' + Glyphs.ellipsis
        } else {
          out.push(Glyphs.ellipsis)
        }
        return { text: out.join('\n'), truncated: true }
      }
      // Fit head of this line into remaining visual rows, leave room for " …"
      const chars = remaining * USER_MIN_CONTENT_WIDTH
      const head = line.slice(0, Math.max(1, chars - 2)).replace(/\s+$/, '')
      out.push(head + ' ' + Glyphs.ellipsis)
      return { text: out.join('\n'), truncated: true }
    }
    out.push(line)
    visual += need
  }
  return { text: out.join('\n'), truncated: false }
}

function entryExpanded(e: ScrollEntry): boolean {
  if (e.kind === 'tool') return !!e.expanded
  if (e.kind === 'thought') return !!e.open
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
    return !e.open
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
function isDensePackable(e: ScrollEntry): boolean {
  if (e.kind === 'group_header') return true
  if (e.kind === 'tool') return !e.expanded
  if (e.kind === 'thought') return !e.open && !e.streaming
  if (e.kind === 'subagent' || e.kind === 'bg_task' || e.kind === 'workflow')
    return true
  return false
}

function isDensePackableRow(row: DisplayRow): boolean {
  if (row.type === 'group_header') return true
  return isDensePackable(row.entry)
}

function EntryShell({
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

function Bullet({
  color,
  animated,
  glyph = Glyphs.diamondFilled,
}: {
  color: string
  animated?: boolean
  glyph?: string
}) {
  return <IconGlyph glyph={glyph} color={color} animated={animated} />
}

function EntryView({
  e,
  selected,
  pendingFreeze,
  now,
  dense = false,
  denseNext = false,
  densePrev = false,
  inGroup = false,
}: {
  e: ScrollEntry
  selected: boolean
  pendingFreeze: boolean
  now: number
  dense?: boolean
  denseNext?: boolean
  densePrev?: boolean
  inGroup?: boolean
}) {
  const toggleTool = useChatStore((s) => s.toggleTool)
  const toggleThought = useChatStore((s) => s.toggleThought)
  const toggleUser = useChatStore((s) => s.toggleUser)
  const openViewer = useChatStore((s) => s.openViewer)
  const selectEntry = useChatStore((s) => s.selectEntry)
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
  const bodyRef = useRef<HTMLDivElement>(null)
  const thoughtStreaming = e.kind === 'thought' ? e.streaming : false
  const thoughtText = e.kind === 'thought' ? e.text : undefined
  useEffect(() => {
    if (!thoughtStreaming) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thoughtStreaming, thoughtText])
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
    // UserPromptBlock: full-width bg_light band, accent_user ❯ prefix,
    // continuation indent, optional collapse to 3 visual lines + " …".
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
          className="flex w-full min-w-0 items-start gap-1.5 py-[5px] text-left font-ui text-[13.5px] leading-[1.55]"
          title="click fold · dblclick / enter view"
        >
          {/* Same icon column as tool/thought bullets so ❯ / ◆ / › line up. */}
          <Bullet
            color="var(--color-gn-accent-user)"
            glyph={Glyphs.promptArrow}
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
          {foldable && (selected || hovered) && !expanded && (
            <span
              className="ml-1 shrink-0 self-start text-[12px] text-gn-gray-dim"
              aria-hidden
            >
              {Glyphs.chevron}
            </span>
          )}
        </button>
      </EntryShell>
    )
  }

  if (e.kind === 'assistant') {
    return (
      <EntryShell {...shell}>
        <Markdown source={e.text} streaming={e.streaming} />
      </EntryShell>
    )
  }

  if (e.kind === 'thought') {
    const showBody = e.streaming || e.open
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
            className="gn-no-scrollbar mt-1 min-h-[1.2em] max-h-[6.5em] overflow-y-auto overscroll-contain border-l pl-3 text-[12.5px] leading-relaxed"
            style={{ borderColor: 'color-mix(in srgb, var(--color-gn-gray-dim) 40%, transparent)' }}
          >
            {e.text ? (
              <div className="italic text-gn-muted whitespace-pre-wrap break-words">
                {e.text}
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
    return (
      <div className="px-4 py-1 text-center text-[11px] text-gn-muted" data-entry-id={e.id}>
        {e.text}
      </div>
    )
  }

  if (e.kind === 'plan') {
    return (
      <EntryShell {...shell}>
        <div className="text-[12px] font-bold mb-1" style={{ color: Accents.plan }}>
          Plan
        </div>
        <pre className="text-[11px] text-gn-muted font-mono whitespace-pre-wrap">
          {JSON.stringify(e.entries, null, 2)}
        </pre>
      </EntryShell>
    )
  }

  if (e.kind === 'subagent') {
    const label =
      e.status === 'started'
        ? e.running
          ? 'Agent'
          : 'Agent'
        : e.status === 'completed'
          ? 'Agent done'
          : e.status === 'cancelled'
            ? 'Agent cancelled'
            : 'Agent failed'
    const cancelSubagent = useChatStore((s) => s.cancelSubagent)
    return (
      <EntryShell {...shell}>
        <div className="flex items-center gap-1.5 py-[2px] text-[13px] leading-[1.35]">
          <Bullet color={bullet.color} animated={bullet.animated} />
          <span className="font-bold" style={{ color: bullet.color }}>
            {label}
          </span>
          <span className="min-w-0 truncate font-mono text-[12.5px] text-gn-muted">
            {e.title}
          </span>
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
        <div className="flex items-center gap-1.5 py-[2px] text-[13px] leading-[1.35]">
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
    const label =
      e.status === 'started'
        ? 'Background'
        : e.status === 'completed'
          ? 'Background done'
          : 'Background failed'
    const killTask = useChatStore((s) => s.killTask)
    return (
      <EntryShell {...shell}>
        <div className="flex items-center gap-1.5 py-[2px] text-[13px] leading-[1.35]">
          <Bullet color={bullet.color} animated={bullet.animated} />
          <span className="font-bold" style={{ color: bullet.color }}>
            {label}
          </span>
          <span className="min-w-0 truncate font-mono text-[12.5px] text-gn-muted">
            {e.title}
          </span>
          {e.detail && (
            <span className="text-[11px] text-gn-gutter truncate">{e.detail}</span>
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
    return (
      <EntryShell {...shell}>
        <div className="flex items-center gap-1.5 py-[2px] text-[13px] leading-[1.35]">
          {(e.recap || e.streaming) && (
            <Bullet color={bullet.color} animated={bullet.animated} />
          )}
          <span
            className="text-[12.5px] whitespace-pre-wrap break-words"
            style={{
              color: e.warning ? Accents.warning : Accents.gray,
            }}
          >
            {e.text}
          </span>
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
}

/** True when any entry is mid finish-flash and needs a clock tick. */
function needsFlashClock(entries: ScrollEntry[], now: number): boolean {
  return entries.some((e) => {
    if (e.kind !== 'tool' && e.kind !== 'thought') return false
    const fa = e.finishedAt
    return fa != null && now - fa < FINISH_FLASH_MS
  })
}

function displayRowKey(row: DisplayRow): string {
  return row.type === 'entry' ? row.entry.id : row.id
}

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

export function Scrollback() {
  const entries = useChatStore((s) => s.entries)
  const selectedId = useChatStore((s) => s.selectedId)
  const focusMode = useChatStore((s) => s.focusMode)
  const pending = useChatStore((s) => s.pending)
  const expandedGroups = useChatStore((s) => s.expandedGroups)
  const historyLoadedAt = useChatStore((s) => s.historyLoadedAt)
  const historyHasMore = useChatStore((s) => s.historyHasMore)
  const historyLoadingMore = useChatStore((s) => s.historyLoadingMore)
  const historyPrependedAt = useChatStore((s) => s.historyPrependedAt)
  const historyAnchorId = useChatStore((s) => s.historyAnchorId)
  const toggleGroupExpansion = useChatStore((s) => s.toggleGroupExpansion)
  const loadMoreHistory = useChatStore((s) => s.loadMoreHistory)
  const bottomRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const [now, setNow] = useState(() => Date.now())

  const { rows: displayRows, spans } = useMemo(() => {
    const spans = scanGroups(entries, expandedGroups)
    return { rows: projectDisplayRows(entries, spans), spans }
  }, [entries, expandedGroups])

  // Pending permission freezes running waves (is_pending_user_input)
  const pendingFreeze = pending.length > 0

  // Clock for finish-flash window (~50ms) while any entry is flashing
  useEffect(() => {
    if (!needsFlashClock(entries, Date.now())) return
    let id: number | undefined
    const tick = () => {
      const n = Date.now()
      setNow(n)
      if (!needsFlashClock(entries, n) && id != null) {
        clearInterval(id)
        id = undefined
      }
    }
    id = window.setInterval(tick, 50)
    return () => {
      if (id != null) clearInterval(id)
    }
  }, [entries])

  // Auto-follow only when near bottom
  useEffect(() => {
    if (!followRef.current) return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries, displayRows.length])

  // History load: always re-follow the bottom (scrollback was reset)
  useEffect(() => {
    if (!historyLoadedAt) return
    followRef.current = true
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [historyLoadedAt])

  // Older page prepended: restore the scroll anchor (previously first row)
  useEffect(() => {
    if (!historyPrependedAt || !historyAnchorId) return
    boxRef.current
      ?.querySelector(`[data-entry-id="${historyAnchorId}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'auto' })
  }, [historyPrependedAt, historyAnchorId])

  // Scroll selected into view
  useEffect(() => {
    if (!selectedId || focusMode !== 'scrollback') return
    const el = boxRef.current?.querySelector(`[data-entry-id="${selectedId}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId, focusMode, displayRows])

  return (
    <div
      ref={boxRef}
      className="gn-scroll flex-1 overflow-y-auto overscroll-contain outline-none"
      tabIndex={0}
      role="listbox"
      aria-label="Scrollback"
      data-focus={focusMode === 'scrollback' ? 'scrollback' : 'prompt'}
      onScroll={(e) => {
        const t = e.currentTarget
        const dist = t.scrollHeight - t.scrollTop - t.clientHeight
        followRef.current = dist < 80
        // Near the top of a loaded history: fetch the next older page.
        if (t.scrollTop < 80 && (historyHasMore || historyLoadingMore)) {
          const firstEl = t.querySelector('[data-entry-id]')
          void loadMoreHistory(firstEl?.getAttribute('data-entry-id') ?? undefined)
        }
      }}
    >
      {(historyHasMore || historyLoadingMore) && entries.length > 0 && (
        <div className="py-1 text-center text-[11px] text-gn-gutter select-none">
          {historyLoadingMore ? '加载更早历史…' : '↑ 向上滚动加载更早历史'}
        </div>
      )}
      {entries.length === 0 && (
        <div className="mx-auto mt-[12vh] max-w-md px-6 text-center text-gn-muted text-[13px] leading-[1.9]">
          <div className="mb-3 text-[28px] tracking-wide text-gn-magenta font-semibold">grok</div>
          <p>
            Agent Client Protocol · GrokNight
            <br />
            工具由 Host 上的 Agent 执行
          </p>
          <p className="mt-3 text-[12px] text-gn-gutter">
            <kbd className="rounded border border-gn-prompt-border bg-gn-bg-highlight px-1.5 py-0.5 text-gn-fg2">
              tab
            </kbd>{' '}
            滚动区 ·{' '}
            <kbd className="rounded border border-gn-prompt-border bg-gn-bg-highlight px-1.5 py-0.5 text-gn-fg2">
              j/k
            </kbd>{' '}
            选中 ·{' '}
            <kbd className="rounded border border-gn-prompt-border bg-gn-bg-highlight px-1.5 py-0.5 text-gn-fg2">
              ←/→
            </kbd>{' '}
            收起/展开 ·{' '}
            <kbd className="rounded border border-gn-prompt-border bg-gn-bg-highlight px-1.5 py-0.5 text-gn-fg2">
              enter
            </kbd>{' '}
            弹窗全文
          </p>
        </div>
      )}
      <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} py-3`}>
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
            />
          )
        })}
      </div>
      <div ref={bottomRef} />
    </div>
  )
}

function GroupHeaderView({
  row,
  selected,
  pendingFreeze,
  now,
  onToggle,
  dense = true,
  denseNext = false,
  densePrev = false,
}: {
  row: Extract<DisplayRow, { type: 'group_header' }>
  selected: boolean
  pendingFreeze: boolean
  now: number
  onToggle: () => void
  dense?: boolean
  denseNext?: boolean
  densePrev?: boolean
}) {
  const selectEntry = useChatStore((s) => s.selectEntry)
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
}
