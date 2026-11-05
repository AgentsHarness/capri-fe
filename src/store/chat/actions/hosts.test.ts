import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostActions, probeHostHeartbeat, resendUndeliveredPrompt, HOST_HEARTBEAT_STALE_MS } from './hosts'
import { handleConnEvent } from '../events/conn'
import { handleSessionNotification } from '../events/sessionNotif'
import { resetModelSwitchEcho } from '../modelSwitchEcho'
import type { AcpEvent, HostInfo } from '../../../api/types'
import type { ChatState, SetState } from '../types'

vi.mock('../../../api/client', () => ({
  transport: {
    listHosts: vi.fn().mockResolvedValue({ hosts: [], defaultHostId: undefined }),
    getLocalHostId: vi.fn(() => undefined),
    getLocalBase: vi.fn(() => ''),
    discoverLocalHost: vi.fn().mockResolvedValue(null),
    getConnectionMode: vi.fn(() => 'hub'),
    // historyPins 在模块加载期就订阅事件流
    onEvent: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    setModel: vi.fn().mockResolvedValue({ ok: true }),
    setDefaultModel: vi.fn().mockResolvedValue({ ok: true }),
    // switchHost 路径
    setHost: vi.fn(),
    status: vi.fn().mockResolvedValue({ ready: true }),
    verifyLocalRoute: vi.fn().mockResolvedValue(undefined),
    emitLocal: vi.fn(),
    lastLiveEventAt: vi.fn(() => undefined),
  },
}))

vi.mock('../../toast', () => ({ pushToast: vi.fn() }))
vi.mock('../modePersist', () => ({
  refreshDefaultModeFlags: vi.fn().mockResolvedValue(undefined),
  restorePlanMode: vi.fn(() => ({})),
}))

import { transport } from '../../../api/client'
import { pushToast } from '../../toast'
import { refreshDefaultModeFlags } from '../modePersist'
import { loadStr, saveStr } from '../../../lib/storage'

const HOST_KEY = 'capri-fe.host'

function host(hostId: string, over: Partial<HostInfo> = {}): HostInfo {
  return {
    hostId,
    hostName: hostId,
    online: true,
    local: false,
    ...over,
  } as HostInfo
}

function makeState(patch: Partial<ChatState> = {}): ChatState {
  return {
    hosts: [],
    selectedHostId: undefined,
    layerErrors: {},
    setLayerError: vi.fn(),
    switchHost: vi.fn().mockResolvedValue(undefined),
    resetToEmpty: vi.fn(),
    stopTopTaskPolling: vi.fn(),
    resetListRefreshGates: vi.fn(),
    ...patch,
  } as unknown as ChatState
}

function bind(state: ChatState) {
  const set: SetState = (partial) => {
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  }
  return hostActions(set, () => state) as Pick<ChatState, 'refreshHosts'>
}

describe('refreshHosts 选中 host 失效', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(transport.getConnectionMode as ReturnType<typeof vi.fn>).mockReturnValue('hub')
    ;(transport.getLocalHostId as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    saveStr(HOST_KEY, 'a')
  })

  it('选中的 host 仍在列表 → 不动选择、不重挑', async () => {
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      hosts: [host('a'), host('b')],
    })
    const state = makeState({ hosts: [host('a')], selectedHostId: 'a' })
    await bind(state).refreshHosts()
    expect(state.selectedHostId).toBe('a')
    expect(state.switchHost).not.toHaveBeenCalled()
    expect(state.resetToEmpty).not.toHaveBeenCalled()
  })

  it('当前 host 被外部删除且还有别的 host → 清掉失效选择并重新挑选', async () => {
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      hosts: [host('b')],
    })
    const state = makeState({
      hosts: [host('a')],
      selectedHostId: 'a',
      layerErrors: { hub: { id: 'host-offline', level: 'error', message: 'x', at: 0 } },
    })
    await bind(state).refreshHosts()
    expect(state.hosts.map((h) => h.hostId)).toEqual(['b'])
    // 先清失效选择，switchHost 才不会被「同一 host」早退挡掉
    expect((state.switchHost as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['b'])
    // 持久化的失效选择被清掉（switchHost 是 mock，所以这里不会再写回新值）
    expect(loadStr(HOST_KEY)).toBeNull()
  })

  it('当前 host 被外部删除且一台不剩 → 落到空状态（不留 connecting）', async () => {
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue({ hosts: [] })
    const state = makeState({
      hosts: [host('a')],
      selectedHostId: 'a',
      hostId: 'a',
      hostName: 'a',
    })
    await bind(state).refreshHosts()
    expect(state.selectedHostId).toBeUndefined()
    expect(state.hostId).toBeUndefined()
    expect(state.hostName).toBeUndefined()
    expect(state.resetToEmpty).toHaveBeenCalledTimes(1)
    expect(state.switchHost).not.toHaveBeenCalled()
    expect(loadStr(HOST_KEY)).toBeNull()
  })

  it('首次进入（还没有任何选择）→ 照旧自动挑一台', async () => {
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      hosts: [host('a')],
    })
    const state = makeState({ selectedHostId: undefined })
    await bind(state).refreshHosts()
    expect(state.switchHost).toHaveBeenCalledWith('a')
  })

  it('选中 host 掉线（仍在注册表里）→ 只亮横幅，不清选择', async () => {
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      hosts: [host('a', { online: false })],
    })
    const state = makeState({ hosts: [host('a')], selectedHostId: 'a' })
    await bind(state).refreshHosts()
    expect(state.selectedHostId).toBe('a')
    expect(state.setLayerError).toHaveBeenCalledWith(
      'hub',
      expect.objectContaining({ id: 'host-offline' }),
    )
    expect(state.resetToEmpty).not.toHaveBeenCalled()
  })

  it('带 hub hello 快照调用 → 直接用快照选 host，不再 GET listHosts', async () => {
    const list = transport.listHosts as ReturnType<typeof vi.fn>
    const state = makeState({ selectedHostId: undefined })
    await bind(state).refreshHosts({ hosts: [host('b')], defaultHostId: 'b' })
    expect(list).not.toHaveBeenCalled()
    expect(state.switchHost).toHaveBeenCalledWith('b')
    expect(state.hosts.map((h) => h.hostId)).toEqual(['b'])
  })
})

describe('首次自动选 host：本机近路 vs 记忆选择', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(transport.getConnectionMode as ReturnType<typeof vi.fn>).mockReturnValue('hub')
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue({ hosts: [] })
    saveStr(HOST_KEY, 'vps')
  })
  afterEach(() => {
    // 别让本机/近路的桩值串到后面的 describe。
    ;(transport.getLocalHostId as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    ;(transport.getLocalBase as ReturnType<typeof vi.fn>).mockReturnValue('')
  })

  const LOCAL = host('mba', { local: true })
  const REMOTE = host('vps')

  function bindFirst(state: ChatState) {
    const set: SetState = (partial) => {
      Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
    }
    return hostActions(set, () => state) as Pick<ChatState, 'refreshHosts'>
  }

  it('远程站探出的 127.0.0.1 近路不顶掉记住的在线 Hub 节点', async () => {
    ;(transport.getLocalHostId as ReturnType<typeof vi.fn>).mockReturnValue('mba')
    ;(transport.getLocalBase as ReturnType<typeof vi.fn>).mockReturnValue(
      'http://127.0.0.1:8765',
    )
    const state = makeState({ selectedHostId: undefined })
    await bindFirst(state).refreshHosts({ hosts: [LOCAL, REMOTE] })
    expect(state.switchHost).toHaveBeenCalledWith('vps')
  })

  it('页面本身跑在本机 host 上（无近路 base）→ 本机优先，不被残留记忆拐走', async () => {
    ;(transport.getLocalHostId as ReturnType<typeof vi.fn>).mockReturnValue('mba')
    ;(transport.getLocalBase as ReturnType<typeof vi.fn>).mockReturnValue('')
    const state = makeState({ selectedHostId: undefined })
    await bindFirst(state).refreshHosts({ hosts: [LOCAL, REMOTE] })
    expect(state.switchHost).toHaveBeenCalledWith('mba')
  })

  it('近路场景下记忆指向离线 host → 落回本机而非连一个死的', async () => {
    ;(transport.getLocalHostId as ReturnType<typeof vi.fn>).mockReturnValue('mba')
    ;(transport.getLocalBase as ReturnType<typeof vi.fn>).mockReturnValue(
      'http://127.0.0.1:8765',
    )
    const state = makeState({ selectedHostId: undefined })
    await bindFirst(state).refreshHosts({ hosts: [LOCAL, host('vps', { online: false })] })
    expect(state.switchHost).toHaveBeenCalledWith('mba')
  })
})

describe('setModel 空状态（无会话）与已锚定两条路径', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetModelSwitchEcho()
  })

  function bindWith(state: ChatState) {
    const set: SetState = (partial) => {
      Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
    }
    return hostActions(set, () => state)
  }

  const CATALOG = [
    {
      modelId: 'grok-4',
      name: 'Grok 4',
      reasoningEfforts: [{ id: 'high', label: 'high', value: 'high', default: true }],
    },
  ]

  it('空状态 → 不发请求，记为待生效并乐观更新 caption', async () => {
    const state = makeState({ sessionId: undefined, entries: [], models: CATALOG })
    await bindWith(state).setModel('grok-4', undefined)
    expect(transport.setModel).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith('Grok 4(high) 将在新对话生效', { type: 'info' })
    expect(state.modelName).toBe('Grok 4')
    expect(state.reasoningEffort).toBe('high')
    expect(state.pendingModel).toEqual({ modelId: 'grok-4', reasoningEffort: 'high' })
    // 会话还没建，不往空时间线里塞切换记录。
    expect(state.entries).toHaveLength(0)
  })

  it('空状态 + 设为默认 → 勾选一并记进待生效（锚定后落盘）', async () => {
    const state = makeState({ sessionId: undefined, entries: [], models: CATALOG })
    await bindWith(state).setModel('grok-4', 'low', { asDefault: true })
    expect(transport.setModel).not.toHaveBeenCalled()
    expect(transport.setDefaultModel).not.toHaveBeenCalled()
    expect(state.pendingModel).toEqual({
      modelId: 'grok-4',
      reasoningEffort: 'low',
      asDefault: true,
    })
  })

  it('已锚定 → 请求携带当前 sessionId，成功按默认 effort 更新 caption', async () => {
    const state = makeState({
      sessionId: 'sess-1',
      modelName: 'grok-3',
      reasoningEffort: 'low',
      entries: [],
      models: CATALOG,
    })
    await bindWith(state).setModel('grok-4', undefined)
    expect(transport.setModel).toHaveBeenCalledWith('grok-4', undefined, 'sess-1')
    expect(state.modelName).toBe('Grok 4')
    expect(state.reasoningEffort).toBe('high')
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0].kind).toBe('session_event')
    expect(state.pendingModel).toBeUndefined()
  })

  // 复刻真实时序：host 的 typed model_changed 广播先于 /api/set-model 的
  // HTTP 响应到达。此时 store 里 modelName 还是旧值，广播侧「名称没变」的
  // 守卫不成立；必须靠 in-flight 登记把这一行留给 setModel 的乐观行。
  it('host 广播先于 HTTP 响应到达 → 只留一行（乐观行），不重复', async () => {
    const state = makeState({
      sessionId: 'sess-1',
      modelName: 'Grok 3',
      reasoningEffort: 'low',
      entries: [],
      models: CATALOG,
    })
    const set: SetState = (partial) => {
      Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
    }
    const get = () => state
    ;(transport.setModel as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      handleSessionNotification(set, get, {
        type: 'session_notification',
        sessionId: 'sess-1',
        params: {
          sessionUpdate: 'model_changed',
          model_id: 'grok-4',
          reasoning_effort: 'high',
        },
      } as AcpEvent)
      return {}
    })
    await hostActions(set, get).setModel('grok-4', 'high')
    const lines = state.entries
      .map((e) => (e.kind === 'session_event' ? e.text : ''))
      .filter((t) => t.includes('模型已从'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('Grok 3(low)')
    expect(lines[0]).toContain('Grok 4(high)')
  })

  it('已锚定 + 设为默认 → 落盘 config.toml 默认，失败只提示', async () => {
    const state = makeState({ sessionId: 'sess-1', entries: [], models: CATALOG })
    await bindWith(state).setModel('grok-4', 'low', { asDefault: true })
    expect(transport.setDefaultModel).toHaveBeenCalledWith('grok-4', 'low', 'sess-1')
    expect(pushToast).toHaveBeenCalledWith('已设为默认模型')

    vi.clearAllMocks()
    ;(transport.setDefaultModel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom'),
    )
    await bindWith(state).setModel('grok-4', 'low', { asDefault: true })
    expect(pushToast).toHaveBeenCalledWith('设为默认失败: boom')
  })

  it('已锚定 + contextWindow → 转发 contextWindow，窗口写进目录并更新 usage.size', async () => {
    const state = makeState({
      sessionId: 'sess-1',
      modelName: 'grok-3',
      reasoningEffort: 'low',
      entries: [],
      models: CATALOG,
    })
    await bindWith(state).setModel('grok-4', 'high', { contextWindow: 500000 })
    expect(transport.setModel).toHaveBeenCalledWith('grok-4', 'high', 'sess-1', 500000)
    // 目录是窗口的唯一真源（菜单从它派生），不能另存一份会话级副本。
    expect(state.models.find((m) => m.modelId === 'grok-4')?.contextWindowSelection).toBe(500000)
    expect(state.usage?.size).toBe(500000)
    const entry = state.entries[0]
    expect(entry.kind === 'session_event' && entry.text).toContain('上下文 500k')
  })

  it('已锚定 + 未指定窗口（普通切模型）→ 不清目录里的旧窗口选择', async () => {
    const state = makeState({
      sessionId: 'sess-1',
      entries: [],
      models: [
        { modelId: 'grok-3' },
        { modelId: 'grok-4', name: 'Grok 4', contextWindowSelection: 500000, contextWindows: [256000, 500000] },
      ],
    })
    await bindWith(state).setModel('grok-4', 'high')
    // agent 是 Preserve 语义：省略 contextWindow 表示沿用会话当前选择，
    // 本地不能把它清成「默认」——那会让菜单显示一个 agent 并未采用的值。
    expect(transport.setModel).toHaveBeenCalledWith('grok-4', 'high', 'sess-1')
    expect(state.models.find((m) => m.modelId === 'grok-4')?.contextWindowSelection).toBe(500000)
  })

  it('已锚定 + 设为默认 + contextWindow → 携带 contextWindow 落盘', async () => {
    const state = makeState({ sessionId: 'sess-1', entries: [], models: CATALOG })
    await bindWith(state).setModel('grok-4', 'low', { asDefault: true, contextWindow: 256000 })
    expect(transport.setModel).toHaveBeenCalledWith('grok-4', 'low', 'sess-1', 256000)
    expect(transport.setDefaultModel).toHaveBeenCalledWith('grok-4', 'low', 'sess-1', 256000)
  })

  it('空状态 + contextWindow → 记入 pendingModel', async () => {
    const state = makeState({ sessionId: undefined, entries: [], models: CATALOG })
    await bindWith(state).setModel('grok-4', 'low', { contextWindow: 1000000 })
    expect(transport.setModel).not.toHaveBeenCalled()
    expect(state.pendingModel).toEqual({
      modelId: 'grok-4',
      reasoningEffort: 'low',
      contextWindow: 1000000,
    })
  })

  // host 的半成功：模型切了、档位被 agent 拒。必须弹 toast 并把 caption
  // 回滚到切换前的档位——不能留下一个 agent 没采用的档位。
  it('host 返回 warning（档位未生效）→ 弹 toast 并回滚档位，模型仍切', async () => {
    const state = makeState({
      sessionId: 'sess-1',
      modelName: 'Grok 3',
      reasoningEffort: 'low',
      entries: [],
      models: CATALOG,
    })
    ;(transport.setModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      warning: '模型已切换，但推理档位 high 未生效：unknown reasoning_effort value',
    })
    await bindWith(state).setModel('grok-4', 'high')
    expect(pushToast).toHaveBeenCalledWith(
      '模型已切换，但推理档位 high 未生效：unknown reasoning_effort value',
      { type: 'warning' },
    )
    expect(state.modelName).toBe('Grok 4')
    expect(state.reasoningEffort).toBe('low')
    // 时间线里也留一行，滚动历史里能看到
    expect(
      state.entries.some(
        (e) => e.kind === 'session_event' && e.text.includes('未生效'),
      ),
    ).toBe(true)
  })

  it('host 无 warning → 档位按请求档位写入（成功路径无噪音）', async () => {
    const state = makeState({
      sessionId: 'sess-1',
      modelName: 'Grok 3',
      reasoningEffort: 'low',
      entries: [],
      models: CATALOG,
    })
    ;(transport.setModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce({})
    await bindWith(state).setModel('grok-4', 'high')
    expect(state.reasoningEffort).toBe('high')
    expect(pushToast).not.toHaveBeenCalledWith(
      expect.stringContaining('未生效'),
      expect.anything(),
    )
  })
})

// ── switchHost：只依赖 hostId 的请求不等 status ────────────────────────
describe('switchHost 请求发起时机', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(transport.getConnectionMode as ReturnType<typeof vi.fn>).mockReturnValue('hub')
    ;(transport.verifyLocalRoute as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  })

  function bindSwitch(state: ChatState) {
    const set: SetState = (partial) => {
      Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
    }
    return hostActions(set, () => state)
  }

  it('status 还没回，host 级数据（会话列表 / 工作区 / [ui]）已经发出', async () => {
    let resolveStatus!: (v: unknown) => void
    ;(transport.status as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => (resolveStatus = r)),
    )
    const state = makeState({
      hosts: [host('a'), host('b')],
      selectedHostId: 'a',
      refreshSessionLists: vi.fn(),
      refreshSessionStats: vi.fn(),
    })
    const p = bindSwitch(state).switchHost('b')
    await new Promise((r) => setTimeout(r, 0))

    expect(transport.status).toHaveBeenCalledTimes(1)
    expect(state.refreshSessionLists).toHaveBeenCalledTimes(1)
    expect(refreshDefaultModeFlags).toHaveBeenCalledTimes(1)

    resolveStatus({ ready: true })
    await p
  })

  it('统计条不在 switchHost 里预拉（hello 锚定会话时组件自己拉，避免问两遍）', async () => {
    ;(transport.status as ReturnType<typeof vi.fn>).mockResolvedValue({
      ready: true,
      sessionId: 's1',
      cwd: '/w',
    })
    const state = makeState({
      hosts: [host('a'), host('b')],
      selectedHostId: 'a',
      refreshSessionLists: vi.fn(),
      refreshSessionStats: vi.fn(),
    })
    await bindSwitch(state).switchHost('b')
    expect(state.refreshSessionStats).not.toHaveBeenCalled()
    // 快照仍按常规 hello 路径落进 store
    expect(transport.emitLocal).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'hello', sessionId: 's1' }),
    )
  })

  it('切到空状态 host 时清空上一台 host 的上下文状态（usage / sessionStatus / todos / goalState / mcp）并保留按 host 记忆的 emptyCwd', async () => {
    ;(transport.status as ReturnType<typeof vi.fn>).mockResolvedValue({
      ready: true,
      sessionId: undefined,
      cwd: undefined,
    })
    const state = makeState({
      hosts: [host('a'), host('b')],
      selectedHostId: 'a',
      sessionId: 'sess-a',
      cwd: '/repo-a',
      emptyCwd: '/repo-a-empty',
      emptyCwdByHost: { a: '/repo-a-empty', b: '/repo-b-empty' },
      usage: { used: 49_000, size: 1_000_000 },
      sessionStatus: {
        contextTokens: 49_000,
        contextWindowSize: 1_000_000,
        usedPercent: 5,
        autoCompactThresholdPercent: 85,
        totalCostUsd: 0.1234,
      },
      todos: [{ id: '1', content: 'task', status: 'in_progress' }],
      todoCounts: { completed: 0, inProgress: 1, pending: 0, total: 1 },
      goalState: { status: 'active', objective: 'ship' },
      mcpServers: [{ name: 'srv', status: 'ready' }],
      mcpInit: { connected: 1, total: 1, startedAt: 1 },
      runningHook: { eventName: 'PreToolUse', count: 1, startedAt: 1 },
      refreshSessionLists: vi.fn(),
      refreshSessionStats: vi.fn(),
    })

    await bindSwitch(state).switchHost('b')

    expect(state.selectedHostId).toBe('b')
    expect(state.sessionId).toBeUndefined()
    expect(state.usage).toBeUndefined()
    expect(state.sessionStatus).toBeUndefined()
    expect(state.todos).toBeUndefined()
    expect(state.todoCounts).toBeUndefined()
    expect(state.goalState).toBeUndefined()
    expect(state.mcpServers).toEqual([])
    expect(state.mcpInit).toBeUndefined()
    expect(state.runningHook).toBeNull()
    expect(state.emptyCwd).toBe('/repo-b-empty')
    expect(state.emptyCwdByHost).toEqual({ a: '/repo-a-empty', b: '/repo-b-empty' })
  })
})

describe('refreshHosts 选中 host 掉线时的在途回合', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(transport.getConnectionMode as ReturnType<typeof vi.fn>).mockReturnValue('hub')
    ;(transport.getLocalHostId as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    saveStr(HOST_KEY, 'a')
  })

  function offlineTurnState(lastLiveAt: number | undefined) {
    ;(transport.lastLiveEventAt as ReturnType<typeof vi.fn>).mockReturnValue(lastLiveAt)
    const state = makeState({
      hosts: [host('a')],
      selectedHostId: 'a',
      conn: 'busy',
      statusText: 'Waiting for response…',
      turnStartedAt: 1_000,
      currentPromptId: 'p-1',
      lastSentPromptId: 'u-1',
      entries: [{ id: 'u-1', kind: 'user', text: 'hi' }],
    })
    return state
  }

  it('本回合零 live 事件 → 收口为未送达，并给一条可重发的错误行', async () => {
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      hosts: [host('a', { online: false })],
    })
    const state = offlineTurnState(undefined)
    await bind(state).refreshHosts()

    expect(state.conn).toBe('error')
    expect(state.turnStartedAt).toBeUndefined()
    expect(state.statusText).toBe('')
    const err = state.entries.find((e) => e.kind === 'error')
    expect(err).toMatchObject({ action: 'resend' })
    expect(err && 'text' in err ? err.text : '').toContain('消息未送达')
  })

  it('本回合收到过 live 事件 → 不动：回合确实在 host 上跑过', async () => {
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      hosts: [host('a', { online: false })],
    })
    // lastLiveAt 晚于 turnStartedAt(=1000) = 断线前就有事件送达。
    const state = offlineTurnState(5_000)
    await bind(state).refreshHosts()

    expect(state.conn).toBe('busy')
    expect(state.turnStartedAt).toBe(1_000)
    expect(state.entries.some((e) => e.kind === 'error')).toBe(false)
  })

  it('没有在途回合 → 只亮离线横幅', async () => {
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      hosts: [host('a', { online: false })],
    })
    const state = makeState({ hosts: [host('a')], selectedHostId: 'a', conn: 'ready' })
    await bind(state).refreshHosts()

    expect(state.setLayerError).toHaveBeenCalledWith(
      'hub',
      expect.objectContaining({ id: 'host-offline' }),
    )
    expect(state.conn).toBe('ready')
  })
})

describe('host 掉线时按「是否已受理」区分', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(transport.getConnectionMode as ReturnType<typeof vi.fn>).mockReturnValue('hub')
    ;(transport.getLocalHostId as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    saveStr(HOST_KEY, 'a')
  })

  it('拿到过 200 → 回合保留，只提示已送达等恢复', async () => {
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      hosts: [host('a', { online: false })],
    })
    ;(transport.lastLiveEventAt as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const state = makeState({
      hosts: [host('a')],
      selectedHostId: 'a',
      conn: 'busy',
      phaseText: 'Waiting for response…',
      turnStartedAt: 1_000,
      promptAcceptedAt: 2_000,
      currentPromptId: 'p-1',
      lastSentPromptId: 'u-1',
      entries: [{ id: 'u-1', kind: 'user', text: 'hi' }],
    })
    await bind(state).refreshHosts()

    // 已受理 = 回合真的在跑；不能把用户引向重发（会被 host 当重号丢弃）。
    expect(state.conn).toBe('busy')
    expect(state.turnStartedAt).toBe(1_000)
    // busy 状态行读 phaseText；statusText 是操作回执槽，不能被过程提示占用。
    expect(state.phaseText).toContain('已送达')
    expect(state.statusText ?? '').not.toContain('已送达')
    expect(state.entries.some((e) => e.kind === 'error')).toBe(false)
  })

  it('拿到过 200 且处于空闲态 → 清掉旧操作回执，让「已送达」可见', async () => {
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      hosts: [host('a', { online: false })],
    })
    ;(transport.lastLiveEventAt as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const state = makeState({
      hosts: [host('a')],
      selectedHostId: 'a',
      conn: 'ready',
      phaseText: '就绪',
      statusText: '已切换到 plan 模式',
      turnStartedAt: 1_000,
      promptAcceptedAt: 2_000,
      currentPromptId: 'p-1',
      lastSentPromptId: 'u-1',
      entries: [{ id: 'u-1', kind: 'user', text: 'hi' }],
    })
    await bind(state).refreshHosts()

    expect(state.phaseText).toContain('已送达')
    expect(state.statusText).toBe('')
  })

  it('既无 200 也无 live 事件 → 判未送达（这是真正没出去的那一类）', async () => {
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      hosts: [host('a', { online: false })],
    })
    ;(transport.lastLiveEventAt as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const state = makeState({
      hosts: [host('a')],
      selectedHostId: 'a',
      conn: 'busy',
      turnStartedAt: 1_000,
      currentPromptId: 'p-1',
      lastSentPromptId: 'u-1',
      entries: [{ id: 'u-1', kind: 'user', text: 'hi' }],
    })
    await bind(state).refreshHosts()

    expect(state.conn).toBe('error')
    expect(state.entries.some((e) => e.kind === 'error')).toBe(true)
  })

  it('离线收口后再收到 ready → 不会把已判死的回合顶回 busy', async () => {
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      hosts: [host('a', { online: false })],
    })
    ;(transport.lastLiveEventAt as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const state = makeState({
      hosts: [host('a')],
      selectedHostId: 'a',
      sessionId: 's1',
      conn: 'busy',
      turnStartedAt: 1_000,
      currentPromptId: 'p-1',
      lastSentPromptId: 'u-1',
      // 旧 handler 保留了这个「回合在飞」标记，重连后的 ready 会据此
      // 本地真相守卫把 conn 翻回 busy。
      pendingOptimisticUserId: 'u-1',
      entries: [{ id: 'u-1', kind: 'user', text: 'hi' }],
      refreshHosts: vi.fn().mockResolvedValue(undefined),
      refreshGitInfo: vi.fn().mockResolvedValue(undefined),
    })
    await bind(state).refreshHosts()
    expect(state.conn).toBe('error')
    expect(state.pendingOptimisticUserId).toBeUndefined()

    handleConnEvent(
      (partial) => {
        Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
      },
      () => state,
      { type: 'ready', sessionId: 's1' } as never,
    )
    expect(state.conn).toBe('ready')
  })
})

describe('未送达重试挂在用户行上', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(transport.getConnectionMode as ReturnType<typeof vi.fn>).mockReturnValue('hub')
    ;(transport.getLocalHostId as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    ;(transport.lastLiveEventAt as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    saveStr(HOST_KEY, 'a')
  })

  async function offlineState() {
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      hosts: [host('a', { online: false })],
    })
    const state = makeState({
      hosts: [host('a')],
      selectedHostId: 'a',
      conn: 'busy',
      turnStartedAt: 1_000,
      currentPromptId: 'p-1',
      lastSentPromptId: 'u-1',
      entries: [
        { id: 'u-0', kind: 'user', text: '上一条' },
        { id: 'u-1', kind: 'user', text: '这一条' },
      ],
    })
    await bind(state).refreshHosts()
    return state
  }

  it('离线收口把标记打在刚发的那条用户行上，别的行不受影响', async () => {
    const state = await offlineState()
    const rows = state.entries.filter((e) => e.kind === 'user')
    expect(rows.map((e) => (e.kind === 'user' ? !!e.undelivered : false))).toEqual([
      false,
      true,
    ])
  })

  it('host 恢复 ready 后行内重试仍可用（连接状态清掉了，标记还在）', async () => {
    const state = await offlineState()
    // 重连成功：conn 回到 ready，layerErrors 清空。
    state.conn = 'ready'
    state.send = vi.fn().mockResolvedValue(undefined)
    expect(resendUndeliveredPrompt(() => {}, () => state)).toBe(true)
    expect(state.send).toHaveBeenCalledTimes(1)
  })

  it('重发收走用户行与未送达错误行，避免时间线出现两遍', async () => {
    const state = await offlineState()
    state.conn = 'ready'
    state.send = vi.fn().mockResolvedValue(undefined)
    const before = state.entries.length
    resendUndeliveredPrompt(
      (partial) => {
        Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
      },
      () => state,
    )
    expect(state.entries.length).toBe(before - 2)
    expect(state.entries.some((e) => e.kind === 'error')).toBe(false)
    expect(state.entries.some((e) => e.id === 'u-0')).toBe(true)
  })

  it('没有标记的回合不能重发（已送达 / 已收口）', async () => {
    const state = makeState({
      conn: 'ready',
      currentPromptId: 'p-1',
      lastSentPromptId: 'u-1',
      entries: [{ id: 'u-1', kind: 'user', text: 'hi' }],
    })
    state.send = vi.fn().mockResolvedValue(undefined)
    expect(resendUndeliveredPrompt(() => {}, () => state)).toBe(false)
    expect(state.send).not.toHaveBeenCalled()
  })
})

describe('probeHostHeartbeat — 区分「在思考」与「心跳停了」', () => {  beforeEach(() => {
    vi.clearAllMocks()
  })

  function withHost(over: Partial<HostInfo>) {
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      hosts: [host('a', over)],
    })
  }

  it('心跳新鲜 → alive（host 只是在思考，不该报警）', async () => {
    withHost({ lastSeenAgeMs: 1_000 })
    expect(await probeHostHeartbeat('a')).toBe('alive')
  })

  it('偶发丢拍（age 2.8s）仍在窗口内 → alive，不误报', async () => {
    withHost({ lastSeenAgeMs: 2_800 })
    expect(await probeHostHeartbeat('a')).toBe('alive')
  })

  it('心跳停住 → silent', async () => {
    withHost({ lastSeenAgeMs: HOST_HEARTBEAT_STALE_MS + 1_000 })
    expect(await probeHostHeartbeat('a')).toBe('silent')
  })

  it('host 已被 hub 标离线 → silent', async () => {
    withHost({ online: false, lastSeenAgeMs: 0 })
    expect(await probeHostHeartbeat('a')).toBe('silent')
  })

  it('缺 lastSeenAgeMs → 按刚收到心跳处理（alive），不做跨机器时钟比较', async () => {
    withHost({})
    expect(await probeHostHeartbeat('a')).toBe('alive')
  })

  it('拿不到注册表（FE↔hub 有问题）→ unknown，不误报成 host 断线', async () => {
    ;(transport.listHosts as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'))
    expect(await probeHostHeartbeat('a')).toBe('unknown')
  })
})
