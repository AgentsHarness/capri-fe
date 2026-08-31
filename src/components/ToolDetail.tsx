/**
 * Expanded tool-call body — field layout mirrors xai-grok-pager tool blocks
 * (read line-gutter content, execute stdout panel, edit diff, search matches…).
 */

import type { ToolCall } from '../api/types'
import { Fragment, useState } from 'react'
import {
  EXEC_FIRST,
  EXEC_LAST,
  INLINE_MAX,
  READ_FIRST,
  READ_LAST,
  discoveredToolAction,
  extractToolDetail,
  truncateLines,
  type DiffLine,
  type ToolDetail as Detail,
} from '../scrollback/toolDetail'
import { mcpTitleizeSegment, pathForSurface } from '../scrollback/toolPaths'
import { useChatStore } from '../store/chat'
import { IconGlyph } from './IconGlyph'
import { fmtBytes } from '../format'
import { Ansi } from './Ansi'

/**
 * Full-viewer page size for long stdout / read / edit bodies.
 * Only the expanded viewer path pages by this; inline truncation still uses
 * EXEC_FIRST/LAST, READ_FIRST/LAST, INLINE_MAX from toolDetail.ts.
 * Keep small (≤250) so mobile DOM stays light — load-more adds one page at a time.
 */
const VIEWER_PAGE_LINES = 200

/** TUI web_search `MAX_INLINE_SOURCES` — domains shown before "+N more". */
const MAX_INLINE_SOURCES = 3

function MoreLinesButton({
  total,
  visible,
  onMore,
}: {
  total: number
  visible: number
  onMore: () => void
}) {
  return (
    <button
      type="button"
      onClick={onMore}
      className="block w-full px-2 py-1 text-left font-mono text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
    >
      … +{total - visible} lines (click to load more)
    </button>
  )
}

type Props = {
  raw: ToolCall
  kindName?: string
  /** When true, show full content (TUI Expanded); else Truncated windows. */
  full?: boolean
  /**
   * Additional same-file edits merged into this row (TUI
   * collapsed_edit_blocks=true). Rendered after the main raw with a gap.
   */
  mergedRaws?: ToolCall[]
  className?: string
}

export function ToolDetail({
  raw,
  kindName,
  full = false,
  mergedRaws,
  className,
}: Props) {
  const d = extractToolDetail(raw, kindName)
  // Only edit rows merge (store-side rule); guard kind anyway.
  const extras = (mergedRaws ?? [])
    .map((r) => extractToolDetail(r, kindName))
    .filter((x): x is Extract<Detail, { kind: 'edit' }> => x.kind === 'edit')
  return (
    <div
      className={`min-w-0 font-ui text-[12.5px] leading-[1.45] ${className ?? 'mt-1'}`}
    >
      {d.kind === 'edit' ? (
        <EditBody d={d} full={full} extra={extras} />
      ) : (
        <DetailBody d={d} full={full} />
      )}
    </div>
  )
}

function DetailBody({ d, full }: { d: Detail; full: boolean }) {
  switch (d.kind) {
    case 'read':
      return <ReadBody d={d} full={full} />
    case 'execute':
      return <ExecuteBody d={d} full={full} />
    case 'edit':
      return <EditBody d={d} full={full} />
    case 'search':
      return <SearchBody d={d} />
    case 'list_dir':
      return <ListDirBody d={d} full={full} />
    case 'fetch':
      return <FetchBody d={d} full={full} />
    case 'web_search':
      return <WebSearchBody d={d} full={full} />
    case 'search_tool':
      return <SearchToolBody d={d} />
    case 'use_tool':
      return <UseToolBody d={d} full={full} />
    case 'generic':
      return <GenericBody d={d} full={full} />
  }
}

// ── shared chrome ────────────────────────────────────────────────────

function Panel({
  children,
  className = '',
  full = false,
}: {
  children: React.ReactNode
  className?: string
  /** Viewer mode: no max-height (outer dialog scrolls). */
  full?: boolean
}) {
  // TUI panel_background(theme.bg_dark) for content previews
  return (
    <div
      className={`${full ? '' : 'max-h-72 overflow-auto'} bg-gn-bg-dark px-0 py-0.5 ${className}`}
    >
      {children}
    </div>
  )
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div
      className="whitespace-pre-wrap break-words py-0.5"
      style={{ color: 'var(--color-gn-accent-error)' }}
    >
      <Ansi text={text} />
    </div>
  )
}

function MetaLine({ children }: { children: React.ReactNode }) {
  return <div className="px-0.5 py-0.5 text-[12px] text-gn-muted">{children}</div>
}

function KvRows({ rows }: { rows: { key: string; value: string }[] }) {
  if (!rows.length) return null
  return (
    <div className="space-y-0.5 py-0.5">
      {rows.map((r) => (
        <div key={r.key} className="flex min-w-0 gap-1 font-mono text-[12px]">
          <span className="shrink-0 text-gn-muted">{r.key}:</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-gn-fg">
            {r.value}
          </span>
        </div>
      ))}
    </div>
  )
}

function StdoutPanel({
  text,
  full,
  first,
  last,
}: {
  text: string
  full: boolean
  first: number
  last: number
}) {
  const raw = text.replace(/\n$/, '').split('\n')
  const { lines } = full ? { lines: raw } : truncateLines(raw, first, last || 0)
  // last=0 means head-only truncate
  const display =
    !full && last === 0 && raw.length > first
      ? [...raw.slice(0, first), `… +${raw.length - first} lines`]
      : lines
  // Full view (viewer) with a very long output: page the rows instead of
  // mounting all of them at once.
  const [visible, setVisible] = useState(() =>
    Math.min(display.length, VIEWER_PAGE_LINES),
  )
  const showMore = visible < display.length
  const rows = showMore ? display.slice(0, visible) : display
  return (
    <Panel full={full}>
      {rows.map((line, i) => (
        <div
          key={i}
          className={`px-2 font-mono text-[12px] leading-[1.4] whitespace-pre-wrap break-all ${
            line.startsWith('… +') ? 'text-gn-muted' : 'text-gn-fg'
          }`}
        >
          {line.startsWith('… +') ? (
            line
          ) : (
            <Ansi text={line || ' '} />
          )}
        </div>
      ))}
      {showMore && (
        <MoreLinesButton
          total={display.length}
          visible={visible}
          onMore={() =>
            setVisible((v) => Math.min(v + VIEWER_PAGE_LINES, display.length))
          }
        />
      )}
    </Panel>
  )
}

// ── read ─────────────────────────────────────────────────────────────

/**
 * Turn read-tool image content (data URI or bare base64) into a usable
 * <img> src; undefined when the content is not image-shaped (→ the
 * existing "(image)" text fallback).
 */
function readImageSrc(content?: string): string | undefined {
  const c = content?.trim()
  if (!c) return undefined
  if (c.startsWith('data:')) return c
  // Stray "image/png;base64,…" prefix without the data: scheme.
  const m = c.match(/^([\w.+-]+\/[\w.+-]+);base64,(.+)$/)
  if (m) return `data:${m[1]};base64,${m[2]}`
  // Long base64-shaped payload → wrap with image/png.
  if (c.length > 64 && /^[A-Za-z0-9+/=\s]+$/.test(c)) {
    return `data:image/png;base64,${c.replace(/\s+/g, '')}`
  }
  return undefined
}

function ReadBody({
  d,
  full,
}: {
  d: Extract<Detail, { kind: 'read' }>
  full: boolean
}) {
  // Full view (viewer) with a very long file: page the rows instead of
  // mounting all of them at once. Unconditional hook (early returns below).
  const [visible, setVisible] = useState(VIEWER_PAGE_LINES)
  if (d.error) return <ErrorLine text={d.error} />
  if (d.media === 'image') {
    const src = readImageSrc(d.content)
    if (src) {
      // Real image preview (base64 / data URI content) — no max-h clip
      // like text panels; the image caps itself at 55vh.
      return (
        <div className="bg-gn-bg-dark px-0 py-1">
          <img
            src={src}
            alt="read image"
            className="mx-auto max-h-[55vh] max-w-full rounded object-contain"
          />
        </div>
      )
    }
    return <MetaLine>(image)</MetaLine>
  }
  if (d.media === 'pdf') {
    // TUI header suffix carries the page count; the body has nothing to show.
    return <MetaLine>{d.pages != null ? `(${d.pages} pages)` : '(pdf)'}</MetaLine>
  }
  if (d.empty) return <MetaLine>(empty)</MetaLine>
  if (!d.content) return <MetaLine>(no content)</MetaLine>

  const base = d.lineStart ?? 1
  const rawLines = d.content.replace(/\n$/, '').split('\n')
  const total = rawLines.length
  const gutterW = String(base + Math.max(total - 1, 0)).length

  type Row = { no?: number; text: string; ellipsis?: boolean }
  let rows: Row[]
  if (!full && total > READ_FIRST + READ_LAST) {
    const head = rawLines.slice(0, READ_FIRST).map((text, i) => ({
      no: base + i,
      text,
    }))
    const tailStart = total - READ_LAST
    const tail = rawLines.slice(tailStart).map((text, i) => ({
      no: base + tailStart + i,
      text,
    }))
    const hidden = total - READ_FIRST - READ_LAST
    rows = [...head, { text: `… +${hidden} lines`, ellipsis: true }, ...tail]
  } else {
    rows = rawLines.map((text, i) => ({ no: base + i, text }))
  }
  const showMore = visible < rows.length
  const shown = showMore ? rows.slice(0, visible) : rows

  return (
    <Panel full={full}>
      {shown.map((r, i) =>
        r.ellipsis ? (
          <div key={i} className="px-2 font-mono text-[11px] text-gn-muted">
            {r.text}
          </div>
        ) : (
          <div key={i} className="flex font-mono text-[12px] leading-[1.4]">
            <span
              className="shrink-0 select-none pr-2 text-right text-gn-gray-dim tabular-nums"
              style={{ width: `${gutterW + 1}ch` }}
            >
              {r.no}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-gn-fg">
              {r.text || ' '}
            </span>
          </div>
        ),
      )}
      {showMore && (
        <MoreLinesButton
          total={rows.length}
          visible={visible}
          onMore={() => setVisible((v) => Math.min(v + VIEWER_PAGE_LINES, rows.length))}
        />
      )}
    </Panel>
  )
}

// ── execute ──────────────────────────────────────────────────────────

function ExecuteBody({
  d,
  full,
}: {
  d: Extract<Detail, { kind: 'execute' }>
  full: boolean
}) {
  return (
    <div className="space-y-1">
      {/* Secondary $ command when description is the collapsed title.
          TUI shell_command_line: "$ " (dim) + command — keep a real gap so
          mono fonts don't glue the dollar to the first token. */}
      {d.description && d.command ? (
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[12.5px] leading-[1.45]">
          {/* Same ICON_COL as scrollback so $ lines up under ◆ / ⌄. */}
          <IconGlyph glyph="$" color="var(--color-gn-gray-dim)" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-gn-fg">
            {d.command}
          </span>
        </div>
      ) : null}

      {d.error && !d.output ? <ErrorLine text={d.error} /> : null}

      {d.output ? (
        <StdoutPanel text={d.output} full={full} first={EXEC_FIRST} last={EXEC_LAST} />
      ) : null}

      {d.error && d.output ? (
        <div className="text-[11px]" style={{ color: 'var(--color-gn-accent-error)' }}>
          {d.error}
        </div>
      ) : null}
    </div>
  )
}

// ── edit ─────────────────────────────────────────────────────────────

function EditBody({
  d,
  full,
  extra = [],
}: {
  d: Extract<Detail, { kind: 'edit' }>
  full: boolean
  /** Additional merged same-file edits (collapsed_edit_blocks row). */
  extra?: Array<Extract<Detail, { kind: 'edit' }>>
}) {
  if (d.error) return <ErrorLine text={d.error} />
  // Combined diffstat across every merged hunk (TUI merged row sums
  // insertions/deletions); each hunk renders its own diff panel.
  const all = [d, ...extra]
  const ins = all.reduce((s, x) => s + x.insertions, 0)
  const del = all.reduce((s, x) => s + x.deletions, 0)
  return (
    <div className="space-y-0.5">
      {(ins > 0 || del > 0) && (
        <MetaLine>
          <span style={{ color: 'var(--color-gn-diff-ins-fg)' }}>+{ins}</span>
          {' '}
          <span style={{ color: 'var(--color-gn-diff-del-fg)' }}>−{del}</span>
        </MetaLine>
      )}
      {all.map((x, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <div className="py-0.5 text-center font-mono text-[11px] text-gn-gutter">
              …
            </div>
          )}
          <EditHunkPanel d={x} full={full} />
        </Fragment>
      ))}
    </div>
  )
}

function EditHunkPanel({
  d,
  full,
}: {
  d: Extract<Detail, { kind: 'edit' }>
  full: boolean
}) {
  // Full view (viewer) with a huge diff: page the rows instead of mounting
  // all of them at once. Unconditional hook (early return below).
  const [visible, setVisible] = useState(VIEWER_PAGE_LINES)
  if (!d.lines.length) return <MetaLine>(no diff)</MetaLine>

  let lines = d.lines
  if (!full && lines.length > 40) {
    const head = lines.slice(0, 20)
    const tail = lines.slice(-10)
    const hidden = lines.length - 30
    lines = [
      ...head,
      { kind: 'gap' as const, text: `… +${hidden} lines` },
      ...tail,
    ]
  }
  const showMore = visible < lines.length
  const shown = showMore ? lines.slice(0, visible) : lines

  const gutterW = Math.max(
    2,
    ...lines.map((l) => String(l.newNo ?? l.oldNo ?? 0).length),
  )

  return (
    <>
      <Panel full={full}>
        {shown.map((l, i) => (
          <DiffRow key={i} line={l} gutterW={gutterW} />
        ))}
        {showMore && (
          <MoreLinesButton
            total={lines.length}
            visible={visible}
            onMore={() =>
              setVisible((v) => Math.min(v + VIEWER_PAGE_LINES, lines.length))
            }
          />
        )}
      </Panel>
    </>
  )
}

function DiffRow({ line, gutterW }: { line: DiffLine; gutterW: number }) {
  if (line.kind === 'header') {
    return (
      <div className="px-2 font-mono text-[11px] text-gn-cyan">{line.text}</div>
    )
  }
  if (line.kind === 'gap') {
    return (
      <div className="px-2 font-mono text-[11px] text-gn-muted">{line.text}</div>
    )
  }
  const bg =
    line.kind === 'insert'
      ? 'var(--color-gn-diff-ins-bg)'
      : line.kind === 'delete'
        ? 'var(--color-gn-diff-del-bg)'
        : undefined
  const fg =
    line.kind === 'insert'
      ? 'var(--color-gn-diff-ins-fg)'
      : line.kind === 'delete'
        ? 'var(--color-gn-diff-del-fg)'
        : 'var(--color-gn-fg2)'
  const sign = line.kind === 'insert' ? '+' : line.kind === 'delete' ? '−' : ' '
  const no = line.newNo ?? line.oldNo
  return (
    <div className="flex font-mono text-[12px] leading-[1.4]" style={{ background: bg }}>
      <span
        className="shrink-0 select-none pr-1 text-right text-gn-gray-dim tabular-nums"
        style={{ width: `${gutterW + 1}ch` }}
      >
        {no ?? ''}
      </span>
      <span className="shrink-0 select-none px-0.5" style={{ color: fg }}>
        {sign}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all" style={{ color: fg }}>
        {line.text || ' '}
      </span>
    </div>
  )
}

// ── search ───────────────────────────────────────────────────────────

function SearchBody({ d }: { d: Extract<Detail, { kind: 'search' }> }) {
  // TUI `make_relative_path`: grep result paths are stored cwd-relative.
  const cwd = useChatStore((s) => s.historyCwd ?? s.cwd)
  const rel = (p: string) => pathForSurface(p, 'expanded', { cwd })
  if (d.error) return <ErrorLine text={d.error} />

  const modeLabel =
    d.outputMode === 'files' ? 'files' : d.outputMode === 'count' ? 'count' : 'pattern'
  const meta: { k: string; v: string }[] = [{ k: 'mode', v: modeLabel }]
  if (d.fileType) meta.push({ k: 'type', v: d.fileType })
  if (d.caseInsensitive) meta.push({ k: 'case-insensitive', v: 'true' })
  if (d.multiline) meta.push({ k: 'multiline', v: 'true' })

  const hasResults = d.fileMatches.length > 0 || d.filePaths.length > 0

  return (
    <div className="space-y-1">
      <MetaLine>
        {meta.map((p, i) => (
          <span key={p.k}>
            {i > 0 ? <span className="text-gn-muted">, </span> : null}
            <span className="text-gn-muted">{p.k}: </span>
            <span className="text-gn-fg">{p.v}</span>
          </span>
        ))}
      </MetaLine>

      {!hasResults && d.matchCount === 0 ? <MetaLine>(no results)</MetaLine> : null}

      {d.fileMatches.map((fm, i) => (
        <Panel key={i} className={i > 0 ? 'mt-1' : ''} full>
          <div
            className="px-2 font-mono text-[12px]"
            style={{ color: 'var(--color-gn-path)' }}
          >
            {rel(fm.path)}
          </div>
          {fm.matches.map((m, j) => (
            <div key={j} className="flex px-2 font-mono text-[12px] leading-[1.4]">
              <span className="w-10 shrink-0 text-right text-gn-muted tabular-nums">
                {m.lineNumber}
              </span>
              <span className="min-w-0 flex-1 pl-2 whitespace-pre-wrap break-all text-gn-fg">
                {m.content.trimEnd()}
              </span>
            </div>
          ))}
        </Panel>
      ))}

      {d.fileMatches.length === 0 &&
        d.filePaths.map((p, i) => (
          <div
            key={i}
            className="px-2 font-mono text-[12px]"
            style={{ color: 'var(--color-gn-path)' }}
          >
            {rel(p)}
          </div>
        ))}
    </div>
  )
}

// ── list dir ─────────────────────────────────────────────────────────

function ListDirBody({
  d,
  full,
}: {
  d: Extract<Detail, { kind: 'list_dir' }>
  full: boolean
}) {
  if (d.error) return <ErrorLine text={d.error} />
  if (!d.output) return <MetaLine>(empty)</MetaLine>
  return <StdoutPanel text={d.output} full={full} first={INLINE_MAX} last={0} />
}

// ── fetch ────────────────────────────────────────────────────────────

function FetchBody({
  d,
  full,
}: {
  d: Extract<Detail, { kind: 'fetch' }>
  full: boolean
}) {
  if (d.error) return <ErrorLine text={d.error} />
  const meta: string[] = []
  if (d.statusCode != null) meta.push(`status ${d.statusCode}`)
  if (d.contentType) meta.push(d.contentType)
  if (d.bytes != null) meta.push(fmtBytes(d.bytes))
  return (
    <div className="space-y-1">
      {meta.length ? <MetaLine>{meta.join(' · ')}</MetaLine> : null}
      {d.output ? (
        <StdoutPanel text={d.output} full={full} first={INLINE_MAX} last={0} />
      ) : (
        <MetaLine>(no content)</MetaLine>
      )}
    </div>
  )
}

// ── web search ───────────────────────────────────────────────────────

function WebSearchBody({
  d,
  full,
}: {
  d: Extract<Detail, { kind: 'web_search' }>
  full: boolean
}) {
  if (d.error) return <ErrorLine text={d.error} />
  // TUI sources_line: deduplicated domains, first 3 inline, rest counted.
  const shown = d.sites.slice(0, MAX_INLINE_SOURCES)
  const remaining = Math.max(0, d.sites.length - MAX_INLINE_SOURCES)
  return (
    <div className="space-y-1">
      {d.content ? (
        <StdoutPanel text={d.content} full={full} first={INLINE_MAX} last={0} />
      ) : (
        <MetaLine>(no content)</MetaLine>
      )}
      {shown.length > 0 ? (
        <div className="px-1 text-[12px] text-gn-muted">
          {'  '}Sources:{' '}
          <span className="text-gn-fg">{shown.join(', ')}</span>
          {remaining > 0 ? ` (+${remaining} more)` : ''}
        </div>
      ) : null}
      {d.citations.length > 0 ? (
        <div className="space-y-0.5 px-1">
          {d.citations.map((c, i) => (
            <div key={i} className="truncate font-mono text-[11px] text-gn-link">
              {i + 1}. {c}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ── search tool discovery ────────────────────────────────────────────

/**
 * TUI SearchToolCallBlock body: numbered rows of `Action  Server`, both halves
 * title-cased, server ghosted. The action drops the trusted `server__` prefix.
 */
function SearchToolBody({ d }: { d: Extract<Detail, { kind: 'search_tool' }> }) {
  if (d.error) return <ErrorLine text={d.error} />
  if (!d.results.length) return <MetaLine>(no results)</MetaLine>
  return (
    <div className="space-y-0.5 py-0.5">
      {d.results.map((t, i) => (
        <div key={`${t.name}-${i}`} className="px-2 font-mono text-[12px] leading-[1.4]">
          <span className="mr-2 text-gn-muted">{i + 1}.</span>
          <span className="font-bold text-gn-fg">
            {mcpTitleizeSegment(discoveredToolAction(t))}
          </span>
          {t.server ? (
            <span className="ml-2 text-gn-gray-dim">{mcpTitleizeSegment(t.server)}</span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

// ── use tool ─────────────────────────────────────────────────────────

function UseToolBody({
  d,
  full,
}: {
  d: Extract<Detail, { kind: 'use_tool' }>
  full: boolean
}) {
  return (
    <div className="space-y-1">
      <KvRows rows={d.args} />
      {d.error && !d.output ? <ErrorLine text={d.error} /> : null}
      {d.output ? (
        <StdoutPanel text={d.output} full={full} first={INLINE_MAX} last={0} />
      ) : null}
    </div>
  )
}

// ── generic ──────────────────────────────────────────────────────────

function GenericBody({
  d,
  full,
}: {
  d: Extract<Detail, { kind: 'generic' }>
  full: boolean
}) {
  return (
    <div className="space-y-1">
      <KvRows rows={d.inputArgs} />
      {d.error && !d.output ? <ErrorLine text={d.error} /> : null}
      {d.output ? (
        <StdoutPanel text={d.output} full={full} first={INLINE_MAX} last={0} />
      ) : !d.inputArgs.length ? (
        <MetaLine>(no output)</MetaLine>
      ) : null}
    </div>
  )
}
