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
})
