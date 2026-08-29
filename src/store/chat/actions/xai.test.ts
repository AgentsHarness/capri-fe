import { beforeEach, describe, expect, it, vi } from 'vitest'
import { xaiActions } from './xai'
import type { ChatState, SetState } from '../types'

vi.mock('../../../api/client', () => ({
  transport: {
    forkSession: vi.fn().mockResolvedValue({ result: { newSessionId: 'fork-1' } }),
    rewindPoints: vi.fn().mockResolvedValue({ points: [{ index: 0 }, { index: 1 }, { index: 2 }] }),
    gitWorktreeResumeSession: vi
      .fn()
      .mockResolvedValue({ sessionId: 'wt-1', worktreePath: '/wt', effectiveCwd: '/wt/x' }),
    sessionDelete: vi.fn().mockResolvedValue({}),
    btw: vi.fn().mockResolvedValue({ answer: '**答案**' }),
  },
}))

vi.mock('../../toast', () => ({
  pushToast: vi.fn(),
}))

import { transport } from '../../../api/client'
import { pushToast } from '../../toast'

/** 最小 ChatState：forkSession 只触碰这里列出的字段。 */
function makeState(patch: Partial<ChatState> = {}): ChatState {
  const state = {
    sessionId: 's1',
    cwd: '/w',
    conn: 'ready',
    entries: [],
    continueSession: vi.fn().mockResolvedValue(undefined),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    refreshWorkspaces: vi.fn().mockResolvedValue(undefined),
    ...patch,
  } as unknown as ChatState
  return state
}

function bind(state: ChatState) {
  const set: SetState = (partial) => {
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  }
  return xaiActions(set, () => state) as Pick<
    ChatState,
    'forkSession' | 'deleteSession' | 'askBtw'
  >
}

describe('xaiActions.forkSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('busy → toast 且不发请求（回合中途 fork 快照缺尾部输出）', async () => {
    const state = makeState({ conn: 'busy' })
    await bind(state).forkSession({})
    expect(pushToast).toHaveBeenCalledWith(expect.stringContaining('会话运行中'))
    expect(transport.forkSession).not.toHaveBeenCalled()
  })

  it('targetPromptIndex 越界 → 按 agent 回合编号（rewind points）收敛', async () => {
    const state = makeState()
    await bind(state).forkSession({ targetPromptIndex: 9 })
    expect(transport.rewindPoints).toHaveBeenCalledWith('s1', '/w')
    expect(transport.forkSession).toHaveBeenCalledWith(
      { targetPromptIndex: 2 },
      's1',
    )
    // fork 成功后刷新列表并切换到新会话（TUI 切到对等 agent）。
    expect(state.refreshSessions).toHaveBeenCalled()
    expect(state.continueSession).toHaveBeenCalledWith('fork-1', '/w')
  })

  it('worktree → 走 resume_session（全量历史），用 effectiveCwd 切换', async () => {
    const state = makeState()
    await bind(state).forkSession({ worktree: true })
    expect(transport.gitWorktreeResumeSession).toHaveBeenCalledWith({
      sourceCwd: '/w',
      copyMode: 'dirty',
    })
    expect(transport.forkSession).not.toHaveBeenCalled()
    expect(state.continueSession).toHaveBeenCalledWith('wt-1', '/wt/x')
  })

  it('fork 成功：先切换会话再刷新列表（continueSession 的世代 bump 会使先发的刷新结果被丢弃）', async () => {
    const state = makeState()
    await bind(state).forkSession({})
    const continueOrder = (state.continueSession as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]
    expect(refreshOrder(state)).toBeGreaterThan(continueOrder)
  })

  it('无 rewind points → 追加错误行、不 fork', async () => {
    ;(transport.rewindPoints as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ points: [] })
    const state = makeState()
    await bind(state).forkSession({ targetPromptIndex: 1 })
    expect(transport.forkSession).not.toHaveBeenCalled()
    expect(state.entries).toHaveLength(1)
    expect((state.entries[0] as { kind: string; text: string }).kind).toBe('error')
  })

  it('删除当前会话：先 resetToEmpty（bump 世代）再刷新列表，刷新结果才不会失效', async () => {
    const resetToEmpty = vi.fn()
    const state = makeState({ resetToEmpty })
    await bind(state).deleteSession('s1', '/w')
    expect(transport.sessionDelete).toHaveBeenCalledWith('s1', '/w')
    expect(resetToEmpty).toHaveBeenCalled()
    expect(refreshOrder(state)).toBeGreaterThan(resetToEmpty.mock.invocationCallOrder[0])
    expect(state.refreshWorkspaces).toHaveBeenCalled()
  })

  it('删除历史会话：不 resetToEmpty，仍刷新两个列表', async () => {
    const resetToEmpty = vi.fn()
    const state = makeState({ resetToEmpty })
    await bind(state).deleteSession('other', '/w')
    expect(resetToEmpty).not.toHaveBeenCalled()
    expect(state.refreshSessions).toHaveBeenCalled()
    expect(state.refreshWorkspaces).toHaveBeenCalled()
  })
})

/** refreshSessions 的全局调用序（对照 invocationCallOrder 用）。 */
function refreshOrder(state: ChatState): number {
  return (state.refreshSessions as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
}

describe('xaiActions.askBtw', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(transport.btw as ReturnType<typeof vi.fn>).mockResolvedValue({ answer: '**答案**' })
  })

  it('带当前 sessionId 直发 transport.btw（busy 中也发，不进队列）', async () => {
    const state = makeState({ conn: 'busy' })
    await bind(state).askBtw('还剩几步？')
    expect(transport.btw).toHaveBeenCalledWith({
      question: '还剩几步？',
      sessionId: 's1',
    })
  })

  it('等待反馈：先插入 streaming 进行中条目，响应到达后原位更新为答案', async () => {
    const state = makeState()
    const p = bind(state).askBtw('翻译一下')
    // 请求未返回时：一条进行中的 btw 条目（可见等待反馈）。
    expect(state.entries).toHaveLength(1)
    const pending = state.entries[0] as Extract<ChatState['entries'][number], { kind: 'btw' }>
    expect(pending.kind).toBe('btw')
    expect(pending.question).toBe('翻译一下')
    expect(pending.streaming).toBe(true)
    expect(pending.open).toBe(false)
    await p
    // 原位更新：同一条目变为答案，streaming 收口。
    expect(state.entries).toHaveLength(1)
    const done = state.entries[0] as Extract<ChatState['entries'][number], { kind: 'btw' }>
    expect(done).toMatchObject({ kind: 'btw', answer: '**答案**', streaming: false })
  })

  it('失败 → 错误写进同一区块（open 展开直接可见），不静默', async () => {
    ;(transport.btw as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('session not found'))
    const state = makeState()
    await bind(state).askBtw('q')
    expect(state.entries).toHaveLength(1)
    const e = state.entries[0] as Extract<ChatState['entries'][number], { kind: 'btw' }>
    expect(e).toMatchObject({
      kind: 'btw',
      error: 'session not found',
      streaming: false,
      open: true,
    })
  })

  it('无活动会话 → 错误行，不发请求', async () => {
    const state = makeState({ sessionId: undefined })
    await bind(state).askBtw('q')
    expect(transport.btw).not.toHaveBeenCalled()
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({ kind: 'error', text: expect.stringContaining('无活动会话') })
  })

  it('应答晚于切走会话 → 按 id 找不到条目，不污染当前会话滚动区', async () => {
    let resolveBtw: (v: unknown) => void = () => {}
    ;(transport.btw as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((res) => { resolveBtw = res }),
    )
    const state = makeState()
    const p = bind(state).askBtw('慢问题')
    // 请求未返回期间用户切走：loadHistory 重建 → entries 换成新会话的。
    state.entries = []
    state.sessionId = 'other'
    resolveBtw({ answer: '迟到的答案' })
    await p
    expect(state.entries).toHaveLength(0)
  })
})
