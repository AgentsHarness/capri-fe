import { beforeEach, describe, expect, it, vi } from 'vitest'
import { transport } from '../../api/client'
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
