import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostActions } from './hosts'
import type { HostInfo } from '../../../api/types'
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
  },
}))

vi.mock('../../toast', () => ({ pushToast: vi.fn() }))

import { transport } from '../../../api/client'
import { pushToast } from '../../toast'
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

describe('setModel 会话隔离守卫', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function bindWith(state: ChatState) {
    const set: SetState = (partial) => {
      Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
    }
    return hostActions(set, () => state)
  }

  it('会话未锚定（空状态）→ 不发请求，提示先开始会话', async () => {
    const state = makeState({ sessionId: undefined, entries: [] })
    await bindWith(state).setModel('grok-4', undefined)
    expect(transport.setModel).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith('请先开始或恢复一个会话，再切换模型')
    expect(state.modelName).toBeUndefined()
    expect(state.entries).toHaveLength(0)
  })

  it('已锚定 → 请求携带当前 sessionId，成功按默认 effort 更新 caption', async () => {
    const state = makeState({
      sessionId: 'sess-1',
      modelName: 'grok-3',
      reasoningEffort: 'low',
      entries: [],
      models: [
        {
          modelId: 'grok-4',
          name: 'Grok 4',
          reasoningEfforts: [{ id: 'high', label: 'high', value: 'high', default: true }],
        },
      ],
    })
    await bindWith(state).setModel('grok-4', undefined)
    expect(transport.setModel).toHaveBeenCalledWith('grok-4', undefined, 'sess-1')
    expect(state.modelName).toBe('Grok 4')
    expect(state.reasoningEffort).toBe('high')
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0].kind).toBe('session_event')
  })
})
