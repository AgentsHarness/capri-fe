import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'
import { clearHistoryWindowBuffer } from './globals'

vi.mock('../../api/client', () => ({
  transport: {
    loadSessionHistory: vi.fn(),
    queueStatus: vi.fn().mockResolvedValue({ queue: [] }),
    onEvent: vi.fn(() => () => {}),
    getConnectionMode: vi.fn(() => 'local'),
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}))

/**
 * msgSeq 契约集成测试（tmp/msgseq/CONTRACT.md）：信封顶层 msgSeq 进回放
 * 条目（用户聚合行取首条 chunk）、loadMore 前插页按 msgSeq 归并、任一端
 * 缺 msgSeq 完全回退现有行为、页内缺口 dev warn。
 */
describe('msgSeq 回放（loadHistory / loadMoreHistory）', () => {
  const SID = 's1'
  const CWD = '/w'

  const env = (
    msgSeq: number | undefined,
    sessionUpdate: string,
    over: Record<string, unknown> = {},
  ) => ({
    ...(msgSeq != null ? { msgSeq } : {}),
    timestamp: 1_700_000_000,
    method: 'session/update',
    params: {
      sessionId: SID,
      update: { sessionUpdate, ...over },
    },
  })

  const text = (t: string) => ({ type: 'text', text: t })

  afterEach(() => {
    vi.restoreAllMocks()
    useChatStore.setState({ entries: [], sessionId: undefined, cwd: undefined })
  })

  beforeEach(() => {
    clearHistoryWindowBuffer()
    useChatStore.setState({
      sessionId: SID,
      cwd: CWD,
      entries: [],
      pending: [],
      historyLoading: false,
      historyLoadingMore: false,
    })
  })

  const kindOf = (e: ScrollEntry) => e.kind

  it('信封顶层 msgSeq 进回放条目；用户聚合行取首条 chunk 的 msgSeq', async () => {
    const snap = [
      env(3, 'user_message_chunk', { content: text('q') }),
      env(4, 'user_message_chunk', { content: text(' more') }),
      env(5, 'agent_message_chunk', { content: text('a') }),
      env(6, 'turn_completed'),
    ]
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: snap,
      promptStarts: [0],
      totalCount: snap.length,
      hasMore: false,
    } as never)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await useChatStore.getState().loadHistory(SID, CWD)

    const es = useChatStore.getState().entries
    expect(es.map(kindOf)).toEqual(['user', 'assistant', 'session_event'])
    // 多 chunk 聚合的用户行 = 首条 chunk 的 msgSeq（3，不是 4）。
    expect(es[0]).toMatchObject({ kind: 'user', text: 'q more', msgSeq: 3 })
    expect(es[1]).toMatchObject({ kind: 'assistant', text: 'a', msgSeq: 5 })
    // 收口标记 = turn_completed 信封的 msgSeq。
    expect(es[2]).toMatchObject({ kind: 'session_event', msgSeq: 6 })
    // 连续页不应触发缺口告警。
    expect(
      warnSpy.mock.calls.every((c) => !String(c[0]).includes('msgSeq')),
    ).toBe(true)
  })

  it('loadMore 前插页按 msgSeq 归并（等值取前插页）；offset/limit 走 msgSeq 空间', async () => {
    // 已加载区带着比新页更大的 msgSeq（宿主晚落盘回插导致序号交错的形态）。
    useChatStore.setState({
      entries: [{ id: 'old-u', kind: 'user', text: '旧1', msgSeq: 1, ts: 1 } as ScrollEntry],
      historySessionId: SID,
      historyCwd: CWD,
      historyHasMore: true,
      historyLoadedStart: 3,
      historyTurnIdx: 1,
      historyPromptStarts: [0, 3],
      historyTotalCount: 3,
      historyLoadedCount: 1,
    })
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: [
        env(0, 'user_message_chunk', { content: text('新0') }),
        env(1, 'agent_message_chunk', { content: text('新1') }),
        env(2, 'turn_completed'),
      ],
      promptStarts: [0, 3],
      totalCount: 3,
      hasMore: false,
    } as never)

    await useChatStore.getState().loadMoreHistory()

    // 前一轮窗口 = [promptStarts[0], min(promptStarts[1], loadedStart)) =
    // [0, 3)——绝对 offset/limit 在 msgSeq 空间解释。
    expect(vi.mocked(transport.loadSessionHistory)).toHaveBeenLastCalledWith(
      SID,
      CWD,
      { offset: 0, limit: 3 },
    )

    const es = useChatStore.getState().entries
    // 归并按 msgSeq：新页 [0,1,2] 与已加载区 [1] 交错；等值(1)取前插页。
    // 现有拼接行为会得到 [新0, 新1, 标记, 旧1] —— 归并改变了它。
    expect(es.map((e) => (e.kind === 'session_event' ? '标记' : (e as { text: string }).text))).toEqual([
      '新0',
      '新1',
      '旧1',
      '标记',
    ])
    expect(es.map((e) => e.msgSeq)).toEqual([0, 1, 1, 2])
  })

  it('任一端缺 msgSeq 完全回退现有行为：不排序、不归并', async () => {
    useChatStore.setState({
      // live 行无 msgSeq（旧端形态）。
      entries: [{ id: 'old-live', kind: 'user', text: '旧', ts: 1 } as ScrollEntry],
      historySessionId: SID,
      historyCwd: CWD,
      historyHasMore: true,
      historyLoadedStart: 3,
      historyTurnIdx: 1,
      historyPromptStarts: [0, 3],
      historyTotalCount: 3,
      historyLoadedCount: 1,
    })
    // 回退透传路径：信封不带 msgSeq。
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: [
        env(undefined, 'user_message_chunk', { content: text('新0') }),
        env(undefined, 'agent_message_chunk', { content: text('新1') }),
        env(undefined, 'turn_completed'),
      ],
      promptStarts: [0, 3],
      totalCount: 3,
      hasMore: false,
    } as never)

    await useChatStore.getState().loadMoreHistory()

    const es = useChatStore.getState().entries
    // 旧页整段在前、已加载区整段在后，条目不带 msgSeq。
    expect(es.map((e) => (e.kind === 'session_event' ? '标记' : (e as { text: string }).text))).toEqual([
      '新0',
      '新1',
      '标记',
      '旧',
    ])
    expect(es.every((e) => !('msgSeq' in e))).toBe(true)
  })

  it('页内 msgSeq 不连续 → dev 环境 console.warn', async () => {
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: [
        env(5, 'user_message_chunk', { content: text('q') }),
        env(6, 'agent_message_chunk', { content: text('a') }),
        env(8, 'turn_completed'),
      ],
      promptStarts: [0],
      totalCount: 4,
      hasMore: false,
    } as never)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await useChatStore.getState().loadHistory(SID, CWD)

    const gapWarnings = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('msgSeq 不连续'),
    )
    expect(gapWarnings).toHaveLength(1)
    expect(String(gapWarnings[0]![0])).toContain('期望 7')
  })
})
