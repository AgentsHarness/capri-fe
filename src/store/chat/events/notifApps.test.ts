import { describe, expect, it, vi } from 'vitest'
import type { AcpEvent, ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'
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
 * 自己的切换有 setModel 的乐观行，靠「名称没变」去重。
 */
describe('model_changed（远端切换）', () => {
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
