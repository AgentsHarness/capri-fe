import { describe, expect, it, vi } from 'vitest'
import type { ChatState, SetState } from '../types'
import type { WireEvent } from './wire'
import { handleNotifApps, parseSessionStatus } from './notifApps'

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

const statusFields = (over: Record<string, unknown> = {}) => ({
  sessionUpdate: 'session_status',
  session_id: 's1',
  cwd: '/w',
  context_window: {
    context_tokens: 214_000,
    context_window_size: 1_000_000,
    used_percentage: 21,
    auto_compact_threshold_percent: 85,
  },
  cost: { total_cost_usd: 0.1234, total_duration_ms: 83_000 },
  ...over,
})

describe('parseSessionStatus — snake_case 载荷解析', () => {
  it('解析展示子集；Grok 取不到的字段是缺失而不是 0', () => {
    expect(parseSessionStatus(statusFields() as Record<string, unknown>)).toEqual({
      contextTokens: 214_000,
      contextWindowSize: 1_000_000,
      usedPercent: 21,
      autoCompactThresholdPercent: 85,
      totalCostUsd: 0.1234,
      totalDurationMs: 83_000,
    })
  })

  it('无 context_window / cost → null；非数值与负数忽略', () => {
    expect(parseSessionStatus({ sessionUpdate: 'session_status' })).toBeNull()
    expect(
      parseSessionStatus({
        context_window: { context_tokens: '214000', context_window_size: -1 },
        cost: { total_cost_usd: Number.NaN },
      }),
    ).toBeNull()
  })

  it('上下文窗口存在但 token 缺失时只带窗口字段（0 是合法值）', () => {
    expect(parseSessionStatus({ context_window: { context_tokens: 0 } })).toEqual({
      contextTokens: 0,
    })
  })
})

describe('handleNotifApps — session_status', () => {
  it('写入 sessionStatus 并用现场快照校正上下文用量', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    const handled = handleNotifApps(
      set,
      get,
      { type: 'session_status', sessionId: 's1' } as WireEvent,
      'session_status',
      statusFields() as Record<string, unknown>,
    )
    expect(handled).toBe(true)
    expect(state().sessionStatus).toMatchObject({
      contextTokens: 214_000,
      contextWindowSize: 1_000_000,
      totalCostUsd: 0.1234,
      totalDurationMs: 83_000,
    })
    expect(state().usage).toEqual({ used: 214_000, size: 1_000_000 })
  })

  it('快照缺 token 时不覆盖已有用量（只补窗口大小）', () => {
    const { set, get, state } = makeStore({ sessionId: 's1', usage: { used: 5, size: 10 } })
    handleNotifApps(
      set,
      get,
      { type: 'session_status', sessionId: 's1' } as WireEvent,
      'session_status',
      { context_window: { context_window_size: 200 } } as Record<string, unknown>,
    )
    expect(state().usage).toEqual({ used: 5, size: 200 })
  })

  it('载荷 session_id 与当前会话不符 → 整条忽略（优先信载荷）', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    handleNotifApps(
      set,
      get,
      { type: 'session_status', sessionId: 's1' } as WireEvent,
      'session_status',
      statusFields({ session_id: 'other' }) as Record<string, unknown>,
    )
    expect(state().sessionStatus).toBeUndefined()
    expect(state().usage).toBeUndefined()
  })

  it('载荷无 session_id 时按宿主标记过滤外来会话', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    const fields = statusFields()
    delete (fields as Record<string, unknown>).session_id
    handleNotifApps(
      set,
      get,
      { type: 'session_status', sessionId: 'other' } as WireEvent,
      'session_status',
      fields as Record<string, unknown>,
    )
    expect(state().sessionStatus).toBeUndefined()
  })

  it('刷新后首帧：无 usage 事件也能先显示窗口用量（来源标注在快照里）', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    handleNotifApps(
      set,
      get,
      { type: 'session_status', sessionId: 's1' } as WireEvent,
      'session_status',
      statusFields({ session_id: undefined }) as Record<string, unknown>,
    )
    expect(state().usage?.used).toBe(214_000)
  })
})
