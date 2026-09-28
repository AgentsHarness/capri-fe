import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryActions } from './memory'
import type { ChatState, SetState } from '../types'

vi.mock('../../../api/client', () => ({
  transport: {
    memoryDream: vi.fn(),
    memoryList: vi.fn(),
    memoryToggle: vi.fn(),
    memoryForget: vi.fn(),
  },
}))

import { transport } from '../../../api/client'

function makeStore(initial: Partial<ChatState> = {}) {
  let state = { entries: [], sessionId: 's1', statusText: '', ...initial } as unknown as ChatState
  const set: SetState = (patch) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  }
  return { set, get: () => state, state: () => state }
}

const texts = (state: ChatState) =>
  (state.entries ?? []).map((e) => (e as { text?: string }).text)

describe('memoryActions.memoryDream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('开始行先落，结果行取 RPC 响应（合并数量 + /memory 查看）', async () => {
    ;(transport.memoryDream as ReturnType<typeof vi.fn>).mockResolvedValue({
      disposition: 'completed',
      observation_count: 3,
      topics_affected: 2,
    })
    const store = makeStore()
    await memoryActions(store.set, store.get).memoryDream!()
    expect(transport.memoryDream).toHaveBeenCalledWith('s1')
    expect(texts(store.state())).toEqual([
      '正在整合记忆…',
      expect.stringMatching(
        /^记忆整合完成：已将 3 条观察合并进 2 个主题。\uff08\d+\.\d+s\uff09· \/memory 查看$/,
      ),
    ])
    expect(store.state().statusText).toBe('')
  })

  it('busy → warning 结果行（不谎报整合完成）', async () => {
    ;(transport.memoryDream as ReturnType<typeof vi.fn>).mockResolvedValue({
      disposition: 'busy',
      observation_count: 0,
      topics_affected: 0,
    })
    const store = makeStore()
    await memoryActions(store.set, store.get).memoryDream!()
    expect(store.state().entries[1]).toMatchObject({
      kind: 'session_event',
      text: expect.stringContaining('已有一次记忆整合在进行中'),
      warning: true,
    })
  })

  it('请求失败 → 错误行 + 命令文案不留在状态位', async () => {
    ;(transport.memoryDream as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('agent down'),
    )
    const store = makeStore({ statusText: '就绪' })
    await memoryActions(store.set, store.get).memoryDream!()
    expect(store.state().entries[1]).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('记忆整合失败: agent down'),
    })
    expect(store.state().statusText).toBe('就绪')
  })

  it('无活动会话 → 错误行，不发请求', async () => {
    const store = makeStore({ sessionId: undefined })
    await memoryActions(store.set, store.get).memoryDream!()
    expect(transport.memoryDream).not.toHaveBeenCalled()
    expect(store.state().entries).toHaveLength(1)
    expect(store.state().entries[0]).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('无活动会话'),
    })
  })

  it('命令在飞时置状态行项，落定后按会话清空', async () => {
    let resolveDream: ((v: unknown) => void) | undefined
    ;(transport.memoryDream as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((res) => { resolveDream = res }),
    )
    const store = makeStore()
    const p = memoryActions(store.set, store.get).memoryDream!()
    expect(store.state().memoryCommandPending).toMatchObject({
      sessionId: 's1',
      label: 'Consolidating memory…',
    })
    resolveDream!({ disposition: 'no_work', observation_count: 0, topics_affected: 0 })
    await p
    expect(store.state().memoryCommandPending).toBeUndefined()
    expect(store.state().entries[1]).toMatchObject({ text: expect.stringContaining('没有需要整合的内容') })
  })
})
