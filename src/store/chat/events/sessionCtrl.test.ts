import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleSessionCtrlEvent } from './sessionCtrl'
import type { AcpEvent } from '../../../api/types'
import type { ChatState, SetState } from '../types'

vi.mock('../pending', () => ({
  SUPPORTED_XAI_REQUESTS: new Set(['x.ai/ask_user_question']),
  syncPendingForSession: vi.fn().mockResolvedValue(undefined),
}))

import { SUPPORTED_XAI_REQUESTS } from '../pending'

function makeState(patch: Partial<ChatState> = {}): ChatState {
  return {
    sessionId: 's1',
    cwd: '/w',
    entries: [],
    pending: [],
    xaiRequests: [],
    respondXai: vi.fn().mockResolvedValue(undefined),
    ...patch,
  } as unknown as ChatState
}

function bind(state: ChatState) {
  const set: SetState = (partial) => {
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  }
  return { set, get: () => state }
}

const reqEvent = (params: Record<string, unknown>, topSid?: string): AcpEvent =>
  ({
    type: 'client_request',
    requestId: 'r1',
    method: 'session/request_permission',
    params,
    ...(topSid ? { sessionId: topSid } : {}),
  }) as unknown as AcpEvent

describe('client_request 会话归属', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    SUPPORTED_XAI_REQUESTS.clear()
    SUPPORTED_XAI_REQUESTS.add('x.ai/ask_user_question')
  })

  it('params 带别的会话 sid（host 未打顶层 sid）→ 不画进当前视图', () => {
    const state = makeState()
    const { set, get } = bind(state)
    const handled = handleSessionCtrlEvent(set, get, reqEvent({ sessionId: 's2' }))
    expect(handled).toBe(true)
    expect(state.pending).toEqual([])
  })

  it('params sid 就是当前会话 → 正常入卡并带上归属', () => {
    const state = makeState()
    const { set, get } = bind(state)
    handleSessionCtrlEvent(set, get, reqEvent({ sessionId: 's1' }))
    expect(state.pending.map((p) => p.requestId)).toEqual(['r1'])
    expect(state.pending[0]).toMatchObject({ sessionId: 's1' })
  })

  it('无 sid 的 legacy 请求照旧放行（兼容老 host）', () => {
    const state = makeState()
    const { set, get } = bind(state)
    handleSessionCtrlEvent(set, get, reqEvent({ options: [] }))
    expect(state.pending.map((p) => p.requestId)).toEqual(['r1'])
  })

  it('空状态（会话尚未锚定）下带 sid 的请求丢弃，无 sid 仍放行', () => {
    const empty = makeState({ sessionId: undefined })
    const a = bind(empty)
    handleSessionCtrlEvent(a.set, a.get, reqEvent({ sessionId: 's2' }))
    expect(empty.pending).toEqual([])
    handleSessionCtrlEvent(a.set, a.get, reqEvent({ options: [] }))
    expect(empty.pending.map((p) => p.requestId)).toEqual(['r1'])
  })

  it('他会话的 x.ai 请求不再被本会话自动拒绝', () => {
    const state = makeState()
    const { set, get } = bind(state)
    handleSessionCtrlEvent(
      set,
      get,
      { type: 'client_request', requestId: 'r9', method: 'x.ai/nope', params: { sessionId: 's2' } } as unknown as AcpEvent,
    )
    expect(state.respondXai).not.toHaveBeenCalled()
    expect(state.xaiRequests).toEqual([])
  })

  it('本会话的 unsupported x.ai 方法仍立即拒绝', () => {
    const state = makeState()
    const { set, get } = bind(state)
    handleSessionCtrlEvent(
      set,
      get,
      { type: 'client_request', requestId: 'r9', method: 'x.ai/nope', params: {} } as unknown as AcpEvent,
    )
    expect(state.respondXai).toHaveBeenCalledWith('r9', undefined, expect.stringContaining('前端不支持方法'))
  })

  it('透传 host 下发的 receivedAt 时间戳', () => {
    const state = makeState()
    const { set, get } = bind(state)
    handleSessionCtrlEvent(set, get, {
      type: 'client_request',
      requestId: 'r-recv',
      method: 'x.ai/ask_user_question',
      params: { sessionId: 's1' },
      receivedAt: 1_700_000_000_123,
    } as unknown as AcpEvent)
    expect(state.xaiRequests[0]).toMatchObject({
      requestId: 'r-recv',
      receivedAt: 1_700_000_000_123,
    })
  })
})

describe('访客：卡片不挂载，只重拉只读状态', () => {
  const guestState = (patch: Partial<ChatState> = {}): ChatState =>
    makeState({
      guestIdentity: {
        role: 'guest',
        guest: { id: 'g1', label: '给小王', expiresAt: 0 },
        sessions: [],
      },
      refreshGuestStatus: vi.fn().mockResolvedValue(undefined),
      ...patch,
    } as Partial<ChatState>)

  it('client_request → 不建 pending 卡，只刷新状态', () => {
    const state = guestState()
    const { set, get } = bind(state)
    handleSessionCtrlEvent(set, get, reqEvent({ sessionId: 's1' }))
    expect(state.pending).toEqual([])
    expect(state.xaiRequests).toEqual([])
    expect(state.refreshGuestStatus).toHaveBeenCalled()
  })

  it('client_request 属于别的会话 → 不刷新本会话状态', () => {
    const state = guestState()
    const { set, get } = bind(state)
    handleSessionCtrlEvent(set, get, reqEvent({}, 's2'))
    expect(state.refreshGuestStatus).not.toHaveBeenCalled()
  })

  it('client_request_resolved → 状态行从「在等」收回', () => {
    const state = guestState()
    const { set, get } = bind(state)
    handleSessionCtrlEvent(set, get, {
      type: 'client_request_resolved',
      requestId: 'r1',
      sessionId: 's1',
    } as AcpEvent)
    expect(state.refreshGuestStatus).toHaveBeenCalled()
  })

  it('管理员壳行为不变：照常入卡、不刷新访客状态', () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const state = makeState({ refreshGuestStatus: refresh } as Partial<ChatState>)
    const { set, get } = bind(state)
    handleSessionCtrlEvent(set, get, reqEvent({ sessionId: 's1' }))
    expect(state.pending.map((p) => p.requestId)).toEqual(['r1'])
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('client_request_resolved 退出 plan', () => {  it('另一端批准 exit_plan_mode → 清掉本页 plan 标记', () => {
    const state = makeState({
      planMode: true,
      permissionMode: 'plan',
      xaiRequests: [
        { requestId: 'r2', method: 'x.ai/exit_plan_mode', params: {} },
      ],
    })
    const { set, get } = bind(state)
    handleSessionCtrlEvent(set, get, {
      type: 'client_request_resolved',
      requestId: 'r2',
      method: 'x.ai/exit_plan_mode',
      outcome: 'approved',
    } as AcpEvent)
    expect(state.planMode).toBe(false)
    expect(state.permissionMode).toBeUndefined()
    expect(state.xaiRequests).toEqual([])
  })

  it('cancelled / 超时不清 plan', () => {
    const state = makeState({
      planMode: true,
      xaiRequests: [
        { requestId: 'r2', method: 'x.ai/exit_plan_mode', params: {} },
      ],
    })
    const { set, get } = bind(state)
    handleSessionCtrlEvent(set, get, {
      type: 'client_request_resolved',
      requestId: 'r2',
      method: 'x.ai/exit_plan_mode',
      cancelled: true,
    } as AcpEvent)
    expect(state.planMode).toBe(true)
    expect(state.xaiRequests).toEqual([])
  })
})
