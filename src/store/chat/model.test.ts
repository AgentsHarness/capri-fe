import { describe, expect, it } from 'vitest'
import {
  BUILTIN_REASONING_EFFORTS,
  applySessionModelState,
  asModelState,
  extractEffortFromAgentInfo,
  extractModelFromAgentInfo,
  extractModelsFromAgentInfo,
  modelDisplayName,
  modelLabel,
  normalizeEffortOption,
} from './model'

describe('modelDisplayName / modelLabel', () => {
  it('目录命中返回 name，miss 返回 id', () => {
    expect(modelDisplayName(() => ({ models: [{ modelId: 'm1', name: 'Grok' }] }) as never, 'm1')).toBe('Grok')
    expect(modelDisplayName(() => ({ models: [] }) as never, 'm2')).toBe('m2')
  })

  it('effort 括号拼接', () => {
    expect(modelLabel('Grok', 'high')).toBe('Grok(high)')
    expect(modelLabel('Grok')).toBe('Grok')
    expect(modelLabel('Grok', null)).toBe('Grok')
  })
})

describe('asModelState', () => {
  it('直接 SessionModelState / _meta.modelState / modelState 字段', () => {
    expect(asModelState({ currentModelId: 'a', availableModels: ['x'] })).toEqual({
      currentModelId: 'a',
      availableModels: ['x'],
      reasoningEffort: undefined,
    })
    expect(asModelState({ _meta: { modelState: { current_model_id: 'b', available_models: ['y'] } } })).toEqual({
      currentModelId: 'b',
      availableModels: ['y'],
      reasoningEffort: undefined,
    })
    expect(asModelState({ modelState: { currentModelId: 'c' } })).toEqual({
      currentModelId: 'c',
      availableModels: undefined,
      reasoningEffort: undefined,
    })
    expect(asModelState(undefined, null)).toBeUndefined()
  })
})

describe('normalizeEffortOption / extractModelsFromAgentInfo', () => {
  it('字符串 effort → id/label/value 同值；对象按 value/id/label 归一', () => {
    expect(normalizeEffortOption('high')).toEqual({ id: 'high', label: 'high', value: 'high' })
    expect(normalizeEffortOption({ id: 'h', value: 'high', label: 'High', default: true })).toEqual({
      id: 'h',
      label: 'High',
      value: 'high',
      default: true,
    })
    expect(normalizeEffortOption(42)).toBeNull()
    expect(normalizeEffortOption({})).toBeNull()
  })

  it('目录解析：supports → 内置 effort；未支持但带列表 → 用列表；否则 undefined', () => {
    const models = extractModelsFromAgentInfo({
      _meta: {
        modelState: {
          availableModels: [
            {
              modelId: 'm1',
              name: 'Model 1',
              _meta: { supportsReasoningEffort: true, totalContextTokens: '128000' },
            },
            {
              model_id: 'm2',
              meta: { supports_reasoning_effort: false, reasoningEfforts: ['low', { id: 'med', value: 'medium' }] },
            },
            { modelId: 'm3', _meta: {} },
          ],
        },
      },
    })
    expect(models).toHaveLength(3)
    expect(models[0].name).toBe('Model 1')
    expect(models[0].contextWindow).toBe(128000)
    expect(models[0].reasoningEfforts).toEqual(BUILTIN_REASONING_EFFORTS)
    expect(models[1].reasoningEfforts).toEqual([
      { id: 'low', label: 'low', value: 'low' },
      { id: 'med', label: 'med', value: 'medium' },
    ])
    expect(models[2].reasoningEfforts).toBeUndefined()
  })

  it('无目录 → []', () => {
    expect(extractModelsFromAgentInfo(null)).toEqual([])
    expect(extractModelsFromAgentInfo({})).toEqual([])
  })
})

describe('extractModelFromAgentInfo / extractEffortFromAgentInfo', () => {
  it('模型名：顶层字段 / _meta.modelState current', () => {
    expect(extractModelFromAgentInfo({ modelName: 'Grok X' })).toBe('Grok X')
    expect(extractModelFromAgentInfo({ _meta: { modelState: { currentModelId: 'mx' } } })).toBe('mx')
    expect(
      extractModelFromAgentInfo({
        _meta: {
          modelState: { currentModelId: 'mx', availableModels: [{ modelId: 'mx', name: 'Grok X' }] },
        },
      }),
    ).toBe('Grok X')
    expect(extractModelFromAgentInfo({})).toBeUndefined()
  })

  it('effort：直接字段 → 当前模型 meta → 默认 effort 列表', () => {
    expect(extractEffortFromAgentInfo({ _meta: { modelState: { reasoningEffort: 'high' } } })).toBe('high')
    expect(
      extractEffortFromAgentInfo({
        _meta: {
          modelState: {
            currentModelId: 'm1',
            availableModels: [{ modelId: 'm1', _meta: { reasoning_effort: 'low' } }],
          },
        },
      }),
    ).toBe('low')
    expect(
      extractEffortFromAgentInfo({
        _meta: {
          modelState: {
            currentModelId: 'm1',
            availableModels: [
              { modelId: 'm1', _meta: { reasoningEfforts: [{ id: 'xhigh', value: 'xhigh', default: true }] } },
            ],
          },
        },
      }),
    ).toBe('xhigh')
    expect(extractEffortFromAgentInfo(null)).toBeUndefined()
  })
})

describe('applySessionModelState', () => {
  it('sessionModels 优先；无 name 时只出目录', () => {
    const out = applySessionModelState(
      { currentModelId: 'm1', availableModels: [{ modelId: 'm1', name: 'One' }] },
      { modelName: 'Fallback' },
    )
    expect(out.modelName).toBe('One')
    expect(out.reasoningEffort).toBeUndefined()
    expect(out.models).toHaveLength(1)
    expect(out.models![0]).toMatchObject({ modelId: 'm1', name: 'One' })
  })

  it('fallback：agentInfo 提供模型名', () => {
    const out = applySessionModelState(null, { _meta: { modelState: { currentModelId: 'ma', availableModels: [{ modelId: 'ma', name: 'A' }], reasoningEffort: 'low' } } })
    expect(out.modelName).toBe('A')
    expect(out.reasoningEffort).toBe('low')
  })

  it('都没有 → 空 partial', () => {
    expect(applySessionModelState(null, {})).toEqual({})
  })
})