import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 与 registry.test.ts 同一套替身：chat / promptQueue 走 fake，theme store 用
// 真实实现；transport 只给 hook 真正会碰的两个只读列表调用。
vi.mock('../../store/chat', () => ({
  useChatStore: Object.assign(vi.fn((sel?: (s: unknown) => unknown) => sel?.(fakeChat)), {
    getState: vi.fn(() => fakeChat),
    setState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  }),
}))
vi.mock('../../store/promptQueue', () => ({
  usePromptQueue: { getState: vi.fn(() => ({ enqueue: vi.fn() })) },
}))
vi.mock('../../api/client', () => ({
  transport: {
    extensions: vi.fn(() => Promise.resolve({ hooks: [], plugins: [], skills: [] })),
    workflowsList: vi.fn(() => Promise.resolve({ workflows: [] })),
  },
}))

import type { ModelOption } from '../../api/types'
import { slashCommands } from '../../commands/registry'
import { useSlashMenu } from './useSlashMenu'

type FakeChat = {
  models: ModelOption[]
  modelName: string
  reasoningEffort?: string
  conn: string
  selectedHostId: string | null
  sessionId: string | null
  agentCommands: Array<{ name: string; description: string }>
  appendLocalEntry: ReturnType<typeof vi.fn>
  setModel: ReturnType<typeof vi.fn>
  newSession: ReturnType<typeof vi.fn>
}

const fakeChat: FakeChat = {
  models: [],
  modelName: '',
  conn: 'online',
  selectedHostId: null,
  sessionId: 's1',
  agentCommands: [],
  appendLocalEntry: vi.fn(),
  setModel: vi.fn(() => Promise.resolve()),
  newSession: vi.fn(),
}

beforeEach(() => {
  fakeChat.models = []
  fakeChat.modelName = ''
  fakeChat.reasoningEffort = undefined
  fakeChat.agentCommands = []
  fakeChat.appendLocalEntry.mockClear()
  fakeChat.setModel.mockClear()
  fakeChat.newSession.mockClear()
  window.localStorage.clear()
})

/** 受控 harness：把 hook 接在一个可改写的草稿上（textarea 的 role）。 */
function harness(initial: string) {
  const state = { text: initial }
  const setText = vi.fn((v: string | ((t: string) => string)) => {
    state.text = typeof v === 'function' ? v(state.text) : v
  })
  const opts = {
    get text() {
      return state.text
    },
    setText,
    taRef: { current: null },
    composerChromeRef: { current: null },
    shellMode: false,
    clearChips: vi.fn(),
    setPendingCaret: vi.fn(),
  }
  const view = renderHook(() => useSlashMenu(opts))
  return {
    state,
    opts,
    setText,
    view,
    /** 改写草稿后重算一次（等价于 textarea 的下一次渲染）。 */
    type(next: string) {
      state.text = next
      view.rerender()
    },
    /** 跑一次 Enter 并把文本变更喂回 hook。 */
    pressEnter(): boolean {
      let handled = false
      act(() => {
        handled = view.result.current.slashEnter()
      })
      view.rerender()
      return handled
    },
    pressTab(): void {
      act(() => {
        view.result.current.acceptSelected()
      })
      view.rerender()
    },
  }
}

const effortCmd = () => slashCommands.find((c) => c.name === 'effort')!

describe('useSlashMenu — 两层下拉的 Enter 路由', () => {
  it('参数未给时 Enter 只补全成 `/name `，不执行也不报缺参数', () => {
    fakeChat.models = [
      { modelId: 'm1', name: 'M1', reasoningEfforts: [{ id: 'low', label: 'low', value: 'low' }, { id: 'high', label: 'high', value: 'high' }] },
    ]
    fakeChat.modelName = 'm1'
    const h = harness('/effort')
    expect(h.view.result.current.slashOpen).toBe(true)
    expect(h.pressEnter()).toBe(true)
    // 补全后进入参数阶段，列出该模型提供的档位
    expect(h.state.text).toBe('/effort ')
    expect(h.view.result.current.slashPhase).toBe('args')
    expect(h.view.result.current.slashArgMatches.map((r) => r.arg.insertText)).toEqual([
      'low',
      'high',
    ])
    expect(fakeChat.setModel).not.toHaveBeenCalled()
    expect(h.opts.setText).not.toHaveBeenCalledWith('')
  })

  it('参数阶段的 Enter = 选定并执行，一行清草稿', () => {
    fakeChat.models = [
      { modelId: 'm1', name: 'M1', reasoningEfforts: [{ id: 'high', label: 'high', value: 'high' }] },
    ]
    fakeChat.modelName = 'm1'
    const h = harness('/effort ')
    expect(h.view.result.current.slashPhase).toBe('args')
    expect(h.pressEnter()).toBe(true)
    expect(fakeChat.setModel).toHaveBeenCalledWith('m1', 'high')
    expect(h.state.text).toBe('')
  })

  it('模糊命中先补全再执行（/ne 一轮 Enter 就清掉草稿）', () => {
    const h = harness('/ne')
    expect(h.pressEnter()).toBe(true)
    // /new 无参：补全成 `/new` 后立即执行 → 执行路径清空草稿
    expect(fakeChat.newSession).toHaveBeenCalled()
    expect(h.state.text).toBe('')
  })

  it('参数完备 → Enter 直接执行；模型没档位时不卡死，退回用法错误', () => {
    fakeChat.models = [
      { modelId: 'm1', name: 'M1', reasoningEfforts: [{ id: 'high', label: 'high', value: 'high' }] },
    ]
    fakeChat.modelName = 'm1'
    const h = harness('/effort high')
    // 参数打全后列表仍展开（只剩这一条，TUI 同款），Enter 是「选定并执行」
    expect(h.view.result.current.slashOpen).toBe(true)
    expect(h.pressEnter()).toBe(true)
    expect(fakeChat.setModel).toHaveBeenCalledWith('m1', 'high')

    // 没有任何候选可列时，空参仍走 run（回一条用法错误，而不是无声吞掉 Enter）
    fakeChat.models = []
    fakeChat.modelName = ''
    fakeChat.setModel.mockClear()
    const h2 = harness('/effort ')
    expect(h2.view.result.current.slashOpen).toBe(false)
    expect(h2.pressEnter()).toBe(true)
    expect(fakeChat.appendLocalEntry).toHaveBeenCalledWith({
      kind: 'error',
      text: expect.stringContaining('用法'),
    })
  })

  it('Tab 只补全，绝不执行（TUI accept_slash_completion）', () => {
    const h = harness('/effort')
    h.pressTab()
    expect(h.state.text).toBe('/effort ')
    expect(fakeChat.setModel).not.toHaveBeenCalled()
    expect(h.opts.clearChips).not.toHaveBeenCalled()
  })

  it('takes-args 但无候选列表的命令：命令行带尾空格，Enter 停在参数位', () => {
    const h = harness('/compac')
    expect(h.view.result.current.slashMatches[0]?.cmd.name).toBe('compact')
    expect(h.pressEnter()).toBe(true)
    expect(h.state.text).toBe('/compact ')
  })

  it('菜单被 Esc 关过后，Enter 重新展开参数层而不是发原文', () => {
    fakeChat.models = [
      { modelId: 'm1', name: 'M1', reasoningEfforts: [{ id: 'high', label: 'high', value: 'high' }] },
    ]
    fakeChat.modelName = 'm1'
    const h = harness('/effort')
    act(() => {
      h.view.result.current.setSlashDismissed(true)
    })
    h.view.rerender()
    expect(h.view.result.current.slashOpen).toBe(false)
    expect(h.pressEnter()).toBe(true)
    expect(h.view.result.current.slashOpen).toBe(true)
    expect(h.state.text).toBe('/effort ')
    expect(h.view.result.current.slashPhase).toBe('args')
    expect(fakeChat.setModel).not.toHaveBeenCalled()
  })

  it('未知首词放行（caller 按原文发送），空参命令仍照常执行', () => {
    expect(harness('/nope x').pressEnter()).toBe(false)
    const h = harness('/theme')
    expect(h.pressEnter()).toBe(true)
    // /theme 无参 = 循环切换：走 run 路径（清草稿），不产生错误行
    expect(h.state.text).toBe('')
    expect(fakeChat.appendLocalEntry).not.toHaveBeenCalled()
  })

  it('/loop 的间隔候选带尾空格：接受后停在参数层等正文', () => {
    const h = harness('/loop ')
    const rows = h.view.result.current.slashArgMatches
    expect(rows.length).toBeGreaterThan(0)
    act(() => {
      // ↑/↓ 的等价操作：把键盘选中项挪到 5m 那一行
      h.view.result.current.setSlashSel(rows.findIndex((r) => r.arg.insertText === '5m '))
    })
    h.view.rerender()
    expect(h.pressEnter()).toBe(true)
    expect(h.state.text).toBe('/loop 5m ')
    expect(fakeChat.appendLocalEntry).not.toHaveBeenCalled()
  })

  it('slashCommands 里 effortCmd 声明了参数候选（回归锚点）', () => {
    expect(typeof effortCmd().suggestArgs).toBe('function')
    expect(effortCmd().argsRequired).toBe(true)
  })

  it('shell 模式下整个菜单不出现', () => {
    fakeChat.models = [
      { modelId: 'm1', name: 'M1', reasoningEfforts: [{ id: 'high', label: 'high', value: 'high' }] },
    ]
    fakeChat.modelName = 'm1'
    const h = harness('/effort ')
    h.opts.shellMode = true
    h.view.rerender()
    expect(h.view.result.current.slashOpen).toBe(false)
    expect(h.pressEnter()).toBe(false)
  })
})
