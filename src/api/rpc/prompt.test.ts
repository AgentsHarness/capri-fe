import { describe, expect, it, vi } from 'vitest'
import { promptRpc } from './prompt'
import { LocalTransport } from '../localTransport'
import type { TransportCore } from '../transport'
import type { ContentBlock } from '../types'

const BLOCKS: ContentBlock[] = [{ type: 'text', text: 'hi' }]

type FetchArgs = [url: string, init?: RequestInit, opts?: { idempotencyKey?: string }]

function coreWith(fetch: ReturnType<typeof vi.fn>): TransportCore {
  return { url: (p: string) => p, fetch } as unknown as TransportCore
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

/** 三参 mock：调用点要按 (url, init, opts) 断言。 */
function fetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async (..._args: FetchArgs) => response({ ok: true }))
}

describe('promptRpc.prompt 的幂等键', () => {
  it('promptId 同时进 body.meta 与 idempotencyKey', async () => {
    const fetch = fetchMock()
    const core = coreWith(fetch)

    await promptRpc.prompt.call(core, BLOCKS, { promptId: 'pid-1', sessionId: 's1' })

    expect(fetch.mock.calls[0][2]).toMatchObject({ idempotencyKey: 'pid-1' })
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      blocks: BLOCKS,
      sessionId: 's1',
      meta: { promptId: 'pid-1' },
    })
  })

  it('没有 promptId 也发键（每次调用新键）', async () => {
    const fetch = fetchMock()
    const core = coreWith(fetch)

    await promptRpc.prompt.call(core, BLOCKS)
    await promptRpc.prompt.call(core, BLOCKS)

    const first = fetch.mock.calls[0][2]?.idempotencyKey
    const second = fetch.mock.calls[1][2]?.idempotencyKey
    expect(first).toEqual(expect.any(String))
    expect(second).toEqual(expect.any(String))
    expect(second).not.toBe(first)
  })

  it('同一 promptId 重发 → wire 上同一个 Idempotency-Key 头', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const t = new LocalTransport()
      await t.prompt(BLOCKS, { promptId: 'pid-resend' })
      await t.prompt(BLOCKS, { promptId: 'pid-resend' })

      const keys = fetchMock.mock.calls.map((call) =>
        new Headers(call[1]?.headers).get('Idempotency-Key'),
      )
      expect(keys).toEqual(['pid-resend', 'pid-resend'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('promptRpc 应答的幂等键', () => {
  it('权限应答网络失败后重试沿用首次键（卡片还在，重试不能二次执行）', async () => {
    const fetch = fetchMock()
    fetch
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(async (..._args: FetchArgs) => response({ ok: true }))
    const core = coreWith(fetch)

    await expect(
      promptRpc.respondPermission.call(core, 'req-retry-1', 'allow'),
    ).rejects.toThrow('offline')
    await promptRpc.respondPermission.call(core, 'req-retry-1', 'allow')

    const first = fetch.mock.calls[0][2]?.idempotencyKey
    const second = fetch.mock.calls[1][2]?.idempotencyKey
    expect(first).toEqual(expect.any(String))
    expect(second).toBe(first)
  })

  it('客户端请求应答网络失败后重试沿用首次键', async () => {
    const fetch = fetchMock()
    fetch
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(async (..._args: FetchArgs) => response({ ok: true }))
    const core = coreWith(fetch)

    await expect(
      promptRpc.respondClientRequest.call(core, 'req-retry-2', { outcome: 'approved' }),
    ).rejects.toThrow('offline')
    await promptRpc.respondClientRequest.call(core, 'req-retry-2', { outcome: 'approved' })

    expect(fetch.mock.calls[1][2]?.idempotencyKey).toBe(
      fetch.mock.calls[0][2]?.idempotencyKey,
    )
  })

  it('不同 requestId 各自独立的键', async () => {
    const fetch = fetchMock()
    const core = coreWith(fetch)

    await promptRpc.respondPermission.call(core, 'req-a', 'allow')
    await promptRpc.respondPermission.call(core, 'req-b', 'allow')

    const a = fetch.mock.calls[0][2]?.idempotencyKey
    const b = fetch.mock.calls[1][2]?.idempotencyKey
    expect(a).toEqual(expect.any(String))
    expect(b).toEqual(expect.any(String))
    expect(b).not.toBe(a)
  })

  it('同一 requestId 改选不同 option → 换新键（同键不同 body 会 409）', async () => {
    const fetch = fetchMock()
    fetch
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(async (..._args: FetchArgs) => response({ ok: true }))
    const core = coreWith(fetch)

    await expect(
      promptRpc.respondPermission.call(core, 'req-switch', 'allow'),
    ).rejects.toThrow('offline')
    await promptRpc.respondPermission.call(core, 'req-switch', 'deny')

    const first = fetch.mock.calls[0][2]?.idempotencyKey
    const second = fetch.mock.calls[1][2]?.idempotencyKey
    expect(first).toEqual(expect.any(String))
    expect(second).toEqual(expect.any(String))
    expect(second).not.toBe(first)
  })
})
