import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionHistoryPage } from '../../api/types'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'
import { clearContinueSessionTimer, runtime } from './globals'
import { resetToolFillCache } from './historyFill'

vi.mock('../../api/client', () => ({
  transport: {
    loadSessionHistory: vi.fn(),
    queueStatus: vi.fn().mockResolvedValue({ queue: [] }),
    sessionResume: vi.fn(),
    loadSession: vi.fn(),
    mcpList: vi.fn().mockResolvedValue({ servers: [] }),
    sessionStats: vi.fn(),
    sessionRunningTasks: vi.fn(),
    // 在跑子代理注册表（continueSession 的 defer 拉取 + 宽限窗口复拉）。
    subagentListRunning: vi.fn().mockResolvedValue({ subagents: [] }),
    listTasks: vi.fn().mockResolvedValue([]),
    gitInfo: vi.fn(),
    status: vi.fn(),
    rewindExecute: vi.fn(),
    rewindPoints: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    getConnectionMode: vi.fn(() => 'local'),
    prefsOrigin: vi.fn(() => ''),
    getPrefs: vi.fn(async () => ({ prefs: {} })),
    putPrefs: vi.fn(async () => ({})),
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}))

const SID = 's-para'
const CWD = '/w'
const T0 = 1_700_000_000_000
const COARSE = Math.floor(T0 / 1000)

function simplePage(): SessionHistoryPage {
  return {
    updates: [
      {
        msgSeq: 0,
        timestamp: COARSE,
        method: 'session/update',
        params: {
          sessionId: SID,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: '跑一下' },
          },
          _meta: { agentTimestampMs: T0 },
        },
      },
      {
        msgSeq: 1,
        timestamp: COARSE + 1,
        method: 'session/update',
        params: {
          sessionId: SID,
          update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' },
          _meta: { agentTimestampMs: T0 + 1 },
        },
      },
    ],
    promptStarts: [0],
    totalCount: 2,
    hasMore: false,
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const p = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { p, resolve, reject }
}

/** 一回合宏任务：flush 已排队的全部微任务链。 */
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('requestIdleCallback', undefined)
  vi.stubGlobal('cancelIdleCallback', undefined)
  // 代际推进让上个用例的在途请求作废。
  runtime.sessionSwitchGen += 1
  resetToolFillCache()
  useChatStore.setState({
    sessionId: SID,
    cwd: CWD,
    hostId: 'h1',
    selectedHostId: undefined,
    entries: [],
    pending: [],
    historyLoading: false,
    historyLoadingMore: false,
  })
})

afterEach(() => {
  clearContinueSessionTimer()
  useChatStore.getState().stopTopTaskPolling()
  useChatStore.setState({ entries: [], sessionId: undefined, cwd: undefined })
})

// ── continueSession 并行切会话（2026-09 性能）────────────────────────
// 打开历史会话的三个请求（sessionResume / sessionRunningTasks /
// session-updates）互不依赖，必须同时发出；快照的回放应用仍需等探活
// 完成（replayUpdates 跳过仍在跑任务的 started 行）。
describe('continueSession 并行切会话', () => {
  it('resume 未返回时探活与历史快照已发出（并行而非串行）', async () => {
    const resume = deferred<Record<string, unknown>>()
    const tasks = deferred<{ events: unknown[] }>()
    const hist = deferred<SessionHistoryPage>()
    vi.mocked(transport.sessionResume).mockReturnValue(resume.p as never)
    vi.mocked(transport.sessionRunningTasks).mockReturnValue(tasks.p as never)
    vi.mocked(transport.loadSessionHistory).mockReturnValue(hist.p as never)
    vi.mocked(transport.sessionStats).mockResolvedValue({} as never)
    vi.mocked(transport.gitInfo).mockResolvedValue({} as never)
    vi.mocked(transport.status).mockResolvedValue({} as never)

    const p = useChatStore.getState().continueSession(SID, CWD)
    await tick()
    // resume 尚未返回，但另两个请求已经发出——旧实现要等 resume
    // await 完才会发探活与快照。
    expect(vi.mocked(transport.sessionResume)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(transport.sessionRunningTasks)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(transport.loadSessionHistory)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(transport.loadSessionHistory)).toHaveBeenCalledWith(
      SID,
      CWD,
      expect.objectContaining({ turnIndex: 1 }),
    )

    resume.resolve({} as never)
    hist.resolve(simplePage())
    tasks.resolve({ events: [] })
    await p
  })

  it('探活未回时快照回放不落地，探活回后才渲染 entries', async () => {
    const tasks = deferred<{ events: unknown[] }>()
    vi.mocked(transport.sessionResume).mockResolvedValue({} as never)
    vi.mocked(transport.sessionRunningTasks).mockReturnValue(tasks.p as never)
    vi.mocked(transport.loadSessionHistory).mockResolvedValue(simplePage() as never)
    vi.mocked(transport.sessionStats).mockResolvedValue({} as never)
    vi.mocked(transport.gitInfo).mockResolvedValue({} as never)
    vi.mocked(transport.status).mockResolvedValue({} as never)

    const p = useChatStore.getState().continueSession(SID, CWD)
    await tick()
    // 快照响应已到手，但探活未回 → 卡在回放前，view 还是空的。
    expect(useChatStore.getState().entries).toEqual([])
    tasks.resolve({ events: [] })
    await p
    expect(useChatStore.getState().entries.length).toBeGreaterThan(0)
  })

  it('resume 与回退 loadSession 都失败：失败态收口并清掉已回放内容', async () => {
    vi.mocked(transport.sessionResume).mockRejectedValue(new Error('no resume'))
    vi.mocked(transport.loadSession).mockRejectedValue(new Error('no load'))
    vi.mocked(transport.sessionRunningTasks).mockResolvedValue({ events: [] } as never)
    vi.mocked(transport.loadSessionHistory).mockResolvedValue(simplePage() as never)
    vi.mocked(transport.sessionStats).mockResolvedValue({} as never)
    vi.mocked(transport.gitInfo).mockResolvedValue({} as never)
    vi.mocked(transport.status).mockResolvedValue({} as never)

    await useChatStore.getState().continueSession(SID, CWD)
    // 快照在并行中已回放成功，失败收口必须把它清掉，统一显示加载失败。
    expect(useChatStore.getState().historyLoadError).toBeTruthy()
    expect(useChatStore.getState().entries).toEqual([])
  })

  it('会话切换成功：触发 syncMcpServers 并更新 mcpServers 权威列表', async () => {
    vi.mocked(transport.sessionResume).mockResolvedValue({} as never)
    vi.mocked(transport.sessionRunningTasks).mockResolvedValue({ events: [] } as never)
    vi.mocked(transport.loadSessionHistory).mockResolvedValue(simplePage() as never)
    vi.mocked(transport.sessionStats).mockResolvedValue({} as never)
    vi.mocked(transport.gitInfo).mockResolvedValue({} as never)
    vi.mocked(transport.status).mockResolvedValue({} as never)
    vi.mocked(transport.mcpList).mockResolvedValue({
      servers: [
        { name: 'server-a', status: 'ready', enabled: true },
        { name: 'server-b', status: 'unavailable', enabled: false },
      ],
    })

    await useChatStore.getState().continueSession(SID, CWD)
    expect(transport.mcpList).toHaveBeenCalled()
    const servers = useChatStore.getState().mcpServers
    expect(servers.length).toBe(2)
    expect(servers[0].name).toBe('server-a')
    expect(servers[0].status).toBe('ready')
    expect(servers[1].name).toBe('server-b')
    expect(servers[1].status).toBe('unavailable')
  })
})

// ── 运行态是会话级：切会话绝不能让上一条会话的 Task / 子代理留在顶部 ──
// syncLiveTasks 对空注册表直接返回（空表不权威，不能据缺失结算），所以只靠
// 下一次轮询收敛不了——切到没有任务的会话时旧行会永久留着（用户报的
// "Task 串对话了"）。
describe('continueSession 清掉上一条会话的运行态', () => {
  beforeEach(() => {
    vi.mocked(transport.sessionResume).mockResolvedValue({} as never)
    vi.mocked(transport.sessionRunningTasks).mockResolvedValue({ events: [] } as never)
    vi.mocked(transport.loadSessionHistory).mockResolvedValue(simplePage() as never)
    vi.mocked(transport.sessionStats).mockResolvedValue({} as never)
    vi.mocked(transport.gitInfo).mockResolvedValue({} as never)
    vi.mocked(transport.status).mockResolvedValue({} as never)
    // 目标会话没有任何在跑的子代理。
    vi.mocked(transport.subagentListRunning).mockResolvedValue({ subagents: [] } as never)
  })

  it('上一条会话的 topTasks / detached / scheduledTasks 不跨会话', async () => {
    useChatStore.setState({
      topTasks: [{ taskId: 'old-task', title: '上一条会话的任务' }],
      detachedTasks: [{ taskId: 'old-detached' }],
      detachedHintKey: 'old-detached',
      runningProbeTaskIds: ['old-detached'],
      scheduledTasks: [{ taskId: 'old-sched', prompt: 'loop', interval: '2h' }],
    })

    await useChatStore.getState().continueSession(SID, CWD)

    const s = useChatStore.getState()
    expect(s.topTasks).toEqual([])
    expect(s.detachedTasks).toEqual([])
    // 旧 key 必须消失：新会话的探活落地后是"空集"签名（'' / null 都对，
    // 关键是不能再是上一条会话那个 key，否则同一集合永远不再提示）。
    expect(s.detachedHintKey).not.toBe('old-detached')
    expect(s.runningProbeTaskIds).toEqual([])
    expect(s.scheduledTasks).toEqual([])
  })

  it('上一条会话的子代理索引不跨会话（否则回放里同 id 的 spawn 会被跳过建行）', async () => {
    useChatStore.setState({
      subagentIndex: { 'sa-old': 'e-old' },
      subagentChildIndex: { 'child-old': 'e-old' },
      subagentViews: { 'child-old': { items: [], fetchState: 'loaded' } },
      pendingSubagentFinishes: {
        'sa-old': { status: 'completed' as const },
      },
    })

    await useChatStore.getState().continueSession(SID, CWD)

    const s = useChatStore.getState()
    expect(s.subagentIndex).toEqual({})
    expect(s.subagentChildIndex).toEqual({})
    expect(s.subagentViews).toEqual({})
    expect(s.pendingSubagentFinishes).toEqual({})
  })

  it('本会话注册表里的在跑子代理在回放收口后补回顶部', async () => {
    vi.mocked(transport.subagentListRunning).mockResolvedValue({
      subagents: [
        {
          subagentId: 'sa-live',
          childSessionId: 'child-live',
          parentSessionId: SID,
          description: '还没跑完的子代理',
          startedAtEpochMs: 1_700_000_000_000,
        },
      ],
    } as never)

    await useChatStore.getState().continueSession(SID, CWD)

    const s = useChatStore.getState()
    const restored = s.entries.filter((e) => e.kind === 'subagent')
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      kind: 'subagent',
      running: true,
      subagentId: 'sa-live',
      childSessionId: 'child-live',
      title: '还没跑完的子代理',
      // 注册表的真实派发时刻，不是回放/拉取时刻。
      startedAt: 1_700_000_000_000,
    })
    expect(s.subagentIndex['sa-live']).toBe(restored[0].id)
    expect(s.subagentChildIndex['child-live']).toBe(restored[0].id)
  })

  it('只有子代理在跑（没有任何 Task）也要开轮询收口', async () => {
    vi.mocked(transport.subagentListRunning).mockResolvedValue({
      subagents: [{ subagentId: 'sa-live', parentSessionId: SID }],
    } as never)
    const startTopTaskPolling = vi.fn()
    useChatStore.setState({ startTopTaskPolling } as never)

    await useChatStore.getState().continueSession(SID, CWD)
    // 收口在宽限窗口的 microtask 链上，等到它落地。
    await tick()
    await tick()

    expect(startTopTaskPolling).toHaveBeenCalled()
  })
})