import type { TransportCore } from '../transport'
import { xaiCall } from './core'

/** server-authoritative 队列管理：增删改序、插话、暂存编辑、状态查询。 */
export const queueRpc = {
  async queueRemove(this: TransportCore,
    opts: { id: string; expectedVersion?: number },
    sessionId?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { id: opts.id }
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== 0) {
      body.expectedVersion = opts.expectedVersion
    }
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/remove', body)
  },

  async queueClear(this: TransportCore, sessionId?: string): Promise<void> {
    const body: Record<string, unknown> = {}
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/clear', body)
  },

  async queueReorder(this: TransportCore, opts: { ids: string[] }, sessionId?: string): Promise<void> {
    const body: Record<string, unknown> = {}
    if (opts.ids.length > 0) body.ids = opts.ids
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/reorder', body)
  },

  async queueEdit(this: TransportCore,
    opts: { id: string; newText: string },
    sessionId?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { id: opts.id, newText: opts.newText }
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/edit', body)
  },

  async queueInterject(this: TransportCore,
    opts: {
      id: string
      newText?: string
      expectedVersion?: number
    },
    sessionId?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { id: opts.id }
    if (opts.newText) body.newText = opts.newText
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== 0) {
      body.expectedVersion = opts.expectedVersion
    }
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/interject', body)
  },

  async queueHoldEdit(this: TransportCore, opts: { id: string }, sessionId?: string): Promise<void> {
    const body: Record<string, unknown> = { id: opts.id }
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/hold-edit', body)
  },

  async queueReleaseEdit(this: TransportCore, opts: { id: string }, sessionId?: string): Promise<void> {
    const body: Record<string, unknown> = { id: opts.id }
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/release-edit', body)
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
