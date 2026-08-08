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

// ── Project to display rows ────────────────────────────────────────────

/**
 * Build the flat list of rows the scrollback renders.
 * Collapsed verb/truncation members are omitted; headers are synthetic.
 */
export function projectDisplayRows(
  entries: ScrollEntry[],
  spans: GroupSpan[],
  showThinking = true,
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
      rows.push({
        type: 'group_header',
        id: `gh_${span.anchorId}`,
        span,
        label: verbGroupLabel(entries, span, showThinking),
        family: 'verb',
      })
      i = span.range.end
      continue
    }
    if (span && !span.expanded && span.kind.type === 'truncation') {
      const label =
        truncationLabel(entries, span, showThinking) ||
        ({
          text: `${span.kind.hidden - 1} more`,
          running: false,
          failed: false,
        } satisfies GroupLabel)
      // TUI count excludes the header itself: hidden - 1 for plain "N more"
      if (!truncationLabel(entries, span, showThinking)) {
        label.text = `${Math.max(0, span.kind.hidden - 1)} more`
      }
      rows.push({
        type: 'group_header',
        id: `gh_${span.anchorId}`,
        span,
        label,
        family: 'truncation',
      })
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
      rows.push({
        type: 'group_header',
        id: `gh_${span.anchorId}`,
        span,
        label: verbGroupLabel(entries, span, showThinking),
        family: 'verb',
      })
      for (let j = span.range.start; j < span.range.end; j++) {
        rows.push({ type: 'entry', entry: entries[j], index: j })
      }
      i = span.range.end
      continue
    }
    if (span && span.expanded && span.kind.type === 'truncation') {
      rows.push({
        type: 'group_header',
        id: `gh_${span.anchorId}`,
        span,
        label: {
          text:
            truncationLabel(entries, span, showThinking)?.text ||
            `${span.kind.participants - 1} tool calls`,
          running: truncationLabel(entries, span, showThinking)?.running || false,
          failed: truncationLabel(entries, span, showThinking)?.failed || false,
        },
        family: 'truncation',
      })
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

/** Find group span containing entry index (if any). */
export function spanContaining(
  spans: GroupSpan[],
  idx: number,
): GroupSpan | undefined {
  return spans.find((s) => idx >= s.range.start && idx < s.range.end)
}
