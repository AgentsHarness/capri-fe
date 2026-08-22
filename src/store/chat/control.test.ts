import { describe, expect, it, vi } from 'vitest'
import { sendControlPrompt } from './control'
import type { ChatState } from './types'

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
}))

vi.mock('../promptQueue', () => ({
  usePromptQueue: {
    getState: () => ({
      enqueue: mocks.enqueue,
      queue: [],
    }),
  },
}))

describe('sendControlPrompt', () => {
  it('忙时入队 + 排队提示', () => {
    mocks.enqueue.mockClear()
    const send = vi.fn()
    const state = { conn: 'busy', sessionId: 's1', send } as unknown as ChatState
    sendControlPrompt(
      () => state,
      vi.fn() as never,
      'workflow "x"',
      '已发送控制指令',
    )
    expect(mocks.enqueue).toHaveBeenCalledWith(
      { text: 'workflow "x"', blocks: [{ type: 'text', text: 'workflow "x"' }] },
      's1',
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('空闲时直接 send + 即时反馈', () => {
    const send = vi.fn()
    const set = vi.fn()
    const state = { conn: 'ready', sessionId: 's1', send } as unknown as ChatState
    sendControlPrompt(() => state, set as never, 'go', 'GO')
    expect(send).toHaveBeenCalledWith('go')
    expect(set).toHaveBeenCalledWith({ statusText: 'GO' })
  })

  it('无 sessionId 时入队标签为空串', () => {
    mocks.enqueue.mockClear()
    const send = vi.fn()
    const state = { conn: 'busy', send } as unknown as ChatState
    sendControlPrompt(() => state, vi.fn() as never, 'x', 'f')
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'x' }),
      '',
    )
  })
})