import { describe, expect, it, vi } from 'vitest'
import {
  SUBAGENT_VIEW_PAGE_SIZE,
  sealSubagentStreaming,
  subagentFinishStatus,
  subagentViewPush,
  resolveSubagentModelAndEffort,
  handleSubagentEvent,
} from './subagent'
import type { ModelOption, ScrollEntry } from '../../api/types'
import type { ChatState, SetState } from './types'

describe('subagent 聚合入口（./subagent）', () => {
  it('常量 + 各函数经聚合可用', () => {
    expect(SUBAGENT_VIEW_PAGE_SIZE).toBe(100)
    expect(subagentFinishStatus({ status: 'cancelled' })).toBe('cancelled')

    const items = [{ id: 'a', kind: 'user', text: 'x' }] as ScrollEntry[]
    expect(subagentViewPush(items, { id: 'b', kind: 'user', text: 'y' } as ScrollEntry)).toHaveLength(2)

    const sealed = sealSubagentStreaming([
      { id: 'a1', kind: 'assistant', text: 'x', streaming: true },
    ] as ScrollEntry[])
    expect(sealed[0]).toMatchObject({ streaming: false })

    // applySubagentFinish 端到端（经 ./subagent 入口）
    const state = { entries: [{ id: 'e1', kind: 'subagent', status: 'started', running: true }] } as Record<string, unknown>
    const ctxSet = vi.fn((partial: unknown) => {
      const patch =
        typeof partial === 'function'
          ? (partial as (s: ChatState) => Partial<ChatState>)(state as unknown as ChatState)
          : (partial as Partial<ChatState>)
      Object.assign(state, patch)
    })
    applySubagentFinish(
      (() => state) as unknown as () => ChatState,
      ctxSet as unknown as SetState,
      'e1',
      'completed',
      3000,
    )
    expect((state.entries as Array<Record<string, unknown>>)[0]).toMatchObject({
      status: 'completed',
      running: false,
      durationMs: 3000,
    })
  })
})

describe('resolveSubagentModelAndEffort', () => {
  const dummyModels: ModelOption[] = [
    {
      modelId: 'grok-4',
      name: 'Grok 4',
      supportsReasoningEffort: true,
      reasoningEffort: 'high',
    },
    {
      modelId: 'claude-3-7-sonnet',
      name: 'Claude 3.7 Sonnet',
      supportsReasoningEffort: true,
      reasoningEfforts: [{ id: 'med', label: 'medium', value: 'medium', default: true }],
    },
    {
      modelId: 'grok-3-fast',
      name: 'Grok 3 Fast',
      supportsReasoningEffort: false,
    },
  ]

  it('显式 reasoning_effort / effort 字段优先', () => {
    const res1 = resolveSubagentModelAndEffort(
      { model: 'grok-4', reasoning_effort: 'low' },
      { modelName: 'Grok 4', reasoningEffort: 'high', models: dummyModels },
    )
    expect(res1).toEqual({ model: 'grok-4', reasoningEffort: 'low' })

    const res2 = resolveSubagentModelAndEffort(
      { model: 'grok-4', effort: 'max' },
      { modelName: 'Grok 4', reasoningEffort: 'high', models: dummyModels },
    )
    expect(res2).toEqual({ model: 'grok-4', reasoningEffort: 'max' })
  })

  it('model 字段自身包含括号 (effort) 时拆解提取', () => {
    const res = resolveSubagentModelAndEffort(
      { model: 'grok-4(medium)' },
      { modelName: 'other-model', reasoningEffort: 'low', models: dummyModels },
    )
    expect(res).toEqual({ model: 'grok-4', reasoningEffort: 'medium' })
  })

  it('无显式 effort 时：同父会话模型则继承父会话 reasoningEffort', () => {
    const res = resolveSubagentModelAndEffort(
      { model: 'grok-4' },
      { modelName: 'Grok 4', reasoningEffort: 'high', models: dummyModels },
    )
    expect(res).toEqual({ model: 'grok-4', reasoningEffort: 'high' })

    // model 缺省也继承父会话模型与 effort
    const resOmitted = resolveSubagentModelAndEffort(
      {},
      { modelName: 'Grok 4', reasoningEffort: 'high', models: dummyModels },
    )
    expect(resOmitted).toEqual({ model: 'Grok 4', reasoningEffort: 'high' })
  })

  it('无显式 effort 且模型不同：从可用模型目录解析默认 effort', () => {
    const res1 = resolveSubagentModelAndEffort(
      { model: 'claude-3-7-sonnet' },
      { modelName: 'Grok 4', reasoningEffort: 'high', models: dummyModels },
    )
    expect(res1).toEqual({ model: 'claude-3-7-sonnet', reasoningEffort: 'medium' })

    // 不支持 effort 的模型返回 undefined
    const res2 = resolveSubagentModelAndEffort(
      { model: 'grok-3-fast' },
      { modelName: 'Grok 4', reasoningEffort: 'high', models: dummyModels },
    )
    expect(res2).toEqual({ model: 'grok-3-fast', reasoningEffort: undefined })
  })
})

describe('handleSubagentEvent — subagent_spawned 带 effort', () => {
  it('生成子代理条目保留 model 与 reasoningEffort', () => {
    const state: Partial<ChatState> = {
      entries: [],
      subagentIndex: {},
      subagentChildIndex: {},
      subagentViews: {},
      pendingSubagentFinishes: {},
      modelName: 'Grok 4',
      reasoningEffort: 'high',
    }
    const ctxSet = vi.fn((partial: unknown) => {
      const patch =
        typeof partial === 'function'
          ? (partial as (s: ChatState) => Partial<ChatState>)(state as unknown as ChatState)
          : (partial as Partial<ChatState>)
      Object.assign(state, patch)
    })

    handleSubagentEvent(
      (() => state) as unknown as () => ChatState,
      ctxSet as unknown as SetState,
      'subagent_spawned',
      {
        subagent_id: 'sub-1',
        description: 'test-agent',
        model: 'grok-4',
        reasoning_effort: 'medium',
      },
    )

    const subEntry = state.entries?.find((e) => e.kind === 'subagent') as Extract<
      ScrollEntry,
      { kind: 'subagent' }
    >
    expect(subEntry).toBeDefined()
    expect(subEntry.model).toBe('grok-4')
    expect(subEntry.reasoningEffort).toBe('medium')
  })
})

// 延迟 import 避免循环引用（聚合文件无循环，仅为让上方入口测试生效）
import { applySubagentFinish } from './subagentEvent'