import type { SessionInfo } from '../api/types'

/**
 * History sidebar buckets:
 * - active    处理中 — turn in flight (host active/awaiting: the agent is
 *              working, or waiting on the user for an open question)
 * - bg        后台任务 — background tasks are STILL RUNNING
 *              (liveness-probed; the top task strip owns them)
 * - awaiting  待处理 — 未读: the session has new activity since the user
 *              last looked at it (and it is not the session being viewed
 *              right now) — something awaiting YOUR attention
 * - idle      空闲 — nothing new since you last looked
 */
export type SessionGroupKey = 'active' | 'bg' | 'awaiting' | 'idle'

/** Fixed group order: working → running bg → pending → idle. */
export const GROUP_ORDER: readonly SessionGroupKey[] = [
  'active',
  'bg',
  'awaiting',
  'idle',
] as const

/** Recency sort for history sessions (newest first, then by id). */
export function byRecency(a: SessionInfo, b: SessionInfo): number {
  return (
    (b.updatedAt || '').localeCompare(a.updatedAt || '') ||
    a.sessionId.localeCompare(b.sessionId)
  )
}

/** Session updatedAt as epoch ms (0 when absent/unparseable). */
function updatedMs(s: SessionInfo): number {
  const iso = s.updatedAt
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/**
 * Effective dashboard bucket for a session.
 * - busy → 处理中 (incl. awaiting user input);
 * - running bg tasks → 后台任务;
 * - otherwise a pure read/unread model: 待处理 iff the session has
 *   activity AFTER the user last viewed it (and it is not the session
 *   being looked at right now). The default viewed time is the moment
 *   the browser was opened (openedAt) — opening the page marks every
 *   session as read; clicking one (markViewed) marks it precisely.
 */
export function sessionGroupKey(
  s: SessionInfo,
  opts?: {
    currentSessionId?: string | null
    lastViewedAt?: Record<string, number>
    openedAt?: number
  },
): SessionGroupKey {
  const state = s.status?.state
  // Busy (incl. awaiting user input) → 处理中.
  if (state === 'active' || state === 'awaiting') return 'active'
  // Still-running background tasks → 后台任务.
  if ((s.bgRunning ?? 0) > 0) return 'bg'
  // Never flag the session being viewed right now.
  if (opts?.currentSessionId && s.sessionId === opts.currentSessionId) return 'idle'
  // Viewed time: explicit mark wins; otherwise the browser-open moment.
  const viewedAt = opts?.lastViewedAt?.[s.sessionId] ?? opts?.openedAt ?? 0
  // Activity after the last view → 未读 → 待处理.
  if (updatedMs(s) > viewedAt) return 'awaiting'
  return 'idle'
}

export function groupLabel(key: SessionGroupKey): string {
  switch (key) {
    case 'active':
      return '处理中'
    case 'bg':
      return '后台任务'
    case 'awaiting':
      return '待处理'
    case 'idle':
      return '空闲'
  }
}

/** Accent class for a status group header. */
export function groupAccentClass(key: SessionGroupKey): string {
  switch (key) {
    case 'active':
      return 'text-gn-green'
    case 'bg':
      return 'text-gn-orange'
    case 'awaiting':
      return 'text-gn-blue'
    case 'idle':
      return 'text-gn-muted'
  }
}

/**
 * Group history sessions by status bucket (处理中 / 后台任务 / 待处理 / 空闲).
 * Empty buckets are omitted; non-empty groups keep the fixed order.
 */
export function groupByState(
  sessions: SessionInfo[],
  opts?: {
    currentSessionId?: string | null
    lastViewedAt?: Record<string, number>
    openedAt?: number
  },
): Array<{ key: SessionGroupKey; label: string; items: SessionInfo[] }> {
  const buckets: Record<SessionGroupKey, SessionInfo[]> = {
    active: [],
    bg: [],
    awaiting: [],
    idle: [],
  }
  for (const s of sessions) {
    buckets[sessionGroupKey(s, opts)].push(s)
  }
  return GROUP_ORDER.filter((key) => buckets[key].length > 0).map((key) => ({
    key,
    label: groupLabel(key),
    items: [...buckets[key]].sort(byRecency),
  }))
}

/**
 * Absolute timestamp (local) — hover title for the relative row time.
 */
export function absTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/**
 * Relative time — TUI format_time_ago (session_picker.rs):
 * now / Xm ago / Xh ago / Xd ago / Xmo ago. Rows hover to the absolute
 * timestamp (absTime) via the title attribute.
 */
export function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const diffMs = Date.now() - d.getTime()
  if (diffMs < 60_000) return 'now'
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

/**
 * Unsafe display characters — TUI is_unsafe_display_char
 * (xai-grok-pager-render/line_utils.rs): C0/C1 control characters plus
 * the bidi-override / zero-width format set (mirror-image spoofing).
 */
function isUnsafeDisplayChar(c: string): boolean {
  const code = c.codePointAt(0) ?? 0
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true // C0 + DEL + C1
  return (
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff
  )
}

/**
 * Inline-rename sanitizer — TUI rename_wire_character_allowed: drops
 * control / bidi-format characters (preserving an existing emoji ZWJ
 * sequence, U+200D), capped at MAX_RENAME_SCALARS (100).
 */
export function sanitizeTitle(title: string, max = 100): string {
  let out = ''
  for (const ch of title) {
    if (ch !== '\u200d' && isUnsafeDisplayChar(ch)) continue
    out += ch
    if (out.length >= max) break
  }
  return out
}

/**
 * Context-window usage percent for a history row. The session list may
 * carry the same contextUsed / contextSize fields the session-info
 * endpoint returns (SessionInfoModal uses them); when absent there is
 * no gauge (TUI context_pct: Option<u8>).
 */
export function sessionContextPct(s: SessionInfo): number | undefined {
  const w = s as SessionInfo & { contextUsed?: unknown; contextSize?: unknown }
  const used =
    typeof w.contextUsed === 'number' && Number.isFinite(w.contextUsed)
      ? w.contextUsed
      : undefined
  const size =
    typeof w.contextSize === 'number' && Number.isFinite(w.contextSize)
      ? w.contextSize
      : 0
  if (used == null || size <= 0) return undefined
  return Math.min(100, Math.round((used / size) * 100))
}
