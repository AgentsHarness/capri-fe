import { describe, expect, it, vi } from 'vitest'
import type { AcpEvent } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { handleExtSessionEvent } from './extSession'

function makeStore(initial: Partial<ChatState> = {}) {
  let state = { entries: [], sessionId: 's1', sessions: [], ...initial } as ChatState
  const set = vi.fn(
    (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    },
  )
  const get = () => state
  return { set: set as unknown as SetState, get, state: () => state }
}

const sessionsChanged = (params?: Record<string, unknown>) =>
  ({ type: 'sessions_changed', params }) as AcpEvent

describe('sessions_changed 的分流', () => {
  it('带 upserted 的行级补丁：合并进列表，不触发整表重拉', () => {
    const refreshSessionLists = vi.fn()
    const { set, get, state } = makeStore({
      sessions: [
        {
          sessionId: 's1',
          cwd: '/w',
          title: 'keep',
          status: { state: 'active', busy: true },
          bgCount: 3,
        },
      ],
      refreshSessionLists,
    } as Partial<ChatState>)

    handleExtSessionEvent(set, get, sessionsChanged({
      upserted: [
        { sessionId: 's1', status: { state: 'idle', busy: false } },
      ],
    }))

    // 这是本次改动的核心收益：一次忙碌翻转不再换来一对全量拉取。
    expect(refreshSessionLists).not.toHaveBeenCalled()
    const row = state().sessions[0]
    expect(row.status?.busy).toBe(false)
    // census 字段不在补丁行里 → 不能被清零
    expect(row.bgCount).toBe(3)
    expect(row.title).toBe('keep')
  })

  it('空 params（结构变化）：仍然整表重拉', () => {
    const refreshSessionLists = vi.fn()
    const { set, get } = makeStore({
      sessions: [],
      refreshSessionLists,
    } as Partial<ChatState>)

    handleExtSessionEvent(set, get, sessionsChanged({}))

    expect(refreshSessionLists).toHaveBeenCalledTimes(1)
  })

  it('补丁里有日历里没有的会话：回落成整表重拉（缺 cwd / 摘要）', () => {
    const refreshSessionLists = vi.fn()
    const { set, get } = makeStore({
      sessions: [{ sessionId: 's1', cwd: '/w' }],
      refreshSessionLists,
    } as Partial<ChatState>)

    handleExtSessionEvent(set, get, sessionsChanged({
      upserted: [{ sessionId: 'brand-new', cwd: '/other' }],
    }))

    expect(refreshSessionLists).toHaveBeenCalledTimes(1)
    // 纠正是整表重拉里最不该等的：绕过闸门的 400ms 尾随窗口。
    expect(refreshSessionLists).toHaveBeenCalledWith(1, { immediate: true })
  })

  it('removed 生效且不需要重拉', () => {
    const refreshSessionLists = vi.fn()
    const { set, get, state } = makeStore({
      sessions: [
        { sessionId: 's1', cwd: '/w' },
        { sessionId: 's2', cwd: '/w' },
      ],
      refreshSessionLists,
    } as Partial<ChatState>)

    handleExtSessionEvent(set, get, sessionsChanged({ removed: ['s2'] }))

    expect(refreshSessionLists).not.toHaveBeenCalled()
    expect(state().sessions.map((s) => s.sessionId)).toEqual(['s1'])
  })
})
