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

describe('handleNotifCore — auto_compact 的相位文案', () => {
  it('空闲时 auto_compact_completed 只写相位，不把反馈槽占住', () => {
    const { set, get, state } = makeStore({
      conn: 'ready',
      phaseText: '就绪',
      statusText: '',
    })
    const handled = handleNotifCore(
      set,
      get,
      { type: 'session_notification', sessionId: 's1' } as WireEvent,
      'auto_compact_completed',
      {},
    )
    expect(handled).toBe(true)
    expect(state().phaseText).toBe('Waiting for response…')
    expect(state().statusText).toBe('')
  })
})

describe('handleNotifCore — 后台任务生命周期刷新会话名册', () => {
  it('task_backgrounded 触发一次 refreshSessions（侧栏 bg 徽标）', () => {
    const refreshSessions = vi.fn().mockResolvedValue(undefined)
    const { set, get } = makeStore({
      entries: [],
      topTasks: [],
      bgTaskIndex: {},
      refreshSessions,
    } as Partial<ChatState>)
    handleNotifCore(
      set,
      get,
      { type: 'session_notification', sessionId: 's1' } as WireEvent,
      'task_backgrounded',
      { sessionUpdate: 'task_backgrounded', task_id: 't-1', command: 'sleep 100' },
    )
    expect(refreshSessions).toHaveBeenCalledTimes(1)
  })

  it('task_completed 触发一次 refreshSessions（撤掉侧栏 bg 徽标）', () => {
    const refreshSessions = vi.fn().mockResolvedValue(undefined)
    const { set, get } = makeStore({
      entries: [
        { id: 'e-1', kind: 'bg_task', taskId: 't-1', title: 'sleep', status: 'started', running: true },
      ],
      topTasks: [],
      bgTaskIndex: { 't-1': 'e-1' },
      phaseText: 'Waiting for response…',
      conn: 'busy',
      refreshSessions,
    } as unknown as Partial<ChatState>)
    handleNotifCore(
      set,
      get,
      { type: 'session_notification', sessionId: 's1' } as WireEvent,
      'task_completed',
      { sessionUpdate: 'task_completed', task_snapshot: { task_id: 't-1', command: 'sleep 100', exit_code: 0 } },
    )
    expect(refreshSessions).toHaveBeenCalledTimes(1)
  })
})

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
