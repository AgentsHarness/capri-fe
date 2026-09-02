import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'

vi.mock('../../api/client', () => ({
  transport: {
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
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}))

const OLD_SID = 's-old'
const NEW_SID = 's-new'
const CWD = '/repo'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 状态栏 git 分支在"开新对话"后消失的回归。
 *
 * newSession 经 resetSessionState 清掉 gitInfo 后必须补拉一次：host 为
 * 新会话广播的 ready 在 POST 响应之前发出（先 Broadcast 再写响应），
 * 到达时本端尚未锚定新 sid、被 ready 守卫当"非当前会话"丢弃——之后
 * done 不触发、空闲会话不发 git_head_changed、hello 只在重连时来，
 * 分支就一直缺失。continueSession（切老会话）在锚定后补拉已修过同款
 * （gitInfoRestore.test.ts），这里对齐 newSession 路径。
 */
describe('开新对话后恢复状态栏 git 分支', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 上一会话活跃中：新会话继承其 cwd（startCwd = cwd ?? cur.cwd）。
    useChatStore.setState({
      sessionId: OLD_SID,
      cwd: CWD,
      gitInfo: { branch: 'old-branch', isWorktree: false },
      entries: [],
      pending: [],
      historyLoading: false,
    })
    vi.mocked(transport.newSession).mockResolvedValue({ sessionId: NEW_SID } as never)
    vi.mocked(transport.gitInfo).mockResolvedValue({
      branch: 'new-branch',
      isWorktree: false,
      mainRepo: '',
    } as never)
  })

  afterEach(() => {
    useChatStore.getState().stopTopTaskPolling()
  })

  it('POST 在飞窗口期旧分支已清掉（旧会话的 ⎇ 不挂在新视图上）', async () => {
    let releaseNewSession: (() => void) | undefined
    vi.mocked(transport.newSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseNewSession = () => resolve({ sessionId: NEW_SID } as never)
        }),
    )
    const creating = useChatStore.getState().newSession()
    // resetSessionState 在发起 POST 前同步清空 gitInfo。
    await wait(0)
    expect(useChatStore.getState().gitInfo).toBeUndefined()
    // 就绪前 composer 锁定标志置位；释放 POST 响应（锚定）后收口清除。
    expect(useChatStore.getState().newSessionPending).toBe(true)
    releaseNewSession?.()
    await creating
    expect(useChatStore.getState().newSessionPending).toBe(false)
    expect(useChatStore.getState().sessionId).toBe(NEW_SID)
  })

  it('POST 失败：锁定标志同样收口（不残留卡死 composer）', async () => {
    vi.mocked(transport.newSession).mockRejectedValue(new Error('boom'))
    await expect(useChatStore.getState().newSession()).rejects.toThrow('boom')
    expect(useChatStore.getState().newSessionPending).toBe(false)
  })

  it('新会话锚定后补拉 git-info，分支恢复显示', async () => {
    await useChatStore.getState().newSession()

    expect(useChatStore.getState().sessionId).toBe(NEW_SID)
    expect(useChatStore.getState().cwd).toBe(CWD)
    await wait(10)
    expect(useChatStore.getState().gitInfo?.branch).toBe('new-branch')
  })

  it('显式 cwd 的"新建会话"（侧边栏分组右键）同样补拉', async () => {
    vi.mocked(transport.gitInfo).mockResolvedValue({
      branch: 'wt-main',
      isWorktree: true,
      mainRepo: '/main',
    } as never)

    await useChatStore.getState().newSession('/other-repo')

    expect(transport.newSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/other-repo' }),
    )
    expect(useChatStore.getState().cwd).toBe('/other-repo')
    await wait(10)
    expect(useChatStore.getState().gitInfo?.branch).toBe('wt-main')
    // 轮询兜底漏判 worktree 时保留事件值——这里没有事件，按响应原样落。
    expect(useChatStore.getState().gitInfo?.isWorktree).toBe(true)
  })
})
