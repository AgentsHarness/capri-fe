import type { TransportCore } from '../transport'
import { xaiCall } from './core'
import { newIdempotencyKey } from '../idempotency'

/** server-authoritative 队列管理：增删改序、插话、暂存编辑、状态查询。 */
export const queueRpc = {
  async queueRemove(this: TransportCore,
    opts: { id: string; expectedVersion?: number; idempotencyKey?: string },
    sessionId?: string,
  ): Promise<void> {
    const { idempotencyKey, ...params } = opts
    const body: Record<string, unknown> = { id: params.id }
    if (params.expectedVersion !== undefined && params.expectedVersion !== 0) {
      body.expectedVersion = params.expectedVersion
    }
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/remove', body, {
      idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
    })
  },

  async queueClear(this: TransportCore, sessionId?: string, idempotencyKey?: string): Promise<void> {
    const body: Record<string, unknown> = {}
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/clear', body, {
      idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
    })
  },

  async queueReorder(this: TransportCore, opts: { ids: string[]; idempotencyKey?: string }, sessionId?: string): Promise<void> {
    const { idempotencyKey, ...params } = opts
    const body: Record<string, unknown> = {}
    if (params.ids.length > 0) body.ids = params.ids
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/reorder', body, {
      idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
    })
  },

  async queueEdit(this: TransportCore,
    opts: { id: string; newText: string; idempotencyKey?: string },
    sessionId?: string,
  ): Promise<void> {
    const { idempotencyKey, ...params } = opts
    const body: Record<string, unknown> = { id: params.id, newText: params.newText }
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/edit', body, {
      idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
    })
  },

  async queueInterject(this: TransportCore,
    opts: {
      id: string
      newText?: string
      expectedVersion?: number
      idempotencyKey?: string
    },
    sessionId?: string,
  ): Promise<void> {
    const { idempotencyKey, ...params } = opts
    const body: Record<string, unknown> = { id: params.id }
    if (params.newText) body.newText = params.newText
    if (params.expectedVersion !== undefined && params.expectedVersion !== 0) {
      body.expectedVersion = params.expectedVersion
    }
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/interject', body, {
      idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
    })
  },

  async queueHoldEdit(this: TransportCore, opts: { id: string; idempotencyKey?: string }, sessionId?: string): Promise<void> {
    const { idempotencyKey, ...params } = opts
    const body: Record<string, unknown> = { id: params.id }
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/hold-edit', body, {
      idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
    })
  },

  async queueReleaseEdit(this: TransportCore, opts: { id: string; idempotencyKey?: string }, sessionId?: string): Promise<void> {
    const { idempotencyKey, ...params } = opts
    const body: Record<string, unknown> = { id: params.id }
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/release-edit', body, {
      idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
    })
  },

  async queueStatus(this: TransportCore,
    sessionId: string,
    cwd: string,
  ): Promise<{ queue?: Record<string, unknown> | null }> {
    const res = await this.fetch(this.url('/api/queue/status'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `queue status failed (${res.status})`)
    }
    return data
  },
}
