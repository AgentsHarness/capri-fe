import { describe, expect, it, vi } from 'vitest'
import { handleExtSessionEvent } from './extSession'
import type { AcpEvent } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { runtime } from '../globals'

function makeStore(initial: Partial<ChatState> = {}) {
  let state = { sessionId: 's1', gitInfo: undefined, ...initial } as ChatState
  const set = vi.fn(
    (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    },
  )
  const get = () => state
  return { set: set as unknown as SetState, get, state: () => state }
}

describe('handleExtSessionEvent — git_head_changed', () => {
  it('当前会话 HEAD 变更写入状态栏分支', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    const handled = handleExtSessionEvent(set, get, {
      type: 'git_head_changed',
      sessionId: 's1',
      params: { sessionId: 's1', branch: 'feat/x', isWorktree: false },
    } as AcpEvent)
    expect(handled).toBe(true)
    expect(state().gitInfo).toEqual({
      branch: 'feat/x',
      isWorktree: false,
      mainRepo: undefined,
    })
  })

  it('payload sessionId 属于别的会话时不覆盖当前分支', () => {
    const { set, get, state } = makeStore({
      sessionId: 's1',
      gitInfo: { branch: 'main', isWorktree: false },
    })
    handleExtSessionEvent(set, get, {
      type: 'git_head_changed',
      sessionId: 's1',
      params: { sessionId: 's-other', branch: 'other-branch' },
    } as AcpEvent)
    expect(state().gitInfo?.branch).toBe('main')
  })

  it('信封 sessionId 错标时仍以 payload sessionId 为准', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    handleExtSessionEvent(set, get, {
      type: 'git_head_changed',
      sessionId: 'active-fallback',
      params: { sessionId: 's1', branch: 'from-payload' },
    } as AcpEvent)
    expect(state().gitInfo?.branch).toBe('from-payload')
  })

  it('空 branch 显示 detached', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    handleExtSessionEvent(set, get, {
      type: 'git_head_changed',
      params: { sessionId: 's1', branch: '' },
    } as AcpEvent)
    expect(state().gitInfo?.branch).toBe('(detached)')
  })

  it('落地后抬升 gitInfoEpoch，挡住在飞的探盘覆盖', () => {
    const before = runtime.gitInfoEpoch
    const { set, get } = makeStore({ sessionId: 's1' })
    handleExtSessionEvent(set, get, {
      type: 'git_head_changed',
      params: { sessionId: 's1', branch: 'new' },
    } as AcpEvent)
    expect(runtime.gitInfoEpoch).toBe(before + 1)
  })
})

describe('handleExtSessionEvent — mcp_server_status', () => {
  const newStore = () => makeStore({ sessionId: 's1', mcpServers: [] })
  const fire = (
    store: ReturnType<typeof makeStore>,
    params: Record<string, unknown>,
  ) =>
    handleExtSessionEvent(store.set, store.get, {
      type: 'mcp_server_status',
      params,
    } as AcpEvent)

  it('带 status 的事件是完整快照：健康的 initialized 清掉上一轮握手错误', () => {
    const store = newStore()
    fire(store, {
      name: 'linear',
      source: 'local',
      status: 'unavailable',
      reason: 'handshake_failed',
      detail: 'cli-chat-proxy returned 502',
    })
    expect(store.state().mcpServers[0].detail).toBe('cli-chat-proxy returned 502')

    fire(store, { name: 'linear', source: 'local', status: 'ready', reason: 'initialized' })
    const row = store.state().mcpServers[0]
    expect(row.status).toBe('ready')
    expect(row.reason).toBe('initialized')
    // detail 未随事件下发 = 本轮无诊断，不能把旧错误文本挂在健康行上。
    expect(row.detail).toBeUndefined()
  })

  it('缺 status 的增量事件沿用上一行字段（旧 shell 只推 reason）', () => {
    const store = newStore()
    fire(store, {
      name: 'fs',
      status: 'unavailable',
      reason: 'transport_closed',
      detail: 'child exited',
    })
    fire(store, { name: 'fs', sessionId: 's1' })
    const row = store.state().mcpServers[0]
    expect(row.status).toBe('unavailable')
    expect(row.reason).toBe('transport_closed')
    expect(row.detail).toBe('child exited')
  })

  it('同名行原地替换，不重复堆积', () => {
    const store = newStore()
    fire(store, { name: 'a', status: 'initializing', reason: 'config_added' })
    fire(store, { name: 'b', status: 'ready', reason: 'initialized' })
    fire(store, { name: 'a', status: 'ready', reason: 'initialized' })
    expect(store.state().mcpServers.map((s) => `${s.name}:${s.status}`)).toEqual([
      'b:ready',
      'a:ready',
    ])
  })

  it('无 name 的事件丢弃', () => {
    const store = newStore()
    fire(store, { status: 'ready', reason: 'initialized' })
    expect(store.state().mcpServers).toEqual([])
  })
})
