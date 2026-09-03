/**
 * TUI verb-group + truncation fold port
 * (xai-grok-pager scrollback/state/verb_group.rs + groups.rs).
 *
 * Verb runs: consecutive collapsed non-destructive tools and subagent
 * rows fold into one "Read 3 files, Ran 2 subagents" header. Sealed
 * collapsed thoughts claim into the run (hidden when folded) but never
 * count toward the member threshold.
 * Truncation: long dense collapsed-groupable runs — tools AND sealed
 * collapsed thoughts (thought-tool-thought alternation included) — hide
 * the oldest rows behind one header. The header label counts the WHOLE
 * run (FE deviation: the TUI counts only the hidden prefix). The fold
 * TRIGGER counts tools only, so short thought-tool alternation stays
 * flat (thoughts hide / label with the group once it forms). A manually
 * expanded thought keeps its participant slot (still counted, exempt
 * from hiding) so opening it never shifts counts or slides rows.
 */

import type { HookCounts, ScrollEntry, ToolHookData } from '../api/types'
import { toolFamily } from '../theme/toolFamily'
import { readPathOf, skillNameFromPath } from './toolDetail'
import { thoughtDisplayMode } from './thoughtMode'
import { groupHookCounts, hookCountsTotal } from './hookRuns'

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
  /** Labeled `[hooks: 1 ok, 1 blocked]` suffix (TUI verb headers only). */
  hookCounts?: HookCounts
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
    // TUI ReadToolCallBlock::is_skill_read — reads of `SKILL.md` group as
    // skills ("Read 2 skills"), not plain files.
    if (skillNameFromPath(e.raw ? readPathOf(e.raw) : e.title)) return 'skill'
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
    // 收口思考(含空文本噪音行)认领进 run,折叠时随组隐藏——空文本的
    // 光杆 "Thought" 行不该漏在折叠组外。流式/手动展开保持 transparent:
    // 实时与用户主动打开的内容不藏。
    if (showThinking && !isRunning(e) && isCollapsed(e)) {
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
 * 分组展开态：expandedGroups 记录「与默认方向相反」的手动切换——默认
 * 折叠（defaultExpanded=false）时集合里有 anchor = 用户展开了该组；
 * 默认展开（true）时集合里有 anchor = 用户收起了该组。
 */
export function spanExpanded(
  anchorId: string,
  expandedGroups: ReadonlySet<string>,
  defaultExpanded: boolean,
): boolean {
  const flipped = expandedGroups.has(anchorId)
  return defaultExpanded ? !flipped : flipped
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
    /** 分组默认展开（false = 默认折叠成分组头，TUI 默认）。 */
    defaultExpanded?: boolean
  } = {},
): GroupSpan[] {
  const groupToolVerbs = opts.groupToolVerbs !== false
  const showThinking = opts.showThinking !== false
  const maxVisible = opts.maxVisible ?? GROUP_MAX_VISIBLE
  const defaultExpanded = opts.defaultExpanded === true
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
      // TUI RunScan::folds: members >= 1（verb_group.rs）。纯 subagent
      // 也折——紧凑的 "Running N subagents" 头优于 N 条独立行，且第一
      // 个成员到达即出 header，避免第二条进来时从单行跳成组头。thought
      // 认领进 run 但不计数，纯思考 walk（标签会空）永不折。
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
        expanded: spanExpanded(anchorId, expandedGroups, defaultExpanded),
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
      // 触发计数按全参与者（TUI groups.rs:220-235 group_len 含收口思考，
      // 仅隐藏思考剔除）：思考-工具交替段与纯工具回合同门槛折叠
      // （groupLen > maxVisible + 1）。隐藏思考（showThinking=false）透明
      // 不计数；流式思考不计数也不打断（FE 直播行语义，见下）。
      let j = i + 1
      while (j < n) {
        if (claimed[j]) break
        const e = entries[j]
        if (participatesInTruncation(e, showThinking)) {
          groupLen += 1
        } else if (e.kind === 'thought') {
          // 思考永不截断密集段（与 verb 扫描的 transparent 语义一致）。
          // 走到这里的是流式思考（直播行不计数、不隐藏）以及
          // showThinking=false 时的全部思考；展开的思考已计入参与者。
          j += 1
          continue
        } else {
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
          expanded: spanExpanded(anchorId, expandedGroups, defaultExpanded),
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
  if (!isGroupable(e)) return false
  if (e.kind === 'thought') {
    // 收口思考（含空文本噪音行）计入截断密度，且**展开不退出参与者集合**：
    // 手动打开只豁免隐藏（projectDisplayRows 里跳过），参与数 / 隐藏预算 /
    // 标签计数全部不动——否则点开一条 thought 会让 hidden 预算 +1，尾部
    // 滑出一条旧行。流式思考不参与（直播行不进数字）。
    return showThinking && !e.streaming
  }
  return (
    isCollapsed(e) && (e.kind === 'tool' || e.kind === 'subagent' || e.kind === 'bg_task')
  )
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
  const hookMembers: Array<{ hooks?: ToolHookData }> = []

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
    if (e.kind === 'tool') hookMembers.push(e)
  }

  const parts: string[] = []
  for (const vg of order) {
    const count = buckets.get(vg) || 0
    parts.push(`${verbOf(vg, running)} ${count} ${nounOf(vg, count)}`)
  }
  let text = parts.join(', ')
  if (failedCount > 0) text += ` · ${failedCount} failed`
  const hookCounts = groupHookCounts(hookMembers)
  const hasHooks = hookCountsTotal(hookCounts) > 0
  return {
    text: text || 'Tools',
    running,
    failed: failedCount > 0 || hookCounts.failed > 0,
    ...(hasHooks ? { hookCounts } : {}),
  }
}

/**
 * Truncation 组标签（TUI verb_group.rs:273-305 truncation_header_label）：
 * 与 verb 组头同一套动词条表，但按 `limit` 只描述**被隐藏的前缀**——
 * 折叠头 limit=hidden，展开头不传（描述整段）。思考行占参与者名额、
 * 永不进词表（TUI "Thoughts … are NEVER bucketed"，无 Thought N times）；
 * showThinking=false 的隐藏思考整行跳过（不占名额）。遇到词表叫不出
 * 名字的非思考参与者（bg_task 等）整个放弃（返回 null → 回落 "N more"），
 * 否则标签会对折叠隐藏的内容撒谎。
 */
export function truncationLabel(
  entries: ScrollEntry[],
  span: GroupSpan,
  showThinking = true,
  limit?: number,
): GroupLabel | null {
  if (span.kind.type !== 'truncation') return null
  const buckets = new Map<VerbGroupKind, number>()
  let running = false
  let failedCount = 0
  let participants = 0
  const order: VerbGroupKind[] = []

  for (let i = span.range.start; i < span.range.end; i++) {
    const e = entries[i]
    if (!e) break
    if (limit != null && participants >= limit) break
    // 隐藏思考（showThinking=false）：透明行，不占名额不进词表。
    if (e.kind === 'thought' && !showThinking) continue
    // 流式思考（直播行，不参与截断计数）同样跳过不占名额。
    if (e.kind === 'thought' && e.streaming) continue
    participants += 1
    // 思考占名额但永不进词表。
    if (e.kind === 'thought') continue
    const lk = labelKind(e)
    if (!lk) return null
    if (!buckets.has(lk)) {
      buckets.set(lk, 0)
      order.push(lk)
    }
    buckets.set(lk, (buckets.get(lk) || 0) + 1)
    if (isRunning(e)) running = true
    if (isFailed(e)) failedCount += 1
  }

  const parts: string[] = []
  for (const vg of order) {
    const count = buckets.get(vg) || 0
    parts.push(`${verbOf(vg, running)} ${count} ${nounOf(vg, count)}`)
  }
  if (parts.length === 0) return null
  let text = parts.join(', ')
  if (failedCount > 0) text += ` · ${failedCount} failed`
  return { text, running, failed: failedCount > 0 }
}

/**
 * Truncation header label — 折叠头只描述 hidden 前缀（limit=hidden，
 * render.rs:421 `(!span.expanded).then_some(hidden)`），展开头描述整段。
 * 退化（前缀无可命名参与者，如纯思考前缀）时回落 "N more"。
 */
function truncationHeaderLabel(
  entries: ScrollEntry[],
  span: GroupSpan,
  kind: { type: 'truncation'; participants: number; hidden: number },
  showThinking: boolean,
): GroupLabel {
  return (
    truncationLabel(
      entries,
      span,
      showThinking,
      span.expanded ? undefined : Math.max(0, kind.hidden),
    ) || {
      text: `${Math.max(0, kind.hidden)} more`,
      running: false,
      failed: false,
    }
  )
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
      // （thought 参与者一并藏进前缀；透明行跳过、不打断前缀计数）。
      // 展开的思考占参与者名额但豁免隐藏——保持可见，预算由其余参与者补齐。
      const toHide = span.kind.hidden
      let seen = 0
      for (let i = span.range.start; i < span.range.end && seen < toHide; i++) {
        const e = entries[i]
        if (e?.kind === 'thought' && !isCollapsed(e)) continue
        if (!participatesInTruncation(e, showThinking)) {
          if (e?.kind === 'thought') continue
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
          () => truncationHeaderLabel(entries, span, kind, showThinking),
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
        // kindName 决定 verbGroupKind/labelKind 的归类（tool_call_update 后到
        // 的 _meta 会改写它），漏进签名会让 span 缓存停留在旧分组上。
        s += `${e.expanded ? '1' : '0'}${e.status ?? ''}|${
          typeof e.kindName === 'string' ? e.kindName : ''
        }`
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
