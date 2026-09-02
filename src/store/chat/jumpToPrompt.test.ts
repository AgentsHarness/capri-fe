import { beforeEach, describe, expect, it, vi } from 'vitest'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'

vi.mock('../../api/client', () => ({
  transport: {
    loadSessionHistory: vi.fn(),
    queueStatus: vi.fn().mockResolvedValue({ queue: [] }),
    sessionResume: vi.fn(),
    loadSession: vi.fn(),
    sessionStats: vi.fn(),
    sessionRunningTasks: vi.fn(),
    gitInfo: vi.fn(),
    status: vi.fn(),
    rewindExecute: vi.fn(),
    rewindPoints: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    getConnectionMode: vi.fn(() => 'local'),
    prefsOrigin: vi.fn(() => ''),
    getPrefs: vi.fn(async () => ({ prefs: {} })),
    putPrefs: vi.fn(async () => ({})),
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}))

/**
 * 目录跳转（jumpToPrompt）契约测试：已加载快速路径零网络、未加载轮循环
 * loadMoreHistory 直到目标轮入库并解析条目 id、失败/空页中止（绝不死循
 * 环）、会话切走放弃。
 */
const SID = 's-jump'
const CWD = '/w'
const T0 = 1_700_000_000_000
const COARSE = Math.floor(T0 / 1000)

function env(msgSeq: number, update: Record<string, unknown>): unknown {
  return {
    msgSeq,
    timestamp: COARSE,
    method: 'session/update',
    params: {
      sessionId: SID,
      update: {
        ...update,
        _meta: { ...((update._meta as object) ?? {}), agentTimestampMs: T0 + msgSeq },
      },
      _meta: { agentTimestampMs: T0 + msgSeq, turnStartMs: T0 },
    },
  }
}

/** 第一轮（seq 0..8）：user + agent 正文。 */
function turn0Page() {
  const updates = [env(0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '第一轮问题' } })]
  for (let i = 1; i < 9; i++) {
    updates.push(env(i, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `a${i}` } }))
  }
  updates.push(env(9, { sessionUpdate: 'turn_completed', stopReason: 'end_turn' }))
  return {
    updates,
    totalCount: 12,
    hasMore: false,
    promptStarts: [0, 10],
    promptPreviews: ['第一轮问题', '第二轮问题'],
  }
}

function seedLoadedLastTurn() {
  useChatStore.setState({
    sessionId: SID,
    cwd: CWD,
    entries: [
      { id: 'u2', kind: 'user', text: '第二轮问题', msgSeq: 10 },
      { id: 'a2', kind: 'assistant', text: '答', msgSeq: 11 },
    ],
    historySessionId: SID,
    historyCwd: CWD,
    historyHasMore: true,
    historyLoadedStart: 10,
    historyTotalCount: 12,
    historyLoadedCount: 2,
    historyTurnIdx: 1,
    historyPromptStarts: [0, 10],
    historyPromptPreviews: ['第一轮问题', '第二轮问题'],
    historyLoading: false,
    historyLoadingMore: false,
    historyLoadError: undefined,
  })
}

describe('jumpToPrompt', () => {
  beforeEach(() => {
    vi.mocked(transport.loadSessionHistory).mockReset()
    seedLoadedLastTurn()
  })

  it('目标已在已加载区 → 直接解析条目 id，零网络', async () => {
    const id = await useChatStore.getState().jumpToPrompt(10)
    expect(id).toBe('u2')
    expect(transport.loadSessionHistory).not.toHaveBeenCalled()
  })

  it('目标未加载 → 循环加载到目标轮后返回该轮 user 条目 id', async () => {
    const load = vi.mocked(transport.loadSessionHistory).mockResolvedValue(turn0Page())
    const id = await useChatStore.getState().jumpToPrompt(0)
    expect(load).toHaveBeenCalledWith(SID, CWD, { offset: 0, limit: 10 })
    const s = useChatStore.getState()
    expect(s.historyTurnIdx).toBe(0)
    expect(s.historyLoadedStart).toBe(0)
    expect(s.historyHasMore).toBe(false)
    const target = s.entries.find((e) => e.kind === 'user' && e.msgSeq === 0)
    expect(target).toBeDefined()
    expect(id).toBe(target!.id)
  })

  it('目标轮 msgSeq 恰好等于已加载区边界 → 走快速路径', async () => {
    // loadedStart === seq：目标轮已完全加载。
    const id = await useChatStore.getState().jumpToPrompt(10)
    expect(id).toBe('u2')
  })

  it('空页（fetch=0）→ 中止返回 null，不死循环', async () => {
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: [],
      totalCount: 12,
      hasMore: false,
      promptStarts: [0, 10],
    })
    const id = await useChatStore.getState().jumpToPrompt(0)
    expect(id).toBeNull()
    expect(transport.loadSessionHistory).toHaveBeenCalledTimes(1)
  })

  it('翻页失败 → 中止返回 null，错误经 historyLoadError 就地显示', async () => {
    vi.mocked(transport.loadSessionHistory).mockRejectedValue(new Error('boom'))
    const id = await useChatStore.getState().jumpToPrompt(0)
    expect(id).toBeNull()
    expect(useChatStore.getState().historyLoadError).toContain('boom')
  })

  it('循环期间会话被切走 → 放弃返回 null', async () => {
    let resolvePage: ((v: ReturnType<typeof turn0Page>) => void) | undefined
    vi.mocked(transport.loadSessionHistory).mockImplementation(
      () =>
        new Promise((res) => {
          resolvePage = res
        }),
    )
    const p = useChatStore.getState().jumpToPrompt(0)
    await Promise.resolve()
    useChatStore.setState({ sessionId: 'other-session', historySessionId: 'other-session' })
    resolvePage!(turn0Page() as ReturnType<typeof turn0Page>)
    expect(await p).toBeNull()
  })

  it('跳转期间 status 显示进度，结束后恢复原文案', async () => {
    useChatStore.setState({ statusText: '历史已加载 (共 12 条更新)' })
    let resolvePage: ((v: ReturnType<typeof turn0Page>) => void) | undefined
    vi.mocked(transport.loadSessionHistory).mockImplementation(
      () =>
        new Promise((res) => {
          resolvePage = res
        }),
    )
    const p = useChatStore.getState().jumpToPrompt(0)
    // 点击后立即可见（第一页在飞）：status 行 + 补全芯片同源进度。
    await Promise.resolve()
    expect(useChatStore.getState().statusText).toContain('跳转中')
    expect(useChatStore.getState().statusText).toMatch(/2\/2 轮/)
    expect(useChatStore.getState().historyJumpProgress).toEqual({ current: 2, total: 2 })
    resolvePage!(turn0Page() as ReturnType<typeof turn0Page>)
    const id = await p
    const target = useChatStore.getState().entries.find((e) => e.id === id)
    expect(target?.kind).toBe('user')
    expect(target?.msgSeq).toBe(0)
    expect(useChatStore.getState().statusText).toBe('历史已加载 (共 12 条更新)')
    expect(useChatStore.getState().historyJumpProgress).toBeUndefined()
  })

  it('跳转失败：status 同样恢复原文案，不残留「跳转中」', async () => {
    useChatStore.setState({ statusText: '就绪' })
    vi.mocked(transport.loadSessionHistory).mockRejectedValue(new Error('boom'))
    const id = await useChatStore.getState().jumpToPrompt(0)
    expect(id).toBeNull()
    expect(useChatStore.getState().statusText).toBe('就绪')
  })

  it('跳转期间别的路径改过 status → 不覆盖对方的值', async () => {
    useChatStore.setState({ statusText: '历史已加载 (共 12 条更新)' })
    let resolvePage: ((v: ReturnType<typeof turn0Page>) => void) | undefined
    vi.mocked(transport.loadSessionHistory).mockImplementation(
      () =>
        new Promise((res) => {
          resolvePage = res
        }),
    )
    const p = useChatStore.getState().jumpToPrompt(0)
    await Promise.resolve()
    expect(useChatStore.getState().statusText).toContain('跳转中')
    // 模拟循环期间发消息等其他路径写入。
    useChatStore.setState({ statusText: '正在发送…' })
    resolvePage!(turn0Page() as ReturnType<typeof turn0Page>)
    await p
    // 别的路径写入后不得被恢复逻辑覆盖（回放自身还会再写 Responding…，
    // 只要不是「跳转中」残留即证明没有无脑恢复）。
    expect(useChatStore.getState().statusText).not.toContain('跳转中')
  })
})
