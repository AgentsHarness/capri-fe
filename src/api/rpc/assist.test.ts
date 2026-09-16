import { describe, expect, it, vi } from 'vitest'
import { assistRpc } from './assist'
import type { TransportCore } from '../transport'

describe('assistRpc.interject', () => {
  it('通过正常插话入口透传每个标签页的 sessionId', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ ok: true, result: { result: { status: 'queued' } } }),
    })
    const core = { url: (p: string) => p, fetch } as unknown as TransportCore
    for (const sessionId of ['session-A', 'session-B']) {
      const opts = { text: `only ${sessionId}`, sessionId }
      expect(await assistRpc.interject.call(core, opts)).toEqual({ status: 'queued' })
      expect(fetch).toHaveBeenLastCalledWith('/api/interject', expect.objectContaining({
        body: JSON.stringify(opts),
      }))
    }
  })
})
