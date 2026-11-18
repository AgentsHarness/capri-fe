import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScrollEntry } from '../../../api/types'
import { usePins } from '../../historyPins'
import { applyUiSettings } from '../../settings'
import type { ChatState, SetState } from '../types'
import { viewerNavActions } from './viewerNav'

const { fillEntryRange } = vi.hoisted(() => ({ fillEntryRange: vi.fn() }))
vi.mock('../historyFill', () => ({
  fillEntryRange: (...args: unknown[]) => fillEntryRange(...args),
}))

function makeState(entries: ScrollEntry[]): ChatState {
  return {
    entries,
    expandedGroups: new Set<string>(),
    selectedId: null,
    focusMode: 'prompt',
  } as unknown as ChatState
}

function bind(state: ChatState) {
  const set: SetState = (partial) => {
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  }
  const actions = viewerNavActions(set, () => state)
  // 生产 store 会把各 mixin 的方法挂回 state；单测手工补上，动作内部
  // 调 get().pinCollapsed 才找得到。
  Object.assign(state, actions)
  return actions as Pick<
    ChatState,
    | 'toggleTool'
    | 'toggleThought'
    | 'setExpanded'
    | 'toggleSelected'
    | 'pinCollapsed'
  >
}

const tool = (
  id: string,
  over: Partial<Extract<ScrollEntry, { kind: 'tool' }>> = {},
): ScrollEntry =>
  ({
    id,
    kind: 'tool',
    title: 'Read a.py',
    kindName: 'read',
    status: 'completed',
    displayMode: 'collapsed',
    expanded: false,
    ...over,
  }) as ScrollEntry

const thought: ScrollEntry = {
  id: 'th',
  kind: 'thought',
  text: 'hmm',
  displayMode: 'collapsed',
}

const command = (id: string, finishedAt: number): ScrollEntry =>
  tool(id, {
    title: 'Run npm test',
    kindName: 'execute',
    finishedAt,
  })

const recentTool = (id: string): ScrollEntry =>
  tool(id, { finishedAt: Date.now() - 100 })

const assistant: ScrollEntry = { id: 'a1', kind: 'assistant', text: 'done' }

const entry = (state: ChatState, id: string) =>
  state.entries.find((e) => e.id === id) as Extract<ScrollEntry, { kind: 'tool' }>

beforeEach(() => {
  fillEntryRange.mockClear()
  applyUiSettings({ tool_call_density: 'compact-all-grouped' })
  const prev = usePins.getState().fePrefs
  usePins.setState({ fePrefs: { ...prev, groupHoldMs: 1000 } })
})

describe('新块预览下的折叠手势', () => {
  it('空格（toggleSelected）命中预览中的工具：钉成折叠态', () => {
    const state = makeState([recentTool('t1')])
    state.selectedId = 't1'
    bind(state).toggleSelected()
    expect(entry(state, 't1')).toMatchObject({
      displayMode: 'collapsed',
      expanded: false,
      foldPinned: true,
    })
  })

  it('思考不在默认展开预览内：空格按正常思考折叠走', () => {
    const state = makeState([thought])
    state.selectedId = 'th'
    bind(state).toggleSelected()
    expect(state.entries[0]).toMatchObject({
      displayMode: 'expanded',
      foldPinned: true,
    })
  })

  it('←（setExpanded(false)）命中预览时也直接钉折叠', () => {
    const state = makeState([recentTool('t1')])
    state.selectedId = 't1'
    bind(state).setExpanded(false)
    expect(entry(state, 't1')).toMatchObject({
      displayMode: 'collapsed',
      foldPinned: true,
    })
  })

  it('detailed 探查类默认折叠：← 仍按预览收成折叠', () => {
    applyUiSettings({ tool_call_density: 'detailed' })
    const state = makeState([recentTool('t1')])
    state.selectedId = 't1'
    bind(state).setExpanded(false)
    expect(entry(state, 't1')).toMatchObject({
      displayMode: 'collapsed',
      expanded: false,
      foldPinned: true,
    })
  })

  it('diff focus 档：不入组的命令同样按预览时间窗折叠', () => {
    applyUiSettings({ tool_call_density: 'compact-shells' })
    const state = makeState([command('c1', Date.now() - 100)])
    state.selectedId = 'c1'
    bind(state).toggleSelected()
    expect(entry(state, 'c1')).toMatchObject({
      displayMode: 'collapsed',
      expanded: false,
      foldPinned: true,
    })
  })

  it('停留为 0 时全部不预览：← 不再把工具钉成折叠', () => {
    const prev = usePins.getState().fePrefs
    usePins.setState({ fePrefs: { ...prev, groupHoldMs: 0 } })
    const state = makeState([recentTool('t1')])
    state.selectedId = 't1'
    bind(state).setExpanded(false)
    expect(entry(state, 't1')).toMatchObject({
      displayMode: 'collapsed',
      expanded: false,
    })
    expect(entry(state, 't1').foldPinned).toBeUndefined()
  })

  it('没有预览补丁的工具按正常三态展开，并记下用户手势', () => {
    const state = makeState([tool('t1'), assistant])
    bind(state).toggleTool('t1')
    expect(entry(state, 't1')).toMatchObject({
      displayMode: 'truncated',
      expanded: true,
      foldPinned: true,
    })
    expect(fillEntryRange).toHaveBeenCalledWith(expect.anything(), expect.anything(), 't1')
  })

  it('空格在非预览工具上走三态 toggle（read → truncated）', () => {
    const state = makeState([tool('t1'), assistant])
    state.selectedId = 't1'
    bind(state).toggleSelected()
    expect(entry(state, 't1')).toMatchObject({
      displayMode: 'truncated',
      expanded: true,
      foldPinned: true,
    })
    expect(fillEntryRange).toHaveBeenCalledWith(expect.anything(), expect.anything(), 't1')
  })

  it('pinCollapsed 对工具与思考统一收成折叠态', () => {
    const state = makeState([tool('t1'), thought])
    bind(state).pinCollapsed('t1')
    expect(entry(state, 't1')).toMatchObject({
      displayMode: 'collapsed',
      expanded: false,
      foldPinned: true,
    })
    bind(state).pinCollapsed('th')
    expect(state.entries[1]).toMatchObject({
      displayMode: 'collapsed',
      foldPinned: true,
    })
  })
})
