import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatState, SetState } from '../types'
import type { GuestIdentity } from '../../../api/types'

vi.mock('../../../api/client', () => ({
  transport: {
    sendGuestSubscribe: vi.fn(),
    guestSessions: vi.fn(async () => []),
    exitGuestMode: vi.fn(),
    setGuestMode: vi.fn(),
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
    prefsOrigin: vi.fn(() => 'https://hub.example'),
    isGuest: vi.fn(() => true),
    status: vi.fn(async () => ({
      ready: true,
      busy: false,
      sessionId: 's2',
      cwd: '/w2',
      hostId: 'h2',
      hostName: 'H2',
    })),
    emitLocal: vi.fn(),
    // historyPins 在模块加载期注册 hub_conn/prefs_changed 监听。
    onEvent: vi.fn(() => () => {}),
  },
}))

vi.mock('../../toast', () => ({ pushToast: vi.fn() }))

vi.mock('../loadHistory', () => ({
  loadHistoryWithTaskProbe: vi.fn(async () => {}),
}))

import { transport } from '../../../api/client'
import { pushToast } from '../../toast'
import { loadHistoryWithTaskProbe } from '../loadHistory'
import { guestActions } from './guest'
import { blockGuestWrite, isGuestActive } from '../guestMode'
import { hostActions } from './hosts'
import { sessionActions } from './session'
import { xaiActions } from './xai'

const identity: GuestIdentity = {
  role: 'guest',
  guest: { id: 'g_1', label: '给小王', expiresAt: 0 },
  sessions: [
    { hostId: 'h1', hostName: 'H1', sessionId: 's1', cwd: '/w1', title: 'one' },
    { hostId: 'h2', hostName: 'H2', sessionId: 's2', cwd: '/w2', title: 'two' },
  ],
}

function state(patch: Partial<ChatState> = {}): ChatState {
  return {
    conn: 'ready',
    statusText: '就绪',
    mode: 'hub',
    hosts: [],
    guestIdentity: identity,
    guestSessions: identity.sessions,
    entries: [],
    pending: [],
    xaiRequests: [],
    ...patch,
  } as unknown as ChatState
}

function bind(s: ChatState) {
  const set: SetState = (partial) => {
    const patch = typeof partial === 'function' ? partial(s) : partial
    Object.assign(s, patch)
  }
  return set
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('访客守卫', () => {
  it('blockGuestWrite 拦下并给一次只读提示', () => {
    expect(blockGuestWrite({ guestIdentity: identity })).toBe(true)
    expect(pushToast).toHaveBeenCalledWith('访客模式为只读', {
      id: 'guest-readonly',
      type: 'info',
    })
    // 管理员不拦、不提示
    vi.mocked(pushToast).mockClear()
    expect(blockGuestWrite({ guestIdentity: undefined })).toBe(false)
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('send / newSession / forkSession 在访客下不触发传输层', async () => {
    const s = state()
    const set = bind(s)
    // send 走真实 sendPrompt 会带一堆依赖；这里验的是入口守卫：先调
    // blockGuestWrite，未通过时直接返回。
    expect(blockGuestWrite(s)).toBe(true)
    await sessionActions(set, () => s).newSession?.('/w1')
    await xaiActions(set, () => s).forkSession?.({})
    expect(transport.newSession).not.toHaveBeenCalled()
    expect(transport.forkSession).not.toHaveBeenCalled()
  })

  it('switchHost 在访客下被拦（host 由白名单会话决定）', async () => {
    const s = state({ selectedHostId: 'h1' })
    const set = bind(s)
    await hostActions(set, () => s).switchHost?.('h2')
    expect(transport.setHost).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith('访客模式下请切换会话', {
      id: 'guest-readonly',
      type: 'info',
    })
  })

  it('refreshSessions / refreshWorkspaces 在访客下跳过（访客读白名单）', async () => {
    const s = state()
    const set = bind(s)
    const actions = sessionActions(set, () => s)
    await actions.refreshSessions?.()
    await actions.refreshWorkspaces?.()
    expect(transport.listSessions).not.toHaveBeenCalled()
    expect(transport.workspaceListRecent).not.toHaveBeenCalled()
  })

  it('refreshHosts：白名单 host 掉线写 hub 层提示，恢复后清掉', async () => {
    const s = state({ sessionId: 's1', cwd: '/w1', layerErrors: {} })
    const set = bind(s)
    const actions = hostActions(set, () => ({
      ...s,
      setLayerError: (layer, err) => {
        s.layerErrors = { ...s.layerErrors, [layer]: err }
      },
    }))
    await actions.refreshHosts?.({
      hosts: [
        { hostId: 'h1', hostName: 'H1', online: false },
        { hostId: 'h2', hostName: 'H2', online: true },
      ],
    })
    expect(s.layerErrors.hub?.id).toBe('host-offline')
    expect(s.layerErrors.hub?.message).toContain('H1')

    await actions.refreshHosts?.({
      hosts: [{ hostId: 'h1', hostName: 'H1', online: true }],
    })
    expect(s.layerErrors.hub).toBeUndefined()
  })
})

describe('switchGuestSession', () => {
  it('setHost + subscribe(host, session) + loadHistory，且不发 session/load', async () => {
    const s = state({ sessionId: 's1', cwd: '/w1' })
    const set = bind(s)
    // continueSession 会发 session/load（写操作）——访客路径绝不能碰它。
    const continueSession = vi.fn()
    Object.assign(s, { continueSession })
    await guestActions(set, () => s).switchGuestSession(identity.sessions[1])

    expect(transport.sendGuestSubscribe).toHaveBeenCalledWith('h2', 's2')
    expect(loadHistoryWithTaskProbe).toHaveBeenCalledWith(expect.any(Function), 's2', '/w2')
    expect(continueSession).not.toHaveBeenCalled()
    // 视图锚到新会话，状态行如实标注只读
    expect(s.sessionId).toBe('s2')
    expect(s.cwd).toBe('/w2')
    expect(s.statusText).toBe('只读 · 历史')
    expect(s.selectedHostId).toBe('h2')
    // 状态快照走既有的 ready 路径（不触发 session/load），并钉到切换后的会话
    expect(transport.status).toHaveBeenCalled()
    const ready = vi.mocked(transport.emitLocal).mock.calls[0][0] as Record<string, unknown>
    expect(ready).toMatchObject({
      type: 'ready',
      sessionId: 's2',
      cwd: '/w2',
      hostId: 'h2',
      hostName: 'H2',
    })
  })

  it('同一 host 内切换只换会话，不清整台 host', async () => {
    const s = state({ sessionId: 's1', cwd: '/w1', selectedHostId: 'h1' })
    const set = bind(s)
    s.guestSessions = [
      identity.sessions[0],
      { hostId: 'h1', hostName: 'H1', sessionId: 's1b', cwd: '/w1b', title: 'sibling' },
    ]
    await guestActions(set, () => s).switchGuestSession(s.guestSessions[1])
    expect(transport.sendGuestSubscribe).toHaveBeenCalledWith('h1', 's1b')
    expect(s.sessionId).toBe('s1b')
  })

  it('非访客调用是空操作', async () => {
    const s = state({ guestIdentity: undefined })
    const set = bind(s)
    await guestActions(set, () => s).switchGuestSession(identity.sessions[0])
    expect(transport.sendGuestSubscribe).not.toHaveBeenCalled()
    expect(loadHistoryWithTaskProbe).not.toHaveBeenCalled()
  })
})

describe('guestSessionState（只读状态）', () => {
  it('只认本会话的状态：status 报的是别的会话 → 不写', async () => {
    const s = state({ sessionId: 's1' })
    const set = bind(s)
    vi.mocked(transport.status).mockResolvedValueOnce({
      sessionId: 'someone-else',
      sessionState: 'awaiting',
      busy: true,
      awaitingInput: true,
      pendingInput: { kind: 'permission', count: 1, receivedAt: 100 },
    } as never)
    await guestActions(set, () => s).refreshGuestStatus('s1')
    expect(s.guestSessionState).toBeUndefined()
  })

  it('老 hub 没有 sessionState → 清空，不沿用上一次读数', async () => {
    const s = state({
      sessionId: 's1',
      guestSessionState: {
        sessionState: 'awaiting',
        busy: true,
        awaitingInput: true,
        pendingInput: { kind: 'permission', count: 1 },
      },
    })
    const set = bind(s)
    vi.mocked(transport.status).mockResolvedValueOnce({ sessionId: 's1', busy: true } as never)
    await guestActions(set, () => s).refreshGuestStatus('s1')
    expect(s.guestSessionState).toBeUndefined()
  })

  it('pendingInput 只带 kind/count/receivedAt（不透传 method/requestId 之类）', async () => {
    const s = state({ sessionId: 's1' })
    const set = bind(s)
    vi.mocked(transport.status).mockResolvedValueOnce({
      sessionId: 's1',
      sessionState: 'awaiting',
      busy: true,
      awaitingInput: true,
      pendingInput: { kind: 'question', count: 2, receivedAt: 1_700_000_000_000 },
    } as never)
    await guestActions(set, () => s).refreshGuestStatus('s1')
    expect(s.guestSessionState).toEqual({
      sessionState: 'awaiting',
      busy: true,
      awaitingInput: true,
      pendingInput: { kind: 'question', count: 2, receivedAt: 1_700_000_000_000 },
    })
  })

  it('倒计时起点缺省时仍然报出等待（老 host 没有 receivedAt）', async () => {
    const s = state({ sessionId: 's1' })
    const set = bind(s)
    vi.mocked(transport.status).mockResolvedValueOnce({
      sessionId: 's1',
      sessionState: 'awaiting',
      busy: true,
      awaitingInput: true,
      pendingInput: { kind: 'permission', count: 1 },
    } as never)
    await guestActions(set, () => s).refreshGuestStatus('s1')
    expect(s.guestSessionState?.pendingInput).toEqual({ kind: 'permission', count: 1 })
  })

  it('count 为 0 的 pendingInput 不算等待', async () => {
    const s = state({ sessionId: 's1' })
    const set = bind(s)
    vi.mocked(transport.status).mockResolvedValueOnce({
      sessionId: 's1',
      sessionState: 'idle',
      busy: false,
      awaitingInput: false,
      pendingInput: { kind: 'permission', count: 0 },
    } as never)
    await guestActions(set, () => s).refreshGuestStatus('s1')
    expect(s.guestSessionState).toEqual({
      sessionState: 'idle',
      busy: false,
      awaitingInput: false,
    })
  })

  it('切会话时状态跟着新会话走（旧会话的 awaiting 不能留下）', async () => {
    const s = state({
      sessionId: 's1',
      guestSessionState: {
        sessionState: 'awaiting',
        busy: true,
        awaitingInput: true,
        pendingInput: { kind: 'permission', count: 1 },
      },
    })
    const set = bind(s)
    vi.mocked(transport.status).mockResolvedValueOnce({
      sessionId: 's2',
      sessionState: 'idle',
      busy: false,
      awaitingInput: false,
    } as never)
    await guestActions(set, () => s).switchGuestSession(identity.sessions[1])
    expect(s.sessionId).toBe('s2')
    expect(s.guestSessionState).toEqual({
      sessionState: 'idle',
      busy: false,
      awaitingInput: false,
    })
  })

  it('refreshGuestStatus 在管理员壳里不发请求', async () => {
    const s = state({ guestIdentity: undefined, sessionId: 's1' })
    const set = bind(s)
    await guestActions(set, () => s).refreshGuestStatus('s1')
    expect(transport.status).not.toHaveBeenCalled()
  })

  it('status 失败时保留上一次状态（离线不把状态行打成空白）', async () => {
    const prev = {
      sessionState: 'awaiting' as const,
      busy: true,
      awaitingInput: true,
      pendingInput: { kind: 'question' as const, count: 1 },
    }
    const s = state({ sessionId: 's1', guestSessionState: prev })
    const set = bind(s)
    vi.mocked(transport.status).mockRejectedValueOnce(new Error('offline'))
    await guestActions(set, () => s).refreshGuestStatus('s1')
    expect(s.guestSessionState).toEqual(prev)
  })

  it('拉取途中切了会话 → 结果作废', async () => {
    const s = state({ sessionId: 's1' })
    const set = bind(s)
    let resolve: (v: unknown) => void = () => {}
    vi.mocked(transport.status).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r as (v: unknown) => void
      }) as never,
    )
    const done = guestActions(set, () => s).refreshGuestStatus('s1')
    s.sessionId = 's2'
    resolve({ sessionId: 's1', sessionState: 'awaiting', busy: true, awaitingInput: true })
    await done
    expect(s.guestSessionState).toBeUndefined()
  })
})

describe('从 host 列表进入访客视图', () => {
  it('整份复位会话态并锚到白名单第一条 host', () => {
    const s = state({
      sessionId: 'admin-session',
      cwd: '/admin',
      selectedHostId: 'h9',
      hostId: 'h9',
      entries: [{ id: 'e1', kind: 'user', text: 'admin 的对话' }],
      historyLoadedAt: 123,
    })
    const set = bind(s)
    guestActions(set, () => s).enterGuestSession(identity)

    expect(transport.setGuestMode).toHaveBeenCalledWith(identity)
    expect(s.guestIdentity).toEqual(identity)
    expect(s.guestSessions).toEqual(identity.sessions)
    // 管理员的会话不能留在访客壳里：否则首条白名单会话的加载守卫会早退
    expect(s.sessionId).toBeUndefined()
    expect(s.entries).toEqual([])
    expect(s.historyLoadedAt).toBeUndefined()
    expect(s.selectedHostId).toBe('h1')
    expect(s.hostName).toBe('H1')
    expect(blockGuestWrite(s)).toBe(true)
  })

  it('退出后镜像复位，写守卫不再拦截', () => {
    const s = state()
    const set = bind(s)
    guestActions(set, () => s).enterGuestSession(identity)
    guestActions(set, () => s).exitGuestSession()
    expect(transport.exitGuestMode).toHaveBeenCalled()
    expect(s.guestIdentity).toBeUndefined()
    expect(isGuestActive()).toBe(false)
    expect(blockGuestWrite(s)).toBe(false)
  })
})

describe('退出访客', () => {
  it('清掉访客身份与模块级镜像（之后写守卫不再拦截）', () => {
    const s = state()
    const set = bind(s)
    guestActions(set, () => s).setGuestIdentity(identity)
    expect(blockGuestWrite(s)).toBe(true)

    guestActions(set, () => s).exitGuestSession()
    expect(s.guestIdentity).toBeUndefined()
    expect(s.guestSessions).toEqual([])
    // 镜像同步清掉：chat store 之外的模块据此恢复同步
    expect(isGuestActive()).toBe(false)
    expect(blockGuestWrite(s)).toBe(false)
  })
})
