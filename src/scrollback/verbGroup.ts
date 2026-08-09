/**
 * TUI verb-group + truncation fold port
 * (xai-grok-pager scrollback/state/verb_group.rs + groups.rs).
 *
 * Verb runs: consecutive collapsed non-destructive tools fold into one
 * "Read 3 files, Searched 2 patterns" header.
 * Truncation: long dense collapsed-groupable runs hide older rows behind "N more".
 */

import type { ScrollEntry } from '../api/types'
import { toolFamily } from '../theme/toolFamily'
import { thoughtDisplayMode } from './thoughtMode'

/** Eager verb-fold kinds (ToolCallBlock::verb_group_kind). */
export type VerbGroupKind =
  | 'file'
  | 'skill'
  | 'search'
  | 'dir'
  | 'web_fetch'
  | 'web_search'
  | 'memory'
  | 'integration'
  | 'subagent'
  | 'command' // label-only (truncation)
  | 'edit' // label-only
  | 'mcp' // label-only
  | 'other' // label-only

export type RunStep =
  | { kind: 'member'; vg: VerbGroupKind }
  | { kind: 'thought' }
  | { kind: 'transparent' }
  | { kind: 'break' }

export type GroupKind =
  | { type: 'verb'; members: number }
  | { type: 'truncation'; participants: number; hidden: number }

export type GroupSpan = {
  range: { start: number; end: number } // end exclusive
  kind: GroupKind
  expanded: boolean
  /** First entry id — key for expandedGroups. */
  anchorId: string
}

export type GroupLabel = {
  text: string
  running: boolean
  failed: boolean
}

export type DisplayRow =
  | {
      type: 'entry'
      entry: ScrollEntry
      /** Index in source entries[]. */
      index: number
    }
  | {
      type: 'group_header'
      id: string
      span: GroupSpan
      label: GroupLabel
      /** Verb run vs truncation ("N more"). */
      family: 'verb' | 'truncation'
    }

/** Default appearance.scrollback.display.group_max_visible. */
export const GROUP_MAX_VISIBLE = 10

// ── Classification ─────────────────────────────────────────────────────

/** Eager verb-group membership (excludes Execute/Edit/MCP/Other). */
export function verbGroupKind(e: ScrollEntry): VerbGroupKind | null {
  if (e.kind === 'subagent') return 'subagent'
  if (e.kind !== 'tool') return null
  const k = (e.kindName || '').toLowerCase().replace(/[\s-]+/g, '_')
  const fam = toolFamily(e.kindName)

  if (fam === 'execute' || fam === 'edit') return null
  if (k === 'skill') return 'skill'
  if (fam === 'never') {
    if (k === 'list_dir' || k === 'listdir' || k === 'ls' || k === 'list') return 'dir'
    if (k === 'search' || k === 'grep' || k === 'glob' || k === 'find') return 'search'
    return 'file' // read
  }
  if (k === 'websearch' || k === 'web_search' || k === 'x_search') return 'web_search'
  if (k === 'fetch' || k === 'webfetch' || k === 'web_fetch') return 'web_fetch'
  if (k === 'memory_search' || k === 'memorysearch') return 'memory'
  if (k === 'search_tool' || k === 'integration_search') return 'integration'
  // standard tools that aren't web/mcp discovery don't eager-fold
  if (k === 'mcp' || k === 'use_tool') return null
  return null
}

/** Label bucket (superset — includes Command/Edit/MCP for truncation labels). */
export function labelKind(e: ScrollEntry): VerbGroupKind | null {
  const vg = verbGroupKind(e)
  if (vg) return vg
  if (e.kind === 'tool') {
    const fam = toolFamily(e.kindName)
    if (fam === 'execute') return 'command'
    if (fam === 'edit') return 'edit'
    const k = (e.kindName || '').toLowerCase()
    if (k === 'mcp' || k === 'use_tool') return 'mcp'
    return 'other'
  }
  if (e.kind === 'subagent') return 'subagent'
  return null
}

function isCollapsed(e: ScrollEntry): boolean {
  if (e.kind === 'tool') return !e.expanded
  if (e.kind === 'thought')
    return thoughtDisplayMode(e) === 'collapsed' && !e.streaming
  if (e.kind === 'subagent' || e.kind === 'bg_task' || e.kind === 'workflow') return true
  return false
}

function isRunning(e: ScrollEntry): boolean {
  if (e.kind === 'tool')
    return e.status === 'pending' || e.status === 'in_progress'
  if (e.kind === 'thought') return !!e.streaming
  if (e.kind === 'subagent' || e.kind === 'workflow' || e.kind === 'bg_task')
    return !!e.running
  return false
}

function isFailed(e: ScrollEntry): boolean {
  if (e.kind === 'tool')
    return e.status === 'failed' || e.status === 'error'
  if (e.kind === 'subagent')
    return e.status === 'failed' || e.status === 'cancelled'
  return false
}

function isGroupable(e: ScrollEntry): boolean {
  return e.kind === 'tool' || e.kind === 'subagent' || e.kind === 'thought' || e.kind === 'bg_task'
}

/** run_step — single source of truth for walk classification. */
export function runStep(e: ScrollEntry, showThinking = true): RunStep {
  const vg = verbGroupKind(e)
  if (vg != null) {
    if (isCollapsed(e)) return { kind: 'member', vg }
    // Manually opened member stays in run without splitting it
    return { kind: 'transparent' }
  }
  if (e.kind === 'subagent') {
    if (isCollapsed(e)) return { kind: 'member', vg: 'subagent' }
    return { kind: 'break' }
  }
  if (e.kind === 'thought') {
    if (showThinking && !isRunning(e) && isCollapsed(e) && e.text.trim()) {
      return { kind: 'thought' }
    }
    return { kind: 'transparent' }
  }
  return { kind: 'break' }
}

// ── Verb / noun labels ─────────────────────────────────────────────────

function verbOf(vg: VerbGroupKind, running: boolean): string {
  const table: Record<VerbGroupKind, [string, string]> = {
    file: ['Read', 'Reading'],
    skill: ['Read', 'Reading'],
    search: ['Searched', 'Searching'],
    dir: ['Listed', 'Listing'],
    web_fetch: ['Fetched', 'Fetching'],
    web_search: ['Searched', 'Searching'],
    memory: ['Searched', 'Searching'],
    integration: ['Searched', 'Searching'],
    subagent: ['Ran', 'Running'],
    command: ['Ran', 'Running'],
    edit: ['Edited', 'Editing'],
    mcp: ['Called', 'Calling'],
    other: ['Ran', 'Running'],
  }
  const [past, present] = table[vg]
  return running ? present : past
}

function nounOf(vg: VerbGroupKind, count: number): string {
  const table: Record<VerbGroupKind, [string, string]> = {
    file: ['file', 'files'],
    skill: ['skill', 'skills'],
    search: ['pattern', 'patterns'],
    dir: ['dir', 'dirs'],
    web_fetch: ['website', 'websites'],
    web_search: ['website', 'websites'],
    memory: ['memory', 'memories'],
    integration: ['MCP tool', 'MCP tools'],
    subagent: ['subagent', 'subagents'],
    command: ['command', 'commands'],
    edit: ['file', 'files'],
    mcp: ['MCP tool', 'MCP tools'],
    other: ['tool', 'tools'],
  }
  const [one, many] = table[vg]
  return count === 1 ? one : many
}

// ── Scan ───────────────────────────────────────────────────────────────

type RunScan = { members: number; end: number; stop: number }

function scanRunForward(
  entries: ScrollEntry[],
  start: number,
  showThinking: boolean,
): RunScan | null {
  const first = entries[start]
  if (!first) return null
  const step0 = runStep(first, showThinking)
  if (step0.kind !== 'member' && step0.kind !== 'thought') return null

  let members = 0
  let end = start
  let i = start
  while (i < entries.length) {
    const step = runStep(entries[i], showThinking)
    if (step.kind === 'member') {
      members += 1
      end = i + 1
    } else if (step.kind === 'thought') {
      end = i + 1
    } else if (step.kind === 'transparent') {
      // skip
    } else {
      break
    }
    i += 1
  }
  return { members, end, stop: i }
}

/**
 * Scan verb runs then truncation runs (verb claims break truncation).
 * `groupToolVerbs` defaults true (TUI default).
 */
export function scanGroups(
  entries: ScrollEntry[],
  expandedGroups: ReadonlySet<string>,
  opts: {
    groupToolVerbs?: boolean
    showThinking?: boolean
    maxVisible?: number
  } = {},
): GroupSpan[] {
  const groupToolVerbs = opts.groupToolVerbs !== false
  const showThinking = opts.showThinking !== false
  const maxVisible = opts.maxVisible ?? GROUP_MAX_VISIBLE
  const n = entries.length
  const claimed = new Array<boolean>(n).fill(false)
  const spans: GroupSpan[] = []

  // ── Verb runs ────────────────────────────────────────────────────────
  if (groupToolVerbs && n > 0) {
    let i = 0
    while (i < n) {
      const scan = scanRunForward(entries, i, showThinking)
      if (!scan) {
        i += 1
        continue
      }
      if (scan.members < 1) {
        i = scan.stop
        continue
      }
      for (let j = i; j < scan.end; j++) {
        const step = runStep(entries[j], showThinking)
        if (step.kind === 'member' || step.kind === 'thought') claimed[j] = true
      }
      const anchorId = entries[i].id
      spans.push({
        range: { start: i, end: scan.end },
        kind: { type: 'verb', members: scan.members },
        expanded: expandedGroups.has(anchorId),
        anchorId,
      })
      i = scan.end
    }
  }

  // ── Truncation ("N more") ────────────────────────────────────────────
  if (maxVisible > 0 && n > 0) {
    let i = 0
    while (i < n) {
      if (claimed[i] || !participatesInTruncation(entries[i], showThinking)) {
        i += 1
        continue
      }
      const groupStart = i
      let groupLen = 1
      let j = i + 1
      while (j < n) {
        if (claimed[j]) break
        const e = entries[j]
        if (participatesInTruncation(e, showThinking)) {
          groupLen += 1
        } else if (!(e.kind === 'thought' && !e.text.trim())) {
          // hidden empty thinking is transparent; anything else breaks
          if (e.kind === 'thought' && !isRunning(e) && isCollapsed(e)) {
            // finished collapsed thought inside dense run — skip, don't break
            j += 1
            continue
          }
          break
        }
        j += 1
      }
      const groupEnd = j
      if (groupLen > maxVisible + 1) {
        const anchorId = entries[groupStart].id
        spans.push({
          range: { start: groupStart, end: groupEnd },
          kind: {
            type: 'truncation',
            participants: groupLen,
            hidden: groupLen - maxVisible,
          },
          expanded: expandedGroups.has(anchorId),
          anchorId,
        })
      }
      i = groupEnd
    }
  }

  spans.sort((a, b) => a.range.start - b.range.start)
  return spans
}

function participatesInTruncation(e: ScrollEntry, showThinking: boolean): boolean {
  if (!isGroupable(e) || !isCollapsed(e)) return false
  if (e.kind === 'thought') {
    // hidden empty / streaming thoughts don't participate
    if (!showThinking) return false
    if (isRunning(e) || !e.text.trim()) return false
  }
  return e.kind === 'tool' || e.kind === 'subagent' || e.kind === 'bg_task'
}

// ── Labels ─────────────────────────────────────────────────────────────

export function verbGroupLabel(
  entries: ScrollEntry[],
  span: GroupSpan,
  showThinking = true,
): GroupLabel {
  const buckets = new Map<VerbGroupKind, number>()
  let running = false
  let failedCount = 0
  const order: VerbGroupKind[] = []

  for (let i = span.range.start; i < span.range.end; i++) {
    const e = entries[i]
    if (!e) break
    const step = runStep(e, showThinking)
    if (step.kind === 'break') break
    if (step.kind !== 'member') continue
    if (!buckets.has(step.vg)) {
      buckets.set(step.vg, 0)
      order.push(step.vg)
    }
    buckets.set(step.vg, (buckets.get(step.vg) || 0) + 1)
    if (isRunning(e)) running = true
    if (isFailed(e)) failedCount += 1
  }

  const parts: string[] = []
  for (const vg of order) {
    const count = buckets.get(vg) || 0
    parts.push(`${verbOf(vg, running)} ${count} ${nounOf(vg, count)}`)
  }
  let text = parts.join(', ')
  if (failedCount > 0) text += ` · ${failedCount} failed`
  return { text: text || 'Tools', running, failed: failedCount > 0 }
}

export function truncationLabel(
  entries: ScrollEntry[],
  span: GroupSpan,
  showThinking = true,
): GroupLabel | null {
  if (span.kind.type !== 'truncation') return null
  const hidden = span.kind.hidden
  const buckets = new Map<VerbGroupKind, number>()
  let running = false
  let failedCount = 0
  const order: VerbGroupKind[] = []
  let participants = 0

  for (let i = span.range.start; i < span.range.end; i++) {
    const e = entries[i]
    if (!e) break
    if (e.kind === 'thought' && !e.text.trim()) continue
    if (!participatesInTruncation(e, showThinking) && e.kind === 'thought') continue
    if (!participatesInTruncation(e, showThinking) && e.kind !== 'thought') break
    if (e.kind === 'thought') {
      participants += 1
      if (participants >= hidden) break
      continue
    }
    participants += 1
    const lk = labelKind(e)
    if (!lk) return null
    if (!buckets.has(lk)) {
      buckets.set(lk, 0)
      order.push(lk)
    }
    buckets.set(lk, (buckets.get(lk) || 0) + 1)
    if (isRunning(e)) running = true
    if (isFailed(e)) failedCount += 1
    if (participants >= hidden) break
  }

  if (order.length === 0) return null
  const parts: string[] = []
  for (const vg of order) {
    const count = buckets.get(vg) || 0
    parts.push(`${verbOf(vg, running)} ${count} ${nounOf(vg, count)}`)
  }
  let text = parts.join(', ')
  if (failedCount > 0) text += ` · ${failedCount} failed`
  return { text, running, failed: failedCount > 0 }
}

/** Truncation header label (TUI count excludes the header itself). */
function truncationHeaderLabel(
  entries: ScrollEntry[],
  span: GroupSpan,
  kind: { type: 'truncation'; participants: number; hidden: number },
  showThinking: boolean,
): GroupLabel {
  const base =
    truncationLabel(entries, span, showThinking) ||
    ({ text: `${kind.hidden - 1} more`, running: false, failed: false } satisfies GroupLabel)
  if (!truncationLabel(entries, span, showThinking)) {
    base.text = `${Math.max(0, kind.hidden - 1)} more`
  }
  return base
}

/**
 * Build a group-header row, reusing the cached row when the span object is
 * unchanged (see projectDisplayRows' headerCache). `makeLabel` is lazy —
 * on a cache hit it never runs, so the per-flush label recompute
 * (runStep over the span members) disappears.
 */
function headerRowFor(
  span: GroupSpan,
  family: 'verb' | 'truncation',
  makeLabel: () => GroupLabel,
  cache?: Map<GroupSpan, DisplayRow>,
): DisplayRow {
  const cached = cache?.get(span)
  if (cached) return cached
  const row: DisplayRow = {
    type: 'group_header',
    id: `gh_${span.anchorId}`,
    span,
    label: makeLabel(),
    family,
  }
  cache?.set(span, row)
  return row
}

// ── Project to display rows ────────────────────────────────────────────

/**
 * Build the flat list of rows the scrollback renders.
 * Collapsed verb/truncation members are omitted; headers are synthetic.
 *
 * `headerCache` (optional): span-keyed map of previously built header rows.
 * Scrollback caches spans keyed on groupingSignature — on a cache hit every
 * span is the same object, so header rows (label text included) are reused
 * verbatim and the per-flush label recompute + header re-render disappear.
 */
export function projectDisplayRows(
  entries: ScrollEntry[],
  spans: GroupSpan[],
  showThinking = true,
  headerCache?: Map<GroupSpan, DisplayRow>,
): DisplayRow[] {
  const spanByStart = new Map(spans.map((s) => [s.range.start, s]))
  const hidden = new Set<number>()

  // Mark hidden indices for collapsed folds
  for (const span of spans) {
    if (span.expanded) {
      if (span.kind.type === 'verb') {
        // expanded verb: all members visible; header is extra synthetic row
        continue
      }
      // expanded truncation: all participants visible + collapse header
      continue
    }
    if (span.kind.type === 'verb') {
      // collapsed: only header shows; claimed members/thoughts hidden
      for (let i = span.range.start; i < span.range.end; i++) {
        const step = runStep(entries[i], showThinking)
        if (step.kind === 'member' || step.kind === 'thought') hidden.add(i)
      }
    } else {
      // collapsed truncation: hide the oldest `hidden` participants
      const toHide = span.kind.hidden
      let seen = 0
      for (let i = span.range.start; i < span.range.end && seen < toHide; i++) {
        if (!participatesInTruncation(entries[i], showThinking)) {
          if (entries[i]?.kind === 'thought') continue
          break
        }
        hidden.add(i)
        seen += 1
      }
    }
  }

  const rows: DisplayRow[] = []
  let i = 0
  while (i < entries.length) {
    const span = spanByStart.get(i)
    if (span && !span.expanded && span.kind.type === 'verb') {
      rows.push(headerRowFor(span, 'verb', () => verbGroupLabel(entries, span, showThinking), headerCache))
      i = span.range.end
      continue
    }
    if (span && !span.expanded && span.kind.type === 'truncation') {
      const kind = span.kind
      rows.push(
        headerRowFor(span, 'truncation', () => truncationHeaderLabel(entries, span, kind, showThinking), headerCache),
      )
      // skip hidden prefix; emit remaining visible tail
      for (let j = span.range.start; j < span.range.end; j++) {
        if (hidden.has(j)) continue
        rows.push({ type: 'entry', entry: entries[j], index: j })
      }
      i = span.range.end
      continue
    }
    if (span && span.expanded && span.kind.type === 'verb') {
      // collapse header + all claimed entries (transparent keep their rows too)
      rows.push(headerRowFor(span, 'verb', () => verbGroupLabel(entries, span, showThinking), headerCache))
      for (let j = span.range.start; j < span.range.end; j++) {
        rows.push({ type: 'entry', entry: entries[j], index: j })
      }
      i = span.range.end
      continue
    }
    if (span && span.expanded && span.kind.type === 'truncation') {
      const kind = span.kind
      rows.push(
        headerRowFor(
          span,
          'truncation',
          () => {
            const tlab = truncationLabel(entries, span, showThinking)
            return {
              text: tlab?.text || `${kind.participants - 1} tool calls`,
              running: tlab?.running || false,
              failed: tlab?.failed || false,
            }
          },
          headerCache,
        ),
      )
      for (let j = span.range.start; j < span.range.end; j++) {
        rows.push({ type: 'entry', entry: entries[j], index: j })
      }
      i = span.range.end
      continue
    }

    if (!hidden.has(i)) {
      rows.push({ type: 'entry', entry: entries[i], index: i })
    }
    i += 1
  }
  return rows
}

/**
 * Find group span containing entry index (if any).
 * Spans are sorted by `range.start` (scanGroups sorts before returning),
 * so this is a binary search — called once per displayed row, linear
 * find would be O(rows × spans) per flush.
 */
export function spanContaining(
  spans: GroupSpan[],
  idx: number,
): GroupSpan | undefined {
  let lo = 0
  let hi = spans.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid].range.start <= idx) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (found === -1) return undefined
  const s = spans[found]
  return idx < s.range.end ? s : undefined
}

/**
 * Cheap per-entry signature of the fields that participate in grouping
 * (verb runs / truncation folds). Text CONTENT is deliberately excluded:
 * streaming appends change only the text, and running/streaming entries
 * never participate in grouping — so the signature is stable across
 * streaming flushes and scanGroups can be skipped (Scrollback caches
 * spans keyed on this signature).
 *
 * The id fold (length + first/last chars + djb2) detects insertion,
 * removal and reorder of entries that carry identical grouping flags.
 */
export function groupingSignature(entries: ScrollEntry[]): string {
  const parts = new Array<string>(entries.length + 1)
  parts[0] = `${entries.length}:`
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const id = e.id
    let h = 5381
    for (let j = 0; j < id.length; j++) {
      h = ((h << 5) + h + id.charCodeAt(j)) | 0
    }
    let s = `${e.kind[0]}${id.length}${id[0] ?? ''}${id[id.length - 1] ?? ''}${h.toString(36)}`
    switch (e.kind) {
      case 'tool':
        s += `${e.expanded ? '1' : '0'}${e.status ?? ''}`
        break
      case 'thought':
        s += `${thoughtDisplayMode(e)[0]}${e.streaming ? 's' : ''}${e.text.trim() ? 'x' : ''}`
        break
      case 'subagent':
        s += `${e.status ?? ''}${e.running ? 'r' : ''}`
        break
      case 'bg_task':
        s += `${e.running ? 'r' : ''}`
        break
    }
    parts[i + 1] = s
  }
  return parts.join('')
}

// ── 显示行辅助（主 scrollback 与迷你 scrollback 共用）──────────────────

/**
 * TUI gap rule (recompute_gap_after): gap=0 between consecutive collapsed
 * groupable rows; gap=1 otherwise. Dense packable = tool/thought/subagent/
 * group_header one-liners that participate in dense runs.
 */
export function isDensePackable(e: ScrollEntry): boolean {
  if (e.kind === 'group_header') return true
  if (e.kind === 'tool') return !e.expanded
  if (e.kind === 'thought')
    return thoughtDisplayMode(e) === 'collapsed' && !e.streaming
  if (e.kind === 'subagent' || e.kind === 'bg_task' || e.kind === 'workflow')
    return true
  return false
}

export function isDensePackableRow(row: DisplayRow): boolean {
  if (row.type === 'group_header') return true
  return isDensePackable(row.entry)
}

/** 显示行的稳定 key（主 scrollback 与迷你 scrollback 共用）。 */
export function displayRowKey(row: DisplayRow): string {
  return row.type === 'entry' ? row.entry.id : row.id
}
