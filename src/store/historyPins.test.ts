import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo, WorkspaceGroup } from '../api/types'
import { PrefsConflictError } from '../api/transport'
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
    getPrefs: vi.fn(async () => ({ prefs: {} })),
    putPrefs: vi.fn(async () => ({})),
    prefsOrigin: vi.fn((): string => ''),
    // liteReplay 的默认值按部署模式现取（hub 开 / local 关）——本文件一律
    // 按 local 测，模式相关的断言在 liteReplay.test.ts 里。
    getConnectionMode: vi.fn((): string => 'local'),
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
    fePrefs: { collapseToolGroups: true, liteReplay: false },
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
    expect(usePins.getState().fePrefs).toEqual({
      collapseToolGroups: false,
      liteReplay: false,
    })
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

  it('本地 dirty（未推送）时忽略广播保本地，刚点的操作不被冲掉', () => {
    usePins.getState().toggleWorkspacePin('/mine') // → dirty
    handlers[0]({
      type: 'prefs_changed',
      params: { prefs: { pinnedWorkspaces: ['/theirs'], pinnedSessions: [], todos: {}, fePrefs: {} } },
    })
    const pins = usePins.getState().pinnedWorkspaces
    expect(pins.has('/mine')).toBe(true)
    // 不做并集合并——并集表达不了删除，会把别端刚删的条目复活；
    // 待推改动由随后的回写以后写覆盖落地。
    expect(pins.has('/theirs')).toBe(false)
  })

  it('PUT 在飞期间的新编辑不被自己 PUT 的回声广播冲掉', async () => {
    vi.mocked(transport.prefsOrigin).mockReturnValue('http://hub')
    let resolvePut: (() => void) | undefined
    vi.mocked(transport.putPrefs).mockImplementationOnce(
      () => new Promise<{ version?: number }>((r) => { resolvePut = () => r({}) }),
    )
    usePins.getState().toggleWorkspacePin('/a')
    await vi.advanceTimersByTimeAsync(HUB_PUSH_DEBOUNCE_MS) // PUT1 在飞（挂起）
    usePins.getState().setTodoStatus('s1', 'todo') // PUT1 在飞期间的新编辑
    resolvePut?.()
    await vi.advanceTimersByTimeAsync(0) // pushToHub 复核：快照不一致 → 保持 dirty
    // 自己 PUT1 的回声（不含 s1）到达：dirty 未清 → 忽略，不冲掉新编辑
    handlers[0]({
      type: 'prefs_changed',
      params: { prefs: { pinnedWorkspaces: ['/a'], pinnedSessions: [], todos: {}, fePrefs: {} } },
    })
    expect(usePins.getState().todos['s1']).toBe('todo')
    // 新编辑的防抖到点 → 第二轮 PUT 推最新状态
    await vi.advanceTimersByTimeAsync(HUB_PUSH_DEBOUNCE_MS)
    expect(transport.putPrefs).toHaveBeenCalledTimes(2)
    const last = vi.mocked(transport.putPrefs).mock.calls.at(-1)?.[0]
    expect(last?.pinnedWorkspaces).toEqual(['/a'])
    expect(last?.todos).toEqual({ s1: 'todo' })
  })

  it('hub_conn 上线（WS 重连成功）后补拉对齐，掉线不触发', async () => {
    vi.mocked(transport.prefsOrigin).mockReturnValue('http://hub')
    vi.mocked(transport.getPrefs).mockResolvedValue({
      prefs: {
        pinnedWorkspaces: ['/fresh'],
        pinnedSessions: [],
        todos: {},
      },
    })
    handlers[0]({ type: 'hub_conn', online: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.getPrefs).toHaveBeenCalled()
    expect([...usePins.getState().pinnedWorkspaces]).toEqual(['/fresh'])
    vi.clearAllMocks()
    handlers[0]({ type: 'hub_conn', online: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.getPrefs).not.toHaveBeenCalled()
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
      prefs: {
        pinnedWorkspaces: ['/x'],
        pinnedSessions: [],
        todos: {},
        fePrefs: { collapseToolGroups: false },
      },
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
      undefined,
    )
    expect(usePins.getState().todos['s1']).toBe('todo')
  })

  it('曾同步过的干净本地：别端删除（含删空）不复活、不上推', async () => {
    vi.mocked(transport.prefsOrigin).mockReturnValue('http://hub')
    vi.mocked(transport.getPrefs).mockResolvedValue({
      prefs: {
        pinnedWorkspaces: ['/x'],
        pinnedSessions: [],
        todos: { s1: 'todo' },
      },
    })
    await usePins.getState().syncPrefsFromHub() // 对齐：本地 {/x, s1}
    expect([...usePins.getState().pinnedWorkspaces]).toEqual(['/x'])
    expect(transport.putPrefs).not.toHaveBeenCalled()
    vi.clearAllMocks()
    vi.mocked(transport.prefsOrigin).mockReturnValue('http://hub')
    // 别端删掉了全部条目（删到最后一条时 hub 文档即为空）
    vi.mocked(transport.getPrefs).mockResolvedValue({
      prefs: {
        pinnedWorkspaces: [],
        pinnedSessions: [],
        todos: {},
      },
    })
    await usePins.getState().syncPrefsFromHub()
    expect([...usePins.getState().pinnedWorkspaces]).toEqual([])
    expect(usePins.getState().todos['s1']).toBeUndefined()
    // 关键：不把本地旧条目推回 hub（旧行为：hub 为空即整份上推 → 删除被复活）
    expect(transport.putPrefs).not.toHaveBeenCalled()
  })

  it('从未同步过的端：本地旧条目并集补齐后上推（迁移/首连）', async () => {
    usePins.setState({ pinnedWorkspaces: new Set(['/legacy']) })
    vi.mocked(transport.prefsOrigin).mockReturnValue('http://hub')
    vi.mocked(transport.getPrefs).mockResolvedValue({
      prefs: {
        pinnedWorkspaces: ['/hubpin'],
        pinnedSessions: [],
        todos: {},
      },
    })
    await usePins.getState().syncPrefsFromHub()
    expect([...usePins.getState().pinnedWorkspaces]).toEqual(['/hubpin', '/legacy'])
    expect(transport.putPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedWorkspaces: ['/hubpin', '/legacy'] }),
      undefined,
    )
  })

  it('dirty 启动同步：待推操作重放到最新 hub 文档再上推（别端删除不丢）', async () => {
    vi.mocked(transport.prefsOrigin).mockReturnValue('http://hub')
    // hub 现状：/x 已被别端删除（本地 localStorage 还留着旧的 /x + 新 /y）
    vi.mocked(transport.getPrefs).mockResolvedValue({
      prefs: { pinnedWorkspaces: [], pinnedSessions: [], todos: {} },
      version: 5,
    })
    usePins.setState({
      pinnedWorkspaces: new Set(['/x', '/y']),
      todos: { s1: 'todo' },
    })
    // 手工制造「dirty + 待推操作」：取消 /x 置顶 + 设待办 s2
    usePins.getState().toggleWorkspacePin('/x') // → 删除 /x（op 记录）
    usePins.getState().setTodoStatus('s2', 'todo') // → op 记录
    await usePins.getState().syncPrefsFromHub()
    // 重放结果 = hub 文档 {空} + ops{删 /x, todo s2}，而非整份本地
    const doc = vi.mocked(transport.putPrefs).mock.calls[0]?.[0]
    expect(doc?.pinnedWorkspaces).toEqual([])
    expect(doc?.todos).toEqual({ s2: 'todo' })
    expect(vi.mocked(transport.putPrefs).mock.calls[0]?.[1]).toBe(5)
    expect(usePins.getState().todos['s1']).toBeUndefined() // 本地残留的旧待办不回写
  })

  it('版本冲突：PUT 409 后待推操作重放到 hub 当前文档再重试', async () => {
    vi.mocked(transport.prefsOrigin).mockReturnValue('http://hub')
    // 对齐到 v1：{pin /x}
    vi.mocked(transport.getPrefs).mockResolvedValue({
      prefs: { pinnedWorkspaces: ['/x'], pinnedSessions: [], todos: {} },
      version: 1,
    })
    await usePins.getState().syncPrefsFromHub()
    expect([...usePins.getState().pinnedWorkspaces]).toEqual(['/x'])
    // 本地新增 pin /y（dirty，base v1）；别端已删除 /x 并推进到 v2
    usePins.getState().toggleWorkspacePin('/y')
    vi.mocked(transport.putPrefs)
      .mockImplementationOnce(() =>
        Promise.reject(
          new PrefsConflictError('conflict', 2, {
            pinnedWorkspaces: [],
            pinnedSessions: [],
            todos: {},
          }),
        ),
      )
      .mockImplementationOnce(async () => ({ version: 3 }))
    await vi.advanceTimersByTimeAsync(HUB_PUSH_DEBOUNCE_MS)
    expect(transport.putPrefs).toHaveBeenCalledTimes(2)
    // 第一次：本地全量（还含已被别端删除的 /x）+ base 1 → 409
    expect(vi.mocked(transport.putPrefs).mock.calls[0]?.[1]).toBe(1)
    // 第二次：重放 {pin /y} 到 v2 文档 → 只含 /y + base 2（删除不复活、新增不丢）
    const second = vi.mocked(transport.putPrefs).mock.calls[1]
    expect(second?.[0]?.pinnedWorkspaces).toEqual(['/y'])
    expect(second?.[1]).toBe(2)
    expect([...usePins.getState().pinnedWorkspaces]).toEqual(['/y'])
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
