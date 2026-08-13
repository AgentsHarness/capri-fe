import type { PendingReq } from '../../api/types'
import { transport } from '../../api/localTransport'
import type { ChatState } from './types'
import { runtime } from './globals'

// ── pending client requests (permission / x.ai questions) ───────────
// Interactive x.ai/* methods that get a UI card. Everything else is
// auto-rejected so the agent never hangs on an unsupported method.
export const SUPPORTED_XAI_REQUESTS = new Set([
  'x.ai/ask_user_question',
  'x.ai/exit_plan_mode',
  'x.ai/diff_review',
])

/** Owning session of a pending request (top-level wire, or params fallback). */
export function pendingReqSessionId(r: PendingReq): string | undefined {
  if (typeof r.sessionId === 'string' && r.sessionId) return r.sessionId
  const p = r.params
  if (!p || typeof p !== 'object') return undefined
  const sid = p.sessionId ?? p.session_id
  return typeof sid === 'string' && sid ? sid : undefined
}

/**
 * Split host pending into permission strip vs x.ai cards, optionally
 * scoped to one session. Untagged rows (old host / no params id) are
 * kept only when `includeUntagged` is true — used for hello of the
 * host's active session, where legacy snapshots had no per-row id.
 * When `sessionId` is undefined (mid-switch / empty state) rows tagged
 * with a KNOWN session are still dropped — they belong to a specific
 * session we are not looking at; only untagged rows pass.
 */
export function partitionPendingRequests(
  reqs: PendingReq[] | undefined,
  sessionId: string | undefined,
  opts: { includeUntagged?: boolean } = {},
): { pending: PendingReq[]; xaiRequests: PendingReq[] } {
  const pending: PendingReq[] = []
  const xaiRequests: PendingReq[] = []
  if (!reqs?.length) return { pending, xaiRequests }
  for (const r of reqs) {
    const sid = pendingReqSessionId(r)
    if (sessionId) {
      if (sid && sid !== sessionId) continue
      if (!sid && !opts.includeUntagged) continue
    } else {
      // 无已知会话（切换中 / 空状态）：带已知会话标签的行绝不能画到
      // 当前视图——只放行无标签（legacy）行，它们无法归属到别处。
      if (sid) continue
    }
    const tagged: PendingReq = sid ? { ...r, sessionId: sid } : r
    if (tagged.method.startsWith('x.ai/')) {
      if (SUPPORTED_XAI_REQUESTS.has(tagged.method)) xaiRequests.push(tagged)
    } else {
      pending.push(tagged)
    }
  }
  return { pending, xaiRequests }
}

/**
 * Rehydrate the active session's pending permission / question cards
 * from GET /api/status (authoritative host clientReqs). Used after
 * continueSession — live client_request SSE for a non-active session
 * is filtered out, so switching back would otherwise leave the agent
 * waiting with an empty UI until the 15min approval timeout.
 *
 * Unsupported x.ai/* methods are auto-rejected (same as live path).
 */
export async function syncPendingForSession(
  sessionId: string,
  get: () => ChatState,
  set: (partial: Partial<ChatState>) => void,
  myGen: number,
): Promise<void> {
  try {
    const st = await transport.status()
    if (myGen !== runtime.sessionSwitchGen) return
    if (get().sessionId !== sessionId) return
    const reqs = st.pendingRequests ?? []
    // Auto-reject unsupported x.ai methods for THIS session so they
    // don't sit until approvalTimeout with no UI.
    for (const r of reqs) {
      const sid = pendingReqSessionId(r)
      if (sid && sid !== sessionId) continue
      if (!sid && st.sessionId !== sessionId) continue
      if (
        r.method.startsWith('x.ai/') &&
        !SUPPORTED_XAI_REQUESTS.has(r.method)
      ) {
        void get().respondXai(r.requestId, undefined, `前端不支持方法 ${r.method}`)
      }
    }
    // After loadSession the host active session is `sessionId`; untagged
    // rows (old host) are attributed to that active session only.
    const includeUntagged = !st.sessionId || st.sessionId === sessionId
    const next = partitionPendingRequests(reqs, sessionId, { includeUntagged })
    if (myGen !== runtime.sessionSwitchGen || get().sessionId !== sessionId) return
    set({ pending: next.pending, xaiRequests: next.xaiRequests })
  } catch {
    /* offline / status failed — leave pending empty until next live event */
  }
}
