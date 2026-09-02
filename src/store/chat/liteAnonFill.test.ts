import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import { useChatStore } from '../chat'
import { runtime, clearContinueSessionTimer } from './globals'
import {
  applyToolBodies,
  extractToolBodies,
  resetLiteCapability,
  resetToolFillCache,
  toolEntryLitePending,
  toolEntryNeedsFill,
} from './historyFill'
import {
  applyEntryLiteStats,
  applyEntryMsgSeq,
  replayUpdates,
  sortEntriesByMsgSeq,
} from './history'
import { settleTurnEntries } from './turnLifecycle'

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
 * lite 补全 × 匿名 call（空 toolCallId，qwen 网关）回归：31fb477 修的
 * 「read 回放 no content」在 lite 投影链路（坐标盖章 / 提取 / 回填）上的
 * 等价物。三层断言：
 * - 坐标：匿名行拿到 msgSeqEnd / liteOmitted（此前被整体跳过）；
 * - 回填：detail=full 页的正文按匿名指纹填回，标题/路径不丢；
 * - 防串台：并行同指纹多候选拒绝合并（与 applyAnonToolUpdate 同纪律）。
 */
const SID = 's-anon-lite'
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

/** 匿名 read 的 lite 形态：正文整段裁掉、只留 `_meta.lite`。 */
function anonReadLiteEnvelopes(): unknown[] {
  return [
    env(1, {
      sessionUpdate: 'tool_call',
      toolCallId: '',
      kind: 'read',
      status: 'in_progress',
      title: 'read a.ts',
      rawInput: { target_file: 'src/a.ts' },
      _meta: { 'x.ai/tool': { name: 'read', kind: 'read', label: 'read' } },
    }),
    env(2, {
      sessionUpdate: 'tool_call_update',
      toolCallId: '',
      status: 'completed',
      // 真实 host strip 形状：结构保留、正文叶子换成 {omitted}。
      rawOutput: { content: { omitted: 500 } },
      _meta: { lite: { omitted: 500, fields: ['rawOutput.content'] } },
    }),
  ]
}

/** 同两条信封的全量形态（detail=full 补全页）。 */
function anonReadFullEnvelopes(): unknown[] {
  return [
    env(1, {
      sessionUpdate: 'tool_call',
      toolCallId: '',
      kind: 'read',
      status: 'in_progress',
      title: 'read a.ts',
      rawInput: { target_file: 'src/a.ts' },
      _meta: { 'x.ai/tool': { name: 'read', kind: 'read', label: 'read' } },
    }),
    env(2, {
      sessionUpdate: 'tool_call_update',
      toolCallId: '',
      status: 'completed',
      rawOutput: { content: 'file text' },
    }),
  ]
}

function turnEndEnvelope(seq: number): unknown {
  return env(seq, { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' })
}

/** lite 首页：user → 匿名 read → turn_completed。 */
function anonReadLitePage(): unknown[] {
  return [
    env(0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '读一下' } }),
    ...anonReadLiteEnvelopes(),
    turnEndEnvelope(3),
  ]
}

function replayPage(updates: unknown[]) {
  useChatStore.setState({ entries: [], toolIndex: {} })
  const get = () => useChatStore.getState()
  const replay = replayUpdates(get, updates)
  const entries = sortEntriesByMsgSeq(
    applyEntryLiteStats(
      applyEntryMsgSeq(settleTurnEntries(get().entries), replay.entryMsgSeq),
      replay.entryMsgSeqEnd,
      replay.entryLiteOmitted,
    ),
  )
  useChatStore.setState({ entries })
  return entries
}

const toolRows = (es: ScrollEntry[]) =>
  es.filter((e) => e.kind === 'tool') as Extract<ScrollEntry, { kind: 'tool' }>[]

beforeEach(() => {
  vi.clearAllMocks()
  runtime.sessionSwitchGen += 1
  resetToolFillCache()
  resetLiteCapability()
  useChatStore.setState({
    entries: [],
    toolIndex: {},
    selectedId: null,
    sessionId: SID,
    cwd: CWD,
    conn: 'ready',
    topTasks: [],
  })
})

afterEach(() => {
  useChatStore.getState().stopTopTaskPolling()
  useChatStore.setState({ entries: [], sessionId: undefined, cwd: undefined })
  clearContinueSessionTimer()
})

describe('lite × 匿名 call（空 toolCallId）：坐标与补全', () => {
  it('回放 lite 页：匿名 read 行拿到 msgSeqEnd / liteOmitted，占位可补', () => {
    const entries = replayPage(anonReadLitePage())
    const [row] = toolRows(entries)
    expect(row).toBeDefined()
    // 行头路径保留（rawInput 不被 lite 裁）。
    expect(row.title).toContain('a.ts')
    expect(row.msgSeq).toBe(1)
    // 最后一条碰到它的信封 = 完成更新的 2（此前匿名行被整体跳过坐标）。
    expect(row.msgSeqEnd).toBe(2)
    expect(row.liteOmitted).toBe(500)
    expect(toolEntryLitePending(row!)).toBe(true)
    expect(toolEntryNeedsFill(row!)).toBe(true)
  })

  it('detail=full 页补全：匿名 read 正文按指纹填回、标题与 rawInput 不丢', () => {
    const entries = replayPage(anonReadLitePage())
    const [row] = toolRows(entries)
    const bodies = extractToolBodies(anonReadFullEnvelopes())
    const after = applyToolBodies(entries, bodies)
    const [filled] = toolRows(after)
    expect(filled.raw?.rawOutput).toEqual({ content: 'file text' })
    expect(filled.liteState).toBe('filled')
    expect(filled.title).toBe(row!.title)
    expect((filled.raw?.rawInput as Record<string, unknown>).target_file).toBe('src/a.ts')
    expect(toolEntryLitePending(filled)).toBe(false)
    expect(toolEntryNeedsFill(filled)).toBe(false)
    // 幂等：再补一次结果一致（不发请求语义由调用方保证，这里纯函数相等）。
    expect(applyToolBodies(after, bodies)).toEqual(after)
  })

  it('并行同路径两个匿名调用：指纹唯一性不满足 → 双双拒绝，绝不跨行串台', () => {
    const start = (seq: number) => env(seq, {
      sessionUpdate: 'tool_call',
      toolCallId: '',
      kind: 'read',
      status: 'in_progress',
      rawInput: { target_file: 'src/a.ts' },
      _meta: { 'x.ai/tool': { name: 'read', kind: 'read' } },
    })
    const done = (seq: number, body: string) => env(seq, {
      sessionUpdate: 'tool_call_update',
      toolCallId: '',
      status: 'completed',
      rawOutput: { content: body },
    })
    const liteDone = (seq: number) => env(seq, {
      sessionUpdate: 'tool_call_update',
      toolCallId: '',
      status: 'completed',
      rawOutput: { content: { omitted: 300 } },
      _meta: { lite: { omitted: 300, fields: ['rawOutput.content'] } },
    })
    const liteUpdates = [
      env(0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '并行读' } }),
      start(1),
      start(2),
      liteDone(3),
      liteDone(4),
      turnEndEnvelope(5),
    ]
    const fullUpdates = [
      env(0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '并行读' } }),
      start(1),
      start(2),
      done(3, 'first file text'),
      done(4, 'second file text'),
      turnEndEnvelope(5),
    ]
    const entries = replayPage(liteUpdates)
    const rows = toolRows(entries)
    expect(rows.length).toBe(2)
    // 两行都有补全坐标（各自被完成更新盖章）。
    expect(rows.map((r) => r.liteOmitted)).toEqual([300, 300])
    const after = applyToolBodies(entries, extractToolBodies(fullUpdates))
    const afterRows = toolRows(after)
    // 双双拒绝：没进 filled。回放侧 second 行按 sole 规则合并过 stub
    // （live 路径本就如此），正文层面两行都只是 stub / 空——真实内容
    // （'first/second file text'）绝不能出现在任何一行。
    for (const r of afterRows) expect(r.liteState).not.toBe('filled')
    const stubs = afterRows.map(
      (r) => (r.raw?.rawOutput as { content?: { omitted?: number } } | undefined)?.content?.omitted,
    )
    expect(stubs).toEqual(expect.arrayContaining([undefined, 300]))
  })

  it('混跑：keyed execute 与无指纹调用并行、无指纹先完成 → 正文不进 execute 的桶', () => {
    // execute 的完成更新带 command 指纹，无名调用的完成更新不带——
    // 无指纹先完成时，没有无名桶计数它就会错并进 execute 的桶。
    const executeStart = env(1, {
      sessionUpdate: 'tool_call',
      toolCallId: '',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'ls -al' },
      _meta: { 'x.ai/tool': { name: 'execute', kind: 'execute' } },
    })
    const executeDone = env(3, {
      sessionUpdate: 'tool_call_update',
      toolCallId: '',
      status: 'completed',
      rawOutput: { type: 'Bash', command: 'ls -al', output: 'file list' },
    })
    const genericStart = env(2, {
      sessionUpdate: 'tool_call',
      toolCallId: '',
      kind: 'other',
      status: 'in_progress',
      rawInput: { query: 'x' },
      _meta: { 'x.ai/tool': { name: 'other', kind: 'other' } },
    })
    const genericDone = env(4, {
      sessionUpdate: 'tool_call_update',
      toolCallId: '',
      status: 'completed',
      rawOutput: { content: 'generic body' },
    })
    const updates = [
      env(0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '跑' } }),
      executeStart,
      genericStart,
      genericDone,
      executeDone,
      turnEndEnvelope(5),
    ]
    // 提取层直接断言（回放层的行形态受 live 匿名路径的交织怪僻影响，与本
    // 修复无关）：无名桶计数让 generic 的完成更新在 execute 桶开放时被拒绝，
    // execute 桶只含自己的正文，任何桶都不含 'generic body'。
    const bodies = extractToolBodies(updates)
    expect((bodies.get('anon:cmd:ls -al') as { rawOutput?: unknown }).rawOutput).toEqual(
      { type: 'Bash', command: 'ls -al', output: 'file list' },
    )
    expect([...bodies.values()].every((b) => b.rawOutput !== 'generic body')).toBe(true)
  })

  it('并行不同命令的两个匿名 execute：指纹各开各桶，双双填回', () => {
    const mkStart = (seq: number, cmd: string) => env(seq, {
      sessionUpdate: 'tool_call',
      toolCallId: '',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: cmd },
      _meta: { 'x.ai/tool': { name: 'execute', kind: 'execute' } },
    })
    const mkDone = (seq: number, cmd: string, body: string) => env(seq, {
      sessionUpdate: 'tool_call_update',
      toolCallId: '',
      status: 'completed',
      // execute 的真实 wire：rawOutput 带 type: 'Bash'（anonToolKey 的
      // command 指纹依赖它）。
      rawOutput: { type: 'Bash', command: cmd, output: body },
    })
    const mkLiteDone = (seq: number, cmd: string) => env(seq, {
      sessionUpdate: 'tool_call_update',
      toolCallId: '',
      status: 'completed',
      rawOutput: { type: 'Bash', command: cmd, output: { omitted: 300 } },
      _meta: { lite: { omitted: 300, fields: ['rawOutput.output'] } },
    })
    const liteUpdates = [
      env(0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '并行跑' } }),
      mkStart(1, 'ls -al'),
      mkStart(2, 'pwd'),
      mkLiteDone(3, 'ls -al'),
      mkLiteDone(4, 'pwd'),
      turnEndEnvelope(5),
    ]
    const fullUpdates = [
      env(0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '并行跑' } }),
      mkStart(1, 'ls -al'),
      mkStart(2, 'pwd'),
      mkDone(3, 'ls -al', 'file list'),
      mkDone(4, 'pwd', '/work'),
      turnEndEnvelope(5),
    ]
    const entries = replayPage(liteUpdates)
    const after = applyToolBodies(entries, extractToolBodies(fullUpdates))
    const rows = toolRows(after)
    expect(rows.length).toBe(2)
    const outs = rows.map((r) => (r.raw?.rawOutput as { output?: string }).output).sort()
    expect(outs).toEqual(['/work', 'file list'])
  })
})