import { KEY } from './keys'
import { loadJSON } from './storage'
import type { GitFileChange, GitStatusData } from '../api/types'

export const CONFIRM_WINDOW_MS = 2000
export const PREVIEW_MAX_LINES = 1000

export type ActiveTab = 'changes' | 'log' | 'sync'
export type ChangeFilter = 'all' | 'staged' | 'unstaged'
export type RowStatus = 'staged' | 'modified' | 'untracked'

export type StatusRow = {
  path: string
  status: RowStatus
  changeType: GitFileChange['type']
  additions: number
  deletions: number
}

/**
 * 徽章字母按 changeType 语义映射（M/D/R/A/C/T/U），色调按 staged/unstaged/
 * untracked 区分——文件是"被删了"还是"被改了"应该一眼可见，与是否已暂存
 * 独立（VS Code 语义）。
 */
const TYPE_LETTER: Partial<Record<GitFileChange['type'], string>> = {
  create: 'A',
  edit: 'M',
  delete: 'D',
  rename: 'R',
  copy: 'C',
  typechange: 'T',
  untracked: 'U',
}

const TYPE_LABEL: Record<GitFileChange['type'], string> = {
  create: '新增',
  edit: '修改',
  delete: '删除',
  rename: '重命名',
  copy: '复制',
  typechange: '类型变更',
  untracked: '未跟踪',
}

export function statusBadge(row: StatusRow): { label: string; title: string; className: string } {
  const label = TYPE_LETTER[row.changeType] ?? 'M'
  const toneClass =
    row.status === 'staged'
      ? 'bg-gn-green/20 text-gn-green border-gn-green/40'
      : row.status === 'untracked'
        ? 'bg-gn-red/20 text-gn-red border-gn-red/40'
        : 'bg-gn-yellow/20 text-gn-yellow border-gn-yellow/40'
  const stateLabel =
    row.status === 'staged' ? '已暂存' : row.status === 'untracked' ? '未跟踪' : '未暂存'
  const title =
    row.changeType === 'untracked'
      ? '未跟踪 (untracked)'
      : `${stateLabel} · ${TYPE_LABEL[row.changeType] ?? label}`
  return {
    label,
    title,
    className: toneClass,
  }
}

export function toRows(data: GitStatusData): StatusRow[] {
  const rows: StatusRow[] = []
  for (const f of data.staged ?? []) {
    rows.push({
      path: f.path,
      status: 'staged',
      changeType: f.type,
      additions: f.additions,
      deletions: f.deletions,
    })
  }
  for (const f of data.unstaged ?? []) {
    rows.push({
      path: f.path,
      status: f.type === 'untracked' ? 'untracked' : 'modified',
      changeType: f.type,
      additions: f.additions,
      deletions: f.deletions,
    })
  }
  const order = { staged: 0, modified: 1, untracked: 2 } as const
  rows.sort(
    (a, b) =>
      order[a.status] - order[b.status] || a.path.localeCompare(b.path),
  )
  return rows
}

// ── read-only unified-diff rendering with hunk detection ──────────────

export type DiffRowKind = 'header' | 'hunk' | 'equal' | 'insert' | 'delete'

export type DiffHunkBlock = {
  header: string
  rows: { kind: DiffRowKind; text: string }[]
}

export function parseUnifiedDiffBlocks(patch: string): DiffHunkBlock[] {
  const blocks: DiffHunkBlock[] = []
  const raw = patch.replace(/\n$/, '').split('\n')
  let currentHunk: DiffHunkBlock | null = null

  for (const line of raw) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('similarity') ||
      line.startsWith('rename ') ||
      line.startsWith('Binary files')
    ) {
      if (!currentHunk) {
        currentHunk = { header: 'File Header', rows: [] }
        blocks.push(currentHunk)
      }
      currentHunk.rows.push({ kind: 'header', text: line })
    } else if (line.startsWith('@@')) {
      // Hunk header is displayed once in the block header bar; do not repeat it as a diff row
      currentHunk = { header: line, rows: [] }
      blocks.push(currentHunk)
    } else if (line.startsWith('+')) {
      if (!currentHunk) {
        currentHunk = { header: 'Changes', rows: [] }
        blocks.push(currentHunk)
      }
      currentHunk.rows.push({ kind: 'insert', text: line.slice(1) })
    } else if (line.startsWith('-')) {
      if (!currentHunk) {
        currentHunk = { header: 'Changes', rows: [] }
        blocks.push(currentHunk)
      }
      currentHunk.rows.push({ kind: 'delete', text: line.slice(1) })
    } else {
      if (!currentHunk) {
        currentHunk = { header: 'Changes', rows: [] }
        blocks.push(currentHunk)
      }
      currentHunk.rows.push({ kind: 'equal', text: line })
    }
  }
  return blocks
}

/** 限制渲染行数（历史提交 patch 可能很大），超出的尾部折叠为一行提示。 */
export function capDiffBlocks(
  blocks: DiffHunkBlock[],
  max: number,
): { blocks: DiffHunkBlock[]; truncated: boolean } {
  let shown = 0
  let truncated = false
  const capped: DiffHunkBlock[] = []
  for (const block of blocks) {
    if (shown >= max) {
      truncated = true
      continue
    }
    const rows = block.rows.slice(0, max - shown)
    if (rows.length < block.rows.length) truncated = true
    shown += rows.length
    capped.push({ header: block.header, rows })
  }
  return { blocks: capped.filter((b) => b.rows.length > 0), truncated }
}

export const COMMIT_PATCH_MAX_LINES = 800

export function splitPath(path: string): { fileName: string; dirPath: string } {
  const lastSlash = path.lastIndexOf('/')
  if (lastSlash < 0) return { fileName: path, dirPath: '' }
  return { fileName: path.slice(lastSlash + 1), dirPath: path.slice(0, lastSlash + 1) }
}

/** ISO/epoch 日期串 → 本地 "YYYY-MM-DD HH:mm"；解析失败原样返回（兼容旧端返回的相对时间）。 */
export function formatGitDate(value: string): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 历史 tab 列宽（px）：作者/日期/哈希三列可拖拽调宽并持久化，
 * 提交信息列占剩余空间（flex-1），图谱列宽由提交拓扑决定。
 * 默认值按 "2026-09-05 20:15" 这类本地化日期不截断取的。
 */
export type LogColWidths = { author: number; date: number; hash: number }
export const LOG_COL_DEFAULTS: LogColWidths = { author: 110, date: 120, hash: 64 }
export const LOG_COL_MIN: Record<keyof LogColWidths, number> = { author: 48, date: 64, hash: 48 }
export const LOG_COL_MAX = 360
/** 提交信息列（flex 剩余空间）的宽度底线。 */
export const LOG_MESSAGE_MIN = 120
/** 表头/行容器 px-1.5 的左右内边距合计，测容器宽算信息列实际宽时扣掉。 */
export const LOG_HEADER_PAD_X = 12

export function clampLogColWidth(w: unknown): number {
  return typeof w === 'number' && Number.isFinite(w)
    ? Math.min(LOG_COL_MAX, Math.max(LOG_COL_MIN.author, Math.round(w)))
    : 0
}

export function loadLogColWidths(): LogColWidths {
  // storage.loadJSON 只兜语法损坏，类型闸在这里补（存进去的可能是任意 JSON）。
  const saved = loadJSON<Partial<LogColWidths>>(KEY.gitLogColWidths, {})
  const pick = (v: unknown, fallback: number) => clampLogColWidth(v) || fallback
  return {
    author: pick(saved.author, LOG_COL_DEFAULTS.author),
    date: pick(saved.date, LOG_COL_DEFAULTS.date),
    hash: pick(saved.hash, LOG_COL_DEFAULTS.hash),
  }
}

/** 可拖的分隔线：以线左侧列命名（message = 提交信息|作者 之间的线）。 */
export type LogDivider = 'message' | 'author' | 'date'

/**
 * 分隔线拖拽的宽度分配：左列变宽多少，右邻列（不够再往右）就让多少，
 * 保证被拖的线始终贴住光标——行布局是 [图谱][信息 flex][作者][日期][哈希]，
 * 弹性列在左侧，若让弹性列吸收增量，分界线会往反方向跑（Swing 表格
 * NEXT_COLUMN 模式的等价物）。
 */
export function computeDividerWidths(
  boundary: LogDivider,
  dx: number,
  snap: { widths: LogColWidths; contentW: number; graphW: number },
): LogColWidths {
  const s = snap.widths
  const next = { ...s }
  if (dx === 0) return next
  if (boundary === 'message') {
    if (dx > 0) {
      // 信息列变宽：依次向作者/日期/哈希要空间（各自不低于下限）
      let need = dx
      for (const col of ['author', 'date', 'hash'] as const) {
        const give = Math.min(need, next[col] - LOG_COL_MIN[col])
        next[col] -= give
        need -= give
        if (need <= 0) break
      }
    } else {
      // 信息列收窄：空间给作者列，底线是信息列自身不小于 LOG_MESSAGE_MIN
      const message = snap.contentW - snap.graphW - s.author - s.date - s.hash
      const give = Math.min(-dx, Math.max(0, message - LOG_MESSAGE_MIN), LOG_COL_MAX - s.author)
      next.author = s.author + give
    }
  } else if (boundary === 'author') {
    if (dx > 0) {
      const give = Math.min(dx, s.date - LOG_COL_MIN.date)
      next.author = s.author + give
      next.date = s.date - give
    } else {
      const give = Math.min(-dx, s.author - LOG_COL_MIN.author)
      next.author = s.author - give
      next.date = s.date + give
    }
  } else {
    if (dx > 0) {
      const give = Math.min(dx, s.hash - LOG_COL_MIN.hash)
      next.date = s.date + give
      next.hash = s.hash - give
    } else {
      const give = Math.min(-dx, s.date - LOG_COL_MIN.date)
      next.date = s.date - give
      next.hash = s.hash + give
    }
  }
  return next
}

// ── panel ────────────────────────────────────────────────────────────

export type DiffState =
  | { loading: boolean; blocks?: undefined; rows?: undefined; error?: undefined; file?: undefined; note?: undefined }
  | {
      loading?: undefined
      blocks: DiffHunkBlock[]
      rows: { kind: DiffRowKind; text: string }[]
      error?: undefined
      file?: GitFileChange
      note?: string
    }
  | { loading?: undefined; blocks?: undefined; rows?: undefined; error: string; file?: undefined; note?: undefined }
