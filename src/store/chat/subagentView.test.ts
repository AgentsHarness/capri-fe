import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpEvent, ScrollEntry } from '../../api/types'
import { sealSubagentStreaming, subagentViewAppend } from './subagentView'
import { extractToolDetail } from '../../scrollback/toolDetail'
import envs from './qwenAnonSliceFixture.json'

type ThoughtEvent = Extract<AcpEvent, { type: 'thought' }>

const thought = (over: Partial<ThoughtEvent> = {}): AcpEvent => ({
  type: 'thought',
  text: 'hmm',
  ...over,
})

describe('subagentViewAppend — thought 耗时', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('回放 thought 带 elapsedMs → 收口用原始耗时，不渲染 0.0s', () => {
    const items = subagentViewAppend([], thought({ elapsedMs: 2300 }))
    const entry = items[items.length - 1]
    if (entry.kind !== 'thought') throw new Error('expected thought')
    expect(entry.elapsedMs).toBe(2300)
    expect(entry.startedAt).toBeUndefined()
    // 收口发生在回放同一时刻：若只看 startedAt 会算出 ~0ms。
    const sealed = sealSubagentStreaming(items)
    const se = sealed[sealed.length - 1]
    if (se.kind !== 'thought') throw new Error('expected thought')
    expect(se.streaming).toBe(false)
    expect(se.elapsed).toBe('2.3s')
  })

  it('live thought 无 elapsedMs → 本地 startedAt 计时', () => {
    const t0 = Date.now()
    const items = subagentViewAppend([], thought({}))
    const entry = items[items.length - 1]
    if (entry.kind !== 'thought') throw new Error('expected thought')
    expect(entry.startedAt).toBe(t0)
    expect(entry.elapsedMs).toBeUndefined()
    vi.setSystemTime(new Date(t0 + 1500))
    const sealed = sealSubagentStreaming(items)
    const se = sealed[sealed.length - 1]
    if (se.kind !== 'thought') throw new Error('expected thought')
    expect(se.elapsed).toBe('1.5s')
  })

  it('续写 chunk：最后一个 chunk 的 elapsedMs 生效（耗时随流增长）', () => {
    let items = subagentViewAppend([], thought({ elapsedMs: 500 }))
    items = subagentViewAppend(items, thought({ text: ' more', elapsedMs: 2300 }))
    const entry = items[items.length - 1]
    if (entry.kind !== 'thought') throw new Error('expected thought')
    expect(entry.elapsedMs).toBe(2300)
    expect(entry.text).toBe('hmm more')
    const sealed = sealSubagentStreaming(items)
    const se = sealed[sealed.length - 1]
    if (se.kind !== 'thought') throw new Error('expected thought')
    expect(se.elapsed).toBe('2.3s')
  })

  it('无 elapsedMs / startedAt → 保留既有 elapsed', () => {
    const items = sealSubagentStreaming([
      { id: 'x', kind: 'thought', text: 't', streaming: true, elapsed: '9.9s' },
    ])
    const se = items[0]
    if (se.kind !== 'thought') throw new Error('expected thought')
    expect(se.elapsed).toBe('9.9s')
  })
})

describe('subagentViewToolItem — todo/plan update 顶层赝品 kind:"think"', () => {
  it('真实 wire 序列：tool_call(todo_write) + update(kind:think, _meta plan) → 动词不落 "Thought"', () => {
    // 用户实测（子代理 01a053ba…）：
    // tool_call  title=todo_write、顶层无 kind、_meta.x.ai/tool.kind=plan；
    // tool_call_update title="Updating plan"、顶层 kind="think"、_meta 恒 plan。
    let items = subagentViewAppend([], {
      type: 'tool_call',
      toolCall: {
        toolCallId: 'call_92b252d6d5444608b4834ff4',
        title: 'todo_write',
        rawInput: { todos: [{ content: 'x', id: '1', status: 'pending' }] },
        _meta: {
          'x.ai/tool': { kind: 'plan', label: 'Plan', name: 'todo_write' },
        },
      },
    } as AcpEvent)
    items = subagentViewAppend(items, {
      type: 'tool_call_update',
      toolCallUpdate: {
        toolCallId: 'call_92b252d6d5444608b4834ff4',
        kind: 'think',
        title: 'Updating plan',
        rawInput: { merge: true, variant: 'TodoWrite' },
        _meta: {
          'x.ai/tool': { kind: 'plan', label: 'Plan', name: 'todo_write' },
        },
      },
    } as AcpEvent)
    const entry = items[items.length - 1]
    if (entry.kind !== 'tool') throw new Error('expected tool')
    // 分类取 _meta 权威值 plan（不取顶层赝品 think）→ 动词是默认 Ran/Running，
    // 标题是真实工具名 "Updating plan"，不以 Thought 开头。
    expect(entry.kindName).toBe('plan')
    expect(entry.verb.startsWith('Thought')).toBe(false)
    expect(entry.verb.startsWith('Thinking')).toBe(false)
    expect(entry.title).toBe('Updating plan')
  })
})

const READ_PATH = '/repo/src/components/scrollback/kinds/TaskEntries.tsx'

/** 宿主 bridge 的 live 形状（toolCall/toolCallUpdate = session/update 的
 *  update 原样），空 toolCallId 场景与 qwen 网关实测一致。 */
const anonCall = (update: Record<string, unknown>): AcpEvent => ({
  type: update.sessionUpdate === 'tool_call' ? 'tool_call' : 'tool_call_update',
  ...(update.sessionUpdate === 'tool_call'
    ? { toolCall: update }
    : { toolCallUpdate: update }),
}) as AcpEvent

/** read 三件套（wire 实录 01a058f4 turnIndex 5，正文裁短）：调用 / 元数据 / 终态。 */
const anonReadTriple = (): AcpEvent[] => [
  anonCall({
    sessionUpdate: 'tool_call',
    toolCallId: '',
    title: 'read_file',
    rawInput: { limit: 30, offset: 7, target_file: READ_PATH },
    _meta: { 'x.ai/tool': { kind: 'read', label: 'Read', name: 'read_file' } },
  }),
  anonCall({
    sessionUpdate: 'tool_call_update',
    toolCallId: '',
    kind: 'read',
    title: `Read \`${READ_PATH}\``,
    rawInput: { limit: 30, offset: 7, target_file: READ_PATH, variant: 'ReadFile' },
    _meta: { 'x.ai/tool': { kind: 'read', label: 'Read', name: 'read_file' } },
  }),
  anonCall({
    sessionUpdate: 'tool_call_update',
    toolCallId: '',
    status: 'completed',
    title: '',
    content: [{ type: 'content', content: { type: 'text', text: '7→export function SubagentEntry({\n' } }],
    rawOutput: {
      FileContent: { absolute_path: READ_PATH, content: '7→export function SubagentEntry({\n' },
    },
  }),
]

const toolsOf = (items: ScrollEntry[]) =>
  items.filter((e): e is Extract<ScrollEntry, { kind: 'tool' }> => e.kind === 'tool')

describe('subagentViewAppend — 空 toolCallId 认领（qwen 网关）', () => {
  it('匿名 read 三件套并成一格：状态收口、内容落行、标题保留路径', () => {
    let items: ScrollEntry[] = []
    for (const ev of anonReadTriple()) items = subagentViewAppend(items, ev)

    const tools = toolsOf(items)
    expect(tools.length).toBe(1)
    const detail = extractToolDetail(tools[0]!.raw!, tools[0]!.kindName)
    expect(tools[0]!.status).toBe('completed')
    expect(tools[0]!.title).toBe(`Read \`${READ_PATH}\``)
    expect((detail as { content?: string }).content).toContain('SubagentEntry')
  })

  it('并行两条匿名行：无指纹的终态 update 只收状态，不贴别人的输出', () => {
    let items = subagentViewAppend(
      [],
      anonCall({
        sessionUpdate: 'tool_call',
        toolCallId: '',
        title: 'read_file',
        rawInput: { target_file: '/repo/a.ts' },
        _meta: { 'x.ai/tool': { kind: 'read', label: 'Read', name: 'read_file' } },
      }),
    )
    items = subagentViewAppend(
      items,
      anonCall({
        sessionUpdate: 'tool_call',
        toolCallId: '',
        title: 'read_file',
        rawInput: { target_file: '/repo/b.ts' },
        _meta: { 'x.ai/tool': { kind: 'read', label: 'Read', name: 'read_file' } },
      }),
    )
    // 不带 rawInput/command/path 的终态 update：两条候选行在跑，归属有歧义。
    items = subagentViewAppend(
      items,
      anonCall({
        sessionUpdate: 'tool_call_update',
        toolCallId: '',
        status: 'completed',
        rawOutput: { FileContent: { absolute_path: '/repo/a.ts', content: 'A\n' } },
      }),
    )

    const tools = toolsOf(items)
    expect(tools.length).toBe(2)
    expect(tools[0]!.status).toBe('completed')
    expect(tools[0]!.raw?.rawOutput).toBeUndefined()
    expect(tools[1]!.status).toBe('pending')
  })

  it('没有未收口的匿名行时不凭空造行', () => {
    let items: ScrollEntry[] = []
    for (const ev of anonReadTriple()) items = subagentViewAppend(items, ev)
    const before = items.length
    items = subagentViewAppend(
      items,
      anonCall({ sessionUpdate: 'tool_call_update', toolCallId: '', status: 'completed' }),
    )
    expect(items.length).toBe(before)
  })

  it('整段匿名会话回放：一次调用一行，read 行都有内容', () => {
    let items: ScrollEntry[] = []
    for (const env of envs as { params?: { update?: Record<string, unknown> } }[]) {
      const u = env.params?.update
      if (!u || (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update')) {
        continue
      }
      items = subagentViewAppend(items, anonCall(u))
    }

    const tools = toolsOf(items)
    // 34 次匿名调用（wire 上 34 条 tool_call / 68 条 update）→ 34 行。
    expect(tools.length).toBe(34)
    expect(tools.filter((t) => t.status === 'pending' || t.status === 'in_progress')).toEqual([])
    const reads = tools.filter((t) => t.kindName === 'read')
    expect(reads.length).toBeGreaterThan(0)
    const noContent = reads.filter((t) => {
      const d = extractToolDetail(t.raw!, t.kindName) as { content?: string; error?: string }
      return !d.content && !d.error
    })
    expect(noContent).toEqual([])
  })
})