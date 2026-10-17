import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useModelMenu } from './useModelMenu'
import { useChatStore } from '../../store/chat'
import type { ModelOption } from '../../api/types'

const models: ModelOption[] = [
  {
    modelId: 'grok-4',
    name: 'Grok 4',
    reasoningEfforts: [
      { id: 'low', label: 'low', value: 'low' },
      { id: 'high', label: 'high', value: 'high', default: true },
    ],
    contextWindow: 256000,
    contextWindows: [256000, 500000],
    contextWindowSelection: 256000,
  },
  {
    modelId: 'gemini-3',
    name: 'Gemini 3',
    reasoningEfforts: [
      { id: 'med', label: 'med', value: 'med', default: true },
      { id: 'ultra', label: 'ultra', value: 'ultra' },
    ],
    contextWindow: 1000000,
    contextWindows: [400000, 1000000],
  },
  { modelId: 'plain', name: 'Plain Model' },
]

function setStore() {
  useChatStore.setState({
    sessionId: 'sess-1',
    modelName: 'Grok 4',
    reasoningEffort: 'high',
    models,
    setModel: vi.fn().mockResolvedValue(undefined),
  } as never)
}

function setModelMock() {
  return useChatStore.getState().setModel as unknown as ReturnType<typeof vi.fn>
}

describe('useModelMenu 累积选择（非选中模型点齐所有类别才切换）', () => {
  beforeEach(() => {
    setStore()
  })

  it('两类要挑的模型：点第一类只记草稿，不切；点第二类才提交', () => {
    const { result } = renderHook(() => useModelMenu())
    act(() => result.current.setModelOpen(true))

    // 第一类：档位
    act(() => result.current.pickOption('gemini-3', 2, { effort: 'ultra' }, 'med'))
    expect(setModelMock()).not.toHaveBeenCalled()
    expect(result.current.draftEffort('gemini-3')).toBe('ultra')

    // 第二类：窗口 → 集齐，提交切换（档位用草稿里的 ultra）
    act(() => result.current.pickOption('gemini-3', 2, { window: 1000000 }, 'med'))
    expect(setModelMock()).toHaveBeenCalledTimes(1)
    const [modelId, effort, opts] = setModelMock().mock.calls[0]
    expect(modelId).toBe('gemini-3')
    expect(effort).toBe('ultra')
    expect(opts).toMatchObject({ contextWindow: 1000000 })
  })

  it('反序点也一样：先窗口后档位，档位不丢', () => {
    const { result } = renderHook(() => useModelMenu())
    act(() => result.current.setModelOpen(true))

    act(() => result.current.pickOption('gemini-3', 2, { window: 400000 }, 'med'))
    expect(setModelMock()).not.toHaveBeenCalled()
    act(() => result.current.pickOption('gemini-3', 2, { effort: 'ultra' }, 'med'))

    const [, effort, opts] = setModelMock().mock.calls[0]
    expect(effort).toBe('ultra')
    expect(opts).toMatchObject({ contextWindow: 400000 })
  })

  it('只有一个类别时点一次即提交', () => {
    const { result } = renderHook(() => useModelMenu())
    act(() => result.current.setModelOpen(true))

    // 假设该模型只有窗口一类（categories=1）
    act(() => result.current.pickOption('gemini-3', 1, { window: 1000000 }, 'med'))
    expect(setModelMock()).toHaveBeenCalledTimes(1)
    expect(setModelMock().mock.calls[0][1]).toBe('med')
  })

  it('未给档位时回落到默认档（fallbackEffort）', () => {
    const { result } = renderHook(() => useModelMenu())
    act(() => result.current.setModelOpen(true))

    act(() => result.current.pickOption('plain', 1, { window: 0 as never }, 'med'))
    // window 为 0/falsy 时不下发 contextWindow，档位用 fallback
    const [, effort, opts] = setModelMock().mock.calls[0]
    expect(effort).toBe('med')
    expect(opts?.contextWindow).toBeUndefined()
  })

  it('菜单关闭丢弃草稿：再打开不残留半套选择', () => {
    const { result } = renderHook(() => useModelMenu())
    act(() => result.current.setModelOpen(true))
    act(() => result.current.pickOption('gemini-3', 2, { effort: 'ultra' }, 'med'))
    expect(result.current.draftEffort('gemini-3')).toBe('ultra')

    act(() => result.current.setModelOpen(false))
    expect(result.current.draftEffort('gemini-3')).toBeUndefined()
  })

  it('草稿里未声明的窗口不下发（目录热重载后防整次拒收）', () => {
    const { result } = renderHook(() => useModelMenu())
    act(() => result.current.setModelOpen(true))

    // grok-4 只声明 [256000, 500000]；999999 不在其中
    act(() => result.current.pickOption('grok-4', 1, { window: 999999 }, 'high'))
    expect(setModelMock()).toHaveBeenCalledTimes(1)
    expect(setModelMock().mock.calls[0][2]?.contextWindow).toBeUndefined()
  })
})
