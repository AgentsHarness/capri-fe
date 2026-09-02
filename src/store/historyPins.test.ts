import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HubPrefsDoc, PrefsEntries, SessionInfo, WorkspaceGroup } from '../api/types'
import { PrefsConflictError } from '../api/transport'
import { transport } from '../api/client'
import { sortSessionsWithPins, sortWorkspacesWithPins, usePins } from './historyPins'
import {
  alive as entryAlive,
  entriesFromView,
  feKey,
  mergeEntries,
  projectEntries,
  sameEntries,
  sessionKey,
  todoKey,
  wsKey,
} from './prefsEntries'
import { KEY } from '../lib/keys'

// historyPins 在模块顶层 transport.onEvent(...) 注册 prefs_changed 监听，
// 用 hoisted 数组捕获 handler 以便直接触发广播。
const handlers = vi.hoisted(() => [] as Array<(ev: unknown) => void>)

vi.mock('../api/client', () => ({
  transport: {
    onEvent: vi.fn((h: (ev: unknown) => void) => {
      handlers.push(h)
      return () => {}
    }),
    getPrefs: vi.fn(async (): Promise<{ prefs: HubPrefsDoc; version?: number }> => {
      throw new Error('未编排：测试里请先设置 hub')
    }),
    putPrefs: vi.fn(async (): Promise<{ version?: number; prefs?: HubPrefsDoc }> => {
      throw new Error('未编排：测试里请先设置 hub')
    }),
    prefsOrigin: vi.fn((): string => ''),
    // liteReplay 的默认值按部署模式现取（hub 开 / local 关）——本文件一律
    // 按 local 测，模式相关的断言在 liteReplay.test.ts 里。
    getConnectionMode: vi.fn((): string => 'local'),
  },
}))

const HUB_PUSH_DEBOUNCE_MS = 500

// ── 测试用 hub：与 internal/hub/prefs.go 同一套条目合并语义 ─────────────
// Go 侧那份由 hub 自己的测试（internal/hub/prefs_test.go）保证；这里复用它
// 要验证的对象是 FE：合并/吸收/何时上推/失败怎么处理。
const hub = vi.hoisted(() => ({
  entries: {} as PrefsEntries,
  ver: 0,
  online: true,
  writes: [] as HubPrefsDoc[],
  broadcasts: 0,
}))

/** hub 的权威文档（投影由条目现算）；版本单独走响应的 version 字段。 */
function hubDoc(): HubPrefsDoc {
  const v = projectEntries(hub.entries)
  return {
    pinnedWorkspaces: v.pinnedWorkspaces,
    pinnedSessions: v.pinnedSessions,
    todos: v.todos as HubPrefsDoc['todos'],
    fePrefs: v.fePrefs,
    entries: { ...hub.entries },
  }
}

/** 别端的一次写入（合并 + 版本 +1），deliver=false 模拟本端不在线收不到。 */
function otherClientWrites(entries: PrefsEntries, deliver = true): void {
  hub.entries = mergeEntries(hub.entries, entries)
  hub.ver += 1
  hub.broadcasts += 1
  if (deliver) fireBroadcast(hubDoc(), hub.ver)
}

function fireBroadcast(doc: HubPrefsDoc, version: number): void {
  handlers[0]?.({ type: 'prefs_changed', params: { prefs: doc, version } })
}

/** 装好 getPrefs/putPrefs，让 store 与这份 hub 交互。 */
function wireHub(): void {
  vi.mocked(transport.prefsOrigin).mockReturnValue(hub.online ? 'http://hub' : '')
  vi.mocked(transport.getConnectionMode).mockReturnValue(hub.online ? 'hub' : 'local')
  vi.mocked(transport.getPrefs).mockImplementation(async () => {
    if (!hub.online) throw new Error('仅 Hub 模式支持置顶/待办持久化')
    return { prefs: hubDoc(), version: hub.ver }
  })
  vi.mocked(transport.putPrefs).mockImplementation(async (prefs, baseVersion) => {
    if (!hub.online) throw new Error('仅 Hub 模式支持置顶/待办持久化')
    hub.writes.push(JSON.parse(JSON.stringify(prefs)) as HubPrefsDoc)
    const incoming = prefs.entries && Object.keys(prefs.entries).length > 0
    if (!incoming && baseVersion != null && baseVersion !== hub.ver) {
      throw new PrefsConflictError('conflict', hub.ver, hubDoc())
    }
    const next = incoming
      ? mergeEntries(hub.entries, prefs.entries as PrefsEntries)
      : entriesFromView(
          {
            pinnedWorkspaces: prefs.pinnedWorkspaces ?? [],
            pinnedSessions: prefs.pinnedSessions ?? [],
            todos: prefs.todos ?? {},
            fePrefs: (prefs.fePrefs ?? {}) as Record<string, boolean>,
          },
          Date.now(),
          'hub-legacy',
        )
    if (sameEntries(hub.entries, next)) return { version: hub.ver, prefs: hubDoc() }
    hub.entries = next
    hub.ver += 1
    return { version: hub.ver, prefs: hubDoc() }
  })
}

const localEntries = (): PrefsEntries => usePins.getState().entries
const pinned = (): string[] => [...usePins.getState().pinnedSessions]
const wsPinned = (): string[] => [...usePins.getState().pinnedWorkspaces]
const hubPinned = (): string[] => projectEntries(hub.entries).pinnedSessions
const pending = (): boolean => window.localStorage.getItem(KEY.historyPinsDirty) === '1'

beforeEach(async () => {
  hub.entries = {}
  hub.ver = 0
  hub.online = true
  hub.writes = []
  hub.broadcasts = 0
  usePins.setState({
    entries: {},
    pinnedWorkspaces: new Set<string>(),
    pinnedSessions: new Set<string>(),
    todos: {},
    fePrefs: { collapseToolGroups: true, liteReplay: false },
  })
  vi.mocked(transport.prefsOrigin).mockReturnValue('')
  vi.mocked(transport.getPrefs).mockRejectedValue(new Error('未编排'))
  vi.mocked(transport.putPrefs).mockRejectedValue(new Error('未编排'))
  // 跑完上一个测试遗留的防抖推送，别让它串进下一个测试的请求计数。
  await vi.advanceTimersByTimeAsync(HUB_PUSH_DEBOUNCE_MS + 5)
  vi.clearAllMocks()
  hub.writes = []
})

vi.useFakeTimers()

// ── 本地读写 ─────────────────────────────────────────────────────────

describe('本地置顶/待办', () => {
  it('toggleWorkspacePin 往返并落盘为条目（v3）', () => {
    usePins.getState().toggleWorkspacePin('/w/1')
    expect(wsPinned()).toEqual(['/w/1'])
    const raw = JSON.parse(window.localStorage.getItem(KEY.historyPins) ?? '{}') as {
      v: number
      entries: PrefsEntries
    }
    expect(raw.v).toBe(3)
    expect(raw.entries[wsKey('/w/1')].v).toBe('1')
    expect(raw.entries[wsKey('/w/1')].at).toBeGreaterThan(0)

    usePins.getState().toggleWorkspacePin('/w/1')
    expect(wsPinned()).toEqual([])
    const gone = JSON.parse(window.localStorage.getItem(KEY.historyPins) ?? '{}') as {
      entries: PrefsEntries
    }
    expect(gone.entries[wsKey('/w/1')].d).toBe(true) // 取消 = 墓碑，不是抹掉记录
  })

  it('setTodoStatus 设置与清除', () => {
    usePins.getState().setTodoStatus('s1', 'todo')
    expect(usePins.getState().todos['s1']).toBe('todo')
    usePins.getState().setTodoStatus('s1', 'completed')
    expect(usePins.getState().todos['s1']).toBe('completed')
    usePins.getState().setTodoStatus('s1', null)
    expect(usePins.getState().todos['s1']).toBeUndefined()
  })

  it('setFePrefs 局部合并，且 liteReplay 被显式选过后才进投影', () => {
    usePins.getState().setFePrefs({ collapseToolGroups: false })
    expect(usePins.getState().fePrefs).toEqual({ collapseToolGroups: false, liteReplay: false })
    expect(liveKeys(localEntries())).toEqual([feKey('collapseToolGroups')])

    usePins.getState().setFePrefs({ liteReplay: true })
    expect(aliveKey(localEntries(), feKey('liteReplay'))).toBe(true)
  })

  it('变更经 500ms 防抖合并为一次回写，文档同时带投影与条目', async () => {
    wireHub()
    usePins.getState().toggleWorkspacePin('/w/1')
    usePins.getState().setTodoStatus('s1', 'todo')
    expect(vi.mocked(transport.putPrefs)).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(HUB_PUSH_DEBOUNCE_MS)
    expect(transport.putPrefs).toHaveBeenCalledTimes(1)
    const doc = vi.mocked(transport.putPrefs).mock.calls[0]?.[0]
    expect(doc?.pinnedWorkspaces).toEqual(['/w/1'])
    expect(doc?.todos).toEqual({ s1: 'todo' })
    expect(Object.keys(doc?.entries ?? {})).toHaveLength(2)
    expect(pending()).toBe(false)
  })
})

// ── 广播：合并而不是替换/忽略 ─────────────────────────────────────────

describe('prefs_changed 广播', () => {
  it('别端的新增与删除都直接合并进来', () => {
    usePins.getState().toggleSessionPin('mine')
    otherClientWrites({ [sessionKey('theirs')]: { v: '1', at: Date.now(), site: 'other' } })
    expect(pinned().sort()).toEqual(['mine', 'theirs'])
    otherClientWrites({ [sessionKey('mine')]: { v: '', at: Date.now() + 1000, site: 'other', d: true } })
    expect(pinned()).toEqual(['theirs'])
  })

  it('本地有还没推上去的改动时不再忽略广播（合并两边，互不覆盖）', () => {
    hub.online = false // 让本地这次改动注定推不出去 → 处于「未落地」状态
    usePins.getState().toggleSessionPin('unsent')
    hub.online = true
    otherClientWrites({ [sessionKey('theirs')]: { v: '1', at: Date.now(), site: 'other' } })
    expect(pinned().sort()).toEqual(['theirs', 'unsent'])
    // 待推的那条仍然在本地，等下一次机会上推
    expect(aliveKey(localEntries(), sessionKey('unsent'))).toBe(true)
  })

  it('陈旧广播压不住较新的本地删除（合并按条目取新）', () => {
    usePins.getState().toggleSessionPin('s1')
    const addedAt = localEntries()[sessionKey('s1')].at
    usePins.getState().toggleSessionPin('s1') // 取消（墓碑 at 更大）
    fireBroadcast(
      { ...hubDocFrom({ entries: { [sessionKey('s1')]: { v: '1', at: addedAt - 1, site: 'x' } } }) },
      1,
    )
    expect(pinned()).toEqual([])
  })

  it('hub_conn 上线补一次合并同步，掉线不触发', async () => {
    wireHub()
    otherClientWrites({ [sessionKey('s1')]: { v: '1', at: Date.now(), site: 'other' } }, false)
    handlers[0]?.({ type: 'hub_conn', online: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.getPrefs).toHaveBeenCalled()
    expect(pinned()).toEqual(['s1'])
    vi.mocked(transport.getPrefs).mockClear()
    handlers[0]?.({ type: 'hub_conn', online: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.getPrefs).not.toHaveBeenCalled()
  })
})

// ── 启动/重连同步 ────────────────────────────────────────────────────

describe('syncPrefsFromHub', () => {
  it('无 hub 地址时静默跳过（local 模式）', async () => {
    hub.online = false
    wireHub()
    await usePins.getState().syncPrefsFromHub()
    expect(transport.getPrefs).not.toHaveBeenCalled()
  })

  it('取消的置顶不会因本地陈旧缓存复活（两端交替使用的真实路径）', async () => {
    wireHub()
    // 本端与 hub 对齐时 s1 是置顶的
    otherClientWrites({ [sessionKey('s1')]: { v: '1', at: 1000, site: 'other' } })
    expect(pinned()).toEqual(['s1'])
    // 本端在 hub 之外取消，并且这一次没能落到 hub（离线 / 请求失败）
    usePins.getState().toggleSessionPin('s1')
    hub.online = false
    await vi.advanceTimersByTimeAsync(HUB_PUSH_DEBOUNCE_MS)
    expect(pinned()).toEqual([])
    expect(pending()).toBe(true)
    // 回到 hub：本地那条更晚的删除必须赢过 hub 上的旧置顶
    hub.online = true
    wireHub()
    await usePins.getState().syncPrefsFromHub()
    expect(pinned()).toEqual([])
    expect(hubPinned()).toEqual([]) // 取消确实落了 hub，而不是被旧文档冲回
  })

  it('本地缓存（旧版快照迁来的 at=0）压不过 hub 现状，只补齐 hub 没有的条目', async () => {
    wireHub()
    // hub：s1 置顶过又被删；本地：一份 v2 旧缓存同时写着 s1 置顶 + s2 置顶
    otherClientWrites(
      {
        [sessionKey('s1')]: { v: '1', at: 5000, site: 'other' },
        [sessionKey('s1') + 'x']: { v: '', at: 5000, site: 'other', d: true },
      },
      false,
    )
    hub.entries = { [sessionKey('s1')]: { v: '', at: 5000, site: 'other', d: true } }
    usePins.setState({ entries: entriesFromView({ pinnedSessions: ['s1', 's2'] }, 0, 'me-legacy') })
    await usePins.getState().syncPrefsFromHub()
    expect(pinned()).toEqual(['s2']) // 陈旧缓存里那条「还pin着」的 s1 没能复活
    expect(hubPinned()).toEqual(['s2']) // 补齐了 hub 从没见过的 s2，且没踩掉任何删除
  })

  it('与 hub 完全一致时不上推（不再每次启动都整份覆盖）', async () => {
    wireHub()
    otherClientWrites({ [sessionKey('s1')]: { v: '1', at: Date.now(), site: 'other' } })
    vi.mocked(transport.putPrefs).mockClear()
    const before = hub.ver
    await usePins.getState().syncPrefsFromHub()
    expect(transport.putPrefs).not.toHaveBeenCalled()
    expect(hub.ver).toBe(before)
  })

  it('离线期间攒下的改动在启动同步时合并上推，别端条目不丢', async () => {
    wireHub()
    otherClientWrites({ [sessionKey('theirs')]: { v: '1', at: 100, site: 'other' } }, false)
    hub.online = false
    usePins.getState().toggleSessionPin('mine')
    await vi.advanceTimersByTimeAsync(HUB_PUSH_DEBOUNCE_MS)
    hub.online = true
    wireHub()
    await usePins.getState().syncPrefsFromHub()
    expect(hubPinned().sort()).toEqual(['mine', 'theirs'])
    expect(pending()).toBe(false)
  })

  it('旧 hub（响应不带条目）仍能对齐：把投影物化进条目', async () => {
    vi.mocked(transport.prefsOrigin).mockReturnValue('http://hub')
    vi.mocked(transport.getPrefs).mockResolvedValue({
      prefs: { pinnedWorkspaces: ['/x'], pinnedSessions: [], todos: { s1: 'todo' } },
      version: 4,
    })
    await usePins.getState().syncPrefsFromHub()
    expect(wsPinned()).toEqual(['/x'])
    expect(usePins.getState().todos['s1']).toBe('todo')
    expect(aliveKey(localEntries(), wsKey('/x'))).toBe(true)
    expect(transport.putPrefs).not.toHaveBeenCalled()
  })

  it('旧 hub 的 409：吸收它的文档并保留待推状态', async () => {
    vi.mocked(transport.prefsOrigin).mockReturnValue('http://hub')
    vi.mocked(transport.getPrefs).mockResolvedValue({ prefs: {}, version: 1 })
    usePins.getState().toggleSessionPin('mine')
    await vi.advanceTimersByTimeAsync(HUB_PUSH_DEBOUNCE_MS) // 建 base 版本 = 1
    vi.mocked(transport.putPrefs).mockRejectedValue(
      new PrefsConflictError('conflict', 9, {
        pinnedSessions: ['theirs'],
        entries: { [sessionKey('theirs')]: { v: '1', at: 9, site: 'other' } },
      }),
    )
    usePins.getState().toggleSessionPin('mine2')
    await vi.advanceTimersByTimeAsync(HUB_PUSH_DEBOUNCE_MS)
    expect(pinned().sort()).toEqual(['mine', 'mine2', 'theirs'])
    expect(pending()).toBe(true) // 没收口才不会自称已同步
    expect(window.localStorage.getItem(KEY.historyPinsVer)).toBe('9')
  })

  it('拉取失败绝不清空本地；未落地的写入照常再试一次', async () => {
    vi.mocked(transport.prefsOrigin).mockReturnValue('http://hub')
    vi.mocked(transport.getPrefs).mockRejectedValue(new Error('401'))
    vi.mocked(transport.putPrefs).mockRejectedValue(new Error('401'))
    usePins.getState().toggleSessionPin('mine')
    await vi.advanceTimersByTimeAsync(HUB_PUSH_DEBOUNCE_MS) // 这一轮写失败
    expect(pending()).toBe(true)
    vi.mocked(transport.putPrefs).mockResolvedValue({ version: 3 })
    vi.mocked(transport.putPrefs).mockClear()
    await usePins.getState().syncPrefsFromHub() // 拉不动也要把待推的再试一次
    expect(pinned()).toEqual(['mine'])
    expect(transport.putPrefs).toHaveBeenCalled()
  })

  it('推送失败保留待推标记（不会被误判成已同步）', async () => {
    wireHub()
    usePins.getState().toggleSessionPin('mine')
    vi.mocked(transport.putPrefs).mockRejectedValueOnce(new Error('网络断了'))
    await vi.advanceTimersByTimeAsync(HUB_PUSH_DEBOUNCE_MS)
    expect(pending()).toBe(true)
    expect(pinned()).toEqual(['mine']) // 本地状态不丢
  })

  it('v1 旧缓存（只有置顶）迁移后按最弱陈述参与合并', async () => {
    window.localStorage.setItem(
      KEY.historyPins,
      JSON.stringify({ workspaces: ['/old'], sessions: ['s-old'] }),
    )
    usePins.setState({
      entries: entriesFromView({ pinnedWorkspaces: ['/old'], pinnedSessions: ['s-old'] }, 0, 'me-legacy'),
    })
    wireHub()
    otherClientWrites({ [sessionKey('s-old')]: { v: '', at: 777, site: 'other', d: true } }, false)
    await usePins.getState().syncPrefsFromHub()
    expect(pinned()).toEqual([])
    expect(wsPinned()).toEqual(['/old'])
  })

  it('待办状态同理：别端清掉的待办不会被本地陈旧值请回来', async () => {
    wireHub()
    const past = Date.now() - 10_000
    otherClientWrites({ [todoKey('s1')]: { v: 'completed', at: past, site: 'me' } })
    otherClientWrites({ [todoKey('s1')]: { v: '', at: past + 1000, site: 'other', d: true } })
    expect(usePins.getState().todos['s1']).toBeUndefined()
    // 另一台拿着「completed」那份陈旧快照的端推一次
    fireBroadcast({ ...hubDoc(), entries: { ...hub.entries } }, hub.ver)
    usePins.setState((s) => ({
      entries: { ...s.entries, [todoKey('s1')]: { v: 'completed', at: past, site: 'stale' } },
    }))
    await usePins.getState().syncPrefsFromHub()
    expect(usePins.getState().todos['s1']).toBeUndefined()
    expect(hub.entries[todoKey('s1')].d).toBe(true)
  })
})

// ── 排序 ─────────────────────────────────────────────────────────────

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

// ── 小工具 ───────────────────────────────────────────────────────────

const aliveKey = entryAlive

function liveKeys(entries: PrefsEntries): string[] {
  return Object.keys(entries)
    .filter((k) => aliveKey(entries, k))
    .sort()
}

/** 从一份投影/条目混合的 partial 文档造出完整 hub 文档（陈旧广播用例用）。 */
function hubDocFrom(partial: Partial<HubPrefsDoc>): HubPrefsDoc {
  const entries = partial.entries ?? {}
  const v = projectEntries(entries)
  return {
    pinnedWorkspaces: partial.pinnedWorkspaces ?? v.pinnedWorkspaces,
    pinnedSessions: partial.pinnedSessions ?? v.pinnedSessions,
    todos: (partial.todos ?? v.todos) as HubPrefsDoc['todos'],
    fePrefs: partial.fePrefs ?? v.fePrefs,
    entries,
  }
}
