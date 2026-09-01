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
    sessionStats: vi.fn(),
    sessionRunningTasks: vi.fn(),
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
})