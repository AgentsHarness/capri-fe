import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpEvent, ScrollEntry, SessionHistoryPage, ToolCall } from '../../api/types'
import { transport } from '../../api/client'
import { usePins } from '../historyPins'
import { useChatStore } from '../chat'
import { runtime, clearContinueSessionTimer } from './globals'
import {
  applyToolBodies,
  extractToolBodies,
  flushScheduledPageFills,
  liteFillSummary,
  resetLiteCapability,
  resetToolFillCache,
  toolEntryLiteOmitted,
  toolEntryLitePending,
  toolEntryNeedsFill,
} from './historyFill'
import { replayEnvelopeKeys, replayEventKeys } from './envelopeParse'
import {
  detailIsEmpty,
  extractToolDetail,
  liteOmittedBytes,
  toolBodyOmitted,
  toolBodyStillOwed,
} from '../../scrollback/toolDetail'
import { toolHeaderExtra } from '../../scrollback/toolHeaderExtra'
import { entryFoldable, toolHasExpandableBody } from '../../scrollback/entryState'

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
    // setFePrefs 会防抖回写 hub —— 给全 prefs 三件套，免得模块级 push 抛错。
    prefsOrigin: vi.fn(() => ''),
    getPrefs: vi.fn(async () => ({ prefs: {} })),
    putPrefs: vi.fn(async () => ({})),
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}))

/**
 * 精简回放（lite）FE 侧契约测试：`detail` 请求档位与 host 能力回显（含旧
 * host 降级）、条目的 lite 坐标（msgSeqEnd / liteOmitted）、只填工具正文的
 * 补全（幂等、行数与文本零变化、切会话作废、预算闸门、就地重试），以及
 * P4 的 session/load noReplay 回退分支。
 */
const SID = 's-lite'
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

/**
 * host lite 投影过的工具信封：`content` 数组换成 `{type, omitted}`，
 * `rawOutput.output` 换成 `{omitted}`，标记打在 `update._meta.lite`。
 */
function liteToolEnvelopes(): unknown[] {
  return [
    env(1, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      kind: 'execute',
      status: 'in_progress',
      title: 'ls -al',
      rawInput: { command: 'ls -al' },
      content: [{ type: 'content', omitted: 900 }],
      _meta: {
        'x.ai/tool': { name: 'execute', kind: 'execute', label: 'Bash' },
        lite: { omitted: 900, fields: ['content'] },
      },
    }),
    env(2, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      rawOutput: { Bash: { output: { omitted: 300 }, exit_code: 0, truncated: false } },
      _meta: { lite: { omitted: 300, fields: ['rawOutput.output'] } },
    }),
  ]
}

/** 同两条信封的全量形态（host 没裁 = 今天的样子）。 */
function fullToolEnvelopes(): unknown[] {
  return [
    env(1, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      kind: 'execute',
      status: 'in_progress',
      title: 'ls -al',
      rawInput: { command: 'ls -al' },
      content: [{ type: 'content', content: { type: 'text', text: '$ ls -al' } }],
      _meta: { 'x.ai/tool': { name: 'execute', kind: 'execute', label: 'Bash' } },
    }),
    env(2, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      rawOutput: {
        Bash: { output: 'total 8\ndrwxr-x .\ndrwxr-x ..', exit_code: 0, truncated: false },
      },
    }),
  ]
}

function litePage(over: Partial<SessionHistoryPage> = {}): SessionHistoryPage {
  return {
    updates: [
      env(0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '跑一下' } }),
      ...liteToolEnvelopes(),
      env(3, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成' } }),
      env(4, { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }),
    ],
    promptStarts: [0],
    totalCount: 5,
    hasMore: false,
    projected: 'lite',
    omittedBytes: 4096,
    ...over,
  }
}

function fullPage(over: Partial<SessionHistoryPage> = {}): SessionHistoryPage {
  return {
    updates: [
      env(0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '跑一下' } }),
      ...fullToolEnvelopes(),
      env(3, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成' } }),
      env(4, { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }),
    ],
    promptStarts: [0],
    totalCount: 5,
    hasMore: false,
    ...over,
  }
}

const toolEntry = (): Extract<ScrollEntry, { kind: 'tool' }> | undefined =>
  useChatStore
    .getState()
    .entries.find((e) => e.kind === 'tool') as
    | Extract<ScrollEntry, { kind: 'tool' }>
    | undefined

const fullCalls = () =>
  vi
    .mocked(transport.loadSessionHistory)
    .mock.calls.filter((c) => (c[2] as { detail?: string } | undefined)?.detail === 'full')

beforeEach(() => {
  vi.clearAllMocks()
  // 后台补全走 requestIdleCallback（缺失才 setTimeout(0) 兜底）——一律置空
  // 走定时器分支，用例里的「转一轮宏任务」才是确定的。
  vi.stubGlobal('requestIdleCallback', undefined)
  vi.stubGlobal('cancelIdleCallback', undefined)
  // 去重集合按「这一批条目」为作用域；代际推进让上个用例的在途请求作废。
  runtime.sessionSwitchGen += 1
  resetToolFillCache()
  // host 能力档案是模块级的：不清掉的话，降级用例会把这个 host 的 lite
  // 一直停用，后面的用例就再也看不到 detail=lite 请求。
  resetLiteCapability()
  useChatStore.setState({
    sessionId: SID,
    cwd: CWD,
    hostId: 'h1',
    selectedHostId: undefined,
    entries: [],
    pending: [],
    historyLoading: false,
    historyLoadingMore: false,
    subagentViews: {},
  })
})

afterEach(() => {
  useChatStore.getState().stopTopTaskPolling()
  useChatStore.setState({ entries: [], sessionId: undefined, cwd: undefined })
})

describe('detail 请求档位与 host 能力回显', () => {
  it('开关开：首页带 detail=lite；条目记 msgSeqEnd / liteOmitted 坐标', async () => {
    usePins.getState().setFePrefs({ liteReplay: true })
    const load = vi.mocked(transport.loadSessionHistory).mockResolvedValue(litePage())

    await useChatStore.getState().loadHistory(SID, CWD)

    expect(load).toHaveBeenCalledWith(SID, CWD, { turnIndex: 1, detail: 'lite' })
    const e = toolEntry()
    expect(e?.msgSeq).toBe(1)
    // 最后一条碰到该行的信封 = tool_call_update 的 2（补全区间右端）。
    expect(e?.msgSeqEnd).toBe(2)
    expect(e?.liteOmitted).toBe(1200)
    expect(e?.liteState).toBeUndefined()
    expect(toolEntryNeedsFill(e!)).toBe(true)
    expect(toolEntryLitePending(e!)).toBe(true)
    expect(useChatStore.getState().historyProjected).toBe('lite')
    expect(useChatStore.getState().historyOmittedBytes).toBe(4096)
  })

  it('旧 host 不回 projected：本次按 full 渲染、零占位残留，并停用该 host 的 lite', async () => {
    usePins.getState().setFePrefs({ liteReplay: true })
    // 旧 host 不认识 detail → 原样回全量页、不带 projected。
    const load = vi.mocked(transport.loadSessionHistory).mockResolvedValue(fullPage())

    await useChatStore.getState().loadHistory(SID, CWD)
    expect(load).toHaveBeenLastCalledWith(SID, CWD, { turnIndex: 1, detail: 'lite' })
    const e = toolEntry()
    expect(e?.liteOmitted).toBeUndefined()
    expect(e?.liteState).toBeUndefined()
    expect(toolEntryLitePending(e!)).toBe(false)
    // 正文本来就是全量 → 直接可读。
    expect((e?.raw?.rawOutput as { Bash: { output: string } }).Bash.output).toContain('total 8')

    await useChatStore.getState().loadHistory(SID, CWD)
    expect(load).toHaveBeenLastCalledWith(SID, CWD, { turnIndex: 1 })
  })

  it('开关关：首页与翻页请求逐字节同今天（连 detail 键都不带）', async () => {
    usePins.getState().setFePrefs({ liteReplay: false })
    const load = vi.mocked(transport.loadSessionHistory).mockResolvedValue(fullPage())

    await useChatStore.getState().loadHistory(SID, CWD)
    expect(load).toHaveBeenLastCalledWith(SID, CWD, { turnIndex: 1 })
    expect(
      useChatStore.getState().entries.every((e) => e.kind !== 'tool' || e.liteOmitted === undefined),
    ).toBe(true)

    // 上滑翻页：按轮次窗口 [promptStarts[0], min(promptStarts[1], loadedStart))。
    useChatStore.setState({
      historySessionId: SID,
      historyCwd: CWD,
      historyHasMore: true,
      historyLoadedStart: 3,
      historyTotalCount: 3,
      historyLoadedCount: 1,
      historyTurnIdx: 1,
      historyPromptStarts: [0, 3],
    })
    await useChatStore.getState().loadMoreHistory()
    expect(load).toHaveBeenLastCalledWith(SID, CWD, { offset: 0, limit: 3 })
    expect(fullCalls()).toHaveLength(0)
  })
})

describe('只填工具正文的补全', () => {
  beforeEach(() => {
    usePins.getState().setFePrefs({ liteReplay: true })
  })

  it('幂等：填两次结果一致；行数 / 顺序 / 非工具条目逐字段零变化', async () => {
    const load = vi
      .mocked(transport.loadSessionHistory)
      .mockResolvedValueOnce(litePage())
      .mockResolvedValue(fullPage())
    await useChatStore.getState().loadHistory(SID, CWD)
    const before = useChatStore.getState().entries
    // 深拷贝快照：非工具条目必须逐字段不变（引用相等不算证据）。
    const nonToolBefore = JSON.parse(JSON.stringify(before.filter((e) => e.kind !== 'tool')))
    const e0 = toolEntry()!
    expect(e0.liteOmitted).toBe(1200)
    // 首页请求档位（开关开 + host 支持）。
    expect(load).toHaveBeenCalledWith(SID, CWD, { turnIndex: 1, detail: 'lite' })

    await useChatStore.getState().fillToolEntryDetail(e0.id)

    // 区间精确到该条目的 [msgSeq, msgSeqEnd]，档位显式 full。
    expect(load).toHaveBeenLastCalledWith(SID, CWD, { offset: 1, limit: 2, detail: 'full' })
    const after = useChatStore.getState().entries
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id))
    expect(after.map((e) => e.kind)).toEqual(before.map((e) => e.kind))
    expect(JSON.parse(JSON.stringify(after.filter((e) => e.kind !== 'tool')))).toEqual(
      nonToolBefore,
    )
    const e1 = after.find((e) => e.id === e0.id) as Extract<ScrollEntry, { kind: 'tool' }>
    expect((e1.raw?.rawOutput as { Bash: { output: string } }).Bash.output).toContain('total 8')
    expect((e1.raw?.content as unknown[])).toEqual([
      { type: 'content', content: { type: 'text', text: '$ ls -al' } },
    ])
    expect(e1.status).toBe(e0.status)
    expect(e1.title).toBe(e0.title)
    expect(e1.msgSeqEnd).toBe(2)
    expect(e1.liteState).toBe('filled')
    expect(toolEntryLitePending(e1)).toBe(false)

    // 再补一次：不发请求、条目一字不变。
    const calls = load.mock.calls.length
    await useChatStore.getState().fillToolEntryDetail(e0.id)
    expect(load.mock.calls.length).toBe(calls)
    expect(useChatStore.getState().entries).toBe(after)
  })

  it('同一区间只拉一次（并发展开共享一次在途请求）', async () => {
    vi.mocked(transport.loadSessionHistory)
      .mockResolvedValueOnce(litePage())
      .mockResolvedValue(fullPage())
    await useChatStore.getState().loadHistory(SID, CWD)
    const id = toolEntry()!.id
    await Promise.all([
      useChatStore.getState().fillToolEntryDetail(id),
      useChatStore.getState().fillToolEntryDetail(id),
    ])
    expect(fullCalls()).toHaveLength(1)
    expect(toolEntry()!.liteState).toBe('filled')
  })

  it('切会话：在途补全整包丢弃，绝不写进新会话的条目', async () => {
    let release: ((p: SessionHistoryPage) => void) | undefined
    vi.mocked(transport.loadSessionHistory)
      .mockResolvedValueOnce(litePage())
      .mockImplementationOnce(
        () => new Promise<SessionHistoryPage>((res) => (release = res)) as never,
      )
    await useChatStore.getState().loadHistory(SID, CWD)
    const id = toolEntry()!.id
    const rawBefore = toolEntry()!.raw

    const pending = useChatStore.getState().fillToolEntryDetail(id)
    // 模拟 continueSession 的切会话锚：代际 +1、视图换到另一会话。
    runtime.sessionSwitchGen += 1
    useChatStore.setState({ sessionId: 'other', cwd: CWD })
    release?.(fullPage())
    await pending

    expect(toolEntry()!.raw).toBe(rawBefore)
    // loading 是切换前就打上的；关键是结果没落地（没有 filled、正文没变）。
    expect(toolEntry()!.liteState).not.toBe('filled')
  })

  it('按需展开失败：条目转 error、占位仍在；重试再发一次请求', async () => {
    const load = vi
      .mocked(transport.loadSessionHistory)
      .mockResolvedValueOnce(litePage())
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValueOnce(fullPage())
    await useChatStore.getState().loadHistory(SID, CWD)
    const id = toolEntry()!.id

    await useChatStore.getState().fillToolEntryDetail(id)
    expect(toolEntry()!.liteState).toBe('error')
    expect(toolEntryLitePending(toolEntry()!)).toBe(true)

    await useChatStore.getState().fillToolEntryDetail(id)
    expect(toolEntry()!.liteState).toBe('filled')
    expect(fullCalls()).toHaveLength(2)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('当前轮后台自动补全：首帧后 idle 期发 detail=full（固定 lite 窗口），只填正文', async () => {
    const load = vi
      .mocked(transport.loadSessionHistory)
      .mockResolvedValueOnce(litePage({ omittedBytes: 1200 }))
      .mockResolvedValue(fullPage())
    await useChatStore.getState().loadHistory(SID, CWD)
    const before = useChatStore.getState().entries
    expect(before.some((e) => toolEntryLitePending(e))).toBe(true)

    // jsdom 没有 requestIdleCallback → setTimeout(0) 兜底，转一轮宏任务。
    await new Promise((r) => setTimeout(r, 5))

    // 补全窗口 = lite 页实际拉的 [loadedStart, +fetched)，不是动态 turnIndex
    // （active 会话里新开一轮会让 turnIndex 窗口漂移，full 页对不上本页行）。
    expect(load).toHaveBeenLastCalledWith(SID, CWD, { offset: 0, limit: 5, detail: 'full' })
    const after = useChatStore.getState().entries
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id))
    expect(after.filter((e) => e.kind !== 'tool')).toEqual(
      before.filter((e) => e.kind !== 'tool'),
    )
    expect(toolEntry()!.liteState).toBe('filled')
  })

  // 预算闸门已按需求去掉：被裁最多的正是带后台任务 / 长流式输出的会话，
  // 拦下来只会让它们整轮退化成逐条手点。
  it('被裁正文再大也照补：omittedBytes 超 2MB 仍发后台 detail=full', async () => {
    vi.mocked(transport.loadSessionHistory)
      .mockResolvedValueOnce(litePage({ omittedBytes: 6 * 1024 * 1024 }))
      .mockResolvedValue(fullPage())
    await useChatStore.getState().loadHistory(SID, CWD)
    expect(toolEntryLitePending(toolEntry()!)).toBe(true)

    await new Promise((r) => setTimeout(r, 5))
    const full = fullCalls()
    expect(full).toHaveLength(1)
    // 窗口 = lite 页实际拉的 [loadedStart, +fetched)，不再用动态 turnIndex。
    expect(full[0]?.[2]).toMatchObject({ offset: 0, limit: 5, detail: 'full' })
    expect(toolEntry()!.liteState).toBe('filled')
    expect(toolEntryLitePending(toolEntry()!)).toBe(false)
    // 在途计数随请求落地归零（顶部进度图标的 spinner 数据源）。
    expect(useChatStore.getState().liteFillBusy ?? 0).toBe(0)
  })

  it('更早轮翻页：lite 页按同一 offset/limit 窗口排队一份 detail=full', async () => {
    const load = vi
      .mocked(transport.loadSessionHistory)
      .mockResolvedValueOnce(litePage())
      .mockResolvedValue(litePage({ updates: litePage().updates?.slice(0, 3) }))
    await useChatStore.getState().loadHistory(SID, CWD)
    // 丢掉首页排的那份整轮补全，只看翻页这一发。
    resetToolFillCache()
    useChatStore.setState({
      historySessionId: SID,
      historyCwd: CWD,
      historyHasMore: true,
      historyLoadedStart: 3,
      historyTotalCount: 3,
      historyLoadedCount: 1,
      historyPromptStarts: [0, 3],
    })
    load.mockClear()

    await useChatStore.getState().loadMoreHistory()
    expect(load).toHaveBeenCalledWith(SID, CWD, { offset: 0, limit: 3, detail: 'lite' })
    await new Promise((r) => setTimeout(r, 5))

    const full = fullCalls()
    expect(full).toHaveLength(1)
    expect(full[0]?.[2]).toMatchObject({ offset: 0, limit: 3, detail: 'full' })
  })

  it('排队中的补全可以立刻催发（点顶部进度图标），已发出的不重复', async () => {
    vi.mocked(transport.loadSessionHistory)
      .mockResolvedValueOnce(litePage())
      .mockResolvedValue(fullPage())
    await useChatStore.getState().loadHistory(SID, CWD)
    expect(fullCalls()).toHaveLength(0)

    flushScheduledPageFills()
    await new Promise((r) => setTimeout(r, 5))
    expect(fullCalls()).toHaveLength(1)

    // 队列已空：再催一次不会多发。
    flushScheduledPageFills()
    await new Promise((r) => setTimeout(r, 5))
    expect(fullCalls()).toHaveLength(1)
  })

  // 活跃会话里重连 / 自动选 host 近路 / pending 同步都会 bump 全局代际，
  // 后台补全不能因此作废（串行队列还会把等待窗口拉到秒级）——认条目归属。
  it('代际被无关流程推进（重连 / 自动选 host）后，排队中的后台补照样落地', async () => {
    vi.mocked(transport.loadSessionHistory)
      .mockResolvedValueOnce(litePage())
      .mockResolvedValue(fullPage())
    await useChatStore.getState().loadHistory(SID, CWD)
    expect(toolEntryLitePending(toolEntry()!)).toBe(true)

    runtime.sessionSwitchGen += 1
    flushScheduledPageFills()
    await new Promise((r) => setTimeout(r, 5))

    expect(fullCalls()).toHaveLength(1)
    expect(toolEntry()!.liteState).toBe('filled')
    expect(toolEntryLitePending(toolEntry()!)).toBe(false)
  })

  // 同一条判别反过来：请求**在途期间**视图被整批重建（新 id）→ 迟到的正文
  // 必须整包丢弃，不能写进陌生行。（重建发生在发请求之前不算竞态：那时候选
  // 就是重建后的那批行，填的是同一会话同一窗口的正确正文。）
  it('补全在途时条目被重建 → 迟到的结果整包丢弃', async () => {
    let resolveFetch!: (p: SessionHistoryPage) => void
    vi.mocked(transport.loadSessionHistory)
      .mockResolvedValueOnce(litePage())
      .mockImplementationOnce(
        () => new Promise<SessionHistoryPage>((r) => {
          resolveFetch = r
        }),
      )
    await useChatStore.getState().loadHistory(SID, CWD)
    const before = useChatStore.getState().entries

    flushScheduledPageFills()
    await new Promise((r) => setTimeout(r, 0)) // 让 fillToolBodies 真的把请求发出去

    useChatStore.setState({
      entries: before.map((e) => ({ ...e, id: `rebuilt-${e.id}` })),
    })
    resolveFetch(fullPage())
    await new Promise((r) => setTimeout(r, 5))

    expect(fullCalls()).toHaveLength(1)
    const after = useChatStore.getState().entries
    expect(after.every((e) => e.kind !== 'tool' || e.liteState === undefined)).toBe(true)
    const rebuilt = after.find((e) => e.kind === 'tool')!
    expect(toolEntryLitePending(rebuilt)).toBe(true)
  })

  it('进度读数：只看行欠不欠正文——未补报数、补齐空串', async () => {
    vi.mocked(transport.loadSessionHistory)
      .mockResolvedValueOnce(litePage())
      .mockResolvedValue(fullPage())
    await useChatStore.getState().loadHistory(SID, CWD)
    // 裁过、还没补 → 1 行待补。
    expect(liteFillSummary(useChatStore.getState())).toBe('1.0.0')

    flushScheduledPageFills()
    await new Promise((r) => setTimeout(r, 5))
    // 补齐 → 图标消失。
    expect(liteFillSummary(useChatStore.getState())).toBe('')

    // 旗标与行状态不同步（最新一页是全量、上滑翻出的旧页是 lite）时以行为准：
    // 带着 liteOmitted 的行仍然报数，图标不会因为旗标是另一页而消失。
    const owed = useChatStore
      .getState()
      .entries.find((e) => e.kind === 'tool') as Extract<ScrollEntry, { kind: 'tool' }>
    useChatStore.setState({
      historyProjected: undefined,
      entries: [{ ...owed, liteState: undefined, liteOmitted: 4096 }],
    })
    expect(liteFillSummary(useChatStore.getState())).toBe('1.0.0')
  })

  it('host 透传回退（整页无 msgSeq）：不显示死占位，但整轮补全仍回填正文', async () => {
    // agent 透传路径的响应不带 msgSeq（bridge 的 _x.ai/session/updates 回退
    // 分支）——区间补算不出窗口，此时占位行必须是不可点的（否则用户点开
    // 永远拿不回正文）；turnIndex 窗口的后台补全按 toolCallId 匹配，照旧生效。
    const dropSeq = (page: SessionHistoryPage): SessionHistoryPage => ({
      ...page,
      updates: (page.updates ?? []).map((raw) => {
        const { msgSeq: _drop, ...rest } = raw as { msgSeq?: number } & Record<string, unknown>
        return rest
      }),
    })
    vi.mocked(transport.loadSessionHistory)
      .mockResolvedValueOnce(dropSeq(litePage({ omittedBytes: 1200 })))
      .mockResolvedValue(dropSeq(fullPage()))
    await useChatStore.getState().loadHistory(SID, CWD)

    const e = toolEntry()!
    // 裁过的事实记下了（补全候选要用），但没有补全坐标 → 不显示占位。
    expect(e.liteOmitted).toBeGreaterThan(0)
    expect(e.msgSeq).toBeUndefined()
    expect(toolEntryLitePending(e)).toBe(false)
    expect(toolEntryNeedsFill(e)).toBe(false)

    await new Promise((r) => setTimeout(r, 5))
    const filled = toolEntry()!
    expect(filled.liteState).toBe('filled')
    expect((filled.raw?.rawOutput as { Bash?: { output?: unknown } })?.Bash?.output).toBeTypeOf(
      'string',
    )
  })

  it('后台补全失败静默：不打 loading / error，也不改 UI', async () => {
    vi.mocked(transport.loadSessionHistory)
      .mockResolvedValueOnce(litePage({ omittedBytes: 1200 }))
      .mockRejectedValueOnce(new Error('502'))
    await useChatStore.getState().loadHistory(SID, CWD)
    await new Promise((r) => setTimeout(r, 5))
    const e = toolEntry()!
    expect(e.liteState).toBeUndefined()
    expect(toolEntryLitePending(e)).toBe(true)
  })
})

describe('补全合并纯函数', () => {
  it('extractToolBodies：同 call 后到覆盖；非工具信封忽略', () => {
    const bodies = extractToolBodies([
      ...fullToolEnvelopes(),
      env(9, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }),
    ])
    expect(bodies.has('9')).toBe(false)
    expect((bodies.get('c1')?.rawOutput as { Bash: { output: string } }).Bash.output).toContain(
      'total 8',
    )
    expect(bodies.get('c1')?.hasContent).toBe(true)
  })

  it('applyToolBodies：只动 raw.rawOutput / raw.content / liteState，并抹掉 lite 标记', () => {
    const bodies = extractToolBodies(fullToolEnvelopes())
    const entries: ScrollEntry[] = [
      { id: 'u', kind: 'user', text: '跑一下', msgSeq: 0 },
      {
        id: 't',
        kind: 'tool',
        title: 'ls -al',
        verb: 'Ran',
        toolCallId: 'c1',
        status: 'completed',
        msgSeq: 1,
        msgSeqEnd: 2,
        liteOmitted: 1200,
        raw: {
          toolCallId: 'c1',
          kind: 'execute',
          status: 'completed',
          content: [{ type: 'content', omitted: 900 }],
          rawOutput: { Bash: { output: { omitted: 300 }, exit_code: 0 } },
          _meta: { lite: { omitted: 300, fields: ['rawOutput.output'] } },
        } as ToolCall,
      },
    ]
    const once = applyToolBodies(entries, bodies)
    // 非工具条目连引用都不变。
    expect(once[0]).toBe(entries[0])
    const t = once[1] as Extract<ScrollEntry, { kind: 'tool' }>
    expect(t.liteState).toBe('filled')
    expect((t.raw as ToolCall).content).toEqual([
      { type: 'content', content: { type: 'text', text: '$ ls -al' } },
    ])
    expect(((t.raw as ToolCall)._meta as { lite?: unknown }).lite).toBeUndefined()
    expect(t.status).toBe('completed')
    // 幂等：再填一次没有变化 → 原数组引用。
    expect(applyToolBodies(once, bodies)).toBe(once)
  })
})

describe('lite 裁正文后的渲染判定', () => {
  it('toolBodyOmitted 认 _meta.lite 与正文占位；detailIsEmpty 认各 kind 空态', () => {
    expect(liteOmittedBytes({ omitted: 300 })).toBe(300)
    // 只有 omitted 一个键才算占位；工具自带的 omitted 字段不算。
    expect(liteOmittedBytes({ omitted: 3, other: 1 })).toBeUndefined()
    const cut: ToolCall = {
      kind: 'search',
      rawOutput: { Grep: { file_matches: [], matches: [{ content: { omitted: 9 } }] } },
      _meta: { lite: { omitted: 9, fields: ['file_matches[0].matches[0].content'] } },
    }
    expect(toolBodyOmitted(cut)).toBe(true)
    expect(toolBodyOmitted({ kind: 'search', rawOutput: { Grep: { match_count: 0 } } })).toBe(false)
    // 兜底预算把整块 rawOutput 换成 {omitted} → match_count 丢了，detailIsEmpty
    // 为真（渲染层据此改说「已省略」，不再报 (no matches)）。
    const d = extractToolDetail(
      { kind: 'search', rawInput: { pattern: 'foo' }, rawOutput: { omitted: 4200 } },
      'search',
    )
    expect(detailIsEmpty(d)).toBe(true)
    // 表头摘要：裁过 → 不给空态；没裁 → 保持今天的 (no matches)。
    expect(toolHeaderExtra(cut, 'search', false)?.suffix).toBeUndefined()
    expect(
      toolHeaderExtra(
        { kind: 'search', rawInput: { pattern: 'foo' }, rawOutput: {} },
        'search',
        false,
      )?.suffix,
    ).toBe(' (no matches)')
  })

  it('lite 占位算「有详情」：行照样可折叠 / 展开', () => {
    const raw: ToolCall = {
      kind: 'execute',
      rawOutput: { Bash: { output: { omitted: 300 }, exit_code: 0 } },
      _meta: { lite: { omitted: 300, fields: ['rawOutput.output'] } },
    }
    expect(toolHasExpandableBody(raw, 'execute')).toBe(true)
    expect(
      entryFoldable({
        id: 't',
        kind: 'tool',
        title: 'ls',
        verb: 'Ran',
        raw: { kind: 'execute' },
        liteOmitted: 300,
      }),
    ).toBe(true)
  })
})

describe('契约 [F]：session/load 回退分支不再要整段重放', () => {
  it('resume 失败 → loadSession 带 meta {noReplay: true}；resume 成功则不发', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(transport.loadSessionHistory).mockResolvedValue({
        updates: [],
        promptStarts: [],
        totalCount: 0,
        hasMore: false,
      } as never)
      vi.mocked(transport.sessionRunningTasks).mockResolvedValue({ events: [] } as never)
      vi.mocked(transport.sessionStats).mockResolvedValue({} as never)
      vi.mocked(transport.gitInfo).mockResolvedValue({} as never)
      vi.mocked(transport.status).mockResolvedValue({} as never)
      const resume = vi.mocked(transport.sessionResume).mockRejectedValue(new Error('no resume'))
      const load = vi.mocked(transport.loadSession).mockResolvedValue({} as never)

      await useChatStore.getState().continueSession(SID, CWD)
      expect(load).toHaveBeenCalledWith(SID, CWD, { noReplay: true })

      // resume 可用（首选路径）：压根不该发 session/load。
      useChatStore.setState({ historyLoading: false, historyLoadingMore: false })
      resume.mockResolvedValue({} as never)
      await useChatStore.getState().continueSession(SID, CWD)
      expect(load).toHaveBeenCalledTimes(1)
    } finally {
      clearContinueSessionTimer()
      vi.useRealTimers()
    }
  })
})

describe('lite 信封的去重键', () => {
  it('带 _meta.lite 的信封改用身份键；live 全量终态更新能对上', () => {
    const [, update] = liteToolEnvelopes()
    const keys = replayEnvelopeKeys(update)
    // lite 信封只登记身份键：内容哈希被裁过，永不可能是判据。
    expect(keys).toHaveLength(1)
    expect(keys[0]).toContain('lite-id')

    const live = replayEventKeys({
      type: 'tool_call_update',
      toolCallUpdate: (fullToolEnvelopes()[1] as { params: { update: ToolCall } }).params.update,
    })
    // 内容键必然不等（快照那份被裁过），身份键必须能对上。
    expect(live[0]).not.toBe(keys[0])
    expect(live.some((k) => keys.includes(k))).toBe(true)
  })

  it('未投影的信封只登记内容键（与今天逐字一致）', () => {
    expect(replayEnvelopeKeys(fullToolEnvelopes()[1])).toHaveLength(1)
    expect(replayEnvelopeKeys(fullToolEnvelopes()[1])[0]).not.toContain('lite-id')
  })
})

/**
 * content 摘要块带原块的 `type`：`{type:'diff', omitted}` 若还当 diff 解析，
 * 会凭空画出一个 `@@ -1,1 +1,1 @@` 空 hunk，把「正文被裁过」这件事遮掉。
 */
describe('lite 摘要块不被当成真空态', () => {
  it('edit 的 diff 摘要块不解析成空 hunk，空态由 lite 标记说话', () => {
    const stubbed = {
      toolCallId: 'c2',
      kind: 'edit',
      status: 'completed',
      title: 'edit a.ts',
      rawInput: { path: 'a.ts' },
      content: [{ type: 'diff', omitted: 4096 }],
    } as ToolCall
    const d = extractToolDetail(stubbed, 'edit')
    expect((d as { lines: unknown[] }).lines).toEqual([])
    expect(detailIsEmpty(d)).toBe(true)
    expect(toolBodyOmitted(stubbed)).toBe(true)

    // 补回真实 Diff 块后照旧出 hunk（占位判定不能顺手把 diff 一起废掉）。
    const filled = { ...stubbed, content: [{ type: 'diff', oldText: 'a\n', newText: 'b\n' }] }
    const fd = extractToolDetail(filled as ToolCall, 'edit')
    expect((fd as { lines: unknown[] }).lines.length).toBeGreaterThan(0)
    expect(detailIsEmpty(fd)).toBe(false)
  })
})

describe('live 事件续写被裁的工具行', () => {
  const feed = (toolCallUpdate: Record<string, unknown>) =>
    useChatStore.getState().handleEvent({
      type: 'tool_call_update',
      toolCallUpdate,
    } as AcpEvent)

  /** lite 首页 + 一行被裁的工具（content 与 rawOutput.output 都是占位）。 */
  const loadLite = async () => {
    usePins.getState().setFePrefs({ liteReplay: true })
    vi.mocked(transport.loadSessionHistory).mockResolvedValue(litePage())
    await useChatStore.getState().loadHistory(SID, CWD)
    expect(toolEntryLitePending(toolEntry()!)).toBe(true)
  }

  it('live 带回正文：占位让位给正文，但账没结清（content 还裁着）', async () => {
    vi.mocked(transport.loadSessionHistory)
      .mockResolvedValueOnce(litePage())
      .mockResolvedValue(fullPage())
    await useChatStore.getState().loadHistory(SID, CWD)
    expect(toolEntryLitePending(toolEntry()!)).toBe(true)

    feed({
      toolCallId: 'c1',
      status: 'completed',
      rawOutput: { Bash: { output: 'live 终态', exit_code: 0 } },
    })

    const e = toolEntry()!
    expect((e.raw?.rawOutput as { Bash: { output: string } }).Bash.output).toBe('live 终态')
    // 有可见正文 → 占位不再盖上去。
    expect(toolEntryLitePending(e)).toBe(false)
    expect(toolBodyStillOwed(e.raw!)).toBe(false)
    // 但 content 那份仍裁着 → 不记 filled、liteOmitted 留着，补全照旧会跑。
    expect(e.liteState).toBeUndefined()
    expect(e.liteOmitted).toBe(1200)
    expect(toolEntryLiteOmitted(e)).toBe(true)

    flushScheduledPageFills()
    await new Promise((r) => setTimeout(r, 5))
    const f = toolEntry()!
    expect(f.liteState).toBe('filled')
    // liteOmitted 按设计不清零（它是"这一页裁过多少"的事实），账靠 liteState 结。
    expect(toolEntryLiteOmitted(f)).toBe(false)
    // content 从快照补回；live 那份 rawOutput 一个字没被动过。
    expect(f.raw?.content as unknown[]).toEqual([
      { type: 'content', content: { type: 'text', text: '$ ls -al' } },
    ])
    expect((f.raw?.rawOutput as { Bash: { output: string } }).Bash.output).toBe('live 终态')
    expect((f.raw?._meta as { lite?: unknown }).lite).toBeUndefined()
    // 只在 live 之后、补全之前：content 仍裁着 → 标记保留（渲染层据此把空
    // 正文报成「已省略」而不是假空态），但占位已经让位给正文。
    expect((e.raw?._meta as { lite?: { omitted?: number } }).lite?.omitted).toBeGreaterThan(0)
  })

  it('状态-only 的 live 更新不撤占位（正文仍然欠着）', async () => {
    await loadLite()

    feed({ toolCallId: 'c1', status: 'completed' })

    const e = toolEntry()!
    expect(e.liteState).toBeUndefined()
    expect(e.liteOmitted).toBe(1200)
    expect(toolEntryLitePending(e)).toBe(true)
  })

  it('展开触发补全时，迟到的历史快照覆盖不了 live 正文', async () => {
    await loadLite()
    feed({
      toolCallId: 'c1',
      status: 'completed',
      rawOutput: { Bash: { output: 'live 终态', exit_code: 0 } },
    })

    // 快照补全照旧会跑（content 那半还欠着），但 live 已有的载体不许被覆盖。
    vi.mocked(transport.loadSessionHistory).mockResolvedValue(
      fullPage({
        updates: [
          env(0, {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: '跑一下' },
          }),
          env(1, {
            sessionUpdate: 'tool_call',
            toolCallId: 'c1',
            kind: 'execute',
            status: 'in_progress',
            title: 'ls -al',
            rawInput: { command: 'ls -al' },
          }),
          env(2, {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'c1',
            status: 'completed',
            rawOutput: { Bash: { output: '历史快照里的旧终态', exit_code: 0 } },
          }),
        ],
      }),
    )
    useChatStore.getState().toggleTool(toolEntry()!.id)
    await new Promise((r) => setTimeout(r, 5))

    expect(fullCalls().length).toBeGreaterThan(0)
    const e = toolEntry()!
    expect((e.raw?.rawOutput as { Bash: { output: string } }).Bash.output).toBe('live 终态')
    expect(toolEntryLitePending(e)).toBe(false)
  })

  it('edit 行只有 content Diff 被裁：live 的 rawOutput 不顶掉欠着的正文', async () => {
    usePins.getState().setFePrefs({ liteReplay: true })
    // 后台补全失败（闸门已去掉，这一发一定会发出去）：让行停在 lite 形状上，
    // 用例只看 live 合并的行为。
    vi.mocked(transport.loadSessionHistory)
      .mockResolvedValueOnce({
        ...litePage(),
        updates: [
          env(1, {
            sessionUpdate: 'tool_call',
            toolCallId: 'c2',
            kind: 'edit',
            status: 'in_progress',
            title: 'edit a.ts',
            rawInput: { path: 'a.ts' },
            content: [{ type: 'diff', omitted: 4096 }],
            _meta: { lite: { omitted: 4096, fields: ['content'] } },
          }),
        ],
      })
      .mockRejectedValue(new Error('不该在本用例里补回正文'))
    await useChatStore.getState().loadHistory(SID, CWD)

    feed({ toolCallId: 'c2', status: 'completed', rawOutput: { ok: true } })

    // rawOutput 已是可显示的实体（不再"欠"）→ 占位让位；但 content 的 Diff
    // 块还裁着 → 不记 filled、liteOmitted 留着，补全候选仍含这一行，
    // 图标也仍然报数（欠账没结清）。
    const e = toolEntry()!
    expect(toolBodyStillOwed(e.raw!)).toBe(false)
    expect(toolEntryLitePending(e)).toBe(false)
    expect(e.liteState).toBeUndefined()
    expect(toolEntryLiteOmitted(e)).toBe(true)
    expect(liteFillSummary(useChatStore.getState())).toBe('1.0.0')
  })
})
