import { describe, expect, it, vi } from 'vitest'
import { sessionsRpc } from './sessions'
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