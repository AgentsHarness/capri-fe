import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpEvent } from '../../api/types'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'
import {
  bufferHistoryWindowEvent,
  clearHistoryWindowBuffer,
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
 * 刷新去重回归：刷新时 hub 缓冲回放的 live 事件（细粒度 chunk、毫秒
 * agentTimestampMs）与快照 envelope（shell 聚合后的整段文本、秒级写盘
 * 戳 + 毫秒 _meta.agentTimestampMs）语义键永不相等，去重只能靠
 * snapTail 时间戳兜底。兜底边界必须与 live 事件同尺度（毫秒 _meta），
 * 用秒级写盘戳会把最新 envelope 覆盖的最后 ~1 秒内容漏过去重 → 重放 →
 * 最后一条 assistant 文本重复。
 */
describe('loadHistory 窗口缓冲去重（snapTail 毫秒边界）', () => {
  const SID = 's1'
  const CWD = '/w'
  // 批内最后 chunk 的毫秒时间戳；envelope 写盘戳是秒级取整。
  const T = 1_700_000_001_500
  const coarseSec = Math.floor(T / 1000)

  const envelope = (
    sessionUpdate: string,
    content: unknown,
    meta: Record<string, number>,
    timestamp = coarseSec,
  ) => ({
    timestamp,
    method: 'session/update',
    params: {
      sessionId: SID,
      update: { sessionUpdate, content },
      _meta: meta,
    },
  })

  afterEach(() => {
    useChatStore.setState({ entries: [], sessionId: undefined, cwd: undefined })
  })
  beforeEach(() => {
    clearHistoryWindowBuffer()
    useChatStore.setState({
      // 真实流程：hello / continueSession 先锚定 sessionId 再 loadHistory，
      // staleLoad 校验依赖这个锚。
      sessionId: SID,
      cwd: CWD,
      entries: [],
      pending: [],
      historyLoading: false,
    })
  })

  it('与快照同秒的细粒度 chunk 不再重放（旧代码会重复最后一条 assistant）', async () => {
    const snap = [
      envelope(
        'user_message_chunk',
        { type: 'text', text: 'hello' },
        { agentTimestampMs: T - 2000, turnStartMs: T - 2000 },
      ),
      envelope(
        'agent_thought_chunk',
        { type: 'text', text: 'thinking…' },
        {
          agentTimestampMs: T - 1000,
          streamStartMs: T - 2000,
          turnStartMs: T - 2000,
        },
      ),
      // 快照里是聚合后的整段文本；meta 毫秒戳 = 批内最后 chunk 的时间。
      envelope(
        'agent_message_chunk',
        { type: 'text', text: '聚合回复内容 TEXT' },
        { agentTimestampMs: T, streamStartMs: T - 1000, turnStartMs: T - 2000 },
      ),
    ]
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: snap,
      promptStarts: [0],
      totalCount: snap.length,
      hasMore: false,
    } as never)

    // hub 缓冲回放的细粒度 chunk：文本边界与聚合 envelope 不同（键必不
    // 相等），毫秒戳落在最新 envelope 的秒级写盘戳之后——旧代码用秒级
    // snapTail 无法覆盖，这两条会被再次回放，把 '聚合回复内容 TEXT' 追加
    // 成 '聚合回复内容 TEXT聚合回复内容TEXT'。
    bufferHistoryWindowEvent({
      type: 'chunk',
      text: '聚合回复内容',
      agentTimestampMs: T - 300,
      streamStartMs: T - 1000,
      turnStartMs: T - 2000,
      sessionId: SID,
    } as AcpEvent)
    bufferHistoryWindowEvent({
      type: 'chunk',
      text: 'TEXT',
      agentTimestampMs: T,
      streamStartMs: T - 1000,
      turnStartMs: T - 2000,
      sessionId: SID,
    } as AcpEvent)

    await useChatStore.getState().loadHistory(SID, CWD)

    const assistant = useChatStore
      .getState()
      .entries.find((e) => e.kind === 'assistant')
    expect(assistant?.kind).toBe('assistant')
    expect((assistant as { text?: string }).text).toBe('聚合回复内容 TEXT')
  })

  it('快照之后真正的新 chunk（毫秒戳 > snapTail）照常回放追加', async () => {
    const snap = [
      envelope(
        'user_message_chunk',
        { type: 'text', text: 'hello' },
        { agentTimestampMs: T - 2000, turnStartMs: T - 2000 },
      ),
      envelope(
        'agent_message_chunk',
        { type: 'text', text: '聚合回复内容 TEXT' },
        { agentTimestampMs: T, streamStartMs: T - 1000, turnStartMs: T - 2000 },
      ),
    ]
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: snap,
      promptStarts: [0],
      totalCount: snap.length,
      hasMore: false,
    } as never)

    // 快照 fetch 之后才产生的内容：毫秒戳晚于快照内任何 envelope，
    // 必须回放（否则丢失真实续流文本）。
    bufferHistoryWindowEvent({
      type: 'chunk',
      text: '新内容',
      agentTimestampMs: T + 500,
      streamStartMs: T - 1000,
      turnStartMs: T - 2000,
      sessionId: SID,
    } as AcpEvent)

    await useChatStore.getState().loadHistory(SID, CWD)
    // 回放追加走 rAF 合帧缓冲（appendStreamBuf）→ liveStream（流式
    // 渲染层），entry.text 要等回合收口（flushLiveStream）才并入——
    // 断言必须看合并视图：entry.text + 挂在本条目上的 liveStream.text。
    await new Promise((r) => requestAnimationFrame(r))

    const s = useChatStore.getState()
    const assistant = s.entries.find((e) => e.kind === 'assistant')
    const streamed =
      s.liveStream != null && s.liveStream.entryId === assistant?.id
        ? s.liveStream.text
        : ''
    expect((assistant as { text?: string }).text + streamed).toBe(
      '聚合回复内容 TEXT新内容',
    )
  })

  it('无 _meta 的旧日志回退秒级写盘戳，边界仍可用', async () => {
    const snap = [
      {
        timestamp: coarseSec,
        method: 'session/update',
        params: {
          sessionId: SID,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '旧日志回复' },
          },
        },
      },
      {
        timestamp: coarseSec,
        method: 'session/update',
        params: {
          sessionId: SID,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'hello' },
          },
        },
      },
    ]
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: snap,
      promptStarts: [0],
      totalCount: snap.length,
      hasMore: false,
    } as never)

    bufferHistoryWindowEvent({
      type: 'chunk',
      text: '旧日志回复',
      agentTimestampMs: T - 400, // ≤ 秒级戳（毫秒化），回退边界足以去重
      sessionId: SID,
    } as AcpEvent)

    await useChatStore.getState().loadHistory(SID, CWD)

    const assistant = useChatStore
      .getState()
      .entries.find((e) => e.kind === 'assistant')
    expect((assistant as { text?: string }).text).toBe('旧日志回复')
  })

  it('historyLoading 落回 false 后，gap-pull 的同回合 live 事件不再追加最后一条', async () => {
    const snap = [
      envelope(
        'user_message_chunk',
        { type: 'text', text: 'hello' },
        { agentTimestampMs: T - 2000, turnStartMs: T - 2000 },
      ),
      envelope(
        'agent_message_chunk',
        { type: 'text', text: '最终回复' },
        { agentTimestampMs: T, streamStartMs: T - 1000, turnStartMs: T - 2000 },
      ),
      envelope(
        'turn_completed',
        {},
        { agentTimestampMs: T + 50, turnStartMs: T - 2000 },
      ),
    ]
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: snap,
      promptStarts: [0],
      totalCount: snap.length,
      hasMore: false,
    } as never)

    await useChatStore.getState().loadHistory(SID, CWD)

    const before = useChatStore.getState().entries.filter((e) => e.kind === 'assistant')
    expect(before).toHaveLength(1)
    expect((before[0] as { text?: string }).text).toBe('最终回复')

    // 刷新路径：hello → loadHistory 完成后 hub gap-pull 把上一轮 live
    // 事件再投一遍（带 sessionId，historyLoading 已是 false）。
    useChatStore.getState().handleEvent({
      type: 'user_chunk',
      text: 'hello',
      agentTimestampMs: T - 2000,
      sessionId: SID,
    } as AcpEvent)
    useChatStore.getState().handleEvent({
      type: 'chunk',
      text: '最终回复',
      agentTimestampMs: T,
      streamStartMs: T - 1000,
      turnStartMs: T - 2000,
      sessionId: SID,
    } as AcpEvent)

    const users = useChatStore.getState().entries.filter((e) => e.kind === 'user')
    const assistants = useChatStore
      .getState()
      .entries.filter((e) => e.kind === 'assistant')
    expect(users).toHaveLength(1)
    expect(assistants).toHaveLength(1)
    expect((assistants[0] as { text?: string }).text).toBe('最终回复')
  })
}
)