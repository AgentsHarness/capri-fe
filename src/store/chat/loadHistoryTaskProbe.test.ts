import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'
import { loadHistoryWithTaskProbe } from './loadHistory'
import { clearTopTaskTimer } from './topTasks'

vi.mock('../../api/client', () => ({
  transport: {
    loadSessionHistory: vi.fn(),
    sessionRunningTasks: vi.fn().mockResolvedValue({ events: [] }),
    queueStatus: vi.fn().mockResolvedValue({ queue: [] }),
    onEvent: vi.fn(() => () => {}),
    getConnectionMode: vi.fn(() => 'local'),
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}))

const SID = 's1'
const CWD = '/w'
const T = 1_700_000_001_500

const envelope = (sessionUpdate: string, content: unknown) => ({
  timestamp: Math.floor(T / 1000),
  method: 'session/update',
  params: {
    sessionId: SID,
    update: { sessionUpdate, content },
    _meta: { agentTimestampMs: T, turnStartMs: T - 1000 },
  },
})

const snapshot = () => ({
  updates: [
    envelope('user_message_chunk', { type: 'text', text: '问题' }),
    envelope('agent_message_chunk', { type: 'text', text: '回答' }),
  ],
  promptStarts: [0],
  totalCount: 2,
  hasMore: false,
})

const get = () => useChatStore.getState()

beforeEach(() => {
  clearTopTaskTimer()
  useChatStore.setState({
    sessionId: SID,
    cwd: CWD,
    entries: [],
    pending: [],
    topTasks: [],
    historyLoading: false,
    historyLoadError: undefined,
  })
  vi.mocked(transport.loadSessionHistory).mockResolvedValue(snapshot() as never)
  vi.mocked(transport.sessionRunningTasks).mockResolvedValue({ events: [] } as never)
})

afterEach(() => {
  clearTopTaskTimer()
  vi.useRealTimers()
})

describe('loadHistoryWithTaskProbe', () => {
  it('探活与快照同时发出，回放严格等探活落地', async () => {
    let settleProbe!: () => void
    const probeP = new Promise<void>((r) => (settleProbe = r))
    vi.mocked(transport.sessionRunningTasks).mockReturnValue(probeP as never)

    const p = loadHistoryWithTaskProbe(get, SID, CWD)
    // 宏任务边界：快照 fetch 的 mock 早已 resolve，回放链若无门控必然已跑完
    await new Promise((r) => setTimeout(r, 0))
    expect(transport.loadSessionHistory).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().entries).toHaveLength(0)

    settleProbe()
    await p
    expect(useChatStore.getState().entries.length).toBeGreaterThan(0)
  })

  it('探活卡住不拖死首帧：到 800ms 上限照常回放', async () => {
    vi.useFakeTimers()
    vi.mocked(transport.sessionRunningTasks).mockReturnValue(
      new Promise<void>(() => {
        /* 永不 resolve */
      }) as never,
    )
    const p = loadHistoryWithTaskProbe(get, SID, CWD)
    // 上限之内仍然等门（回放链上的快照 mock 早就 resolve 了）
    await vi.advanceTimersByTimeAsync(799)
    expect(useChatStore.getState().entries).toHaveLength(0)
    // 越过上限：首帧不再等一个不会回来的探活
    await vi.advanceTimersByTimeAsync(50)
    await p
    expect(useChatStore.getState().entries.length).toBeGreaterThan(0)
    expect(useChatStore.getState().historyLoading).toBe(false)
  })

  it('探活查到在跑任务 → 填顶部任务条并开轮询', async () => {
    vi.mocked(transport.sessionRunningTasks).mockResolvedValue({
      events: [
        { kind: 'task_backgrounded', taskId: 't9', description: '跑集成测试', command: 'npm t' },
      ],
    } as never)
    const startTopTaskPolling = vi.fn()
    useChatStore.setState({ startTopTaskPolling } as never)

    await loadHistoryWithTaskProbe(get, SID, CWD)
    expect(useChatStore.getState().topTasks.map((t) => t.taskId)).toEqual(['t9'])
    expect(startTopTaskPolling).toHaveBeenCalledWith(SID, CWD)
  })

  it('没有在跑任务 → 不留 10s 轮询定时器', async () => {
    const startTopTaskPolling = vi.fn()
    useChatStore.setState({ startTopTaskPolling } as never)
    await loadHistoryWithTaskProbe(get, SID, CWD)
    expect(startTopTaskPolling).not.toHaveBeenCalled()
  })

  it('探活落地前会话已被切走 → 不给旧会话开轮询', async () => {
    let settleProbe!: () => void
    vi.mocked(transport.sessionRunningTasks).mockReturnValue(
      new Promise<void>((r) => (settleProbe = r)) as never,
    )
    const startTopTaskPolling = vi.fn()
    useChatStore.setState({ startTopTaskPolling } as never)

    const p = loadHistoryWithTaskProbe(get, SID, CWD)
    useChatStore.setState({ sessionId: 'other', cwd: '/other' } as never)
    settleProbe()
    await p
    expect(startTopTaskPolling).not.toHaveBeenCalled()
  })
})
