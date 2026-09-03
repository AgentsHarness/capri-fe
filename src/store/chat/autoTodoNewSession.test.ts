import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'
import { usePins } from '../historyPins'

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
    prefsOrigin: vi.fn(() => ''),
    getPrefs: vi.fn(),
    putPrefs: vi.fn(),
    prompt: vi.fn(),
  },
}))

const NEW_SID = 's-new-1'
const CWD = '/test-repo'

describe('发起新对话自动设置为待办', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sessionId: undefined,
      cwd: CWD,
      entries: [],
      pending: [],
      historyLoading: false,
    })
    usePins.setState({
      entries: {},
      pinnedWorkspaces: new Set<string>(),
      pinnedSessions: new Set<string>(),
      todos: {},
      fePrefs: { collapseToolGroups: true, liteReplay: false, autoTodoNewSession: false },
    })
    vi.mocked(transport.newSession).mockResolvedValue({ sessionId: NEW_SID } as never)
    vi.mocked(transport.gitInfo).mockResolvedValue({
      branch: 'main',
      isWorktree: false,
      mainRepo: '',
    } as never)
  })

  afterEach(() => {
    useChatStore.getState().stopTopTaskPolling()
  })

  it('默认关闭（autoTodoNewSession: false）：newSession 不设为待办', async () => {
    expect(usePins.getState().fePrefs.autoTodoNewSession).toBe(false)
    const sid = await useChatStore.getState().newSession(CWD)
    expect(sid).toBe(NEW_SID)
    expect(usePins.getState().todos[NEW_SID]).toBeUndefined()
  })

  it('开启（autoTodoNewSession: true）：newSession 自动将新会话标记为待办', async () => {
    usePins.getState().setFePrefs({ autoTodoNewSession: true })
    expect(usePins.getState().fePrefs.autoTodoNewSession).toBe(true)

    const sid = await useChatStore.getState().newSession(CWD)
    expect(sid).toBe(NEW_SID)
    expect(usePins.getState().todos[NEW_SID]).toBe('todo')
  })

  it('关闭后不再自动设为待办', async () => {
    usePins.getState().setFePrefs({ autoTodoNewSession: true })
    usePins.getState().setFePrefs({ autoTodoNewSession: false })

    const sid = await useChatStore.getState().newSession(CWD)
    expect(sid).toBe(NEW_SID)
    expect(usePins.getState().todos[NEW_SID]).toBeUndefined()
  })

  it('newSession 失败时不会误标记待办', async () => {
    usePins.getState().setFePrefs({ autoTodoNewSession: true })
    vi.mocked(transport.newSession).mockRejectedValue(new Error('failed'))

    await expect(useChatStore.getState().newSession(CWD)).rejects.toThrow('failed')
    expect(usePins.getState().todos[NEW_SID]).toBeUndefined()
  })

  it('空状态发送消息（send）自动开启新会话时也会自动设为待办', async () => {
    usePins.getState().setFePrefs({ autoTodoNewSession: true })
    useChatStore.setState({ sessionId: undefined, emptyCwd: CWD })
    vi.mocked(transport.prompt).mockResolvedValue(undefined as never)

    await useChatStore.getState().send('hello world')

    expect(transport.newSession).toHaveBeenCalled()
    expect(useChatStore.getState().sessionId).toBe(NEW_SID)
    expect(usePins.getState().todos[NEW_SID]).toBe('todo')
  })
})
