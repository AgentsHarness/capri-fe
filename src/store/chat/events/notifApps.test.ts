import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpEvent, ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { beginModelSwitch, endModelSwitch, resetModelSwitchEcho } from '../modelSwitchEcho'
import { handleSessionNotification } from './sessionNotif'

function makeStore(initial: Partial<ChatState> = {}) {
  let state = { entries: [], sessionId: 's1', ...initial } as unknown as ChatState
  const set = vi.fn(
    (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    },
  )
  return { set: set as unknown as SetState, get: () => state, state: () => state }
}

const generic = (tag: string, extra: Record<string, unknown> = {}) =>
  ({
    type: 'session_notification',
    sessionId: 's1',
    params: { sessionUpdate: tag, ...extra },
  }) as AcpEvent

const texts = (state: ChatState) =>
  (state.entries ?? []).map((e) => (e as { text?: string }).text)

/**
 * 别的客户端切模型时，host 广播 typed model_changed（bridge.go
 * dispatchSessionUpdateKind）。FE 要在滚动区落一行，并同步 caption；
 * 自己的切换由 setModel 的乐观行记录，in-flight 登记负责抑制这条广播行。
 */
describe('model_changed（远端切换）', () => {
  beforeEach(() => resetModelSwitchEcho())

  const models = [
    { modelId: 'grok-3', name: 'Grok 3' },
    { modelId: 'grok-4', name: 'Grok 4' },
  ]

  it('名称变了 → 一行警告 + caption 换成显示名', () => {
    const { set, get, state } = makeStore({
      modelName: 'Grok 3',
      reasoningEffort: 'low',
      models,
    })
    expect(
      handleSessionNotification(
        set,
        get,
        generic('model_changed', { model_id: 'grok-4', reasoning_effort: 'high' }),
      ),
    ).toBe(true)
    expect(texts(state())).toEqual(['模型已从 Grok 3(low) 切换到 Grok 4(high)'])
    expect((state().entries[0] as ScrollEntry).kind).toBe('session_event')
    expect(state().modelName).toBe('Grok 4')
    expect(state().reasoningEffort).toBe('high')
  })

  it('本端的乐观切换回声（名称已相同）→ 不再补一行', () => {
    const { set, get, state } = makeStore({ modelName: 'Grok 4', models })
    handleSessionNotification(
      set,
      get,
      generic('model_changed', { model_id: 'grok-4' }),
    )
    expect(texts(state())).toEqual([])
  })

  // host 先广播 model_changed 再回 HTTP 响应：发起切换的标签页此刻
  // modelName 还是旧值，单靠「名称没变」守卫会重复落行。in-flight 登记
  // 让广播只更新身份，切换行留给 setModel 的乐观行。
  it('本端切换在飞行中（广播先于 HTTP 响应）→ 只更新身份，不落行', () => {
    const { set, get, state } = makeStore({
      modelName: 'Grok 3',
      reasoningEffort: 'low',
      models,
    })
    beginModelSwitch('s1', 'grok-4')
    try {
      handleSessionNotification(
        set,
        get,
        generic('model_changed', { model_id: 'grok-4', reasoning_effort: 'high' }),
      )
    } finally {
      endModelSwitch('s1', 'grok-4')
    }
    expect(texts(state())).toEqual([])
    expect(state().modelName).toBe('Grok 4')
    expect(state().reasoningEffort).toBe('high')
  })

  it('本端切换结束后标记释放 → 同一模型的远端广播仍落行', () => {
    const { set, get, state } = makeStore({ modelName: 'Grok 3', models })
    beginModelSwitch('s1', 'grok-4')
    endModelSwitch('s1', 'grok-4')
    handleSessionNotification(
      set,
      get,
      generic('model_changed', { model_id: 'grok-4' }),
    )
    expect(texts(state())).toEqual(['模型已从 Grok 3 切换到 Grok 4'])
  })

  it('会话切换加载中 → 忽略（load 响应是权威）', () => {
    const { set, get, state } = makeStore({
      modelName: 'Grok 3',
      historyLoading: true,
      models,
    })
    handleSessionNotification(
      set,
      get,
      generic('model_changed', { model_id: 'grok-4' }),
    )
    expect(texts(state())).toEqual([])
    expect(state().modelName).toBe('Grok 3')
  })
})
