import { describe, expect, it, vi } from 'vitest'
import { handleExtMiscEvent } from './extMisc'
import type { AcpEvent, ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'

function makeStore(initial: Partial<ChatState> = {}) {
  let state = { entries: [], sessionId: 's1', ...initial } as ChatState
  const set = vi.fn(
    (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    },
  )
  const get = () => state
  return { set: set as unknown as SetState, get, state: () => state }
}

describe('handleExtMiscEvent — session_interjection', () => {
  it('实时收到 session_interjection 广播时，生成带 isInterjection: true 的 user 行', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    const ev: AcpEvent = {
      type: 'session_interjection',
      sessionId: 's1',
      params: { text: '提交完了就部署fe' },
    }
    const handled = handleExtMiscEvent(set, get, ev)
    expect(handled).toBe(true)
    const users = state().entries.filter(
      (e): e is Extract<ScrollEntry, { kind: 'user' }> => e.kind === 'user',
    )
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({
      kind: 'user',
      text: '提交完了就部署fe',
      isInterjection: true,
      expanded: false,
    })
  })

  it('非当前会话的 session_interjection 被忽略', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    const ev: AcpEvent = {
      type: 'session_interjection',
      sessionId: 'other-session',
      params: { text: 'other' },
    }
    handleExtMiscEvent(set, get, ev)
    expect(state().entries).toHaveLength(0)
  })
})
