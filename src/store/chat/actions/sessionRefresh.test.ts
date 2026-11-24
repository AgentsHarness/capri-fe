// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('工作区列表拉取失败时的收口', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('保留已加载的列表：不降级成只有标题，也不翻成全量', async () => {
    const prev = [
      {
        cwd: '/w',
        label: '/w',
        sessions: [{ sessionId: 's1', cwd: '/w', title: '标题在', lastTurnSummary: '上次干了什么' }],
      },
    ]
    const s = state({ workspaces: prev })
    asMock(transport.workspaceListRecent).mockRejectedValueOnce(new Error('502'))

    await bind(s).refreshSessionLists()

    expect(s.workspaces).toBe(prev)
    expect(s.workspaceListMode).toBe('recent')
    expect(s.workspaceLoading).toBe(false)
  })

  it('一份都没有时用名册兜底，展示模式仍保持最近', async () => {
    const s = state({
      workspaces: [],
      sessions: [{ sessionId: 'a', cwd: '/w', title: 'A' }],
    })
    // 名册与摘要并发：名册回来的行要被兜底用上（mock 默认返回空名册）。
    asMock(transport.listSessions).mockResolvedValueOnce({
      sessions: [{ sessionId: 'a', cwd: '/w', title: 'A' }],
    })
    asMock(transport.workspaceListRecent).mockRejectedValueOnce(new Error('502'))

    await bind(s).refreshSessionLists()

    expect(s.workspaces).toEqual([
      { cwd: '/w', label: 'w', sessions: [{ sessionId: 'a', cwd: '/w', title: 'A' }] },
    ])
    expect(s.workspaceListMode).toBe('recent')
  })

  it('失败不阻塞调用方，4 秒后在闸门外补一次并落地', async () => {
    const s = state()
    asMock(transport.workspaceListRecent)
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValueOnce({
        groups: [
          { cwd: '/w', label: '/w', sessions: [{ sessionId: 's1', cwd: '/w', title: '回来了' }] },
        ],
        count: 1,
      })

    await bind(s).refreshSessionLists()
    expect(transport.workspaceListRecent).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4000)
    expect(transport.workspaceListRecent).toHaveBeenCalledTimes(2)
    expect(s.workspaces[0]?.sessions[0]?.title).toBe('回来了')
  })
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
