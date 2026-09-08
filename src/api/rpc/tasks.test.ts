import { describe, expect, it, vi } from 'vitest'
import { parseKillOutcome, tasksRpc } from './tasks'
import type { TransportCore } from '../transport'

/** 最小 TransportCore：killTask 只用 fetch/url，回一个 ExtMethodResult 信封。 */
function rpcThis(outcome: string) {
  return {
    url: (p: string) => p,
    fetch: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { result: { taskId: 't-1', outcome } } }),
    }),
  } as unknown as TransportCore
}

describe('tasksRpc.killTask', () => {
  it('带 sessionId 与 source，并读出 outcome', async () => {
    const t = rpcThis('killed')
    const res = await tasksRpc.killTask.call(t, 't-1', 's-1', 'teardown')
    expect(t.fetch).toHaveBeenCalledWith(
      '/api/task-kill',
      expect.objectContaining({
        body: JSON.stringify({ taskId: 't-1', sessionId: 's-1', source: 'teardown' }),
      }),
    )
    expect(res).toBe('killed')
  })

  it('不传 source 时不上 wire（老 host 与 agent 缺省都不受影响）', async () => {
    const t = rpcThis('killed')
    await tasksRpc.killTask.call(t, 't-1', 's-1')
    expect(t.fetch).toHaveBeenCalledWith(
      '/api/task-kill',
      expect.objectContaining({
        body: JSON.stringify({ taskId: 't-1', sessionId: 's-1' }),
      }),
    )
  })

  it('not_found 包在成功响应里也要如实上报', async () => {
    const t = rpcThis('not_found')
    expect(await tasksRpc.killTask.call(t, 't-1')).toBe('not_found')
  })
})

describe('parseKillOutcome', () => {
  it('未知 verdict → unknown（旧 host 不带 outcome）', () => {
    expect(parseKillOutcome({ ok: true, result: { result: { taskId: 't-1' } } })).toBe('unknown')
  })
})
