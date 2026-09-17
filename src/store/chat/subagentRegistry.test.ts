import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatState } from './types'

vi.mock('../../api/client', () => ({
  transport: { subagentListRunning: vi.fn().mockResolvedValue({ subagents: [] }) },
}))
import { transport } from '../../api/client'
import {
  foldRunningSubagents,
  parseRunningSubagent,
  parseRunningSubagents,
  subagentEntryFrom,
} from './subagentRegistry'
import { liveTaskActions } from './actions/liveTasks'

const SID = 'sess-1'

function makeState(patch: Partial<ChatState> = {}): ChatState {
  return {
    sessionId: SID,
    cwd: '/w',
    entries: [],
    bgTaskIndex: {},
    subagentIndex: {},
    subagentChildIndex: {},
    subagentViews: {},
    topTasks: [],
    ...patch,
  } as unknown as ChatState
}

function bind(initial: ChatState) {
  let current = initial
  const set = (partial: unknown) => {
    current = {
      ...current,
      ...(typeof partial === 'function'
        ? (partial as (s: ChatState) => Partial<ChatState>)(current)
        : (partial as Partial<ChatState>)),
    }
  }
  return {
    get: () => current,
    set,
    actions: liveTaskActions(set as never, () => current) as Pick<
      ChatState,
      'syncLiveSubagents' | 'applyRunningSubagents'
    >,
    snapshot: () => current,
  }
}

describe('parseRunningSubagent', () => {
  it('读 agent 的 camelCase 快照字段', () => {
    const row = parseRunningSubagent({
      subagentId: 'sa-1',
      childSessionId: 'child-1',
      parentSessionId: SID,
      subagentType: 'code-reviewer',
      description: 'Code Reviewer',
      startedAtEpochMs: 1789586267000,
      durationMs: 12000,
      turnCount: 3,
      toolCallCount: 7,
      tokensUsed: 1234,
      contextWindowTokens: 200000,
      contextUsagePct: 42,
      toolsUsed: ['read_file', 'grep'],
      errorCount: 0,
    })
    expect(row).toMatchObject({
      subagentId: 'sa-1',
      childSessionId: 'child-1',
      parentSessionId: SID,
      subagentType: 'code-reviewer',
      description: 'Code Reviewer',
      startedAtMs: 1789586267000,
      durationMs: 12000,
      turns: 3,
      toolCalls: 7,
      tokensUsed: 1234,
      contextWindowTokens: 200000,
      contextUsagePct: 42,
      toolsUsed: ['read_file', 'grep'],
      errorCount: 0,
    })
  })

  it('snake_case 兜底；缺 subagentId 的行丢弃', () => {
    expect(
      parseRunningSubagent({ subagent_id: 'sa-2', child_session_id: 'c2' }),
    ).toMatchObject({ subagentId: 'sa-2', childSessionId: 'c2' })
    expect(parseRunningSubagent({ description: 'no id' })).toBeNull()
    expect(parseRunningSubagent({ subagentId: '   ' })).toBeNull()
  })
})

describe('parseRunningSubagents', () => {
  it('剥掉 host 的 result 包络', () => {
    const rows = parseRunningSubagents({
      ok: true,
      result: { result: { subagents: [{ subagentId: 'a' }, { subagentId: 'b' }] } },
    })
    expect(rows.map((r) => r.subagentId)).toEqual(['a', 'b'])
  })

  it('形状不认识时返回空数组（不抛）', () => {
    expect(parseRunningSubagents(undefined)).toEqual([])
    expect(parseRunningSubagents({ result: { error: 'nope' } })).toEqual([])
  })
})

describe('subagentEntryFrom', () => {
  it('startedAt 取注册表的真实派发时刻，不是拉取时刻', () => {
    const e = subagentEntryFrom(
      { subagentId: 'sa-1', startedAtMs: 1000, description: 'Reviewer' },
      9999,
    )
    expect(e).toMatchObject({
      kind: 'subagent',
      running: true,
      status: 'started',
      title: 'Reviewer',
      subagentId: 'sa-1',
      startedAt: 1000,
    })
  })

  it('注册表没有派发时刻才回落到拉取时刻', () => {
    const e = subagentEntryFrom({ subagentId: 'sa-1' }, 9999)
    expect(e).toMatchObject({ startedAt: 9999, title: 'sa-1' })
  })
})

describe('foldRunningSubagents', () => {
  it('为注册表里没有行的子代理补一条运行中条目，并建子会话索引', () => {
    const state = makeState()
    const patch = foldRunningSubagents(
      () => state,
      [{ subagentId: 'sa-1', childSessionId: 'c1', description: 'Reviewer' }],
      5000,
    )
    expect(patch).not.toBeNull()
    expect(patch!.entries).toHaveLength(1)
    expect(patch!.entries[0]).toMatchObject({
      kind: 'subagent',
      running: true,
      subagentId: 'sa-1',
      childSessionId: 'c1',
      startedAt: 5000,
    })
    expect(patch!.subagentIndex).toEqual({ 'sa-1': patch!.entries[0].id })
    expect(patch!.subagentChildIndex).toEqual({ c1: patch!.entries[0].id })
    // 迷你时间线视图占位：宿主为该子会话广播的事件流才有地方落。
    expect(patch!.subagentViews.c1).toEqual({ items: [], fetchState: 'idle' })
  })

  it('已有行只合进度，绝不重建（保住回放拿到的 persona/role 元信息）', () => {
    const existing = {
      id: 'e1',
      kind: 'subagent',
      title: 'Reviewer',
      status: 'started',
      running: true,
      subagentId: 'sa-1',
      persona: 'strict',
      role: 'critic',
      startedAt: 111,
    } as never
    const state = makeState({
      entries: [existing],
      subagentIndex: { 'sa-1': 'e1' },
    })
    const patch = foldRunningSubagents(
      () => state,
      [{ subagentId: 'sa-1', turns: 4, toolCalls: 9, contextUsagePct: 33 }],
      5000,
    )
    expect(patch!.entries).toHaveLength(1)
    expect(patch!.entries[0]).toMatchObject({
      id: 'e1',
      persona: 'strict',
      role: 'critic',
      startedAt: 111,
      turns: 4,
      toolCalls: 9,
      contextUsagePct: 33,
    })
    // 已有行不重复建索引
    expect(patch!.subagentIndex).toEqual({ 'sa-1': 'e1' })
  })

  it('空注册表不据缺失收口（返回 null，什么都不改）', () => {
    const state = makeState({
      entries: [
        {
          id: 'e1',
          kind: 'subagent',
          title: 'still running',
          status: 'started',
          running: true,
          subagentId: 'sa-1',
        } as never,
      ],
    })
    expect(foldRunningSubagents(() => state, [], 5000)).toBeNull()
    expect(state.entries[0]).toMatchObject({ running: true })
  })
})

describe('syncLiveSubagents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('按 parentSessionId 过滤掉别的会话的行', async () => {
    ;(transport.subagentListRunning as ReturnType<typeof vi.fn>).mockResolvedValue({
      subagents: [
        { subagentId: 'mine', parentSessionId: SID },
        { subagentId: 'other', parentSessionId: 'other-session' },
      ],
    })
    const h = bind(makeState())
    await h.actions.syncLiveSubagents(SID)
    expect(h.snapshot().entries.map((e) => (e as { subagentId?: string }).subagentId)).toEqual([
      'mine',
    ])
  })

  it("mode 'defer' 只取数不落地（回放会整体替换 entries）", async () => {
    ;(transport.subagentListRunning as ReturnType<typeof vi.fn>).mockResolvedValue({
      subagents: [{ subagentId: 'sa-1', parentSessionId: SID }],
    })
    const h = bind(makeState())
    const rows = await h.actions.syncLiveSubagents(SID, 'defer')
    expect(rows.map((r) => r.subagentId)).toEqual(['sa-1'])
    expect(h.snapshot().entries).toEqual([])

    h.actions.applyRunningSubagents(rows)
    expect(h.snapshot().entries).toHaveLength(1)
  })

  it('请求失败 → 空数组且不动视图', async () => {
    ;(transport.subagentListRunning as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('offline'),
    )
    const h = bind(makeState())
    expect(await h.actions.syncLiveSubagents(SID)).toEqual([])
    expect(h.snapshot().entries).toEqual([])
  })
})
