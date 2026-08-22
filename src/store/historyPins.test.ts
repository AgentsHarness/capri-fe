import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo, WorkspaceGroup } from '../api/types'
import { transport } from '../api/client'
import { sortSessionsWithPins, sortWorkspacesWithPins, usePins } from './historyPins'

// historyPins 在模块顶层 transport.onEvent(...) 注册 prefs_changed 监听，
// 用 hoisted 数组捕获 handler 以便直接触发广播。
const handlers = vi.hoisted(() => [] as Array<(ev: unknown) => void>)

vi.mock('../api/client', () => ({
  transport: {
    onEvent: vi.fn((h: (ev: unknown) => void) => {
      handlers.push(h)
      return () => {}
    }),
    getPrefs: vi.fn(async () => ({})),
    putPrefs: vi.fn(async () => undefined),
    prefsOrigin: vi.fn((): string => ''),
  },
}))

const HUB_PUSH_DEBOUNCE_MS = 500

// 整文件假时钟：只装一次——beforeEach 里重复 useFakeTimers 会重建时钟、
// 丢弃上个测试遗留的防抖定时器，让 dirty 收敛失效。
vi.useFakeTimers()

beforeEach(async () => {
  usePins.setState({
    pinnedWorkspaces: new Set<string>(),
    pinnedSessions: new Set<string>(),
    todos: {},
    fePrefs: { collapseToolGroups: true },
  })
  vi.mocked(transport.prefsOrigin).mockReturnValue('')
  // 跑完上一个测试遗留的防抖推送，把模块级 dirty 标记收敛回干净，
  // 让每个测试的「替换 vs 合并」语义不依赖执行顺序。
  await vi.advanceTimersByTimeAsync(HUB_PUSH_DEBOUNCE_MS + 1)
  // 收敛产生的 mock 调用不计入新测试：flush 之后再清。
  vi.clearAllMocks()
})

describe('本地置顶/待办', () => {
  it('toggleWorkspacePin 往返并持久化 localStorage', () => {
    usePins.getState().toggleWorkspacePin('/w/1')
    expect(usePins.getState().pinnedWorkspaces.has('/w/1')).toBe(true)
    const raw = window.localStorage.getItem('acpfe.historyPins')
    expect(JSON.parse(raw ?? '{}').pinnedWorkspaces).toEqual(['/w/1'])
    usePins.getState().toggleWorkspacePin('/w/1')
    expect(usePins.getState().pinnedWorkspaces.has('/w/1')).toBe(false)
  })

  it('setTodoStatus 设置与清除', () => {
    usePins.getState().setTodoStatus('s1', 'todo')
    expect(usePins.getState().todos['s1']).toBe('todo')
    usePins.getState().setTodoStatus('s1', 'completed')
    expect(usePins.getState().todos['s1']).toBe('completed')
    usePins.getState().setTodoStatus('s1', null)
    expect(usePins.getState().todos['s1']).toBeUndefined()
  })

  it('setFePrefs 局部合并', () => {
    usePins.getState().setFePrefs({ collapseToolGroups: false })
    expect(usePins.getState().fePrefs).toEqual({ collapseToolGroups: false })
  })

  it('变更经 500ms 防抖合并为一次 hub 回写', async () => {
    usePins.getState().toggleWorkspacePin('/w/1')
    usePins.getState().setTodoStatus('s1', 'todo')
    expect(vi.mocked(transport.putPrefs)).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(HUB_PUSH_DEBOUNCE_MS)
    expect(transport.putPrefs).toHaveBeenCalledTimes(1)
    const doc = vi.mocked(transport.putPrefs).mock.calls[0]?.[0]
    expect(doc?.pinnedWorkspaces).toEqual(['/w/1'])
    expect(doc?.todos).toEqual({ s1: 'todo' })
  })
})

describe('prefs_changed 广播（跨端同步）', () => {
  it('本地干净时以 hub 文档整体替换', () => {
    const handler = handlers[0]
    expect(handler).toBeTruthy()
    handler({
      type: 'prefs_changed',
      params: { prefs: { pinnedSessions: ['s9'], pinnedWorkspaces: [], todos: {}, fePrefs: {} } },
    })
    expect([...usePins.getState().pinnedSessions]).toEqual(['s9'])
  })

  it('本地 dirty（未推送）时合并保留本地，刚点的操作不被冲掉', () => {
    usePins.getState().toggleWorkspacePin('/mine') // → dirty
    handlers[0]({
      type: 'prefs_changed',
      params: { prefs: { pinnedWorkspaces: ['/theirs'], pinnedSessions: [], todos: {}, fePrefs: {} } },
    })
    const merged = usePins.getState().pinnedWorkspaces
    expect(merged.has('/mine')).toBe(true)
    expect(merged.has('/theirs')).toBe(true)
  })
})

describe('syncPrefsFromHub', () => {
  it('无 hub 地址时静默跳过（local 模式）', async () => {
    await usePins.getState().syncPrefsFromHub()
    expect(transport.getPrefs).not.toHaveBeenCalled()
  })

  it('本地干净时以 hub 为准整体替换（含删除）', async () => {
    vi.mocked(transport.prefsOrigin).mockReturnValue('http://hub')
    vi.mocked(transport.getPrefs).mockResolvedValue({
      pinnedWorkspaces: ['/x'],
      pinnedSessions: [],
      todos: {},
      fePrefs: { collapseToolGroups: false },
    })
    await usePins.getState().syncPrefsFromHub()
    const st = usePins.getState()
    expect([...st.pinnedWorkspaces]).toEqual(['/x'])
    expect(st.fePrefs.collapseToolGroups).toBe(false)
    expect(transport.putPrefs).not.toHaveBeenCalled()
  })

  it('hub 为空而本地有未推送变更 → 整份本地上推', async () => {
    vi.mocked(transport.prefsOrigin).mockReturnValue('http://hub')
    usePins.getState().setTodoStatus('s1', 'todo') // → dirty
    await usePins.getState().syncPrefsFromHub()
    expect(transport.putPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ todos: { s1: 'todo' } }),
    )
    expect(usePins.getState().todos['s1']).toBe('todo')
  })
})

describe('排序（置顶 / 待办）', () => {
  const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
    sessionId: id,
    ...over,
  })
  const noCmp = (): number => 0

  it('sortWorkspacesWithPins：置顶工作区在前，其余保持原顺序', () => {
    const ws = (cwd: string): WorkspaceGroup => ({ cwd, label: cwd, sessions: [] })
    const wss = [ws('/a'), ws('/b'), ws('/c')]
    const out = sortWorkspacesWithPins(wss, new Set(['/c']))
    expect(out.map((g) => g.cwd)).toEqual(['/c', '/a', '/b'])
  })

  it('sortSessionsWithPins：置顶 > 待办 > 状态优先级 > cmp', () => {
    const sessions = [
      session('idle-a'),
      session('todo-c'),
      session('awaiting-d', { status: { state: 'awaiting' } }),
      session('idle-b'),
    ]
    const out = sortSessionsWithPins(
      sessions,
      new Set(['idle-b']),
      null,
      noCmp,
      { 'todo-c': 'todo' },
    )
    // 待办提升是组内主键（先于状态优先级）：置顶 > 待办 > awaiting > 空闲
    expect(out.map((s) => s.sessionId)).toEqual(['idle-b', 'todo-c', 'awaiting-d', 'idle-a'])
  })

  it('已完成的待办不升位（完成痕迹保留、排序回归正常）', () => {
    const sessions = [session('done-todo'), session('plain')]
    const out = sortSessionsWithPins(sessions, new Set(), null, noCmp, {
      'done-todo': 'completed',
    })
    // 两者同为空闲优先级，cmp 恒 0 → 保持原顺序
    expect(out.map((s) => s.sessionId)).toEqual(['done-todo', 'plain'])
  })
})
