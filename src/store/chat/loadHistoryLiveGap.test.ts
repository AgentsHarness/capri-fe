import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpEvent } from '../../api/types'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'
import { useToastStore } from '../toast'
import {
  bufferHistoryWindowEvent,
  clearHistoryWindowBuffer,
  LIVE_STREAM_HISTORY_GAP_TOAST,
  LIVE_STREAM_HISTORY_GAP_TOAST_ID,
  LIVE_STREAM_HISTORY_GAP_TOAST_MS,
} from './globals'

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
 * 回放进行中回合时，agent 把当前完整块留在 pending 聚合里不落盘；
 * 本端中途订阅接上的 live 只有后半段。应 toast 提醒等直播结束再重开。
 */
describe('loadHistory 直播完整块前半段缺口 toast', () => {
  const SID = 's-live'
  const CWD = '/w'
  const NOW = 1_800_000_000_000
  const STREAM_START = NOW - 8_000

  const envelope = (
    sessionUpdate: string,
    content: unknown,
    meta: Record<string, number>,
  ) => ({
    timestamp: Math.floor(meta.agentTimestampMs / 1000),
    method: 'session/update',
    params: {
      sessionId: SID,
      update: { sessionUpdate, content },
      _meta: meta,
    },
  })

  const toastTexts = () => useToastStore.getState().toasts.map((t) => t.text)

  afterEach(() => {
    vi.useRealTimers()
    useChatStore.setState({ entries: [], sessionId: undefined, cwd: undefined })
  })

  beforeEach(() => {
    clearHistoryWindowBuffer()
    useToastStore.setState({ toasts: [] })
    vi.useFakeTimers({ now: NOW })
    useChatStore.setState({
      sessionId: SID,
      cwd: CWD,
      entries: [],
      pending: [],
      historyLoading: false,
    })
  })

  it('进行中回合：快照没有这一路流，窗口期 live 是中途订阅 → toast', async () => {
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: [
        envelope(
          'user_message_chunk',
          { type: 'text', text: 'go' },
          { agentTimestampMs: NOW - 10_000, turnStartMs: NOW - 10_000 },
        ),
      ],
      promptStarts: [0],
      totalCount: 1,
      hasMore: false,
    } as never)

    bufferHistoryWindowEvent({
      type: 'chunk',
      text: '后半段',
      sessionId: SID,
      streamStartMs: STREAM_START,
      agentTimestampMs: NOW - 100,
      turnStartMs: NOW - 10_000,
    } as AcpEvent)

    await useChatStore.getState().loadHistory(SID, CWD)

    expect(toastTexts()).toEqual([LIVE_STREAM_HISTORY_GAP_TOAST])
    expect(useToastStore.getState().toasts[0]?.id).toBe(
      LIVE_STREAM_HISTORY_GAP_TOAST_ID,
    )
    expect(useToastStore.getState().toasts[0]?.type).toBe('warning')
    expect(useToastStore.getState().toasts[0]?.durationMs).toBe(
      LIVE_STREAM_HISTORY_GAP_TOAST_MS,
    )
  })

  it('快照已有同一路 assistant 流 → 历史含前缀，不 toast', async () => {
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: [
        envelope(
          'user_message_chunk',
          { type: 'text', text: 'go' },
          { agentTimestampMs: NOW - 10_000, turnStartMs: NOW - 10_000 },
        ),
        envelope(
          'agent_message_chunk',
          { type: 'text', text: '已落盘的完整块' },
          {
            agentTimestampMs: NOW - 2_000,
            streamStartMs: STREAM_START,
            turnStartMs: NOW - 10_000,
          },
        ),
      ],
      promptStarts: [0],
      totalCount: 2,
      hasMore: false,
    } as never)

    bufferHistoryWindowEvent({
      type: 'chunk',
      text: '续写',
      sessionId: SID,
      streamStartMs: STREAM_START,
      agentTimestampMs: NOW + 50,
      turnStartMs: NOW - 10_000,
    } as AcpEvent)

    await useChatStore.getState().loadHistory(SID, CWD)
    expect(toastTexts()).toEqual([])
  })

  it('已收口回合不武装检测：gap-pull 的旧 chunk 不 toast', async () => {
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: [
        envelope(
          'user_message_chunk',
          { type: 'text', text: 'go' },
          { agentTimestampMs: NOW - 10_000, turnStartMs: NOW - 10_000 },
        ),
        envelope(
          'agent_message_chunk',
          { type: 'text', text: 'done' },
          {
            agentTimestampMs: NOW - 1_000,
            streamStartMs: STREAM_START,
            turnStartMs: NOW - 10_000,
          },
        ),
        envelope(
          'turn_completed',
          {},
          { agentTimestampMs: NOW - 500, turnStartMs: NOW - 10_000 },
        ),
      ],
      promptStarts: [0],
      totalCount: 3,
      hasMore: false,
    } as never)

    await useChatStore.getState().loadHistory(SID, CWD)
    useChatStore.getState().handleEvent({
      type: 'chunk',
      text: '迟到',
      sessionId: SID,
      streamStartMs: NOW - 20_000,
      agentTimestampMs: NOW + 10,
    } as AcpEvent)
    expect(toastTexts()).toEqual([])
  })

  it('流在本次回放开始之后才开工 → 能从头接到，不 toast', async () => {
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: [
        envelope(
          'user_message_chunk',
          { type: 'text', text: 'go' },
          { agentTimestampMs: NOW - 10_000, turnStartMs: NOW - 10_000 },
        ),
      ],
      promptStarts: [0],
      totalCount: 1,
      hasMore: false,
    } as never)

    await useChatStore.getState().loadHistory(SID, CWD)
    useChatStore.getState().handleEvent({
      type: 'chunk',
      text: '首包',
      sessionId: SID,
      streamStartMs: NOW + 200,
      agentTimestampMs: NOW + 250,
      turnStartMs: NOW - 10_000,
    } as AcpEvent)
    expect(toastTexts()).toEqual([])
  })

  it('同一路只 toast 一次（后续 chunk 不再弹）', async () => {
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: [
        envelope(
          'user_message_chunk',
          { type: 'text', text: 'go' },
          { agentTimestampMs: NOW - 10_000, turnStartMs: NOW - 10_000 },
        ),
      ],
      promptStarts: [0],
      totalCount: 1,
      hasMore: false,
    } as never)

    await useChatStore.getState().loadHistory(SID, CWD)
    const live = (text: string): AcpEvent =>
      ({
        type: 'chunk',
        text,
        sessionId: SID,
        streamStartMs: STREAM_START,
        agentTimestampMs: NOW - 50,
        turnStartMs: NOW - 10_000,
      }) as AcpEvent
    useChatStore.getState().handleEvent(live('a'))
    useChatStore.getState().handleEvent(live('b'))
    expect(toastTexts()).toEqual([LIVE_STREAM_HISTORY_GAP_TOAST])
  })

  it('快照只有 thought、live 是同 streamStartMs 的 assistant → 仍 toast', async () => {
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: [
        envelope(
          'user_message_chunk',
          { type: 'text', text: 'go' },
          { agentTimestampMs: NOW - 10_000, turnStartMs: NOW - 10_000 },
        ),
        envelope(
          'agent_thought_chunk',
          { type: 'text', text: '想过了' },
          {
            agentTimestampMs: NOW - 3_000,
            streamStartMs: STREAM_START,
            turnStartMs: NOW - 10_000,
          },
        ),
      ],
      promptStarts: [0],
      totalCount: 2,
      hasMore: false,
    } as never)

    bufferHistoryWindowEvent({
      type: 'chunk',
      text: '回答后半',
      sessionId: SID,
      streamStartMs: STREAM_START,
      agentTimestampMs: NOW - 80,
      turnStartMs: NOW - 10_000,
    } as AcpEvent)

    await useChatStore.getState().loadHistory(SID, CWD)
    expect(toastTexts()).toEqual([LIVE_STREAM_HISTORY_GAP_TOAST])
  })
})
