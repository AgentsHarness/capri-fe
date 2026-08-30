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
  return xaiActions(set, () => state) as Pick<ChatState, 'forkSession' | 'deleteSession'>
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
