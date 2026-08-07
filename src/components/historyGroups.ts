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

export function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}
