import { describe, expect, it, vi } from 'vitest'
import { handleExtMiscEvent } from './extMisc'
import type { AcpEvent, ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { restorePlanMode } from '../modeFlags'

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

describe('handleExtMiscEvent — scheduled_task_deleted 跨会话同步', () => {
  it('其他会话删除定时任务：本会话任务列表能成功移除该任务，且不污染本会话滚动区提示行', () => {
    const task = {
      taskId: 'task-123',
      prompt: 'do something',
      interval: '1h',
      status: 'active' as const,
    }
    const { set, get, state } = makeStore({
      sessionId: 's1',
      scheduledTasks: [task],
      entries: [],
    })

    const ev: AcpEvent = {
      type: 'scheduled_task_deleted',
      sessionId: 'other-session',
      taskId: 'task-123',
      reason: 'deleted',
    } as AcpEvent

    handleExtMiscEvent(set, get, ev)

    // 全局 scheduledTasks 必须被移除
    expect(state().scheduledTasks).toEqual([])
    // entries 不能插入非本会话的 session_event 提示行
    expect(state().entries).toHaveLength(0)
  })

  it('当前会话删除定时任务：本会话任务列表移除，且生成可见的提示行', () => {
    const task = {
      taskId: 'task-123',
      prompt: 'do something',
      interval: '1h',
      status: 'active' as const,
    }
    const { set, get, state } = makeStore({
      sessionId: 's1',
      scheduledTasks: [task],
      entries: [],
    })

    const ev: AcpEvent = {
      type: 'scheduled_task_deleted',
      sessionId: 's1',
      taskId: 'task-123',
      reason: 'deleted',
    } as AcpEvent

    handleExtMiscEvent(set, get, ev)

    expect(state().scheduledTasks).toEqual([])
    expect(state().entries).toHaveLength(1)
    expect(state().entries[0].kind).toBe('session_event')
  })
})

describe('handleExtMiscEvent — model 与 session_rewound 跨会话同步', () => {
  it('非当前会话的 model 事件：更新侧边栏 workspaces 缓存中对应会话的 currentModelId', () => {
    const ws = [
      {
        cwd: '/work',
        label: 'work',
        sessions: [
          { sessionId: 's1', cwd: '/work', currentModelId: 'grok-3' },
          { sessionId: 'other-session', cwd: '/work', currentModelId: 'grok-3' },
        ],
      },
    ]
    const { set, get, state } = makeStore({
      sessionId: 's1',
      modelName: 'Grok 3',
      workspaces: ws,
    })

    const ev: AcpEvent = {
      type: 'model',
      sessionId: 'other-session',
      modelId: 'grok-4',
      modelName: 'Grok 4',
    } as AcpEvent

    handleExtMiscEvent(set, get, ev)

    // 本会话当前模型不变
    expect(state().modelName).toBe('Grok 3')
    // workspaces 里 other-session 的 currentModelId 更新为 grok-4
    const target = state().workspaces[0].sessions.find((s) => s.sessionId === 'other-session')
    expect(target?.currentModelId).toBe('grok-4')
  })

  it('session_rewound 事件：刷新会话列表并对当前会话执行截断', () => {
    const refreshSessions = vi.fn()
    const refreshWorkspaces = vi.fn()
    const entries = [
      { id: 'u0', kind: 'user' as const, text: 'q0' },
      { id: 'a0', kind: 'assistant' as const, text: 'a0' },
      { id: 'u1', kind: 'user' as const, text: 'q1' },
      { id: 'a1', kind: 'assistant' as const, text: 'a1' },
    ]
    const { set, get, state } = makeStore({
      sessionId: 's1',
      cwd: '/work',
      entries,
      refreshSessions,
      refreshWorkspaces,
    })

    const ev: AcpEvent = {
      type: 'session_rewound',
      sessionId: 's1',
      targetPromptIndex: 1,
    } as AcpEvent

    handleExtMiscEvent(set, get, ev)

    expect(refreshSessions).toHaveBeenCalled()
    expect(refreshWorkspaces).toHaveBeenCalled()
    // 截断到 targetPromptIndex 1：保留 u0/a0，切除 u1/a1
    expect(state().entries.map((e) => e.id)).toEqual(['u0', 'a0'])
  })

  it('modes_update 事件更新其他会话的 planMode 时，安全更新本地 planModes 缓存且不影响当前会话', () => {
    const { set, get, state } = makeStore({
      sessionId: 's1',
      planMode: false,
    })

    const ev: AcpEvent = {
      type: 'modes_update',
      sessionId: 'other-session',
      modes: { currentModeId: 'plan' },
    } as AcpEvent

    handleExtMiscEvent(set, get, ev)

    // 当前会话 s1 planMode 不受影响
    expect(state().planMode).toBe(false)
    // other-session 的 planMode 写入了缓存
    const restored = restorePlanMode('other-session')
    expect(restored.planMode).toBe(true)
  })
})


