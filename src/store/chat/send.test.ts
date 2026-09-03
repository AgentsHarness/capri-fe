import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock, ScrollEntry } from '../../api/types'
import { transport } from '../../api/client'
import { queueRowText, usePromptQueue } from '../promptQueue'
import { adoptTurn } from './turnLifecycle'
import { useChatStore } from '../chat'
import { pushToast } from '../toast'

vi.mock('../../api/client', () => ({
  transport: {
    prompt: vi.fn(),
    newSession: vi.fn(),
    gitInfo: vi.fn(),
    sessionResume: vi.fn(),
    sessionStats: vi.fn(),
    sessionRunningTasks: vi.fn(),
    loadSessionHistory: vi.fn(),
    queueStatus: vi.fn(),
    status: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    getConnectionMode: vi.fn(() => 'local'),
    lastLiveEventAt: vi.fn(() => undefined),
  },
}))

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
