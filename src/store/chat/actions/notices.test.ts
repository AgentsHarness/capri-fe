import { describe, expect, it, vi } from 'vitest'
import { noticeActions } from './notices'
import type { ChatState, SetState } from '../types'
import { pushToast } from '../../toast'

vi.mock('../../toast', () => ({ pushToast: vi.fn(), dismissToast: vi.fn() }))
vi.mock('../../notifyConfig', () => ({ shouldNotify: () => true }))

function makeStore(initial: Partial<ChatState> = {}) {
  let state = {
    sessionId: 'cur',
    completedNotices: {},
    sessions: [
      { sessionId: 'cur', title: '当前会话' },
      { sessionId: 'other', title: '别的会话' },
    ],
    ...initial,
  } as unknown as ChatState
  const set = vi.fn(
    (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    },
  )
  return { set: set as unknown as SetState, get: () => state, state: () => state }
}

const mockToast = vi.mocked(pushToast)

/** jsdom 没有 Notification：走页面 toast 分支，便于断言"有没有提醒"。 */
vi.stubGlobal('Notification', undefined)

describe('noteSessionCompleted', () => {
  it('别的会话跑完：记 ✓ 并弹完成 toast', () => {
    const { set, get, state } = makeStore()
    mockToast.mockClear()
    noticeActions(set, get).noteSessionCompleted('other')
    expect(typeof state().completedNotices.other).toBe('number')
    expect(mockToast).toHaveBeenCalledWith('「别的会话」已完成', expect.any(String))
  })

  it('当前会话跑完：只记数据（切走后可从 ✓ 看到），不弹提醒', () => {
    const { set, get, state } = makeStore()
    mockToast.mockClear()
    noticeActions(set, get).noteSessionCompleted('cur')
    expect(typeof state().completedNotices.cur).toBe('number')
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('silent：记数据但不提醒（任意会话）', () => {
    const { set, get, state } = makeStore()
    mockToast.mockClear()
    noticeActions(set, get).noteSessionCompleted('other', { silent: true })
    expect(typeof state().completedNotices.other).toBe('number')
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('去重窗口内重复完成只提醒一次，数据仍刷新', () => {
    const { set, get, state } = makeStore()
    mockToast.mockClear()
    const actions = noticeActions(set, get)
    actions.noteSessionCompleted('other')
    const first = state().completedNotices.other
    actions.noteSessionCompleted('other')
    expect(state().completedNotices.other).toBeGreaterThanOrEqual(first)
    expect(mockToast).toHaveBeenCalledTimes(1)
  })
})
