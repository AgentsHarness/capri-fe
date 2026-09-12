import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleNotifCore } from './notifCore'
import type { ChatState, SetState } from '../types'
import type { WireEvent } from './wire'
import { resetPlanExitApprovedForTest } from '../modePersist'

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

describe('handleNotifCore — current_mode_update', () => {
  beforeEach(() => {
    resetPlanExitApprovedForTest()
  })

  it('currentModeId=plan → 当前会话进入 plan', () => {
    const { set, get, state } = makeStore({ planMode: false })
    const handled = handleNotifCore(
      set,
      get,
      { type: 'session_notification', sessionId: 's1' } as WireEvent,
      'current_mode_update',
      { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    )
    expect(handled).toBe(true)
    expect(state().planMode).toBe(true)
  })

  it('currentModeId=default → 当前会话退出 plan', () => {    const { set, get, state } = makeStore({
      planMode: true,
      permissionMode: 'plan',
    })
    handleNotifCore(
      set,
      get,
      { type: 'session_notification', sessionId: 's1' } as WireEvent,
      'current_mode_update',
      { sessionUpdate: 'current_mode_update', currentModeId: 'default' },
    )
    expect(state().planMode).toBe(false)
    expect(state().permissionMode).toBeUndefined()
  })

  // 跨会话过滤已上移到分发层（events/sessionNotif.ts + attribution.ts），
  // 对应用例见 sessionDispatch.test.ts。
})
