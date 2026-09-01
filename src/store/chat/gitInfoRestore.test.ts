import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'

vi.mock('../../api/client', () => ({
  transport: {
    sessionResume: vi.fn(),
    gitInfo: vi.fn(),
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

const SID = 's-git-restore'
const CWD = '/repo'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const delay = <T>(ms: number, value: T) => wait(ms).then(() => value)

/**
 * 状态栏 git 分支在"回放老对话"后消失的回归。
 *
 * 分支只有两个来源：agent 的 git_head_changed（只在 HEAD 真的变了才发，
 * 空闲的老会话永远不会发）与 refreshGitInfo 轮询。continueSession 在
 * resume 返回后立即 fire refreshGitInfo（不 await），而 loadHistory 的
 * 快照复位里也清 gitInfo——host 实测 git-info ~25ms、它前面的
 * session-running-tasks ~24ms，两者同量级，轮询结果常常先落地、随后被
 * 复位抹掉，且此后无人再取。
 */
describe('会话切换后恢复状态栏 git 分支', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sessionId: SID,
      cwd: CWD,
      entries: [],
      pending: [],
      historyLoading: false,
      gitInfo: undefined,
    })
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: [],
      promptStarts: [],
      totalCount: 0,
      hasMore: false,
    } as never)
    vi.mocked(transport.queueStatus).mockResolvedValue({ queue: {} } as never)
    vi.mocked(transport.status).mockResolvedValue({} as never)
    vi.mocked(transport.sessionStats).mockResolvedValue({} as never)
    vi.mocked(transport.gitInfo).mockResolvedValue({
      branch: 'main',
      isWorktree: false,
      mainRepo: '',
    } as never)
  })

  afterEach(() => {
    useChatStore.getState().stopTopTaskPolling()
  })

  it('loadHistory 快照复位不再清掉本会话已取到的分支', async () => {
    useChatStore.setState({ gitInfo: { branch: 'main', isWorktree: false } })

    await useChatStore.getState().loadHistory(SID, CWD)

    expect(useChatStore.getState().gitInfo?.branch).toBe('main')
  })

  it('换会话先清掉上一个会话的分支（同步锚定阶段，不等任何往返）', async () => {
    let releaseResume: (() => void) | undefined
    vi.mocked(transport.sessionResume).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseResume = () => resolve({})
        }),
    )
    useChatStore.setState({ gitInfo: { branch: 'stale-branch' } })

    const loading = useChatStore.getState().continueSession('other-sid', '/other')
    // resume 尚未返回：视图已锚定到新会话，旧分支必须已经消失。
    await wait(0)
    expect(useChatStore.getState().gitInfo).toBeUndefined()

    releaseResume?.()
    await loading
  })

  it('轮询早于历史快照落地时，回放完成后仍显示分支（真实丢分支时序）', async () => {
    vi.mocked(transport.sessionResume).mockResolvedValue({} as never)
    // git-info 比紧随其后的 session-running-tasks 先回，loadHistory 的
    // 复位因此发生在轮询写入之后——正是线上丢掉分支的那条时序。
    vi.mocked(transport.gitInfo).mockImplementation(() => delay(5, { branch: 'main' }))
    vi.mocked(transport.sessionRunningTasks).mockImplementation(() =>
      delay(40, { events: [] }),
    )

    await useChatStore.getState().continueSession(SID, CWD)
    // 跨过 continueSession 的 500ms 防串话宽限窗口，模拟用户实际看到的
    // 稳定态。
    await wait(700)

    expect(useChatStore.getState().gitInfo?.branch).toBe('main')
  })
})
