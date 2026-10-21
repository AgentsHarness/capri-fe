/**
 * TUI verb-group fold port (xai-grok-pager scrollback/state/verb_group.rs +
 * groups.rs，口径对齐真机 grok 1.0.62 的 `/density` 五档).
 *
 * Verb runs: 连续的、按当前密度参与分组的工具行折成一行聚合头
 * （`Explored 3 files, 2 searches` / `Edited 2 files, ran 1 command`）。
 * 收口思考认领进 run（折叠时随组隐藏），但不计入成员数；流式 / 手动展开
 * 的思考保持透明，既不认领也不打断。
 *
 * 单条规则：段里只有一个成员时**不**折——它保留自己的行（`Read a.py`、
 * `Edit report.py`）。被 200 条上限切出来的尾段同样适用：尾段只剩 1 条时
 * 也单独显示。聚合头只在段里至少有 2 个成员时出现。
 *
 * 展开不影响分组结构：手动展开的成员仍算这一段的成员（参与成员数、组边界
 * 与聚合头数字），只是自己保持可见。展开组里 2 条中的 1 条，组不会解散，
 * 上下条目也不会重新分组。
 *
 * 密度（`[ui] tool_call_density`）决定哪些工具参与分组：
 *  - 读取 / 搜索 / 列目录 / 其他工具在所有档位都折成 `Explored …` 段。
 *  - detailed / compact-shells / compact-ungrouped：编辑与命令逐条显示。
 *  - compact-grouped：编辑段、命令段各自成组（`Edited report.py +1 -1`
 *    / `Ran 2 commands`），两族之间不并组。
 *  - compact-all-grouped（默认）：所有连续工具调用合成一组
 *    （`Edited report.py, explored 2 files, ran 2 commands +1 -1`）。
 *
 * 段长上限：每段最多 200 个成员，超出的部分另起一段（真机 1.0.62 实测
 * 300 条命令 → `Ran 200 commands` + `Ran 100 commands`）。旧的
 * `group_max_visible` 截断（头部藏最旧 10 条、标签 "N more"）在 1.0.62
 * 已失效，FE 不再实现。
 */

import type { ScrollEntry } from '../api/types'
import { isCreateToolKind, toolFamily } from '../theme/toolFamily'
import { extractToolDetail, readPathOf } from './toolDetail'
import { thoughtDisplayMode } from './thoughtMode'

/**
 * Label buckets. `file` / `search` / `dir` / `other` are the eager verb-fold
 * kinds; `edit` / `command` join only at the grouped densities; `subagent`
 * never folds (1.0.62 keeps its own `Subagent …` row).
 */
export type VerbGroupKind =
  | 'file'
  | 'search'
  | 'dir'
  | 'other' // web / MCP / 未分类工具，标签统一叫 "tool"
  | 'edit' // 就地修改
  | 'create' // 新建文件（write / create）
  | 'command'

export type RunStep =
  /** 参与分组的成员（折叠态）。 */
  | { kind: 'member'; vg: VerbGroupKind }
  /** 认领进 run 的收口思考（折叠时随组隐藏）。 */
  | { kind: 'thought' }
  /**
   * 手动展开的工具成员：仍算这段 run 的成员（参与成员数、组边界、族判定与
   * 聚合头数字），只是自己保持可见、不随折叠头隐藏。展开因此不改变分组
   * 结构——组里 2 条时展开 1 条，组不会解散、上下也不会重新分组。
   */
  | { kind: 'open'; vg: VerbGroupKind }
  /** 不参与分组、也不劈开 run 的行（流式 / 手动展开的思考）。 */
  | { kind: 'transparent' }
  /** 分组边界（非工具行、不参与当前密度的工具）。 */
  | { kind: 'break' }

export type GroupKind = { type: 'verb'; members: number }

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
  /**
   * 段内编辑的增删行数（官方 density 预览的彩色 `+1 -1`）。只在段内有
   * 编辑 / 新建时出现；renderer 把它画在标签右侧。
   */
  diffstat?: { insertions: number; deletions: number }
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

/** 每段最多容纳的成员数（真机 1.0.62 实测上限）。 */
export const GROUP_MAX_MEMBERS = 200

/** 分组范围：哪些工具族参与折组，以及各族是否分开成组。 */
export type GroupScope = {
  /** 读取 / 搜索 / 列目录 / 其他工具（`Explored …` 段）。 */
  explore: boolean
  /** 编辑 / 新建文件（`Edited …` 段）。 */
  edits: boolean
  /** shell 命令（`Ran …` 段）。 */
  commands: boolean
  /**
   * true = 编辑段、命令段、探查段各自成组，不互相并组（grouped 档）；
   * false = 所有参与的族合成一段（compact 档）。
   */
  separateFamilies: boolean
}

/** 默认档（compact-all-grouped）：所有工具参与，且合成一组。 */
const SCOPE_ALL: GroupScope = {
  explore: true,
  edits: true,
  commands: true,
  separateFamilies: false,
}
/** 更详细的档位：只折探查类工具（`Explored 2 files, 1 search`）。 */
const SCOPE_EXPLORE: GroupScope = {
  explore: true,
  edits: false,
  commands: false,
  separateFamilies: false,
}

/**
 * 密度档 → 分组范围（对齐官方 density 预览）。
 *  - detailed / compact-shells / compact-ungrouped：只折探查类工具；
 *    编辑与命令逐条显示。
 *  - compact-grouped：编辑段、命令段各自成组，与探查段互不并组。
 *  - compact-all-grouped：所有连续工具调用合成一组。
 */
export function groupScopeForDensity(density: string): GroupScope {
  switch (density) {
    case 'detailed':
    case 'compact-shells':
    case 'compact-ungrouped':
      return SCOPE_EXPLORE
    case 'compact-grouped':
      return { ...SCOPE_ALL, separateFamilies: true }
    // compact-all-grouped 与未知值（旧 host / 手改坏的配置）都按默认档。
    default:
      return SCOPE_ALL
  }
}

// ── Classification ─────────────────────────────────────────────────────

function normalizedKind(kindName: string | undefined): string {
  return (kindName || '').toLowerCase().replace(/[\s-]+/g, '_')
}

/**
 * run_step 用的成员桶。真机 1.0.62 的词表只有四种可命名桶：文件 / 目录 /
 * 搜索 / 其他工具。技能读取并入 files（`Explored 2 files`），web、MCP、
 * 未分类工具一律 `called N tools`。
 */
export function verbGroupKind(
  e: ScrollEntry,
  scope: GroupScope = SCOPE_ALL,
): VerbGroupKind | null {
  if (e.kind !== 'tool') return null
  const k = normalizedKind(e.kindName)
  const fam = toolFamily(e.kindName)
  if (fam === 'execute') return scope.commands ? 'command' : null
  if (fam === 'edit')
    return scope.edits ? (isCreateToolKind(e.kindName) ? 'create' : 'edit') : null
  if (!scope.explore) return null
  if (fam === 'never') {
    if (k === 'list_dir' || k === 'listdir' || k === 'ls' || k === 'list') return 'dir'
    if (k === 'search' || k === 'grep' || k === 'glob' || k === 'find') return 'search'
    // 技能读取与普通文件读取同桶（1.0.62：两个 SKILL.md → "Explored 2 files"）。
    return 'file'
  }
  // memory_v2_activity 的读写/搜索在 1.0.62 仍按原桶归类（实测两条
  // memory 读 → "Explored 2 files"），因此这里不再单列 memory 桶。
  return 'other'
}

/** 兼容导出：标签桶与成员桶一致（1.0.62 只有一组词表）。 */
export function labelKind(
  e: ScrollEntry,
  scope: GroupScope = SCOPE_ALL,
): VerbGroupKind | null {
  return verbGroupKind(e, scope)
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

/**
 * run_step — 单一路径的走查分类。subagent 行在 1.0.62 恒单独成行（`Break`），
 * 与本组无关；bg_task / workflow 也打破 run（它们的行自带状态）。
 */
export function runStep(
  e: ScrollEntry,
  showThinking = true,
  scope: GroupScope = SCOPE_ALL,
): RunStep {
  if (e.kind === 'tool') {
    const vg = verbGroupKind(e, scope)
    if (vg == null) return { kind: 'break' }
    // 展开的成员仍算这段的成员（只是不隐藏）：若把它排除在成员之外，
    // 组里 2 条时展开 1 条会让组掉到 1 个成员而解散，上下条目随之重新分组。
    // 正在跑的尾部成员例外，见 scanRunForward 的收尾裁剪。
    return isCollapsed(e) ? { kind: 'member', vg } : { kind: 'open', vg }
  }
  if (e.kind === 'thought') {
    // 收口思考（含空文本噪音行）认领进 run；流式 / 手动展开保持透明。
    if (showThinking && !isRunning(e) && isCollapsed(e)) return { kind: 'thought' }
    return { kind: 'transparent' }
  }
  return { kind: 'break' }
}

// ── Verb / noun labels ─────────────────────────────────────────────────

/**
 * 聚合头动词。文件 / 目录 / 搜索归 `Explored`，其余工具（web、MCP、未分类）
 * 归 `Called`，编辑 `Edited`，命令 `Ran`。1.0.62 的聚合头不使用进行时——
 * 运行中的段落也用过去式。
 */
function verbOf(vg: VerbGroupKind): string {
  switch (vg) {
    case 'edit':
      return 'Edited'
    case 'create':
      return 'Created'
    case 'command':
      return 'Ran'
    case 'other':
      return 'Called'
    default:
      return 'Explored'
  }
}

type Phrase = {
  /** 名词单数 / 复数（`files` / `directories`…）。 */
  noun: string
  nounPlural: string
}

/** 每种桶的名词与短语模板（`Explored 2 files` / `Explored a.py`）。 */
const PHRASES: Record<VerbGroupKind, Phrase> = {
  file: { noun: 'file', nounPlural: 'files' },
  dir: { noun: 'directory', nounPlural: 'directories' },
  search: { noun: 'search', nounPlural: 'searches' },
  other: { noun: 'tool', nounPlural: 'tools' },
  edit: { noun: 'file', nounPlural: 'files' },
  create: { noun: 'file', nounPlural: 'files' },
  command: { noun: 'command', nounPlural: 'commands' },
}

/** 聚合头里桶的固定顺序（与出现顺序无关；真机实测）。 */
const BUCKET_ORDER: VerbGroupKind[] = [
  'create',
  'edit',
  'dir',
  'file',
  'search',
  'other',
  'command',
]


type Bucket = {
  vg: VerbGroupKind
  members: ScrollEntry[]
}

/**
 * 单值命名：某桶只有一个成员、且它是整条标签里的**第一个**短语时，
 * 用成员自己的名字代替数字——`Explored a.py`、`Explored work`、
 * `Edited a.py`、`Ran ls`。后续短语一律用数字（`Explored a.py, 1 search`）。
 */
function singleName(e: Extract<ScrollEntry, { kind: 'tool' }>): string | undefined {
  if (e.kind !== 'tool') return undefined
  const k = normalizedKind(e.kindName)
  if (k === 'list_dir' || k === 'listdir' || k === 'ls' || k === 'list') {
    const path = listDirPath(e)
    if (!path) return undefined
    const tail = path.replace(/\/+$/, '').split('/').pop()
    return tail || path
  }
  if (k === 'search' || k === 'grep' || k === 'glob' || k === 'find') return undefined
  const path = readPathOf(e.raw ?? {}) || e.title
  if (!path) return undefined
  const tail = path.replace(/\/+$/, '').split('/').pop()
  return tail || undefined
}

function listDirPath(e: Extract<ScrollEntry, { kind: 'tool' }>): string | undefined {
  const input = e.raw?.rawInput as Record<string, unknown> | undefined
  const v = input?.target_directory ?? input?.path ?? input?.directory ?? e.title
  return typeof v === 'string' && v ? v : undefined
}

/** `Ran ls`, `Edit a.py`：命令用 description，编辑用文件名。 */
function commandName(e: Extract<ScrollEntry, { kind: 'tool' }>): string | undefined {
  const input = e.raw?.rawInput as Record<string, unknown> | undefined
  const v = input?.description ?? input?.command ?? e.title
  return typeof v === 'string' && v ? v : undefined
}

function editName(e: Extract<ScrollEntry, { kind: 'tool' }>): string | undefined {
  const input = e.raw?.rawInput as Record<string, unknown> | undefined
  const v = input?.file_path ?? input?.path ?? e.title
  if (typeof v !== 'string' || !v) return undefined
  return v.replace(/\/+$/, '').split('/').pop() || v
}

function memberName(
  e: ScrollEntry,
  vg: VerbGroupKind,
): string | undefined {
  if (e.kind !== 'tool') return undefined
  if (vg === 'command') return commandName(e)
  if (vg === 'edit' || vg === 'create') return editName(e)
  // 文件 / 目录用路径末段；搜索与"其他工具"没有单值命名（真机恒用数字）。
  if (vg === 'file' || vg === 'dir') return singleName(e)
  return undefined
}
/** 逐段扫成员、按固定桶序拼标签。 */
function buildLabel(
  entries: ScrollEntry[],
  range: { start: number; end: number },
  showThinking: boolean,
  scope: GroupScope,
): GroupLabel {
  const buckets = new Map<VerbGroupKind, Bucket>()
  let running = false
  let failed = false
  for (let i = range.start; i < range.end; i++) {
    const e = entries[i]
    if (!e) break
    const step = runStep(e, showThinking, scope)
    if (step.kind === 'break') break
    // 展开的成员照常计入聚合头：展开不改数字。
    if (step.kind !== 'member' && step.kind !== 'open') continue
    let b = buckets.get(step.vg)
    if (!b) {
      b = { vg: step.vg, members: [] }
      buckets.set(step.vg, b)
    }
    b.members.push(e)
    if (isRunning(e)) running = true
    if (isFailed(e)) failed = true
  }

  const parts: string[] = []
  let lastVerb: string | undefined
  for (const vg of BUCKET_ORDER) {
    const b = buckets.get(vg)
    if (!b) continue
    const count = b.members.length
    const p = PHRASES[vg]
    const verb = verbOf(vg)
    // 同一动词的相邻桶省略重复动词：`Explored 1 directory, 1 file, 1 search`。
    // 动词变化时才重写（`Edited 2 files, explored 1 file`）。
    const lead = parts.length === 0
    const showVerb = verb !== lastVerb
    lastVerb = verb
    // 第一个短语且只有一个成员 → 用成员名字代替数字。
    if (lead && count === 1) {
      const name = memberName(b.members[0], vg)
      parts.push(name ? `${verb} ${name}` : `${verb} 1 ${p.noun}`)
    } else if (showVerb) {
      parts.push(`${verb} ${count} ${count === 1 ? p.noun : p.nounPlural}`)
    } else {
      parts.push(`${count} ${count === 1 ? p.noun : p.nounPlural}`)
    }
  }

  // 只有第一个短语首字母大写，后续短语小写（`Edited a.py, explored 1 file`）。
  const text = parts
    .map((part, i) => (i === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1)))
    .join(', ')

  // 段内编辑的 diffstat（官方密度预览：`Edited report.py, … ran 2 commands +1 -1`）。
  let insertions = 0
  let deletions = 0
  let hasEdits = false
  for (const vg of ['edit', 'create'] as const) {
    const b = buckets.get(vg)
    if (!b) continue
    hasEdits = true
    for (const m of b.members) {
      if (m.kind !== 'tool' || !m.raw) continue
      const d = extractToolDetail(m.raw, m.kindName)
      if (d.kind !== 'edit') continue
      insertions += d.insertions
      deletions += d.deletions
    }
  }
  return {
    text: text || 'Tools',
    running,
    failed,
    ...(hasEdits ? { diffstat: { insertions, deletions } } : {}),
  }
}

/** 全段标签（展开态 / 截断头共用）。 */
export function verbGroupLabel(
  entries: ScrollEntry[],
  span: GroupSpan,
  showThinking = true,
  scope: GroupScope = SCOPE_ALL,
): GroupLabel {
  return buildLabel(entries, span.range, showThinking, scope)
}

/** 1.0.62 已无 "N more" 截断头；保留函数签名供旧调用方，恒返回 null。 */
export function truncationLabel(): GroupLabel | null {
  return null
}

// ── Scan ───────────────────────────────────────────────────────────────

type RunScan = {
  members: number
  thoughts: number
  end: number
  stop: number
  /** 段内的桶集合（separateFamilies 判族用）。 */
  kinds: Set<VerbGroupKind>
}

/** 从 start 起走一段最大 200 成员的 run。 */
function scanRunForward(
  entries: ScrollEntry[],
  start: number,
  showThinking: boolean,
  scope: GroupScope,
): RunScan | null {
  const first = entries[start]
  if (!first) return null
  const step0 = runStep(first, showThinking, scope)
  if (
    step0.kind !== 'member' &&
    step0.kind !== 'open' &&
    step0.kind !== 'thought'
  ) {
    return null
  }

  let members = 0
  let end = start
  let thoughts = 0
  const kinds = new Set<VerbGroupKind>()
  /** 段内最后一个工具成员的索引，以及它计入时的成员序号。 */
  let lastToolIdx = -1
  let lastToolOrdinal = 0
  let i = start
  while (i < entries.length) {
    const step = runStep(entries[i], showThinking, scope)
    if (step.kind === 'member' || step.kind === 'open') {
      if (members >= GROUP_MAX_MEMBERS) break
      kinds.add(step.vg)
      // separateFamilies：族一变就收口，编辑段 / 命令段 / 探查段各自成组。
      if (
        scope.separateFamilies &&
        members > 0 &&
        !sameFamily(kinds, step.vg)
      ) {
        break
      }
      members += 1
      end = i + 1
      lastToolIdx = i
      lastToolOrdinal = members
    } else if (step.kind === 'thought') {
      thoughts += 1
      end = i + 1
    } else if (step.kind === 'transparent') {
      // 跳过：透明行留在 run 内，既不算成员也不延长 claimed 边界
    } else {
      break
    }
    i += 1
  }
  // 段里最后一个工具调用还在跑 → 把它（及它之后的收口思考）留在组外：
  // 正在输出的行缩进折叠头后面就看不到了。它跑完进终态后下一帧再入组。
  // 注意 stop 仍指向整段末尾（不是裁剪点）：外层扫描要从这里继续前进，
  // 否则指针原地不动会死循环。
  const tail = lastToolIdx >= 0 ? entries[lastToolIdx] : undefined
  if (tail?.kind === 'tool' && isRunning(tail)) {
    return {
      members: lastToolOrdinal - 1,
      thoughts: 0,
      end: lastToolIdx,
      stop: i,
      kinds,
    }
  }
  return { members, thoughts, end, stop: i, kinds }
}

/** 工具族：编辑 / 新建同属编辑族，探查类同属探查族，命令单独一族。 */
function familyOf(vg: VerbGroupKind): 'edit' | 'command' | 'explore' {
  if (vg === 'edit' || vg === 'create') return 'edit'
  if (vg === 'command') return 'command'
  return 'explore'
}

function sameFamily(kinds: ReadonlySet<VerbGroupKind>, vg: VerbGroupKind): boolean {
  const fam = familyOf(vg)
  for (const k of kinds) {
    if (familyOf(k) !== fam) return false
  }
  return true
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
 * 扫描所有 verb run。成员数不足 2 的 run 不折，成员各自成行；被 200 条
 * 上限切出来的尾段同样按这条判定。
 */
export function scanGroups(
  entries: ScrollEntry[],
  expandedGroups: ReadonlySet<string>,
  opts: {
    /** false = 完全不做分组（保留给调试 / 旧调用方）。 */
    groupToolVerbs?: boolean
    showThinking?: boolean
    /** 分组范围（密度）。默认与 compact-all-grouped 一致。 */
    scope?: GroupScope
    /** 分组默认展开（false = 默认折叠成分组头）。 */
    defaultExpanded?: boolean
  } = {},
): GroupSpan[] {
  const groupToolVerbs = opts.groupToolVerbs !== false
  const showThinking = opts.showThinking !== false
  const scope = opts.scope ?? SCOPE_ALL
  const defaultExpanded = opts.defaultExpanded === true
  const n = entries.length
  const spans: GroupSpan[] = []
  if (!groupToolVerbs || n === 0) return spans

  let i = 0
  while (i < n) {
    const scan = scanRunForward(entries, i, showThinking, scope)
    if (!scan) {
      i += 1
      continue
    }
    // 组里只有一个成员（或只有收口思考）→ 不成组，单独展示自己的行。
    // 200 条上限切出来的尾段同样按这条判定：尾段只有 1 条时也单独显示。
    if (scan.members < 2) {
      i = scan.stop
      continue
    }
    const anchorId = entries[i].id
    spans.push({
      range: { start: i, end: scan.end },
      kind: { type: 'verb', members: scan.members },
      expanded: spanExpanded(anchorId, expandedGroups, defaultExpanded),
      anchorId,
    })
    // 进度保护：scan.end 在裁剪尾部时可能等于/小于当前起点，扫描指针必须
    // 严格前进，否则外层 while 会原地死循环。
    i = scan.end > i ? scan.end : Math.max(scan.stop, i + 1)
  }
  return spans
}

/**
 * Build a group-header row, reusing the cached row when the span object is
 * unchanged (see projectDisplayRows' headerCache). `makeLabel` is lazy —
 * on a cache hit it never runs.
 */
function headerRowFor(
  span: GroupSpan,
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
    family: 'verb',
  }
  cache?.set(span, row)
  return row
}

/**
 * Build the flat list of rows the scrollback renders.
 * Collapsed run members are omitted; headers are synthetic.
 */
export function projectDisplayRows(
  entries: ScrollEntry[],
  spans: GroupSpan[],
  showThinking = true,
  headerCache?: Map<GroupSpan, DisplayRow>,
  scope: GroupScope = SCOPE_ALL,
): DisplayRow[] {
  const spanByStart = new Map(spans.map((s) => [s.range.start, s]))
  const hidden = new Set<number>()

  for (const span of spans) {
    if (span.expanded) continue
    for (let i = span.range.start; i < span.range.end; i++) {
      const step = runStep(entries[i], showThinking, scope)
      if (step.kind === 'member' || step.kind === 'thought') hidden.add(i)
    }
  }

  const rows: DisplayRow[] = []
  let i = 0
  while (i < entries.length) {
    const span = spanByStart.get(i)
    if (span && !span.expanded) {
      rows.push(
        headerRowFor(span, () => verbGroupLabel(entries, span, showThinking, scope), headerCache),
      )
      // 折叠头后面按原顺序补出区间内保持可见的行（用户手动展开的成员 /
      // 思考）。它们不能被折叠头一并吞掉，也不能挪到组外。
      for (let j = span.range.start; j < span.range.end; j++) {
        if (!hidden.has(j)) rows.push({ type: 'entry', entry: entries[j], index: j })
      }
      i = span.range.end
      continue
    }
    if (span && span.expanded) {
      rows.push(
        headerRowFor(span, () => verbGroupLabel(entries, span, showThinking, scope), headerCache),
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
 * Spans are sorted by `range.start`, so this is a binary search.
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
 * Cheap per-entry signature of the fields that participate in grouping.
 * Text CONTENT is deliberately excluded: streaming appends change only the
 * text, and running/streaming entries never participate in grouping.
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
        // kindName 决定 verbGroupKind 的归类，漏进签名会让 span 缓存停留在旧分组上。
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
 * TUI gap rule: 折叠成组后组内相邻行不加空行。Dense packable = 参与分组的
 * 单行工具 / 思考 / 分组头。
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
