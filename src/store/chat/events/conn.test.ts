import { describe, expect, it, vi } from 'vitest'
import { handleConnEvent } from './conn'
import type { AcpEvent, ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'

function makeStore(initial: Partial<ChatState> = {}) {
  let state = {
    entries: [],
    refreshHosts: vi.fn(),
    refreshGitInfo: vi.fn(),
    setLayerError: vi.fn(),
    ...initial,
  } as ChatState
  const set = vi.fn(
    (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    },
  )
  const get = () => state
  return { set: set as unknown as SetState, get, state: () => state }
}

const ready = (over: Partial<Extract<AcpEvent, { type: 'ready' }>> = {}): AcpEvent =>
  ({ type: 'ready', ...over }) as AcpEvent

const runningTool = (): ScrollEntry => ({
  id: 't1',
  kind: 'tool',
  title: 'bash',
  verb: 'run',
  kindName: 'execute',
  status: 'in_progress',
})

describe('handleConnEvent — ready 的本地真相守卫', () => {
  it('live 中途（工具运行、无 open 指针、尾部无终止标记）拒绝翻 ready', () => {
    const { set, get, state } = makeStore({
      sessionId: 's1',
      conn: 'busy',
      statusText: 'Running bash…',
      turnStartedAt: 1000,
      entries: [runningTool()],
    })
    handleConnEvent(set, get, ready({ sessionId: 's1' }))
    const s = state()
    // conn 保持 busy、计时器与文案不动——状态行不熄灭
    expect(s.conn).toBe('busy')
    expect(s.turnStartedAt).toBe(1000)
    expect(s.statusText).toBe('Running bash…')
  })

  it('真实终态（尾部带回合终止标记）照常走 ready', () => {
    const { set, get, state } = makeStore({
      sessionId: 's1',
      conn: 'busy',
      statusText: 'Responding…',
      turnStartedAt: 1000,
      entries: [
        { id: 'a', kind: 'assistant', text: 'done', streaming: false },
        { id: 'm', kind: 'session_event', text: 'Worked for 5s' },
      ],
    })
    handleConnEvent(set, get, ready({ sessionId: 's1' }))
    const s = state()
    expect(s.conn).toBe('ready')
    expect(s.statusText).toBe('就绪')
    expect(s.turnStartedAt).toBeUndefined()
  })

  it('open 流式指针在场时拒绝翻 ready', () => {
    const { set, get, state } = makeStore({
      sessionId: 's1',
      conn: 'busy',
      statusText: 'Responding…',
      turnStartedAt: 1000,
      openAssistantId: 'a1',
      entries: [{ id: 'a1', kind: 'assistant', text: '…', streaming: true }],
    })
    handleConnEvent(set, get, ready({ sessionId: 's1' }))
    const s = state()
    expect(s.conn).toBe('busy')
    expect(s.turnStartedAt).toBe(1000)
    expect(s.statusText).toBe('Responding…')
  })

  it('缺 sid 的 ready 在 live 中途同样被守卫', () => {
    const { set, get, state } = makeStore({
      sessionId: 's1',
      conn: 'busy',
      statusText: 'Running bash…',
      turnStartedAt: 1000,
      entries: [runningTool()],
    })
    handleConnEvent(set, get, ready())
    const s = state()
    expect(s.conn).toBe('busy')
    expect(s.turnStartedAt).toBe(1000)
  })

  it('空闲会话的 ready 行为不变（就绪 + 清残留计时器）', () => {
    const { set, get, state } = makeStore({
      sessionId: 's1',
      conn: 'busy',
      statusText: 'Responding…',
      turnStartedAt: 1000,
      entries: [],
    })
    handleConnEvent(set, get, ready({ sessionId: 's1' }))
    const s = state()
    expect(s.conn).toBe('ready')
    expect(s.statusText).toBe('就绪')
    expect(s.turnStartedAt).toBeUndefined()
  })
})

describe('handleConnEvent — hub hello 用注册表快照选 host', () => {
  const hello = (
    over: Partial<Extract<AcpEvent, { type: 'hello' }>> = {},
  ): AcpEvent => ({ type: 'hello', service: 'hub', ...over }) as AcpEvent

  it('hello 带 hosts → refreshHosts 直接收快照，不自己再 GET', () => {
    const { set, get, state } = makeStore({})
    handleConnEvent(set, get, hello({ hosts: [{ hostId: 'h1' } as never], defaultHostId: 'h1' }))
    expect(state().conn).toBe('ready')
    expect(get().refreshHosts).toHaveBeenCalledTimes(1)
    expect(get().refreshHosts).toHaveBeenCalledWith({
      hosts: [{ hostId: 'h1' }],
      defaultHostId: 'h1',
    })
  })

  it('hello 不带 hosts（老 hub）→ 照旧无参 refreshHosts(发 GET)', () => {
    const { set, get, state } = makeStore({})
    handleConnEvent(set, get, hello({}))
    expect(state().conn).toBe('ready')
    expect(get().refreshHosts).toHaveBeenCalledTimes(1)
    expect(get().refreshHosts).toHaveBeenCalledWith(undefined)
  })
})

// ── 首屏/刷新回锚的会话回放：探活与快照一起发 ─────────────────────────
describe('handleConnEvent — hello 触发的历史回放带任务探活', () => {
  const hostHello = (
    over: Partial<Extract<AcpEvent, { type: 'hello' }>> = {},
  ): AcpEvent =>
    ({ type: 'hello', hostId: 'h1', hostName: 'H1', ready: true, ...over }) as AcpEvent

  it('空时间线 + hello 带 sessionId → 探活先发起，loadHistory 拿到 awaitBeforeReplay', () => {
    const probeP = Promise.resolve()
    const loadHistory = vi.fn()
    const { set, get } = makeStore({
      entries: [],
      sessionId: undefined,
      cwd: undefined,
      loadHistory,
      replayRunningTasks: vi.fn(() => probeP),
      startTopTaskPolling: vi.fn(),
      clearCompletedNotice: vi.fn(),
      topTasks: [],
    })
    handleConnEvent(set, get, hostHello({ sessionId: 's1', cwd: '/w' }))
    expect(get().replayRunningTasks).toHaveBeenCalledWith('s1', '/w')
    expect(loadHistory).toHaveBeenCalledWith('s1', '/w', {
      awaitBeforeReplay: probeP,
    })
  })

  it('时间线已有内容（中途重连）→ 既不重载也不探活', () => {
    const loadHistory = vi.fn()
    const { set, get } = makeStore({
      entries: [{ id: 'a', kind: 'assistant', text: 'x', streaming: false }],
      sessionId: 's1',
      cwd: '/w',
      loadHistory,
      replayRunningTasks: vi.fn(),
      startTopTaskPolling: vi.fn(),
      clearCompletedNotice: vi.fn(),
    })
    handleConnEvent(set, get, hostHello({ sessionId: 's1', cwd: '/w' }))
    expect(get().replayRunningTasks).not.toHaveBeenCalled()
    expect(loadHistory).not.toHaveBeenCalled()
  })
})
