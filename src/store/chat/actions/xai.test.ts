import { beforeEach, describe, expect, it, vi } from 'vitest'
import { xaiActions } from './xai'
import type { ChatState, SetState } from '../types'

vi.mock('../../../api/client', () => ({
  transport: {
    forkSession: vi.fn().mockResolvedValue({ result: { newSessionId: 'fork-1' } }),
    rewindPoints: vi.fn().mockResolvedValue({ points: [{ index: 0 }, { index: 1 }, { index: 2 }] }),
    // 精简回放模块在导入期就挂 prefs_changed 监听并读连接模式（liteReplay
    // 默认值按 hub / local 取），替身必须带上这两个。
    onEvent: vi.fn(() => () => {}),
    getConnectionMode: vi.fn(() => 'local'),
    rewindExecute: vi.fn().mockResolvedValue({
      success: true,
      targetPromptIndex: 1,
      promptText: 'hi',
    }),
    loadSessionHistory: vi.fn().mockResolvedValue({
      promptStarts: [0],
      totalCount: 2,
      updates: [],
    }),
    gitWorktreeResumeSession: vi
      .fn()
      .mockResolvedValue({ sessionId: 'wt-1', worktreePath: '/wt', effectiveCwd: '/wt/x' }),
    sessionDelete: vi.fn().mockResolvedValue({}),
    btw: vi.fn().mockResolvedValue({ answer: '**答案**' }),
    memoryRewrite: vi.fn().mockResolvedValue({
      ok: true,
      result: { rewritten: '## 部署\n\n- eu-west 集群' },
    }),
  },
}))

vi.mock('../../toast', () => ({
  pushToast: vi.fn(),
}))

import { transport } from '../../../api/client'
import { pushToast } from '../../toast'
import { usePins } from '../../historyPins'
import { restorePlanMode, savePlanMode } from '../modePersist'

/** 最小 ChatState：forkSession 只触碰这里列出的字段。 */
function makeState(patch: Partial<ChatState> = {}): ChatState {
  const state = {
    sessionId: 's1',
    cwd: '/w',
    conn: 'ready',
    entries: [],
    scheduledTasks: [],
    historyTurnIdx: 0,
    loadHistory: vi.fn().mockResolvedValue(undefined),
    // 重载走 loadHistoryWithTaskProbe：需要探活与（有才开的）轮询
    replayRunningTasks: vi.fn().mockResolvedValue(undefined),
    startTopTaskPolling: vi.fn(),
    topTasks: [],
    continueSession: vi.fn().mockResolvedValue(undefined),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    refreshWorkspaces: vi.fn().mockResolvedValue(undefined),
    clearCompletedNotice: vi.fn(),
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
    'forkSession' | 'deleteSession' | 'askBtw' | 'rememberNote' | 'rewindExecute'
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

  it('删除会话同步清理 prefs（置顶/待办）、completedNotice 和 planMode', async () => {
    usePins.getState().toggleSessionPin('s-del')
    usePins.getState().setTodoStatus('s-del', 'todo')
    savePlanMode('s-del', true)
    const clearCompletedNotice = vi.fn()
    const state = makeState({ clearCompletedNotice })

    await bind(state).deleteSession('s-del', '/w')

    expect(usePins.getState().pinnedSessions.has('s-del')).toBe(false)
    expect(usePins.getState().todos['s-del']).toBeUndefined()
    expect(clearCompletedNotice).toHaveBeenCalledWith('s-del')
    expect(restorePlanMode('s-del')).toEqual({})
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
    // 默认展开：FE 没有 TUI 的 inline btw panel，折叠 = 答案不可见。
    expect(pending.open).toBe(true)
    await p
    // 原位更新：同一条目变为答案，streaming 收口。
    expect(state.entries).toHaveLength(1)
    const done = state.entries[0] as Extract<ChatState['entries'][number], { kind: 'btw' }>
    expect(done).toMatchObject({
      kind: 'btw',
      answer: '**答案**',
      streaming: false,
      open: true,
    })
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

describe('xaiActions.rememberNote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(transport.memoryRewrite as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      result: { rewritten: '## 部署\n\n- eu-west 集群' },
    })
  })

  it('有会话 → memoryRewrite 带显式 sessionId 与原文；反馈行含改写稿与原文', async () => {
    const state = makeState({
      cwd: '/w',
      entries: [
        { id: 'u1', kind: 'user', text: '第一段对话' },
        { id: 'u2', kind: 'user', text: '第二段对话' },
      ],
    })
    await bind(state).rememberNote('部署用 eu-west')
    expect(transport.memoryRewrite).toHaveBeenCalledWith(
      's1',
      '部署用 eu-west',
      expect.stringContaining('CWD: /w'),
    )
    const ctx = (transport.memoryRewrite as ReturnType<typeof vi.fn>).mock
      .calls[0][2] as string
    expect(ctx).toContain('- 第一段对话')
    expect(ctx).toContain('- 第二段对话')
    expect(state.entries).toHaveLength(3)
    const e = state.entries[2] as { kind: string; text: string }
    expect(e.kind).toBe('session_event')
    expect(e.text).toContain('改写稿')
    expect(e.text).toContain('eu-west 集群')
    expect(e.text).toContain('部署用 eu-west')
  })

  it('rewritten 缺失 → 展示原文（不回退到提示词路径）', async () => {
    ;(transport.memoryRewrite as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      result: {},
    })
    const state = makeState()
    await bind(state).rememberNote('原文笔记')
    expect(transport.memoryRewrite).toHaveBeenCalled()
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({
      kind: 'session_event',
      text: expect.stringContaining('原文笔记'),
    })
  })

  it('无活动会话 → 错误行，不发请求', async () => {
    const state = makeState({ sessionId: undefined })
    await bind(state).rememberNote('x')
    expect(transport.memoryRewrite).not.toHaveBeenCalled()
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('无活动会话'),
    })
  })

  it('请求失败 → 错误行可见', async () => {
    ;(transport.memoryRewrite as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('rewrite failed'),
    )
    const state = makeState()
    await bind(state).rememberNote('x')
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('rewrite failed'),
    })
  })
})

describe('xaiActions.rewindExecute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(transport.rewindExecute as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      targetPromptIndex: 1,
      promptText: 'hi',
    })
    ;(transport.loadSessionHistory as ReturnType<typeof vi.fn>).mockResolvedValue({
      promptStarts: [0],
      totalCount: 2,
      updates: [],
    })
  })

  /** 4 条滚动区条目：轮 0 的 user+assistant 与轮 1 的 user+assistant。 */
  const twoTurns = [
    { id: 'u0', kind: 'user', text: '第一问' },
    { id: 'a0', kind: 'assistant', text: '第一答' },
    { id: 'u1', kind: 'user', text: '第二问' },
    { id: 'a1', kind: 'assistant', text: '第二答' },
  ] as ChatState['entries']

  it('成功 → 本地按 target 立即截断，对齐后全量重载（scheduledTasks 暂存跨重载）', async () => {
    const state = makeState({
      historyTurnIdx: 0,
      entries: twoTurns,
      scheduledTasks: [{ taskId: 't1' } as never],
    })
    ;(transport.rewindExecute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      targetPromptIndex: 1,
    })
    await bind(state).rewindExecute(1, 'conversation_only')
    // 轮 1 起的条目被本地截掉，显示立即正确。
    expect(state.entries.map((e) => e.id)).toEqual(['u0', 'a0'])
    // 对齐探针（promptStarts=[0] ≤ target 1）通过后才重载，且只重载一次。
    expect(transport.loadSessionHistory).toHaveBeenCalledTimes(1)
    // 探针只要 promptStarts：恒传 detail=meta（与精简回放开关无关，不拉整页）。
    expect(transport.loadSessionHistory).toHaveBeenCalledWith('s1', '/w', {
      turnIndex: 1,
      detail: 'meta',
    })
    expect(state.loadHistory).toHaveBeenCalledWith('s1', '/w', {
      awaitBeforeReplay: expect.any(Promise),
    })
    expect(state.scheduledTasks).toHaveLength(1)
  })

  it('无 targetPromptIndex（旧 agent 响应）→ 跳过探针直接重载（老行为）', async () => {
    ;(transport.rewindExecute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
    })
    const state = makeState()
    await bind(state).rewindExecute(1, 'conversation_only')
    expect(transport.loadSessionHistory).not.toHaveBeenCalled()
    expect(state.loadHistory).toHaveBeenCalledTimes(1)
  })

  it('首次探针未对齐（marker 未落盘）→ 退避重试，对齐后才重载', async () => {
    vi.useFakeTimers()
    try {
      ;(transport.rewindExecute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        targetPromptIndex: 2,
      })
      // 探针 1：未截断（3 轮 > target 2）；探针 2：标记已落盘（2 轮）。
      ;(transport.loadSessionHistory as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ promptStarts: [0, 1, 2], totalCount: 9, updates: [] })
        .mockResolvedValueOnce({ promptStarts: [0, 1], totalCount: 4, updates: [] })
      const state = makeState({ historyTurnIdx: 0, entries: twoTurns })
      const p = bind(state).rewindExecute(2, 'conversation_only')
      await vi.advanceTimersByTimeAsync(250)
      await p
      expect(transport.loadSessionHistory).toHaveBeenCalledTimes(2)
      expect(state.loadHistory).toHaveBeenCalledTimes(1)
      // 等待期间显示保持本地截断（轮 2 起被删）。
      expect(state.entries.map((e) => e.id)).toEqual(['u0', 'a0', 'u1', 'a1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('重试窗口内始终未对齐 → 保留本地截断视图、不重载，状态行提示未就绪', async () => {
    vi.useFakeTimers()
    try {
      ;(transport.rewindExecute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        targetPromptIndex: 1,
      })
      // 所有探针都返回未截断的历史（marker 始终未落盘 / 会话走 agent 透传）。
      ;(transport.loadSessionHistory as ReturnType<typeof vi.fn>).mockResolvedValue({
        promptStarts: [0, 1, 2],
        totalCount: 9,
        updates: [],
      })
      const state = makeState({ historyTurnIdx: 0, entries: twoTurns })
      const p = bind(state).rewindExecute(1, 'conversation_only')
      // 0 + 250 + 500 + 750 = 4 次探针全部未对齐后收口。
      await vi.advanceTimersByTimeAsync(1500)
      await p
      expect(transport.loadSessionHistory).toHaveBeenCalledTimes(4)
      expect(state.loadHistory).not.toHaveBeenCalled()
      // 过期页不覆盖本地截断：轮 1 起的条目仍被删掉。
      expect(state.entries.map((e) => e.id)).toEqual(['u0', 'a0'])
      expect(state.statusText).toContain('历史刷新未就绪')
    } finally {
      vi.useRealTimers()
    }
  })

  it('切走会话后响应到达 → 不截断新会话视图、不重载旧会话', async () => {
    ;(transport.rewindExecute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      targetPromptIndex: 1,
    })
    // RPC 期间整体替换状态对象（zustand set → 新快照）：get() 闭包读取
    // 可变 current，rewindExecute 开头捕获的 s 停留在旧对象——与真实
    // store 的「旧快照 vs 新状态」一致，会话切换守卫才能生效。bind 的
    // get 固定绑定参数对象，这里手写同款 set/get。
    let current = makeState({ entries: twoTurns })
    const set: SetState = (partial) => {
      Object.assign(current, typeof partial === 'function' ? partial(current) : partial)
    }
    const api = xaiActions(set, () => current) as Pick<ChatState, 'rewindExecute'>
    const p = api.rewindExecute(1, 'conversation_only')
    // RPC 返回前用户切走：状态对象换成新会话。
    current = {
      ...current,
      sessionId: 'other',
      entries: [{ id: 'nx', kind: 'user', text: '新会话' }],
    }
    await p
    expect(current.entries.map((e) => e.id)).toEqual(['nx'])
    expect(current.loadHistory).not.toHaveBeenCalled()
  })

  it('切走会话后成功响应到达 → 状态行与 stashedDraft 也不写进新视图', async () => {
    ;(transport.rewindExecute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      targetPromptIndex: 1,
      promptText: '被回退的那条 prompt',
    })
    let current = makeState({ entries: twoTurns, statusText: '就绪' })
    const set: SetState = (partial) => {
      Object.assign(current, typeof partial === 'function' ? partial(current) : partial)
    }
    const api = xaiActions(set, () => current) as Pick<ChatState, 'rewindExecute'>
    const p = api.rewindExecute(1, 'conversation_only')
    current = { ...current, sessionId: 'other', statusText: '就绪', stashedDraft: '新会话草稿' }
    await p
    expect(current.statusText).toBe('就绪')
    expect(current.stashedDraft).toBe('新会话草稿')
  })

  it('切走会话后请求失败 → 不在新会话里落「回退失败」错误行（仍向上抛）', async () => {
    ;(transport.rewindExecute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('rewind failed'),
    )
    let current = makeState({ entries: twoTurns })
    const set: SetState = (partial) => {
      Object.assign(current, typeof partial === 'function' ? partial(current) : partial)
    }
    const api = xaiActions(set, () => current) as Pick<ChatState, 'rewindExecute'>
    const p = api.rewindExecute(1, 'conversation_only')
    current = { ...current, sessionId: 'other', entries: [{ id: 'nx', kind: 'user', text: '新会话' }] }
    await expect(p).rejects.toThrow('rewind failed')
    expect(current.entries.map((e) => e.id)).toEqual(['nx'])
  })
})
