import { describe, expect, it, vi } from 'vitest'
import { memoryRpc } from './memory'
import type { TransportCore } from '../transport'

/** Transport core whose fetch replies with a canned host body. */
function coreWithBody(body: unknown, status = 200): TransportCore & { fetch: ReturnType<typeof vi.fn> } {
  return {
    mode: 'local',
    url: (path: string) => `http://host.test${path}`,
    apiBase: () => 'http://host.test',
    prefsOrigin: () => 'http://host.test',
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })),
  }
}

/** Body shape the host actually produces: {ok, result: <jsonrpc result>}. */
function hostBody(payload: unknown) {
  // The agent's ext reply nests one more level ({result: payload}).
  return { ok: true, result: { result: payload } }
}

function sentBody(core: TransportCore & { fetch: ReturnType<typeof vi.fn> }): Record<string, unknown> {
  return JSON.parse(String(core.fetch.mock.calls[0][1]?.body ?? '{}'))
}

function sentPath(core: TransportCore & { fetch: ReturnType<typeof vi.fn> }): string {
  return String(core.fetch.mock.calls[0][0])
}

describe('memoryRpc.memoryList', () => {
  it('剥掉两层信封并归一化 listing，sessionId 随参数下发', async () => {
    const core = coreWithBody(
      hostBody({
        files: [{ path: '/ws/.grok/memory/topics/t.md', source: 'workspace', size_bytes: 9, title: 'T' }],
        enabled: false,
        disabled_reason: 'session_toggle',
        capture_enabled: true,
        dream_enabled: false,
      }),
    )
    const listing = await memoryRpc.memoryList.call(core, 's1')
    expect(sentPath(core)).toBe('http://host.test/api/memory-list')
    expect(sentBody(core)).toEqual({ sessionId: 's1' })
    expect(listing.enabled).toBe(false)
    expect(listing.disabledReason).toBe('session_toggle')
    expect(listing.dreamEnabled).toBe(false)
    expect(listing.files[0]).toMatchObject({ path: '/ws/.grok/memory/topics/t.md', sizeBytes: 9, title: 'T' })
  })

  it('无 sessionId 时不发送该键（由 host 兜底活动会话）', async () => {
    const core = coreWithBody(hostBody({ files: [] }))
    await memoryRpc.memoryList.call(core)
    expect(sentBody(core)).toEqual({})
  })

  it('host 报错时抛出 host 的文案', async () => {
    const core = coreWithBody({ ok: false, error: '暂无活动会话' }, 404)
    await expect(memoryRpc.memoryList.call(core)).rejects.toThrow('暂无活动会话')
  })
})

describe('memoryRpc.memoryToggle', () => {
  it('回传 message/enabled/listing，并把 listing 归一化', async () => {
    const core = coreWithBody(
      hostBody({
        message: '记忆已开启',
        enabled: true,
        listing: { files: [{ path: '/a/MEMORY.md', generated: true }], enabled: true },
      }),
    )
    const res = await memoryRpc.memoryToggle.call(core, 's1', true)
    expect(sentBody(core)).toEqual({ sessionId: 's1', enabled: true })
    expect(res.message).toBe('记忆已开启')
    expect(res.enabled).toBe(true)
    expect(res.listing?.files).toHaveLength(1)
  })

  it('拒绝时不谎报状态（用响应里的 enabled，缺 listing 也照实回）', async () => {
    const core = coreWithBody(
      hostBody({ message: '本会话无法开启记忆', enabled: false, disabled_reason: 'process_disabled' }),
    )
    const res = await memoryRpc.memoryToggle.call(core, 's1', true)
    expect(res.enabled).toBe(false)
    expect(res.disabledReason).toBe('process_disabled')
    expect(res.listing).toBeUndefined()
  })

  it('缺 message 时按目标状态给默认文案', async () => {
    const core = coreWithBody(hostBody({ enabled: false }))
    const res = await memoryRpc.memoryToggle.call(core, 's1', false)
    expect(res.message).toBe('记忆已关闭')
  })
})

describe('memoryRpc.memoryForget', () => {
  it('把 path 与摘要原样发给 host', async () => {
    const core = coreWithBody(hostBody({ outcome: 'forgotten', was_already_forgotten: false }))
    const res = await memoryRpc.memoryForget.call(core, 's1', '/ws/topics/t.md', 'abc123')
    expect(sentBody(core)).toEqual({
      sessionId: 's1',
      path: '/ws/topics/t.md',
      expectedContentHash: 'abc123',
    })
    expect(res).toEqual({ outcome: 'forgotten', wasAlreadyForgotten: false })
  })

  it('映射 store 的拒绝（changed / not_deletable / dream_running）', async () => {
    const core = coreWithBody(
      hostBody({ outcome: 'rejected', reason: 'changed', message: 'This note changed since you opened it.' }),
    )
    const res = await memoryRpc.memoryForget.call(core, 's1', '/p', 'h')
    expect(res).toEqual({
      outcome: 'rejected',
      reason: 'changed',
      message: 'This note changed since you opened it.',
    })
  })

  it('已删除过也会明确回报', async () => {
    const core = coreWithBody(hostBody({ outcome: 'forgotten', was_already_forgotten: true }))
    const res = await memoryRpc.memoryForget.call(core, 's1', '/p', 'h')
    expect(res).toEqual({ outcome: 'forgotten', wasAlreadyForgotten: true })
  })
})

describe('memoryRpc.memoryDream', () => {
  it('打到 /api/memory-dream 并返回 disposition 载荷', async () => {
    const core = coreWithBody(
      hostBody({ disposition: 'no_work', observation_count: 0, topics_affected: 0 }),
    )
    const res = await memoryRpc.memoryDream.call(core, 's1')
    expect(sentPath(core)).toBe('http://host.test/api/memory-dream')
    expect(res.disposition).toBe('no_work')
  })
})

describe('memoryRpc.fsReadFile', () => {
  it('在信封里找到正文与大小', async () => {
    const core = coreWithBody({
      ok: true,
      result: { result: { result: { content: '# note\n', size: 7, type: 'text' } } },
    })
    const res = await memoryRpc.fsReadFile.call(core, '/ws/t.md')
    expect(sentBody(core)).toEqual({ path: '/ws/t.md' })
    expect(res).toEqual({ content: '# note\n', size: 7 })
  })

  it('缺 content 时抛出 agent 自己的说法（过大 / 不可读）', async () => {
    const core = coreWithBody({
      ok: true,
      result: { result: { error: 'file too large', message: 'File exceeds the read limit' } },
    })
    await expect(memoryRpc.fsReadFile.call(core, '/ws/big.md')).rejects.toThrow(
      'File exceeds the read limit',
    )
  })

  it('二进制读取的 base64 兜底', async () => {
    const core = coreWithBody({
      ok: true,
      result: { result: { result: { content_base64: 'YWJj', size: 3 } } },
    })
    const res = await memoryRpc.fsReadFile.call(core, '/ws/bin')
    expect(res.content).toBe('YWJj')
  })
})
