// @vitest-environment node
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

const page = (over: Record<string, unknown> = {}) => ({
  updates: [],
  promptStarts: [],
  totalCount: 0,
  hasMore: false,
  ...over,
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

describe('loadHistory 从回放页恢复 goal 状态', () => {
  beforeEach(() => {
    vi.mocked(transport.loadSessionHistory).mockReset()
    vi.mocked(transport.loadSessionHistory).mockResolvedValue(page())
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

  it('回放页自带 goal 时恢复状态，不发额外的状态请求', async () => {
    vi.mocked(transport.loadSessionHistory).mockResolvedValue(
      page({ goal: goal('修好构建', 'active') }),
    )

    await useChatStore.getState().loadHistory(SID, CWD)
    await Promise.resolve()

    expect(useChatStore.getState().goalState).toMatchObject({
      objective: '修好构建',
      status: 'active',
    })
    expect(transport.goalStatus).not.toHaveBeenCalled()
  })

  it('回放页 goal 为 null 时不写状态', async () => {
    vi.mocked(transport.loadSessionHistory).mockResolvedValue(page({ goal: null }))

    await useChatStore.getState().loadHistory(SID, CWD)
    await Promise.resolve()

    expect(useChatStore.getState().goalState).toBeUndefined()
    expect(transport.goalStatus).not.toHaveBeenCalled()
  })

  it('cleared 目标不恢复（避免残留的交付项计数点亮 TodoChip）', async () => {
    vi.mocked(transport.loadSessionHistory).mockResolvedValue(
      page({
        goal: {
          ...goal('已清掉', 'cleared'),
          total_deliverables: 5,
          completed_deliverables: 3,
        },
      }),
    )

    await useChatStore.getState().loadHistory(SID, CWD)
    await Promise.resolve()

    expect(useChatStore.getState().goalState).toBeUndefined()
  })

  it('加载期间到达的 live goal_updated 不会被更旧的快照覆盖', async () => {
    let finish!: (value: never) => void
    vi.mocked(transport.loadSessionHistory).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve as never
      }) as never,
    )

    const loading = useChatStore.getState().loadHistory(SID, CWD)
    await Promise.resolve()
    useChatStore.getState().handleEvent(goalEvent('complete', 'live 完成'))
    expect(useChatStore.getState().goalState).toMatchObject({ status: 'complete' })

    finish(page({ goal: goal('snapshot', 'active') }) as never)
    await loading
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useChatStore.getState().goalState).toMatchObject({
      objective: 'live 完成',
      status: 'complete',
    })
  })

  it('旧 host（响应缺 goal 键）回退到一次 /api/goal/status', async () => {
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

  it('旧 host 回退返回 null 时不写状态', async () => {
    await useChatStore.getState().loadHistory(SID, CWD)
    await Promise.resolve()

    expect(transport.goalStatus).toHaveBeenCalledWith(SID)
    expect(useChatStore.getState().goalState).toBeUndefined()
  })

  it('旧 host 回退请求失败不破坏历史加载', async () => {
    vi.mocked(transport.goalStatus).mockRejectedValue(new Error('404'))

    await useChatStore.getState().loadHistory(SID, CWD)
    await Promise.resolve()

    expect(useChatStore.getState().historyLoading).toBe(false)
    expect(useChatStore.getState().goalState).toBeUndefined()
  })

  it('访客在旧 host 上不回退查询（hub 中继白名单不含该端点）', async () => {
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

  it('访客在新 host 上直接使用回放页里的 goal', async () => {
    useChatStore.setState({
      guestIdentity: {
        role: 'guest',
        guest: { id: 'g1', label: '访客', expiresAt: 0 },
        sessions: [],
      },
    })
    vi.mocked(transport.loadSessionHistory).mockResolvedValue(
      page({ goal: goal('访客可见', 'active') }),
    )

    await useChatStore.getState().loadHistory(SID, CWD)
    await Promise.resolve()

    expect(useChatStore.getState().goalState).toMatchObject({
      objective: '访客可见',
      status: 'active',
    })
    expect(transport.goalStatus).not.toHaveBeenCalled()
  })
})
