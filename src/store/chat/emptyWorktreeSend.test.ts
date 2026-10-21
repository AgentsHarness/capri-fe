import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'
import { pushToast } from '../toast'

vi.mock('../../api/client', () => ({
  AgentTurnError: class AgentTurnError extends Error {},
  transport: {
    newSession: vi.fn(),
    gitInfo: vi.fn(),
    gitWorktreeCreate: vi.fn(),
    prompt: vi.fn(),
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

vi.mock('../toast', () => ({ pushToast: vi.fn(), dismissToast: vi.fn() }))

const NEW_SID = 's-wt-1'
const SRC = '/repo'
const WT = '/repo-wt'

/** 空状态首条消息与 worktree 的时序契约：开关只表达意图，发送才建 worktree。 */
describe('空状态首条消息建 worktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sessionId: undefined,
      cwd: undefined,
      emptyCwd: SRC,
      emptyWorktree: false,
      emptyWorktreePath: undefined,
      emptyWorktreeBusy: false,
      entries: [],
      pending: [],
      historyLoading: false,
      conn: 'ready',
    })
    vi.mocked(transport.newSession).mockResolvedValue({ sessionId: NEW_SID } as never)
    vi.mocked(transport.gitWorktreeCreate).mockResolvedValue({
      status: 'creating',
      sessionId: 'nosession-1',
      worktreePath: WT,
    } as never)
    vi.mocked(transport.prompt).mockResolvedValue(undefined as never)
  })

  afterEach(() => {
    useChatStore.getState().stopTopTaskPolling()
  })

  it('开关开启：先建 worktree，再用 worktree 路径建会话并发送', async () => {
    useChatStore.setState({ emptyWorktree: true })

    await useChatStore.getState().send('你好')

    expect(transport.gitWorktreeCreate).toHaveBeenCalledWith({
      sourcePath: SRC,
      copyMode: 'dirty',
    })
    expect(transport.newSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: WT }),
    )
    expect(useChatStore.getState().sessionId).toBe(NEW_SID)
    expect(useChatStore.getState().cwd).toBe(WT)
    expect(transport.prompt).toHaveBeenCalled()
    // 建 worktree 必须先于建会话：反过来会话会落在源目录上。
    expect(vi.mocked(transport.gitWorktreeCreate).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(transport.newSession).mock.invocationCallOrder[0]!,
    )
    expect(useChatStore.getState().emptyWorktreeBusy).toBe(false)
  })

  it('开关关闭：不碰 worktree 端点，直接用所选目录建会话', async () => {
    await useChatStore.getState().send('你好')

    expect(transport.gitWorktreeCreate).not.toHaveBeenCalled()
    expect(transport.newSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: SRC }),
    )
    expect(useChatStore.getState().cwd).toBe(SRC)
  })

  it('自定义 worktree 路径随请求带上', async () => {
    useChatStore.setState({ emptyWorktree: true, emptyWorktreePath: ' /wt/x ' })

    await useChatStore.getState().send('你好')

    expect(transport.gitWorktreeCreate).toHaveBeenCalledWith({
      sourcePath: SRC,
      worktreePath: '/wt/x',
      copyMode: 'dirty',
    })
  })

  it('建 worktree 失败：不建会话、不发送，用 toast 说明原因', async () => {
    useChatStore.setState({ emptyWorktree: true })
    vi.mocked(transport.gitWorktreeCreate).mockRejectedValue(new Error('not a git repo'))

    await useChatStore.getState().send('你好')

    expect(transport.newSession).not.toHaveBeenCalled()
    expect(transport.prompt).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith('创建 worktree 失败：not a git repo')
    expect(useChatStore.getState().emptyWorktreeBusy).toBe(false)
    // 开关留在原处：改目录或关掉后重发，不需要重新打开。
    expect(useChatStore.getState().emptyWorktree).toBe(true)
  })

  it('响应缺 worktreePath：按失败处理（不把会话落到空目录）', async () => {
    useChatStore.setState({ emptyWorktree: true })
    vi.mocked(transport.gitWorktreeCreate).mockResolvedValue({ status: 'creating' } as never)

    await useChatStore.getState().send('你好')

    expect(transport.newSession).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith(
      expect.stringContaining('响应缺少 worktree 路径'),
    )
  })

  it('建 worktree 在飞时再次发送：不重复建', async () => {
    useChatStore.setState({ emptyWorktree: true, emptyWorktreeBusy: true })

    await useChatStore.getState().send('再发一次')

    expect(transport.gitWorktreeCreate).not.toHaveBeenCalled()
    expect(transport.newSession).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith('正在创建 worktree，请稍候')
  })

  it('worktree 建好但会话没建起来：把路径留作工作目录并关开关，重发不再建第二个', async () => {
    useChatStore.setState({ emptyWorktree: true })
    vi.mocked(transport.newSession).mockRejectedValue(new Error('agent down'))

    await useChatStore.getState().send('你好')

    const err = useChatStore
      .getState()
      .entries.find((e) => e.kind === 'error') as { text: string } | undefined
    expect(err?.text).toContain('创建会话失败: agent down')
    expect(err?.text).toContain(WT)
    // 重发直接在刚建好的 worktree 里建会话，不再建新的那个。
    expect(useChatStore.getState().emptyWorktree).toBe(false)
    expect(useChatStore.getState().emptyCwd).toBe(WT)
    expect(useChatStore.getState().emptyWorktreePath).toBeUndefined()

    vi.mocked(transport.gitWorktreeCreate).mockClear()
    vi.mocked(transport.newSession).mockResolvedValue({ sessionId: NEW_SID } as never)
    await useChatStore.getState().send('你好')
    expect(transport.gitWorktreeCreate).not.toHaveBeenCalled()
    expect(transport.newSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: WT }))
  })

  it('开关开着但没选目录：交给宿主默认目录，不建 worktree', async () => {
    useChatStore.setState({ emptyCwd: undefined, emptyWorktree: true })

    await useChatStore.getState().send('你好')

    expect(transport.gitWorktreeCreate).not.toHaveBeenCalled()
    expect(transport.newSession).toHaveBeenCalledWith(expect.not.objectContaining({ cwd: SRC }))
  })
})
