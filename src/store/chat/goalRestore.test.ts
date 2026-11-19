import { beforeEach, describe, expect, it, vi } from 'vitest'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'

vi.mock('../../api/client', () => ({
  transport: {
    loadSessionHistory: vi.fn(),
    goalStatus: vi.fn(),
    queueStatus: vi.fn().mockResolvedValue({ queue: [] }),
    onEvent: vi.fn(() => () => {}),
    getConnectionMode: vi.fn(() => 'local'),
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}))

const SID = 's-goal'
const CWD = '/w'

const page = () => ({
  updates: [],
  promptStarts: [],
  totalCount: 0,
  hasMore: false,
})

const goal = (objective: string, status: string) => ({
  objective,
  status,
  phase: 'executing',
  started_at: 1_700_000_000_000,
  elapsed_ms: 1_000,
})

/** Live typed goal_updated，与 host dispatch 的形状一致。 */
const goalEvent = (status: string, objective: string) =>
  ({
    type: 'goal_updated',
    sessionId: SID,
    update: { sessionUpdate: 'goal_updated', status, objective },
  }) as never

describe('loadHistory 恢复 goal 状态', () => {
  beforeEach(() => {
    vi.mocked(transport.loadSessionHistory).mockReset()
    vi.mocked(transport.loadSessionHistory).mockResolvedValue(page() as never)
    vi.mocked(transport.goalStatus).mockReset()
    vi.mocked(transport.goalStatus).mockResolvedValue({ ok: true, goal: null } as never)
    useChatStore.setState({
      sessionId: SID,
      cwd: CWD,
      entries: [],
      historyLoading: false,
      guestIdentity: undefined,
      goalState: undefined,
      goalReceivedAt: undefined,
    })
  })

  it('回放不含 goal_updated 时按会话拉取 host 侧 goal 并显示', async () => {
    vi.mocked(transport.goalStatus).mockResolvedValue({
      ok: true,
      goal: goal('修好构建', 'active'),
    } as never)

    await useChatStore.getState().loadHistory(SID, CWD)
    await Promise.resolve()

    expect(transport.goalStatus).toHaveBeenCalledWith(SID)
    expect(useChatStore.getState().goalState).toMatchObject({
      objective: '修好构建',
      status: 'active',
    })
  })

  it('加载期间到达的 live goal_updated 不会被更旧的 status 快照覆盖', async () => {
    let finish!: (value: never) => void
    vi.mocked(transport.goalStatus).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve as (value: never) => void
      }) as never,
    )

    await useChatStore.getState().loadHistory(SID, CWD)
    useChatStore.getState().handleEvent(goalEvent('complete', 'live 完成'))
    expect(useChatStore.getState().goalState).toMatchObject({ status: 'complete' })

    finish({ ok: true, goal: goal('snapshot', 'active') } as never)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useChatStore.getState().goalState).toMatchObject({
      objective: 'live 完成',
      status: 'complete',
    })
  })

  it('cleared 目标不恢复（避免残留的交付项计数点亮 TodoChip）', async () => {
    vi.mocked(transport.goalStatus).mockResolvedValue({
      ok: true,
      goal: { ...goal('已清掉', 'cleared'), total_deliverables: 5, completed_deliverables: 3 },
    } as never)

    await useChatStore.getState().loadHistory(SID, CWD)
    await Promise.resolve()

    expect(useChatStore.getState().goalState).toBeUndefined()
  })

  it('host 没有 goal（null / 失败）时不写状态，也不破坏历史加载', async () => {
    vi.mocked(transport.goalStatus).mockRejectedValue(new Error('404'))

    await useChatStore.getState().loadHistory(SID, CWD)
    await Promise.resolve()

    expect(useChatStore.getState().historyLoading).toBe(false)
    expect(useChatStore.getState().goalState).toBeUndefined()
  })

  it('访客不请求 goal 状态（hub 中继白名单不含该端点）', async () => {
    useChatStore.setState({
      guestIdentity: {
        role: 'guest',
        guest: { id: 'g1', label: '访客', expiresAt: 0 },
        sessions: [],
      },
    })

    await useChatStore.getState().loadHistory(SID, CWD)
    await Promise.resolve()

    expect(transport.goalStatus).not.toHaveBeenCalled()
  })
})
