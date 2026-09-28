import { describe, expect, it, vi } from 'vitest'
import { toolsRpc } from './tools'
import type { TransportCore } from '../transport'

/** Transport core whose fetch replies with a canned host body. */
function coreWithBody(
  body: unknown,
  status = 200,
): TransportCore & { fetch: ReturnType<typeof vi.fn> } {
  return {
    mode: 'local',
    url: (path: string) => `http://host.test${path}`,
    urlForHost: () => null,
    apiBase: () => 'http://host.test',
    prefsOrigin: () => 'http://host.test',
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })),
  }
}

describe('toolsRpc.memoryFlush', () => {
  it('剥掉 {ok, result} 信封，返回 agent 的 MemoryFlushResponse', async () => {
    const core = coreWithBody({
      ok: true,
      result: { flushed: true, disposition: 'flushed', through_turn: 12 },
    })
    const res = await toolsRpc.memoryFlush.call(core, 's1')
    expect(String(core.fetch.mock.calls[0][0])).toBe('http://host.test/api/memory-flush')
    expect(JSON.parse(String(core.fetch.mock.calls[0][1]?.body))).toEqual({ sessionId: 's1' })
    expect(res).toEqual({ flushed: true, disposition: 'flushed', through_turn: 12 })
  })

  it('关掉传输硬超时（timeoutMs: 0）——刷新是模型工作，pager 侧也无截止', async () => {
    const core = coreWithBody({ ok: true, result: { disposition: 'flushed' } })
    await toolsRpc.memoryFlush.call(core, 's1')
    expect(core.fetch.mock.calls[0][2]).toEqual({ timeoutMs: 0 })
  })

  it('host 报错 → 抛出它自己的说法', async () => {
    const core = coreWithBody({ ok: false, error: '暂无活动会话' }, 404)
    await expect(toolsRpc.memoryFlush.call(core, 's1')).rejects.toThrow('暂无活动会话')
  })
})

describe('toolsRpc.memoryRewrite', () => {
  it('下发 sessionId + 原文 + 上下文，返回 host 体（调用方读 result.rewritten）', async () => {
    const core = coreWithBody({ ok: true, result: { rewritten: '## 部署' } })
    const res = await toolsRpc.memoryRewrite.call(core, 's1', '部署用 eu-west', 'CWD: /w')
    expect(String(core.fetch.mock.calls[0][0])).toBe('http://host.test/api/memory-rewrite')
    expect(JSON.parse(String(core.fetch.mock.calls[0][1]?.body))).toEqual({
      sessionId: 's1',
      rawText: '部署用 eu-west',
      contextSummary: 'CWD: /w',
    })
    expect(res).toEqual({ ok: true, result: { rewritten: '## 部署' } })
  })

  it('关掉传输硬超时（timeoutMs: 0）——改写是模型调用，pager 侧也无截止', async () => {
    const core = coreWithBody({ ok: true, result: { rewritten: 'x' } })
    await toolsRpc.memoryRewrite.call(core, 's1', 'note')
    expect(core.fetch.mock.calls[0][2]).toEqual({ timeoutMs: 0 })
    // 无 contextSummary 时不下发该键（agent 侧必填字段之外不塞空串）
    expect(JSON.parse(String(core.fetch.mock.calls[0][1]?.body))).toEqual({
      sessionId: 's1',
      rawText: 'note',
    })
  })
})
