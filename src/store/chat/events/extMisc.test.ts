import { describe, expect, it, vi } from 'vitest'
import { handleExtMiscEvent } from './extMisc'
import type { AcpEvent, ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'

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

describe('handleExtMiscEvent — session_interjection', () => {
  it('实时收到 session_interjection 广播时，生成带 isInterjection: true 的 user 行', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    const ev: AcpEvent = {
      type: 'session_interjection',
      sessionId: 's1',
      params: { text: '提交完了就部署fe' },
    }
    const handled = handleExtMiscEvent(set, get, ev)
    expect(handled).toBe(true)
    const users = state().entries.filter(
      (e): e is Extract<ScrollEntry, { kind: 'user' }> => e.kind === 'user',
    )
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({
      kind: 'user',
      text: '提交完了就部署fe',
      isInterjection: true,
      expanded: false,
    })
  })

  it('非当前会话的 session_interjection 被忽略', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    const ev: AcpEvent = {
      type: 'session_interjection',
      sessionId: 'other-session',
      params: { text: 'other' },
    }
    handleExtMiscEvent(set, get, ev)
    expect(state().entries).toHaveLength(0)
  })
})

describe('handleExtMiscEvent — models_update', () => {
  // 目录刷新 payload：当前模型不变、无显式 reasoningEffort——目录里当前
  // 模型的 _meta.reasoningEffort 是静态默认档（如 low）。
  const catalogRefresh = {
    currentModelId: 'glm-5.3',
    availableModels: [
      {
        modelId: 'glm-5.3',
        name: 'GLM-5.3',
        _meta: {
          reasoningEffort: 'low',
          supportsReasoningEffort: true,
          reasoningEfforts: [
            { value: 'low' },
            { value: 'high' },
            { value: 'max' },
          ],
        },
      },
    ],
  }

  it('目录刷新不带显式档位时保留会话当前档位（不被静态默认档覆盖）', () => {
    const { set, get, state } = makeStore({
      sessionId: 's1',
      modelName: 'GLM-5.3',
      reasoningEffort: 'high',
    })
    const ev: AcpEvent = {
      type: 'models_update',
      sessionId: 's1',
      params: catalogRefresh,
    } as AcpEvent
    handleExtMiscEvent(set, get, ev)
    expect(state().reasoningEffort).toBe('high')
    // 目录本身照常更新。
    expect(state().models?.[0]?.modelId).toBe('glm-5.3')
  })

  it('目录刷新带显式档位时（真正的档位切换）采用显式值', () => {
    const { set, get, state } = makeStore({
      sessionId: 's1',
      modelName: 'GLM-5.3',
      reasoningEffort: 'high',
    })
    const ev: AcpEvent = {
      type: 'models_update',
      sessionId: 's1',
      params: { ...catalogRefresh, reasoningEffort: 'max' },
    } as AcpEvent
    handleExtMiscEvent(set, get, ev)
    expect(state().reasoningEffort).toBe('max')
  })

  it('模型切换后（当前模型变化）落到新目录的默认档', () => {
    const { set, get, state } = makeStore({
      sessionId: 's1',
      modelName: 'GLM-5.3',
      reasoningEffort: 'high',
    })
    const switched = {
      currentModelId: 'grok-4',
      availableModels: [
        ...catalogRefresh.availableModels,
        {
          modelId: 'grok-4',
          name: 'Grok 4',
          _meta: {
            reasoningEffort: 'low',
            supportsReasoningEffort: true,
            reasoningEfforts: [{ value: 'low' }, { value: 'high' }],
          },
        },
      ],
    }
    const ev: AcpEvent = {
      type: 'models_update',
      sessionId: 's1',
      params: switched,
    } as AcpEvent
    handleExtMiscEvent(set, get, ev)
    expect(state().modelName).toBe('Grok 4')
    expect(state().reasoningEffort).toBe('low')
  })
})
