import type { FollowUp } from '../../api/types'
import type { ChatState, SetState } from './types'

export function applyMcpInitProgress(set: SetState, params: unknown): void {
  const p =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {}
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
  const total = num(p.total) ?? num(p.totalCount) ?? num(p.total_count)
  const connected = num(p.connected) ?? num(p.connectedCount) ?? num(p.connected_count)
  if (total == null || connected == null) return
  set({
    mcpInit: {
      total,
      connected,
      startedAt: Date.now(),
    },
  })
}

// ── x.ai/follow_ups — turn-end suggestion chips (TUI follow_ups.rs) ─────
// The TUI renders these as a transient clickable row between the
// scrollback and the prompt — NEVER as scrollback rows — so the FE parses
// them into store state for the composer's chip row instead.

/**
 * x.ai/* notifications with no scrollback UI value — silently dropped in
 * `handleEvent`'s ext_notification case (the host forwards everything
 * pass-through, so suppression happens at the render boundary). Aligned
 * with the TUI: these are status-type notifications shown ONLY inside
 * their dedicated panels, never as scrollback rows. Everything NOT in
 * this set still falls through to the dim "扩展通知" status line
 * (forward visibility).
 */
export const SILENT_EXT_NOTIFICATIONS = new Set([
  'x.ai/settings/update',
  // File-watcher state (TUI file-watch panel) — fires on every change.
  'x.ai/fs_notify',
  'x.ai/fs/index',
  'x.ai/fs/index/delta',
  // Search engine status (TUI /search panel).
  'x.ai/search/fuzzy/status',
  'x.ai/search/content/status',
  // Config reload notice (TUI settings modal; FE has no config editor).
  'x.ai/config_changed',
  // NOTE: x.ai/mcp/init_progress is intentionally NOT here — it is
  // consumed into mcpInit state (McpPanel init progress), both as the
  // typed `mcp_init_progress` event and via the ext_notification
  // fallback in handleEvent.
  // NOTE: x.ai/queue/changed is intentionally NOT here — it feeds the
  // promptQueue sync layer (applyQueueChanged), both as the typed
  // `queue_changed` event and via the ext_notification fallback.
])

/** TUI MAX_FOLLOW_UPS — max chips kept from one (server-controlled) delivery. */
export const MAX_FOLLOW_UPS = 6
/** TUI MAX_FOLLOW_UP_LABEL — max chars per (server-controlled) suggestion. */
export const MAX_FOLLOW_UP_LABEL = 256

/**
 * Sanitize a server-supplied suggestion label (TUI `sanitize_suggestion`
 * → `is_unsafe_display_char`): strip control + bidi/format characters so
 * a chip can neither inject terminal escapes nor spoof layout, bound the
 * length, and trim surrounding whitespace. Iterated by code point
 * (Array.from) so surrogate pairs (emoji) survive.
 */
export function sanitizeFollowUpLabel(label: string): string {
  const cleaned = Array.from(label)
    .filter((c) => {
      const cp = c.codePointAt(0)!
      const control = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)
      const bidiFormat =
        cp === 0x061c ||
        (cp >= 0x200b && cp <= 0x200f) ||
        (cp >= 0x202a && cp <= 0x202e) ||
        (cp >= 0x2060 && cp <= 0x206f) ||
        cp === 0xfeff
      return !control && !bidiFormat
    })
    .slice(0, MAX_FOLLOW_UP_LABEL)
    .join('')
  return cleaned.trim()
}

/**
 * Handle `x.ai/follow_ups` — store turn-end suggestion chips for the
 * latest assistant response. Wire params (TUI FollowUpsParams, snake_case
 * verbatim): `{ response_id, suggestions: [{ label, … }], promptId?,
 * _meta? }`. Only the labels are consumed; count/length are bounded and
 * labels sanitized at ingestion. No scrollback row — chips live in the
 * composer, above the input. Newest-wins keyed by `response_id` (TUI
 * AgentView::apply_follow_ups): a missing id is ignored, a same-id
 * re-delivery is idempotent, a newer id replaces, and an empty (or
 * all-sanitized-away) list retracts the chips. Malformed payloads are
 * ignored (no chip, no scrollback line).
 */
export function applyFollowUps(
  get: () => ChatState,
  set: SetState,
  params?: Record<string, unknown>,
): void {
  let p = params
  // Defensive: some hosts ship the params as a raw JSON string (the TUI
  // reads `notif.params` as one) instead of a pre-parsed object.
  if (typeof p === 'string') {
    try {
      p = JSON.parse(p) as Record<string, unknown>
    } catch {
      return
    }
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return
  const responseId =
    (typeof p.response_id === 'string' && p.response_id ? p.response_id : '') ||
    (typeof p.responseId === 'string' ? p.responseId : '')
  if (!responseId || responseId === get().followUpsResponseId) return
  const raw = Array.isArray(p.suggestions) ? p.suggestions : []
  const suggestions: FollowUp[] = []
  for (const s of raw.slice(0, MAX_FOLLOW_UPS)) {
    const label =
      typeof s === 'string'
        ? s
        : s && typeof s === 'object'
          ? (s as Record<string, unknown>).label
          : undefined
    if (typeof label !== 'string') continue
    const cleaned = sanitizeFollowUpLabel(label)
    if (cleaned) suggestions.push({ label: cleaned })
  }
  set({
    followUpsResponseId: responseId,
    followUps: suggestions.length > 0 ? suggestions : undefined,
  })
}
