import { describe, expect, it } from 'vitest'
import type { ModelOption } from '../../api/types'
import {
  BUILTIN_REASONING_EFFORTS,
  activeContextWindow,
  applySessionModelState,
  asModelState,
  contextWindowOptions,
  extractEffortFromAgentInfo,
  extractModelFromAgentInfo,
  extractModelsFromAgentInfo,
  formatContextWindow,
  modelDisplayName,
  modelLabel,
  normalizeEffortOption,
  parseConfigOptions,
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

  it('窗口目录：解析 contextWindows 与 contextWindow，丢弃非法项', () => {
    const models = extractModelsFromAgentInfo({
      _meta: {
        modelState: {
          availableModels: [
            {
              modelId: 'w1',
              _meta: {
                totalContextTokens: 500000,
                contextWindows: [256000, 500000],
                contextWindow: 256000,
              },
            },
            {
              modelId: 'w2',
              // 脏数据：非数值/0/负数都丢掉；有效项保留原始顺序。
              _meta: { totalContextTokens: 200000, contextWindows: [0, '500000', -1, 'x', 256000] },
            },
            // 没有 contextWindows 键 → undefined（本地不得凭空造菜单）。
            { modelId: 'w3', _meta: { totalContextTokens: 1000000 } },
            // contextWindows 全是非法值 → undefined，同样不出菜单。
            { modelId: 'w4', _meta: { contextWindows: ['', 0] } },
          ],
        },
      },
    })

    expect(models[0].contextWindows).toEqual([256000, 500000])
    expect(models[0].contextWindowSelection).toBe(256000)
    expect(models[0].contextWindow).toBe(500000)
    expect(models[1].contextWindows).toEqual([500000, 256000])
    expect(models[1].contextWindowSelection).toBeUndefined()
    expect(models[2].contextWindows).toBeUndefined()
    expect(models[3].contextWindows).toBeUndefined()
  })
})

describe('上下文窗口菜单（目录驱动）', () => {
  const model = (over: Partial<ModelOption>): ModelOption => ({ modelId: 'm', ...over })

  it('contextWindowOptions：单窗口不算菜单（TUI has_selectable_windows）', () => {
    expect(contextWindowOptions(model({ contextWindows: [256000, 500000] }))).toEqual([
      256000, 500000,
    ])
    expect(contextWindowOptions(model({ contextWindows: [500000] }))).toEqual([])
    expect(contextWindowOptions(model({}))).toEqual([])
    expect(contextWindowOptions(undefined)).toEqual([])
  })

  it('activeContextWindow：会话选择优先，未声明则回落到模型默认窗口', () => {
    expect(
      activeContextWindow(model({ contextWindow: 256000, contextWindows: [256000, 500000] })),
    ).toBe(256000)
    expect(
      activeContextWindow(
        model({ contextWindow: 256000, contextWindows: [256000, 500000], contextWindowSelection: 500000 }),
      ),
    ).toBe(500000)
    // 选择不被当前模型支持（换过模型/目录热重载）→ 用模型默认窗口，
    // 与 ModelState::get_context_window 的过滤一致。
    expect(
      activeContextWindow(
        model({ contextWindow: 256000, contextWindows: [256000, 500000], contextWindowSelection: 1000000 }),
      ),
    ).toBe(256000)
    // 选择等于默认窗口也算有效（TUI 的 default == selection 分支）。
    expect(
      activeContextWindow(model({ contextWindow: 256000, contextWindowSelection: 256000 })),
    ).toBe(256000)
    expect(activeContextWindow(undefined)).toBeUndefined()
  })

  it('formatContextWindow：整百万/整千简写，其余原样', () => {
    expect(formatContextWindow(256000)).toBe('256k')
    expect(formatContextWindow(500000)).toBe('500k')
    expect(formatContextWindow(1000000)).toBe('1m')
    expect(formatContextWindow(2000000)).toBe('2m')
    expect(formatContextWindow(960000)).toBe('960k')
    expect(formatContextWindow(1048576)).toBe('1048576')
    expect(formatContextWindow(12345)).toBe('12345')
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

describe('parseConfigOptions — ACP configOptions 的模型/档位投影', () => {
  it('按 id 取 model / reasoning_effort，模型名取 options 里的 label', () => {
    const out = parseConfigOptions([
      {
        id: 'model',
        category: 'model',
        type: 'select',
        currentValue: 'grok-4',
        options: [
          { value: 'grok-3', name: 'Grok 3' },
          { value: 'grok-4', name: 'Grok 4' },
        ],
      },
      {
        id: 'reasoning_effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [{ value: 'high', name: 'High' }],
      },
    ])
    expect(out).toEqual({ modelId: 'grok-4', modelName: 'Grok 4', reasoningEffort: 'high' })
  })

  it('id 缺失时退回 category / type 的写法', () => {
    const out = parseConfigOptions([
      { type: 'model', currentValue: 'm1' },
      { category: 'thought_level', currentValue: 'low' },
    ])
    expect(out.modelId).toBe('m1')
    expect(out.modelName).toBe('m1')
    expect(out.reasoningEffort).toBe('low')
  })

  it('数组没带某个 selector → 该字段缺省（调用方不会误清空）', () => {
    const out = parseConfigOptions([{ id: 'reasoning_effort', currentValue: 'high' }])
    expect(out.modelId).toBeUndefined()
    expect(out.modelName).toBeUndefined()
    expect(out.reasoningEffort).toBe('high')
  })

  it('非数组 / 空数组 / 脏元素 → 空结果，不抛错', () => {
    expect(parseConfigOptions(undefined)).toEqual({})
    expect(parseConfigOptions({ model: 'x' })).toEqual({})
    expect(parseConfigOptions([])).toEqual({})
    expect(parseConfigOptions([null, 'x', 3])).toEqual({})
  })

  it('currentValue 为空白 → 该字段缺省', () => {
    const out = parseConfigOptions([
      { id: 'model', currentValue: '   ' },
      { id: 'reasoning_effort', currentValue: '' },
    ])
    expect(out.modelId).toBeUndefined()
    expect(out.reasoningEffort).toBeUndefined()
  })
})