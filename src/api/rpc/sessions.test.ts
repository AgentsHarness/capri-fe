import { describe, expect, it, vi } from 'vitest'
import { parseSessionUsage, sessionsRpc } from './sessions'
import type { TransportCore } from '../transport'

/** 最小 TransportCore：只提供 rewindExecute 用到的 fetch/url。 */
function rpcThis(respond: unknown) {
  return {
    url: (p: string) => p,
    fetch: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => respond,
    }),
  } as unknown as TransportCore
}

describe('sessionsRpc.rewindExecute', () => {
  it('透传 targetIndex/mode，解析 snake_case 回退结果字段', async () => {
    const t = rpcThis({
      ok: true,
      result: {
        success: true,
        target_prompt_index: 2,
        prompt_text: '回退点 prompt',
        reverted_files: ['a.txt'],
      },
    })
    const res = await sessionsRpc.rewindExecute.call(t, 's1', 2, 'all')
    expect(t.fetch).toHaveBeenCalledWith(
      '/api/rewind-execute',
      expect.objectContaining({
        body: JSON.stringify({ sessionId: 's1', targetIndex: 2, mode: 'all' }),
      }),
    )
    expect(res.targetPromptIndex).toBe(2)
    expect(res.promptText).toBe('回退点 prompt')
    expect(res.revertedFiles).toEqual(['a.txt'])
  })

  it('camelCase targetPromptIndex 同样解析', async () => {
    const t = rpcThis({ ok: true, result: { success: true, targetPromptIndex: 0 } })
    const res = await sessionsRpc.rewindExecute.call(t, 's1', 0)
    expect(res.targetPromptIndex).toBe(0)
  })

  it('响应缺 target 字段 → 不带 targetPromptIndex（本地截断回退到纯重载）', async () => {
    const t = rpcThis({ ok: true, result: { success: true, prompt_text: 'x' } })
    const res = await sessionsRpc.rewindExecute.call(t, 's1', 1)
    expect(res.targetPromptIndex).toBeUndefined()
  })

  it('result.success=false → 抛错（回退未被接受，滚动区保持不变）', async () => {
    const t = rpcThis({
      ok: true,
      result: { success: false, error: 'Cannot rewind to prompt #9' },
    })
    await expect(sessionsRpc.rewindExecute.call(t, 's1', 9)).rejects.toThrow(
      'Cannot rewind to prompt #9',
    )
  })
})

describe('sessionsRpc.sessionUsage', () => {
  it('POST /api/session/usage，解开 usage 信封', async () => {
    const t = rpcThis({
      ok: true,
      result: { usage: { inputTokens: 5, modelCalls: 1 } },
    })
    const res = await sessionsRpc.sessionUsage.call(t, { sessionId: 's1' })
    expect(t.fetch).toHaveBeenCalledWith(
      '/api/session/usage',
      expect.objectContaining({
        body: JSON.stringify({ sessionId: 's1' }),
      }),
    )
    expect(res).toEqual({ inputTokens: 5, modelCalls: 1 })
  })
})

describe('parseSessionUsage', () => {
  it('解 { usage: PromptUsage } 信封 + camelCase', () => {
    expect(
      parseSessionUsage({
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          modelCalls: 1,
          costUsdTicks: 20_000_000,
          numTurns: 3,
          modelUsage: { grok: { inputTokens: 100, outputTokens: 10 } },
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      modelCalls: 1,
      costUsdTicks: 20_000_000,
      numTurns: 3,
      modelUsage: { grok: { inputTokens: 100, outputTokens: 10 } },
    })
  })

  it('扁平 PromptUsage + snake_case', () => {
    expect(
      parseSessionUsage({
        input_tokens: 8,
        cost_usd_ticks: 0,
        usage_is_incomplete: true,
        cost_is_partial: true,
        model_usage: { a: { input_tokens: 8, api_duration_ms: 500 } },
      }),
    ).toEqual({
      inputTokens: 8,
      costUsdTicks: 0,
      costIsPartial: true,
      usageIsIncomplete: true,
      modelUsage: { a: { inputTokens: 8, apiDurationMs: 500 } },
    })
  })

  it('脏数据 / 非对象 → 空对象', () => {
    expect(parseSessionUsage(null)).toEqual({})
    expect(parseSessionUsage([])).toEqual({})
    expect(parseSessionUsage('nope')).toEqual({})
  })
}
)