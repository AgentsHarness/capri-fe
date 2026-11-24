import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock, ScrollEntry } from '../../api/types'
import { transport } from '../../api/client'
import { queueRowText, usePromptQueue } from '../promptQueue'
import { adoptTurn } from './turnLifecycle'
import { useChatStore } from '../chat'
import { pushToast } from '../toast'

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/transport')>(
    '../../api/transport',
  )
  return {
    AgentTurnError: actual.AgentTurnError,
    transport: {
      prompt: vi.fn(),
      newSession: vi.fn(),
      gitInfo: vi.fn(),
      sessionResume: vi.fn(),
      sessionStats: vi.fn(),
      sessionRunningTasks: vi.fn(),
      loadSessionHistory: vi.fn(),
      goalStatus: vi.fn().mockResolvedValue({ goal: null }),
      queueStatus: vi.fn(),
      status: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      getConnectionMode: vi.fn(() => 'local'),
      lastLiveEventAt: vi.fn(() => undefined),
    },
  }
})

vi.mock('../toast', () => ({
  pushToast: vi.fn(),
  dismissToast: vi.fn(),
}))

describe('sendPrompt 切换会话守卫', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sessionId: 'sess-test-1',
      cwd: '/workspace',
      entries: [],
      pending: [],
      historyLoading: false,
      conn: 'ready',
    })
  })

  it('正在切换会话（historyLoading 为 true）时阻止发送并弹出 toast 提示', async () => {
    useChatStore.setState({ historyLoading: true })

    await useChatStore.getState().send('hello world')

    expect(pushToast).toHaveBeenCalledWith('正在切换会话，请稍候再发送')
    expect(transport.prompt).not.toHaveBeenCalled()
  })

  it('非切换会话中（historyLoading 为 false）时正常发送 prompt', async () => {
    vi.mocked(transport.prompt).mockResolvedValue(undefined as never)

    await useChatStore.getState().send('hello world')

    expect(pushToast).not.toHaveBeenCalled()
    expect(transport.prompt).toHaveBeenCalled()
  })
})

describe('无会话发送：建会话与 prompt 复用同一次操作身份', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sessionId: undefined,
      cwd: undefined,
      emptyCwd: undefined,
      emptyWorktree: false,
      emptyWorktreeBusy: false,
      entries: [],
      pending: [],
      historyLoading: false,
      conn: 'ready',
      turnStartedAt: undefined,
      pendingOptimisticUserId: undefined,
      openAssistantId: undefined,
      openThoughtId: undefined,
    })
    vi.mocked(transport.newSession).mockResolvedValue({ sessionId: 'sess-new' } as never)
    vi.mocked(transport.prompt).mockResolvedValue(undefined as never)
  })

  it('newSession 用 promptId:session，prompt 用同一个 promptId', async () => {
    await useChatStore.getState().send('第一条消息')

    const nsOpts = vi.mocked(transport.newSession).mock.calls[0]?.[0] as
      | { idempotencyKey?: string }
      | undefined
    const promptOpts = vi.mocked(transport.prompt).mock.calls[0]?.[1] as
      | { promptId?: string; sessionId?: string }
      | undefined

    expect(promptOpts?.promptId).toEqual(expect.any(String))
    expect(promptOpts?.sessionId).toBe('sess-new')
    expect(nsOpts?.idempotencyKey).toBe(`${promptOpts?.promptId}:session`)
  })

  it('重发沿用同一个 promptId（以及同一个 newSession 键）', async () => {
    const { AgentTurnError } = await import('../../api/transport')
    vi.mocked(transport.prompt).mockRejectedValueOnce(
      new AgentTurnError('unreachable', 'host 离线', 503),
    )
    await useChatStore.getState().send('会失败的一条')

    const promptId = useChatStore.getState().currentPromptId
    expect(promptId).toEqual(expect.any(String))
    expect(useChatStore.getState().resendUndeliveredPrompt()).toBe(true)
    await vi.waitFor(() => {
      expect(vi.mocked(transport.prompt)).toHaveBeenCalledTimes(2)
    })

    expect(vi.mocked(transport.prompt).mock.calls[1]?.[1]).toMatchObject({ promptId })
    expect(vi.mocked(transport.newSession).mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: `${promptId}:session`,
    })
  })
})

describe('忙时入队复用调用方 promptId', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePromptQueue.setState({
      queues: {},
      queue: [],
      sending: false,
      drainedIds: new Set(),
      deletedRows: new Map(),
      editIndex: null,
      editDraft: '',
      editImages: [],
      sessionId: undefined,
    })
    useChatStore.setState({
      sessionId: 'sess-busy',
      cwd: '/workspace',
      conn: 'busy',
      turnStartedAt: Date.now(),
      historyLoading: false,
      entries: [],
      pending: [],
      pendingOptimisticUserId: undefined,
      openAssistantId: undefined,
      openThoughtId: undefined,
    })
    vi.mocked(transport.prompt).mockResolvedValue(undefined as never)
  })

  it('重发送的 promptId 成为队列行 id 与 wire promptId（不换幂等键）', async () => {
    await useChatStore.getState().send('忙时重发', undefined, { promptId: 'pid-resend' })

    const q = usePromptQueue.getState().queue
    expect(q).toHaveLength(1)
    expect(q[0]?.id).toBe('pid-resend')
    expect(transport.prompt).toHaveBeenCalledWith(
      [{ type: 'text', text: '忙时重发' }],
      { sessionId: 'sess-busy', promptId: 'pid-resend' },
    )
  })
})

describe('纯图片 prompt（正文为空，图片只在 blocks 里）', () => {
  const IMG = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
  const IMG2 = { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }
  const textless = (extra: ContentBlock[]) => [{ type: 'text', text: '' }, ...extra] as ContentBlock[]

  beforeEach(() => {
    vi.clearAllMocks()
    usePromptQueue.setState({
      queues: {},
      queue: [],
      sending: false,
      drainedIds: new Set(),
      deletedRows: new Map(),
      editIndex: null,
      editDraft: '',
      sessionId: undefined,
    })
    useChatStore.setState({
      sessionId: 'sess-test-1',
      cwd: '/workspace',
      entries: [],
      pending: [],
      historyLoading: false,
      conn: 'ready',
      turnStartedAt: undefined,
      openAssistantId: undefined,
      openThoughtId: undefined,
      pendingOptimisticUserId: undefined,
    })
    vi.mocked(transport.prompt).mockResolvedValue(undefined as never)
  })

  it('空闲直发：用户行用 [image] 标记兜底，wire 仍是真 blocks', async () => {
    await useChatStore.getState().send('', textless([IMG]))

    const user = useChatStore
      .getState()
      .entries.find((e) => e.kind === 'user') as Extract<ScrollEntry, { kind: 'user' }>
    expect(user?.text).toBe('[image]')
    // 标记只是显示层：发给 agent 的正文块保持空串，图另走 image block。
    expect(transport.prompt).toHaveBeenCalledWith(
      textless([IMG]),
      expect.objectContaining({ sessionId: 'sess-test-1' }),
    )
  })

  it('忙时入队：行正文留空 + 图片 blocks，队列行按标记展示', async () => {
    useChatStore.setState({ conn: 'busy', turnStartedAt: Date.now() })

    await useChatStore.getState().send('', textless([IMG, IMG2]))

    const q = usePromptQueue.getState().queue
    expect(q).toHaveLength(1)
    expect(q[0]?.text).toBe('')
    expect(queueRowText(q[0]!)).toBe('[image 1] [image 2]')
    // 排队消息不进 transcript（由队列条展示）。
    expect(useChatStore.getState().entries).toEqual([])
  })

  it('出队收养：纯图片行的用户行带 [image N] 标记', () => {
    adoptTurn(
      useChatStore.setState as never,
      useChatStore.getState,
      { id: 'p1', text: '', blocks: textless([IMG, IMG2]) },
    )

    const user = useChatStore
      .getState()
      .entries.find((e) => e.kind === 'user') as Extract<ScrollEntry, { kind: 'user' }>
    expect(user?.text).toBe('[image 1] [image 2]')
  })
})
