import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initChat } from './init'
import type { ChatState, SetState } from '../types'
import type { StoreApi } from 'zustand'
import { MODE_FLAGS_KEY, PLAN_FLAGS_KEY } from '../modeFlags'
import { saveJSON } from '../../../lib/storage'

let eventHandler: ((ev: unknown) => void) | undefined

vi.mock('../../../api/client', () => ({
  transport: {
    onEvent: vi.fn((fn: (ev: unknown) => void) => {
      eventHandler = fn
      return () => {
        eventHandler = undefined
      }
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getConnectionMode: vi.fn(() => 'local'),
  },
}))

vi.mock('../../promptQueue', () => ({
  applyQueueChanged: vi.fn(),
}))

vi.mock('../../historyPins', () => ({
  usePins: {
    getState: () => ({
      syncPrefsFromHub: vi.fn(),
    }),
  },
}))

vi.mock('../globals', () => ({
  bufferHistoryWindowEvent: vi.fn(),
  clearContinueSessionTimer: vi.fn(),
  clearPeerSessionLoad: vi.fn(),
}))

vi.mock('../../settings', () => ({
  onUiSettingsReady: vi.fn(),
  onUiSettingsChange: vi.fn(() => () => {}),
}))

describe('initChat 多会话与双 FE 全局模式同步', () => {
  let state: Partial<ChatState>
  let set: SetState
  let get: () => ChatState
  let api: StoreApi<ChatState>

  beforeEach(() => {
    state = {
      sessionId: 'sess-current',
      historyLoading: false,
      historyLoadingMore: false,
      subagentChildIndex: {},
      yoloMode: true,
      autoMode: false,
      permissionMode: 'always-approve',
      handleEvent: vi.fn(),
      stopTopTaskPolling: vi.fn(),
    }
    set = vi.fn((patch) => {
      const next = typeof patch === 'function' ? patch(state as ChatState) : patch
      Object.assign(state, next)
    }) as unknown as SetState
    get = () => state as ChatState
    api = {
      getState: get,
      setState: set as unknown as StoreApi<ChatState>['setState'],
      subscribe: vi.fn(() => () => {}),
      getInitialState: get,
    }
  })

  afterEach(() => {
    eventHandler = undefined
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('全局事件族（yolo_mode_changed）即使携带非当前会话的 sessionId 也不得被过滤', () => {
    const cleanup = initChat(set, get, api)
    expect(eventHandler).toBeDefined()

    // 模拟来自另一个会话 sess-other 的 yolo_mode_changed 事件
    eventHandler!({
      type: 'yolo_mode_changed',
      sessionId: 'sess-other',
      params: { yolo_mode: false, auto_mode: false, permission_mode: 'ask' },
    })

    // 必须成功放行给 handleEvent，不能被单会话过滤丢弃
    expect(state.handleEvent).toHaveBeenCalledWith({
      type: 'yolo_mode_changed',
      sessionId: 'sess-other',
      params: { yolo_mode: false, auto_mode: false, permission_mode: 'ask' },
    })

    cleanup()
  })

  it('普通会话事件（如 chunk/tool_call）带其它会话 sessionId 时必须被过滤', () => {
    const cleanup = initChat(set, get, api)

    eventHandler!({
      type: 'chunk',
      sessionId: 'sess-other',
      text: 'hello from other session',
    })

    // 普通事件不属于当前会话，不得放行给主 handleEvent
    expect(state.handleEvent).not.toHaveBeenCalled()

    cleanup()
  })

  it('检索引擎状态流（search_fuzzy_status）即使 sessionId 是 "agent" 也要放行', () => {
    // host 用 agent 自报的 sessionId 给 fuzzy 状态打标签（字面量 "agent"，
    // 永远不等于会话 UUID）——顶层会话过滤一旦拦截，@ 选择器就再也拿不到
    // 任何匹配结果。
    const cleanup = initChat(set, get, api)

    const ev = {
      type: 'search_fuzzy_status',
      sessionId: 'agent',
      params: { sessionId: 'agent', searchId: 'sr-1', matches: [], done: true },
    }
    eventHandler!(ev)

    expect(state.handleEvent).toHaveBeenCalledWith(ev)

    cleanup()
  })

  it('同源多 Tab 同步：监听 storage 事件可在另一 Tab 切换模式后即时同步', () => {
    const cleanup = initChat(set, get, api)

    // 初始状态是 yoloMode: true
    expect(state.yoloMode).toBe(true)

    // 模拟另一个 Tab 切换为 normal 模式并写入 localStorage
    saveJSON(MODE_FLAGS_KEY, { confirmedAsk: true })
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: MODE_FLAGS_KEY,
        newValue: JSON.stringify({ confirmedAsk: true }),
      }),
    )

    // 本 Tab 应立即更新为 normal 模式
    expect(set).toHaveBeenCalledWith({
      yoloMode: false,
      autoMode: false,
      permissionMode: undefined,
    })
    expect(state.yoloMode).toBe(false)
    expect(state.permissionMode).toBeUndefined()

    // 模拟另一个 Tab 切换为 always-approve
    saveJSON(MODE_FLAGS_KEY, { yoloMode: true, permissionMode: 'always-approve' })
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: MODE_FLAGS_KEY,
        newValue: JSON.stringify({ yoloMode: true, permissionMode: 'always-approve' }),
      }),
    )

    expect(state.yoloMode).toBe(true)
    expect(state.permissionMode).toBe('always-approve')

    cleanup()
  })

  it('同源多 Tab 同步：监听 storage 事件可在另一 Tab 切换/退出当前会话 planMode 时即时同步', () => {
    state.sessionId = 'sess-current'
    state.planMode = false
    const cleanup = initChat(set, get, api)

    // 模拟另一个 Tab 将当前会话 sess-current 切换为 plan 模式
    saveJSON(PLAN_FLAGS_KEY, { 'sess-current': true, 'sess-other': false })
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: PLAN_FLAGS_KEY,
        newValue: JSON.stringify({ 'sess-current': true }),
      }),
    )

    // 本 Tab 当前会话立即开启 planMode
    expect(state.planMode).toBe(true)

    // 模拟另一个 Tab 退出 plan 模式（例如审批通过 exit_plan_mode 或 Shift+Tab）
    saveJSON(PLAN_FLAGS_KEY, { 'sess-current': false, 'sess-other': false })
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: PLAN_FLAGS_KEY,
        newValue: JSON.stringify({ 'sess-current': false }),
      }),
    )

    // 本 Tab 当前会话立即关闭 planMode
    expect(state.planMode).toBe(false)

    // 模拟另一个 Tab 修改了非当前会话 sess-other 的 plan 模式，本会话不受影响
    saveJSON(PLAN_FLAGS_KEY, { 'sess-current': false, 'sess-other': true })
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: PLAN_FLAGS_KEY,
        newValue: JSON.stringify({ 'sess-other': true }),
      }),
    )
    expect(state.planMode).toBe(false)

    cleanup()
  })
})
