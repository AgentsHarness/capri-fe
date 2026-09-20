import type { TransportCore } from '../transport'
import { assertRpcOk, findField, readRpcJson, unwrapExtResult, xaiCall } from './core'
import type { MemoryListing } from '../../lib/memory'
import { normalizeMemoryListing } from '../../lib/memory'

/**
 * Memory modal rails (TUI /memory). The host owns one typed endpoint per
 * agent method — flush / rewrite (pre-existing) plus list / toggle / dream /
 * forget — and every one of them wraps the agent's reply in the JSON-RPC
 * `{result: …}` envelope, hence `unwrapExtResult`.
 */
export type MemoryToggleResult = {
  message: string
  enabled: boolean
  disabledReason?: string
  listing?: MemoryListing
}

/** The agent's answer to x.ai/memory/forget (`outcome` tagged enum). */
export type MemoryForgetResult =
  | { outcome: 'forgotten'; wasAlreadyForgotten: boolean }
  | { outcome: 'rejected'; reason: string; message: string }

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

export const memoryRpc = {
  /** POST /api/memory-list → the /memory modal's listing. */
  async memoryList(this: TransportCore, sessionId?: string): Promise<MemoryListing> {
    const raw = unwrapExtResult<unknown>(
      await xaiCall(this, '/api/memory-list', sessionId ? { sessionId } : {}),
    )
    return normalizeMemoryListing(raw)
  },

  /**
   * POST /api/memory-toggle → flip memory for the session. The reply is
   * authoritative (a refusal leaves memory where it was) and carries a fresh
   * listing, so the caller does not need a second round trip.
   */
  async memoryToggle(
    this: TransportCore,
    sessionId: string,
    enabled: boolean,
  ): Promise<MemoryToggleResult> {
    const raw = unwrapExtResult<Record<string, unknown>>(
      await xaiCall(this, '/api/memory-toggle', { sessionId, enabled }),
    )
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const listing = o.listing ?? o.Listing
    return {
      message: str(o.message) ?? (enabled ? '记忆已开启' : '记忆已关闭'),
      enabled: typeof o.enabled === 'boolean' ? o.enabled : enabled,
      disabledReason: str(o.disabled_reason) ?? str(o.disabledReason),
      listing: listing ? normalizeMemoryListing(listing) : undefined,
    }
  },

  /** POST /api/memory-dream → run consolidation now (TUI /dream). */
  async memoryDream(this: TransportCore, sessionId?: string) {
    return unwrapExtResult<Record<string, unknown>>(
      await xaiCall(this, '/api/memory-dream', sessionId ? { sessionId } : {}),
    )
  },

  /**
   * POST /api/memory-forget → delete one note. `expectedContentHash` must be
   * the BLAKE3 hex of the bytes the caller previewed: the store refuses
   * anything else, which is what stops a note edited after the preview from
   * being deleted unnoticed.
   */
  async memoryForget(
    this: TransportCore,
    sessionId: string,
    path: string,
    expectedContentHash: string,
  ): Promise<MemoryForgetResult> {
    const raw = unwrapExtResult<Record<string, unknown>>(
      await xaiCall(this, '/api/memory-forget', { sessionId, path, expectedContentHash }),
    )
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    if (o.outcome === 'forgotten') {
      return { outcome: 'forgotten', wasAlreadyForgotten: o.was_already_forgotten === true }
    }
    return {
      outcome: 'rejected',
      reason: str(o.reason) ?? 'failed',
      message: str(o.message) ?? '删除被拒绝',
    }
  },

  /**
   * POST /api/fs/read-file → note text for the preview pane. The agent owns
   * file access (the host never reads memory paths itself); the response
   * nests the payload inside the ext-result envelope, so `findField` digs.
   */
  async fsReadFile(this: TransportCore, path: string): Promise<{ content: string; size?: number }> {
    const res = await this.fetch(this.url('/api/fs/read-file'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    const data = await readRpcJson(res)
    assertRpcOk(res, data, 'fs read-file failed')
    const content = findField(data, 'content')
    if (typeof content !== 'string') {
      // Native binary reads answer with base64; a memory note never should.
      const b64 = findField(data, 'content_base64') ?? findField(data, 'contentBase64')
      if (typeof b64 === 'string') return { content: b64, size: sizeOf(data) }
      // The agent refuses oversized/unreadable files through the ext-result
      // envelope — surface its own words instead of a generic parse error.
      const detail = findField(data, 'message') ?? findField(data, 'error')
      throw new Error(
        typeof detail === 'string' && detail ? detail : '读取记忆文件失败：响应缺少 content',
      )
    }
    return { content, size: sizeOf(data) }
  },
}

function sizeOf(data: unknown): number | undefined {
  const size = findField(data, 'size')
  return typeof size === 'number' && Number.isFinite(size) ? size : undefined
}
