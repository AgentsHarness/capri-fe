import { describe, expect, it, vi } from 'vitest'
import { handleExtSessionEvent } from './extSession'
import type { AcpEvent } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { runtime } from '../globals'

function makeStore(initial: Partial<ChatState> = {}) {
  let state = { sessionId: 's1', gitInfo: undefined, ...initial } as ChatState
  const set = vi.fn(
    (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    },
  )
  const get = () => state
  return { set: set as unknown as SetState, get, state: () => state }
}

describe('handleExtSessionEvent — git_head_changed', () => {
  it('当前会话 HEAD 变更写入状态栏分支', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    const handled = handleExtSessionEvent(set, get, {
      type: 'git_head_changed',
      sessionId: 's1',
      params: { sessionId: 's1', branch: 'feat/x', isWorktree: false },
    } as AcpEvent)
    expect(handled).toBe(true)
    expect(state().gitInfo).toEqual({
      branch: 'feat/x',
      isWorktree: false,
      mainRepo: undefined,
    })
  })

  it('payload sessionId 属于别的会话时不覆盖当前分支', () => {
    const { set, get, state } = makeStore({
      sessionId: 's1',
      gitInfo: { branch: 'main', isWorktree: false },
    })
    handleExtSessionEvent(set, get, {
      type: 'git_head_changed',
      sessionId: 's1',
      params: { sessionId: 's-other', branch: 'other-branch' },
    } as AcpEvent)
    expect(state().gitInfo?.branch).toBe('main')
  })

  it('信封 sessionId 错标时仍以 payload sessionId 为准', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    handleExtSessionEvent(set, get, {
      type: 'git_head_changed',
      sessionId: 'active-fallback',
      params: { sessionId: 's1', branch: 'from-payload' },
    } as AcpEvent)
    expect(state().gitInfo?.branch).toBe('from-payload')
  })

  it('空 branch 显示 detached', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    handleExtSessionEvent(set, get, {
      type: 'git_head_changed',
      params: { sessionId: 's1', branch: '' },
    } as AcpEvent)
    expect(state().gitInfo?.branch).toBe('(detached)')
  })

  it('落地后抬升 gitInfoEpoch，挡住在飞的探盘覆盖', () => {
    const before = runtime.gitInfoEpoch
    const { set, get } = makeStore({ sessionId: 's1' })
    handleExtSessionEvent(set, get, {
      type: 'git_head_changed',
      params: { sessionId: 's1', branch: 'new' },
    } as AcpEvent)
    expect(runtime.gitInfoEpoch).toBe(before + 1)
  })
})
