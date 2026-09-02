import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import { transport } from '../../api/client'
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
import { anonToolKey } from './tools'

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
    // 修复无关）：无名实例计数让 generic 的完成更新在 execute 实例也开放时
    // 被拒绝，execute 实例只含自己的正文，任何桶都不含 'generic body'。
    const bodies = extractToolBodies(updates)
    // 实例键 = 开窗 start 的 msgSeq（executeStart 在 1）。
    expect((bodies.get('anon@1:cmd:ls -al') as { rawOutput?: unknown }).rawOutput).toEqual({
      type: 'Bash',
      command: 'ls -al',
      output: 'file list',
    })
    expect((bodies.get('anon@2') as { hasRawOutput: boolean }).hasRawOutput).toBe(false)
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

  it('串行同文件三次匿名 read：每行拿自己的正文（同指纹不再互相顶掉）', () => {
    // 真实网关形态：一次调用 = 名字帧（tool_call）+ kind/title 帧 + 完成帧，
    // 三帧同指纹；完成帧不带 rawInput（算不出指纹）。同一个文件被连着读三次
    // 是编码会话里最普通的形状。
    const gwRead = (s: number, path: string, body: string) => {
      const name = env(s, {
        sessionUpdate: 'tool_call',
        toolCallId: '',
        rawInput: { target_file: path },
      })
      const rich = (content: unknown, lite?: unknown) =>
        env(s + 1, {
          sessionUpdate: 'tool_call_update',
          toolCallId: '',
          kind: 'read',
          title: `Read \`${path}\``,
          rawInput: { target_file: path },
          content,
          ...(lite ? { _meta: { lite } } : {}),
        })
      const done = (content: unknown, lite?: unknown) =>
        env(s + 2, {
          sessionUpdate: 'tool_call_update',
          toolCallId: '',
          status: 'completed',
          rawOutput: { type: 'ReadFile', FileContent: { content } },
          ...(lite ? { _meta: { lite } } : {}),
        })
      return {
        lite: [
          name,
          rich({ omitted: 12 }, { omitted: 12, fields: ['content'] }),
          done({ omitted: 400 }, { omitted: 400, fields: ['rawOutput.FileContent.content'] }),
        ],
        full: [name, rich(`${path} 头部`), done(body)],
      }
    }
    const a = gwRead(1, 'src/a.ts', 'AAA')
    const b = gwRead(4, 'src/a.ts', 'BBB')
    const c = gwRead(7, 'src/a.ts', 'CCC')
    const entries = replayPage([
      env(0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '读三次' } }),
      ...a.lite,
      ...b.lite,
      ...c.lite,
      turnEndEnvelope(10),
    ])
    const rows = toolRows(entries)
    expect(rows.length).toBe(3)
    // 三行同指纹、都欠正文。
    expect(new Set(rows.map((r) => anonToolKey(r.raw ?? {}))).size).toBe(1)
    expect(rows.every((r) => toolEntryLitePending(r))).toBe(true)

    const after = toolRows(
      applyToolBodies(entries, extractToolBodies([
        env(0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '读三次' } }),
        ...a.full,
        ...b.full,
        ...c.full,
        turnEndEnvelope(10),
      ])),
    )
    expect(after.map((r) => r.liteState)).toEqual(['filled', 'filled', 'filled'])
    expect(
      after.map(
        (r) =>
          ((r.raw?.rawOutput ?? {}) as { FileContent?: { content?: string } }).FileContent?.content,
      ),
    ).toEqual(['AAA', 'BBB', 'CCC'])
    // 幂等：再补一次一字不变。
    expect(applyToolBodies(after, extractToolBodies(fullThree()))).toEqual(after)
  })

  it('乱序完成帧（真实网关并发调用）：按工具族归属，两行各拿自己的正文', () => {
    // 真实形状（会话 01a06312 首轮 msgSeq 16..21）：bash 与 grep 并发，
    // grep 的完成帧先到且不带指纹（rawOutput 只有 stdout / file_matches），
    // bash 的完成帧后到且带 command。旧规则「唯一开放实例」在 20 处直接
    // 拒绝，被拒的实例还留在开放集合里，把后面每条无指纹完成帧一起拖死。
    const frames = {
      lite: [
        env(16, { sessionUpdate: 'tool_call', toolCallId: '', rawInput: { command: 'git status' } }),
        env(17, {
          sessionUpdate: 'tool_call_update',
          toolCallId: '',
          kind: 'execute',
          title: 'Execute `git status`',
          rawInput: { command: 'git status' },
        }),
        env(18, { sessionUpdate: 'tool_call', toolCallId: '', rawInput: { path: 'src/a.ts' } }),
        env(19, {
          sessionUpdate: 'tool_call_update',
          toolCallId: '',
          kind: 'search',
          title: 'grep',
          rawInput: { path: 'src/a.ts' },
        }),
        env(20, {
          sessionUpdate: 'tool_call_update',
          toolCallId: '',
          status: 'completed',
          rawOutput: { type: 'GrepSearch', match_count: 3, stdout: { omitted: 900 } },
          _meta: { lite: { omitted: 900, fields: ['rawOutput.stdout'] } },
        }),
        env(21, {
          sessionUpdate: 'tool_call_update',
          toolCallId: '',
          status: 'completed',
          rawOutput: {
            type: 'Bash',
            command: 'git status',
            output: { omitted: 700 },
            output_for_prompt: { omitted: 700 },
          },
          _meta: { lite: { omitted: 700, fields: ['rawOutput.output'] } },
        }),
      ],
      full: [
        env(16, { sessionUpdate: 'tool_call', toolCallId: '', rawInput: { command: 'git status' } }),
        env(17, {
          sessionUpdate: 'tool_call_update',
          toolCallId: '',
          kind: 'execute',
          title: 'Execute `git status`',
          rawInput: { command: 'git status' },
        }),
        env(18, { sessionUpdate: 'tool_call', toolCallId: '', rawInput: { path: 'src/a.ts' } }),
        env(19, {
          sessionUpdate: 'tool_call_update',
          toolCallId: '',
          kind: 'search',
          title: 'grep',
          rawInput: { path: 'src/a.ts' },
        }),
        env(20, {
          sessionUpdate: 'tool_call_update',
          toolCallId: '',
          status: 'completed',
          rawOutput: { type: 'GrepSearch', match_count: 3, stdout: 'GREP BODY' },
        }),
        env(21, {
          sessionUpdate: 'tool_call_update',
          toolCallId: '',
          status: 'completed',
          rawOutput: { type: 'Bash', command: 'git status', output: 'BASH BODY' },
        }),
      ],
    }
    const entries = replayPage([...frames.lite, turnEndEnvelope(22)])
    const rows = toolRows(entries)
    expect(rows.map((r) => `${r.msgSeq}:${r.kindName}`)).toEqual(['16:execute', '18:search'])
    const after = toolRows(
      applyToolBodies(entries, extractToolBodies([...frames.full, turnEndEnvelope(22)])),
    )
    const bySeq = new Map(after.map((r) => [r.msgSeq, r]))
    const bashOut = (bySeq.get(16)!.raw?.rawOutput ?? {}) as { output?: string }
    const grepOut = (bySeq.get(18)!.raw?.rawOutput ?? {}) as { stdout?: string }
    expect(bashOut.output).toBe('BASH BODY')
    expect(grepOut.stdout).toBe('GREP BODY')
    expect(after.map((r) => r.liteState)).toEqual(['filled', 'filled'])
  })

  it('同族两条开放 + 无指纹完成帧：仍然拒绝，工具族不是新的串台口子', () => {
    const start = (seq: number, path: string) =>
      env(seq, {
        sessionUpdate: 'tool_call',
        toolCallId: '',
        kind: 'read',
        status: 'in_progress',
        rawInput: { target_file: path },
      })
    const done = (seq: number, body: string) =>
      env(seq, {
        sessionUpdate: 'tool_call_update',
        toolCallId: '',
        status: 'completed',
        rawOutput: { type: 'ReadFile', FileContent: { content: body } },
      })
    const lite = [
      start(1, 'src/a.ts'),
      start(2, 'src/b.ts'),
      env(3, {
        sessionUpdate: 'tool_call_update',
        toolCallId: '',
        status: 'completed',
        rawOutput: { type: 'ReadFile', FileContent: { content: { omitted: 400 } } },
        _meta: { lite: { omitted: 400, fields: ['rawOutput.FileContent.content'] } },
      }),
      env(4, {
        sessionUpdate: 'tool_call_update',
        toolCallId: '',
        status: 'completed',
        rawOutput: { type: 'ReadFile', FileContent: { content: { omitted: 400 } } },
        _meta: { lite: { omitted: 400, fields: ['rawOutput.FileContent.content'] } },
      }),
    ]
    const full = [start(1, 'src/a.ts'), start(2, 'src/b.ts'), done(3, 'A BODY'), done(4, 'B BODY')]
    const entries = replayPage([...lite, turnEndEnvelope(5)])
    const after = toolRows(applyToolBodies(entries, extractToolBodies([...full, turnEndEnvelope(5)])))
    // 两行同族（read）且完成帧都不带指纹 → 归属有歧义，双双不填，且真实正文
    // 不出现在任何一行上。
    for (const r of after) {
      expect(r.liteState).not.toBe('filled')
      const c = (r.raw?.rawOutput as { FileContent?: { content?: unknown } } | undefined)?.FileContent?.content
      expect(c === 'A BODY' || c === 'B BODY').toBe(false)
    }
  })

  it('补全页没给到这一行的正文：退成 error 而不是永久 loading，再点真的重发', async () => {
    replayPage(anonReadLitePage())
    const id = toolRows(useChatStore.getState().entries)[0]!.id
    const row = () => toolRows(useChatStore.getState().entries)[0]!
    // 空页：窗口里没有这一行的正文（host 回退 / 窗口漂移）。
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: [],
      totalCount: 3,
      hasMore: false,
    })
    await useChatStore.getState().fillToolEntryDetail(id)
    // 留在 loading 就是永久 spinner，而 settled 只放行 error 重试 —— 那点
    // 第二次[加载]会彻底没反应。
    expect(row().liteState).toBe('error')
    expect(toolEntryLitePending(row())).toBe(true)
    await useChatStore.getState().fillToolEntryDetail(id)
    expect(transport.loadSessionHistory).toHaveBeenCalledTimes(2)
  })
})

/** 上面「串行三次」用例的全量页（幂等复补用）。 */
function fullThree(): unknown[] {
  const one = (s: number, body: string) => [
    env(s, { sessionUpdate: 'tool_call', toolCallId: '', rawInput: { target_file: 'src/a.ts' } }),
    env(s + 1, {
      sessionUpdate: 'tool_call_update',
      toolCallId: '',
      kind: 'read',
      title: 'Read `src/a.ts`',
      rawInput: { target_file: 'src/a.ts' },
      content: 'src/a.ts 头部',
    }),
    env(s + 2, {
      sessionUpdate: 'tool_call_update',
      toolCallId: '',
      status: 'completed',
      rawOutput: { type: 'ReadFile', FileContent: { content: body } },
    }),
  ]
  return [
    env(0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '读三次' } }),
    ...one(1, 'AAA'),
    ...one(4, 'BBB'),
    ...one(7, 'CCC'),
    turnEndEnvelope(10),
  ]
}