import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatState, SetState } from '../types'

vi.mock('../../../api/client', () => ({
  transport: {
    getConnectionMode: vi.fn(() => 'local'),
    getHost: vi.fn(() => 'h1'),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    workspaceListRecent: vi.fn(async () => ({ groups: [], count: 0 })),
    // historyPins 在模块加载期注册 hub_conn/prefs_changed 监听。
    onEvent: vi.fn(() => () => {}),
  },
}))

import { transport } from '../../../api/client'
import { sessionActions } from './session'

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>

function state(patch: Partial<ChatState> = {}): ChatState {
  return {
    sessionId: 's1',
    sessions: [],
    workspaces: [],
    workspaceLoading: false,
    workspaceListMode: 'recent',
    workspaceRecentLimit: 50,
    guestIdentity: null,
    entries: [],
    ...patch,
  } as unknown as ChatState
}

function bind(s: ChatState) {
  const set: SetState = (partial) => {
    Object.assign(s, typeof partial === 'function' ? partial(s) : partial)
  }
  return sessionActions(set, () => s)
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(transport.getConnectionMode as ReturnType<typeof vi.fn>).mockReturnValue('local')
  ;(transport.getHost as ReturnType<typeof vi.fn>).mockReturnValue('h1')
})

describe('sessionActions.refreshSessionLists', () => {
  it('一次调用同时刷新会话名册与工作区摘要', async () => {
    const actions = bind(state())
    await actions.refreshSessionLists()
    expect(transport.listSessions).toHaveBeenCalledTimes(1)
    expect(transport.workspaceListRecent).toHaveBeenCalledTimes(1)
  })

  it('等两个列表都结束才 resolve（各自的重试窗口计入）', async () => {
    let releaseSessions!: () => void
    let releaseWorkspaces!: () => void
    asMock(transport.listSessions).mockImplementationOnce(
      () => new Promise((resolve) => (releaseSessions = () => resolve({ sessions: [] }))),
    )
    asMock(transport.workspaceListRecent).mockImplementationOnce(
      () =>
        new Promise((resolve) => (releaseWorkspaces = () => resolve({ groups: [], count: 0 }))),
    )

    let done = false
    const p = bind(state()).refreshSessionLists().then(() => {
      done = true
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(done).toBe(false)

    releaseSessions()
    await new Promise((r) => setTimeout(r, 0))
    // 会话列表回来了，工作区摘要还在飞：统一入口不能提前放行。
    expect(done).toBe(false)

    releaseWorkspaces()
    await p
    expect(done).toBe(true)
  })
})
