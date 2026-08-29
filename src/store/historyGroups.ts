import type { SessionInfo, WorkspaceGroup } from '../api/types'

/**
 * History sidebar buckets:
 * - active    处理中 — turn in flight (host status.state 'active': the
 *              agent is working)
 * - bg        后台任务 — background tasks are STILL RUNNING
 *              (liveness-probed; the top task strip owns them)
 * - awaiting  待处理 — host 真·等待输入: 权限/提问挂起
 *              (status.awaitingInput / state 'awaiting')
 * - idle      空闲 — nothing else applies
 */
export type SessionGroupKey = 'active' | 'bg' | 'awaiting' | 'idle'

/**
 * 会话行排序优先级（组内排序主键，越小越靠前）：
 *   0 待处理（host 真·等待输入：权限/提问挂起，需要用户处理）
 *   1 完成对勾（✓ 待查看，completedNotices 命中）
 *   2 运行中且有后台任务（active + bgRunning > 0）
 *   3 运行中（active，无后台任务）
 *   4 空闲但后台任务仍在运行（bgRunning > 0）
 *   5 空闲
 * 同优先级内置顶的会话优先、再按最新活动降序
 * （见 historyPins.sortSessionsWithPins）。
 */
export function sessionSortRank(
  s: SessionInfo,
  completedNotices?: Record<string, number> | null,
): number {
  // 待处理是用户必须回应的信号（权限/提问挂起），永远最前。
  if (s.status?.state === 'awaiting' || s.status?.awaitingInput === true) return 0
  // 完成对勾：别的会话跑完待查看，排在运行中之前。
  if (completedNotices?.[s.sessionId] != null) return 1
  if (s.status?.state === 'active') return (s.bgRunning ?? 0) > 0 ? 2 : 3
  if ((s.bgRunning ?? 0) > 0) return 4
  return 5
}

/**
 * Effective dashboard bucket for a session. 待处理 is driven by the
 * host's authentic awaiting-input signal (pending permission / x.ai
 * question) — no local read/unread timestamps.
 */
export function sessionGroupKey(
  s: SessionInfo,
  currentSessionId?: string | null,
): SessionGroupKey {
  const state = s.status?.state
  // Host-authentic "waiting on user input" — a permission request or
  // x.ai question is pending for this session (host status.awaitingInput,
  // derived state 'awaiting' = busy + awaitingInput). 待处理 → blue
  // diamond.
  if (state === 'awaiting' || s.status?.awaitingInput === true) return 'awaiting'
  // Busy turn in flight → 处理中.
  if (state === 'active') return 'active'
  // Still-running background tasks → 后台任务.
  if ((s.bgRunning ?? 0) > 0) return 'bg'
  // Never flag the session being viewed right now.
  if (currentSessionId && s.sessionId === currentSessionId) return 'idle'
  return 'idle'
}

/**
 * TUI repo_name_from_cwd — 路径最后两个 Normal 组件以 '-' 连接；
 * 只有一个组件时取本身。空字符串 → 'unknown'，根 '/' → '/'。
 * 例：/home/user/fw/1 → "fw-1"，/home/user/xai → "user-xai"，
 * /xai → "xai"。
 */
export function repoNameFromCwd(cwd: string): string {
  if (!cwd) return 'unknown'
  const comps = cwd.split('/').filter((c) => c !== '' && c !== '.' && c !== '..')
  if (comps.length === 0) return '/'
  if (comps.length === 1) return comps[0]
  return comps.slice(-2).join('-')
}

/** 工作区最新活动时间（组内 max updatedAt，epoch ms；无时间戳返回 0）。 */
function workspaceLatestMs(g: WorkspaceGroup): number {
  let latest = 0
  for (const s of g.sessions) {
    if (!s.updatedAt) continue
    const t = Date.parse(s.updatedAt)
    if (Number.isFinite(t) && t > latest) latest = t
  }
  return latest
}

/**
 * 工作区按最新活动时间降序排序（时间戳缺失的按 label 字母序垫底）。
 * 与侧边栏"6 小时活跃窗口"共用 workspaceLatestMs 语义：组头排序和
 * 默认收起判定用同一个时间，避免同一工作区出现排序与折叠不一致。
 */
export function groupWorkspaces<T extends WorkspaceGroup>(workspaces: T[]): T[] {
  return [...workspaces].sort((a, b) => {
    const ta = workspaceLatestMs(a)
    const tb = workspaceLatestMs(b)
    if (ta !== tb) return tb - ta
    return a.label.localeCompare(b.label)
  })
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
