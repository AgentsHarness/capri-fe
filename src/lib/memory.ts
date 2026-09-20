/**
 * Memory domain logic for the /memory modal — the web counterpart of the
 * TUI's `views/memory_modal.rs` (build_entries / is_deletable / can_enable /
 * the empty + disabled notice copy). Pure helpers only: no store and no
 * fetch, so grouping, labels, deletability and the notice text stay testable
 * without a host.
 */
import { blake3 } from '@noble/hashes/blake3.js'
import { fmtBytes } from '../format'

/** One note as `x.ai/memory/list` reports it (agent `MemoryFileInfo`). */
export type MemoryFileInfo = {
  path: string
  /** `"global"`, `"workspace"`, `"session"`; anything else buckets with sessions. */
  source: string
  sizeBytes: number
  modifiedEpochSecs?: number
  /** Store-generated index (`MEMORY.md`) rather than a note. */
  generated: boolean
  /** Human-readable label when the filename is not one (v2 inbox observations). */
  title?: string
}

export type MemoryListing = {
  files: MemoryFileInfo[]
  enabled: boolean
  /** Only meaningful when `enabled` is false. */
  disabledReason?: string
  /** Notes are captured automatically after turns. */
  captureEnabled: boolean
  /** `/dream` is available in this session. */
  dreamEnabled: boolean
}

/**
 * Agent `MEMORY_FORGET_MAX_FILE_BYTES` (xai-grok-memory/v2_maintenance.rs):
 * larger notes cannot be deleted through the store.
 */
export const MEMORY_FORGET_MAX_FILE_BYTES = 256 * 1024

/** Agent `MAX_PREVIEW_BYTES` (TUI memory_modal.rs): read cap for the preview. */
export const MEMORY_PREVIEW_MAX_BYTES = 1024 * 1024

const defaultTrue = (v: unknown): boolean => (typeof v === 'boolean' ? v : true)

function pickString(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

function pickNumber(o: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

function normalizeFile(raw: unknown): MemoryFileInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const path = pickString(o, 'path') ?? ''
  if (!path) return null
  return {
    path,
    source: pickString(o, 'source') ?? '',
    sizeBytes: pickNumber(o, 'size_bytes', 'sizeBytes', 'size') ?? 0,
    modifiedEpochSecs: pickNumber(o, 'modified_epoch_secs', 'modifiedEpochSecs', 'updatedAt'),
    generated: o.generated === true,
    title: pickString(o, 'title'),
  }
}

/**
 * Normalize a `x.ai/memory/list` response (or a `memory_files` notification
 * payload — same field set) into the modal's listing. An older shell omits the
 * flags: `enabled` / `capture_enabled` / `dream_enabled` then default to true,
 * mirroring the agent's own serde defaults.
 */
export function normalizeMemoryListing(raw: unknown): MemoryListing {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const files = Array.isArray(o.files) ? o.files : []
  return {
    files: files.map(normalizeFile).filter((f): f is MemoryFileInfo => f !== null),
    enabled: defaultTrue(o.enabled),
    disabledReason: pickString(o, 'disabled_reason', 'disabledReason'),
    captureEnabled: defaultTrue(o.capture_enabled ?? o.captureEnabled),
    dreamEnabled: defaultTrue(o.dream_enabled ?? o.dreamEnabled),
  }
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/**
 * v2 inbox observations are keyed `…__t<from>-<through>__n<ordinal>.md`; the
 * TUI turns that into a readable label (observation_key_label).
 */
export function observationKeyLabel(fileName: string): string | null {
  if (!fileName.endsWith('.md')) return null
  const parts = fileName.slice(0, -3).split('__')
  if (parts.length !== 3) return null
  const range = parts[1].replace(/^t/, '')
  const ordRaw = parts[2].replace(/^n/, '')
  if (!/^\d+-\d+$/.test(range) || !/^\d+$/.test(ordRaw)) return null
  const [from, through] = range.split('-').map((s) => Number(s))
  const turns = from === through ? `turn ${from}` : `turns ${from}–${through}`
  return `observation, ${turns} (#${Number(ordRaw) + 1})`
}

/** Row label: an explicit title wins, then the observation key, then the filename. */
export function memoryFileLabel(f: MemoryFileInfo): string {
  const title = f.title?.trim()
  if (title) return title
  const name = baseName(f.path)
  return observationKeyLabel(name) ?? name
}

/** Relative age, TUI format_modified: —/<1m/Nm/Nh/Nd/Nw/Ny. */
export function formatMemoryAge(epochSecs: number | undefined, nowSecs: number): string {
  if (epochSecs == null) return '—'
  const delta = Math.max(0, nowSecs - epochSecs)
  if (delta < 60) return '<1m'
  if (delta < 3600) return `${Math.floor(delta / 60)}m`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`
  const days = Math.floor(delta / 86400)
  if (days < 100) return `${days}d`
  if (days < 365) return `${Math.floor(days / 7)}w`
  return `${Math.floor(days / 365)}y`
}

/** Metadata column, TUI meta_text (`8 B · 3h`). */
export function memorySizeText(f: MemoryFileInfo): string {
  return `${fmtBytes(f.sizeBytes)} · ${formatMemoryAge(f.modifiedEpochSecs, Math.floor(Date.now() / 1000))}`
}

/**
 * What the store will actually delete (TUI MemoryFileEntry::is_deletable):
 * v2 topics and inbox observations, or legacy session logs — never the
 * generated `MEMORY.md` indexes, never an oversized note.
 */
export function isMemoryFileDeletable(f: MemoryFileInfo): boolean {
  if (f.generated || f.sizeBytes > MEMORY_FORGET_MAX_FILE_BYTES) return false
  if (f.source === 'session') return true
  if (f.source !== 'workspace' && f.source !== 'global') return false
  const parent = f.path.split(/[\\/]/).filter(Boolean).slice(-2)[0] ?? ''
  return parent === 'topics' || parent === 'observations/_inbox' || f.path.includes('/observations/_inbox/')
}

/**
 * Memory is off but the session can turn it back on (TUI can_enable): a
 * session toggle and a `config.toml` opt-out are recoverable, a
 * process/rollout restriction and an unconfigured store are not. An unknown
 * reason fails closed.
 */
export function canEnableMemory(reason: string | undefined): boolean {
  return reason == null || reason === 'session_toggle' || reason === 'config_opt_out'
}

export type MemoryNotice = { title: string; lines: string[] }

/**
 * Empty state, mirroring `empty_state_markdown`: only advertise the actions
 * the shell reported as available in this session.
 */
export function emptyMemoryNotice(captureEnabled: boolean, dreamEnabled: boolean): MemoryNotice {
  const lines: string[] = []
  if (captureEnabled) {
    lines.push('继续工作即可 —— 每个回合结束后笔记会自动保存。')
  }
  lines.push('`/remember <笔记>` 可以立刻记下指定内容。')
  if (dreamEnabled) {
    lines.push('`/dream` 会把已保存的笔记整理成主题。')
  }
  lines.push(
    '记忆让 Grok 跨会话记住约定、决策和项目事实，不必反复交代。' +
      '笔记存放在**工作区**记忆（当前仓库）与**全局**记忆中，' +
      '两者各有一个自动生成的 `MEMORY.md` 索引。',
  )
  return { title: '还没有任何记忆。', lines }
}

/** Disabled state, mirroring `disabled_state_markdown` (one copy per reason). */
export function disabledMemoryNotice(reason: string | undefined): MemoryNotice {
  switch (reason) {
    case 'config_opt_out':
      return {
        title: '记忆已关闭（config.toml 中 `[memory] enabled = false`）。',
        lines: [
          '打开后只对本次会话生效；新建会话仍按 `config.toml` 走。',
          '要让记忆长期开启，请在 `config.toml` 里设置 `enabled = true`（或删掉该行）。',
          '已经记住的内容仍保留在磁盘上。',
        ],
      }
    case 'process_disabled':
      return {
        title: '记忆在本进程中已关闭。',
        lines: [
          '启动时带了 `--no-memory` 或 `GROK_MEMORY=0`，因此这里无法打开它。',
          '需要记忆时，请不带这些参数新建一个会话。已经记住的内容仍保留在磁盘上。',
        ],
      }
    case 'rollout_restricted':
      return {
        title: '本会话不可用记忆。',
        lines: [
          '本会话的记忆配置在启动时被固定，且是关闭状态，因此这里无法打开。',
          '新建一个会话即可按当前设置生效。',
        ],
      }
    case 'not_configured':
      return {
        title: '记忆尚未配置。',
        lines: ['本会话没有配置记忆存储，因此既没有可浏览的内容，也没有可打开的记忆。'],
      }
    case 'unknown':
      return {
        title: '记忆在本会话中已关闭。',
        lines: ['本会话上报了一个当前版本无法识别的关闭原因；可以尝试打开它。'],
      }
    default:
      return {
        title: '记忆在本会话中已关闭。',
        lines: [
          '关闭期间 Grok 不会读取或保存笔记；已经记住的内容仍保留在磁盘上。',
          '记忆让 Grok 跨会话记住约定、决策和项目事实，不必反复交代。',
        ],
      }
  }
}

/** Human label for a disabled reason (status line / badge). */
export function disabledReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case 'session_toggle':
      return '本会话已关闭'
    case 'config_opt_out':
      return 'config.toml 已关闭'
    case 'process_disabled':
      return '进程级关闭'
    case 'rollout_restricted':
      return '本会话被限制'
    case 'not_configured':
      return '未配置存储'
    default:
      return '已关闭'
  }
}

export type MemoryGroup = { label: string; items: MemoryFileInfo[] }

/**
 * Group by source the way the TUI does (build_entries): Global / Workspace /
 * Sessions, session logs newest first, everything else A–Z by label. Files
 * whose source the shell did not report fall back to a path sniff, and
 * leftovers ride with the sessions bucket (`_ => session` in the TUI).
 */
export function groupMemoryFiles(files: MemoryFileInfo[]): MemoryGroup[] {
  const global: MemoryFileInfo[] = []
  const workspace: MemoryFileInfo[] = []
  const session: MemoryFileInfo[] = []
  for (const f of files) {
    if (f.source === 'global') global.push(f)
    else if (f.source === 'workspace') workspace.push(f)
    else if (f.source === 'session') session.push(f)
    else if (/(^|[\\/])sessions?[\\/]/.test(f.path)) session.push(f)
    else if (f.path.includes('.grok/memory') || /(^|[\\/])MEMORY\.md$/i.test(f.path)) global.push(f)
    else session.push(f)
  }
  const byLabel = (a: MemoryFileInfo, b: MemoryFileInfo) =>
    memoryFileLabel(a).localeCompare(memoryFileLabel(b)) || a.path.localeCompare(b.path)
  global.sort(byLabel)
  workspace.sort(byLabel)
  // Session logs: newest first, unknown timestamps last (TUI session.reverse()).
  session.sort((a, b) => (b.modifiedEpochSecs ?? 0) - (a.modifiedEpochSecs ?? 0) || byLabel(a, b))

  const groups: MemoryGroup[] = []
  if (global.length) groups.push({ label: 'Global', items: global })
  if (workspace.length) groups.push({ label: 'Workspace', items: workspace })
  if (session.length) groups.push({ label: 'Sessions', items: session })
  return groups
}

/** Every whitespace-separated term must match label / path / (loaded) content. */
export function filterMemoryFiles(
  files: MemoryFileInfo[],
  query: string,
  contents: Record<string, string> = {},
): MemoryFileInfo[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return files
  return files.filter((f) => {
    const hay = `${memoryFileLabel(f)} ${f.path} ${contents[f.path] ?? ''}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
  })
}

/**
 * Progressive listing states, mirroring the TUI's `shows_notice`: memory off,
 * or on with nothing but the generated indexes.
 */
export function memoryHasNotes(listing: MemoryListing): boolean {
  return listing.files.some((f) => !f.generated)
}

/**
 * BLAKE3 hex of the previewed bytes — the evidence `x.ai/memory/forget`
 * compares against the store's own bytes, so a note edited after the preview
 * is refused instead of deleted (TUI: preview_hash).
 */
export function memoryContentHash(content: string): string {
  return Array.from(blake3(new TextEncoder().encode(content)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
