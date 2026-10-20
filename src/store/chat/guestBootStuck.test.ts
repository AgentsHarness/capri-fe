import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GuestIdentity } from '../../api/types'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'
import { clearHistoryWindowBuffer } from './globals'
import { setGuestActive } from './guestMode'

/**
 * 访客（只读分享）首屏：滚动区停在「加载会话…」。
 *
 * 现场证据（线上部署，经 hub 中继的访客分享链接）：
 *  - /api/session-updates?host=<host>&session=… 返回 200 + 完整 updates；
 *  - 页面仍显示加载覆盖层，说明 historyLoading 没有落回 false。
 *
 * 启动链是 GuestShell → switchGuestSession，它先 resetSessionState（推进
 * sessionSwitchGen，清 sessionId/cwd），再调 loadHistoryWithTaskProbe。
 * loadHistory 的 staleLoad 比对的是「调用前捕获的 scope」：scope 里
 * sessionId/cwd 由调用方显式传入，但 selectedHostId/hostId 取的是当时
 * store 里的值；而 switchGuestSession 在 loadHistory 发起之后才写
 * selectedHostId（transport.sendGuestSubscribe 只改 transport）。
 * 于是回放落地前的每一次 staleLoad 都判为失效 → 提前 return，而
 * `historyLoading` 只在成功/失败两处收口，这条早退路径什么也不写。
 */
vi.mock('../../api/client', () => ({
  transport: {
    sendGuestSubscribe: vi.fn(),
    guestSessions: vi.fn(async () => []),
    exitGuestMode: vi.fn(),
    getConnectionMode: vi.fn(() => 'hub'),
    getHost: vi.fn(() => 'h1'),
    newSession: vi.fn(),
    sendPrompt: vi.fn(),
    cancel: vi.fn(),
    forkSession: vi.fn(),
    setHost: vi.fn(),
    setMode: vi.fn(),
    setModel: vi.fn(),
    syncMcpServers: vi.fn(),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    workspaceListRecent: vi.fn(async () => ({ groups: [], count: 0 })),
    prefsOrigin: vi.fn(() => ''),
    isGuest: vi.fn(() => true),
    isLocalDirect: vi.fn(() => false),
    emitLocal: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    loadSessionHistory: vi.fn(),
    sessionRunningTasks: vi.fn(),
    listTasks: vi.fn(),
    queueStatus: vi.fn(),
    status: vi.fn(),
  },
}))

const SID = 's-guest-1'
const CWD = '/tmp/work'
const HOST = 'host-a'

const identity: GuestIdentity = {
  role: 'guest',
  guest: { id: 'g_1', label: 'guest-a', expiresAt: 0 },
  sessions: [{ hostId: HOST, hostName: 'Host A', sessionId: SID, cwd: CWD }],
}

const snapshot = () => ({
  updates: [
    {
      timestamp: 1_792_484_423,
      method: 'session/update',
      msgSeq: 1,
      params: {
        sessionId: SID,
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: '问题' },
        },
        _meta: { agentTimestampMs: 1_792_484_423_640 },
      },
    },
  ],
  promptStarts: [1],
  totalCount: 1,
  hasMore: false,
})

describe('访客首屏', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearHistoryWindowBuffer()
    setGuestActive(true)
    vi.mocked(transport.loadSessionHistory).mockResolvedValue(snapshot() as never)
    vi.mocked(transport.sessionRunningTasks).mockResolvedValue({ events: [] } as never)
    vi.mocked(transport.listTasks).mockResolvedValue([] as never)
    vi.mocked(transport.queueStatus).mockResolvedValue({ queue: [] } as never)
    vi.mocked(transport.status).mockResolvedValue({
      ready: true,
      busy: false,
      sessionId: SID,
      cwd: CWD,
      hostId: HOST,
      hostName: 'Host A',
    } as never)
    useChatStore.setState({
      mode: 'hub',
      guestIdentity: identity,
      guestSessions: identity.sessions,
      // 访客壳挂载时 store 里还没有任何 host 锚点——这就是现场的起点。
      selectedHostId: undefined,
      hostId: undefined,
      hosts: [],
    } as never)
  })

  it('switchGuestSession 落地后滚动区离开加载态', async () => {
    await useChatStore.getState().switchGuestSession(identity.sessions[0])

    const s = useChatStore.getState()
    expect(s.historyLoading).toBe(false)
    expect(s.entries.length).toBeGreaterThan(0)
    expect(s.sessionId).toBe(SID)
  })

  it('resetSessionState 推进代际不会让本次加载无声作废', async () => {
    await useChatStore.getState().switchGuestSession(identity.sessions[0])
    expect(useChatStore.getState().historyLoadError).toBeUndefined()
    expect(useChatStore.getState().historyLoading).toBe(false)
  })

  it('加载期间 hub hello 回填 hostId 不能让快照作废并卡在加载态', async () => {
    let finish!: (v: unknown) => void
    vi.mocked(transport.loadSessionHistory).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }) as never,
    )

    const p = useChatStore.getState().switchGuestSession(identity.sessions[0])
    // 回放还在飞：hub 的连接型 hello 到达 → refreshHosts 快照 → 访客分支
    // 把 hostId / selectedHostId 从 undefined 填成白名单里的 host。
    useChatStore.getState().handleEvent({
      type: 'hello',
      service: 'hub',
      hosts: [{ hostId: HOST, hostName: 'Host A', online: true }],
      defaultHostId: HOST,
    } as never)
    await Promise.resolve()
    expect(useChatStore.getState().hostId).toBe(HOST)

    finish(snapshot())
    await p

    const s = useChatStore.getState()
    expect(s.historyLoading).toBe(false)
    expect(s.entries.length).toBeGreaterThan(0)
  })

  it('旧加载早退不清新一次加载的加载位', async () => {
    const resolveOld: ((v: unknown) => void)[] = []
    vi.mocked(transport.loadSessionHistory).mockImplementation((() => {
      return new Promise((resolve) => {
        resolveOld.push(resolve)
      })
    }) as never)

    // 第一次加载：让它停在在途。
    const first = useChatStore.getState().loadHistory(SID, CWD)
    await Promise.resolve()
    expect(resolveOld).toHaveLength(1)

    // 切到另一会话（resetSessionState 推进代际）→ 第一次加载作废。
    useChatStore.setState({ sessionId: 's-other', cwd: '/other', historyLoading: false } as never)
    const second = useChatStore.getState().loadHistory('s-other', '/other')
    await Promise.resolve()
    expect(resolveOld).toHaveLength(2)
    expect(useChatStore.getState().historyLoading).toBe(true)

    // 旧请求此刻才回来：它的 abandon 不能把第二次加载的加载位清掉。
    resolveOld[0](snapshot())
    await first
    expect(useChatStore.getState().historyLoading).toBe(true)

    resolveOld[1](snapshot())
    await second
    expect(useChatStore.getState().historyLoading).toBe(false)
  })
})
