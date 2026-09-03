import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpEvent, ScrollEntry } from '../../api/types'
import {
  applySubagentViewEvent,
  sealSubagentStreaming,
  subagentViewAppend,
} from './subagentView'
import { extractToolDetail } from '../../scrollback/toolDetail'

type ThoughtEvent = Extract<AcpEvent, { type: 'thought' }>

const thought = (over: Partial<ThoughtEvent> = {}): AcpEvent => ({
  type: 'thought',
  text: 'hmm',
  ...over,
})

/** 取视图末条（断言收口标记用），并校验条目种类。 */
function lastOf(items: ScrollEntry[]): ScrollEntry {
  const e = items[items.length - 1]
  if (!e) throw new Error('expected an entry')
  return e
}

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

describe('subagentViewAppend — 回合收口标记（TUI session_event.rs 对齐）', () => {
  it('turn_completed 成功 + elapsedMs → "Worked for X"（无句号）', () => {
    const items = subagentViewAppend([], {
      type: 'turn_completed',
      elapsedMs: 125000,
    } as AcpEvent)
    const e = lastOf(items)
    expect(e.kind).toBe('session_event')
    expect(e.kind === 'session_event' && e.text).toBe('Worked for 2m5s')
    expect(e.kind === 'session_event' && e.warning).toBeUndefined()
  })

  it('turn_completed error + agentResult + elapsedMs → "Turn failed in X: err" 带 warning', () => {
    const items = subagentViewAppend([], {
      type: 'turn_completed',
      stopReason: 'error',
      agentResult: 'connection reset',
      elapsedMs: 3000,
    } as AcpEvent)
    const e = lastOf(items)
    expect(e.kind).toBe('session_event')
    expect(e.kind === 'session_event' && e.text).toBe(
      'Turn failed in 3.0s: connection reset',
    )
    expect(e.kind === 'session_event' && e.warning).toBe(true)
  })

  it('turn_completed rate_limit → "Turn failed in X: rate limited"', () => {
    const items = subagentViewAppend([], {
      type: 'turn_completed',
      stopReason: 'rate_limit',
      elapsedMs: 32000,
    } as AcpEvent)
    const e = lastOf(items)
    expect(e.kind === 'session_event' && e.text).toBe(
      'Turn failed in 32s: rate limited',
    )
  })

  it('turn_completed cancelled + elapsedMs → "Turn cancelled by user in X."', () => {
    const items = subagentViewAppend([], {
      type: 'turn_completed',
      stopReason: 'cancelled',
      elapsedMs: 10000,
    } as AcpEvent)
    const e = lastOf(items)
    expect(e.kind === 'session_event' && e.text).toBe(
      'Turn cancelled by user in 10s.',
    )
  })

  it('update 原样字段（live rail 形状）→ stop_reason/agent_result/elapsed_ms 兜底', () => {
    const items = subagentViewAppend([], {
      type: 'turn_completed',
      update: { stop_reason: 'error', agent_result: 'boom', elapsed_ms: 2500 },
    } as unknown as AcpEvent)
    const e = lastOf(items)
    expect(e.kind === 'session_event' && e.text).toBe('Turn failed in 2.5s: boom')
  })

  it('turn_completed 无任何数据 → 回退旧固定文案 "— turn ended —"', () => {
    const items = subagentViewAppend([], { type: 'turn_completed' } as AcpEvent)
    const e = lastOf(items)
    expect(e.kind === 'session_event' && e.text).toBe('— turn ended —')
  })

  it('live done 无数据 → 固定文案 "— turn completed —"；带 stopReason=error → Turn failed', () => {
    const idle = lastOf(subagentViewAppend([], { type: 'done' } as AcpEvent))
    expect(idle.kind === 'session_event' && idle.text).toBe('— turn completed —')

    const failed = lastOf(
      subagentViewAppend([], { type: 'done', stopReason: 'error' } as AcpEvent),
    )
    expect(failed.kind === 'session_event' && failed.text).toBe(
      'Turn failed: unknown error',
    )
  })

  it('live cancelled 无字段 → "Turn cancelled."（事件类型即 stopReason，TUI TurnCancelled）', () => {
    const items = subagentViewAppend([], { type: 'cancelled' } as AcpEvent)
    const e = lastOf(items)
    expect(e.kind === 'session_event' && e.text).toBe('Turn cancelled.')
  })

  it('turn_completed 旧日志无 elapsed_ms → turnStartedAt/endMs 推导时长', () => {
    const items = subagentViewAppend([], {
      type: 'turn_completed',
      turnStartedAt: 1000,
      endMs: 61000,
    } as AcpEvent)
    const e = lastOf(items)
    expect(e.kind === 'session_event' && e.text).toBe('Worked for 1m0s')
  })
})

describe('applySubagentViewEvent — cancelled 本地回合锚（live cancelled 无字段也带时长）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  function makeSet(state: { subagentViews: Record<string, { items: ScrollEntry[]; fetchState: string }> }) {
    return vi.fn((partial: unknown) => {
      const patch =
        typeof partial === 'function'
          ? (partial as (s: typeof state) => Partial<typeof state>)(state)
          : (partial as Partial<typeof state>)
      Object.assign(state, patch)
    }) as unknown as Parameters<typeof applySubagentViewEvent>[0]
  }

  it('user_message 锚定 → cancelled 注入本地时长 "Turn cancelled by user in 1.5s."', () => {
    const state = {
      subagentViews: { child1: { items: [] as ScrollEntry[], fetchState: 'idle' } },
    }
    applySubagentViewEvent(makeSet(state), 'child1', {
      type: 'user_message',
      text: 'go',
    } as AcpEvent)
    vi.setSystemTime(new Date('2026-01-01T00:00:01.500Z'))
    applySubagentViewEvent(makeSet(state), 'child1', { type: 'cancelled' } as AcpEvent)
    const items = state.subagentViews['child1']!.items
    const e = lastOf(items)
    expect(e.kind === 'session_event' && e.text).toBe(
      'Turn cancelled by user in 1.5s.',
    )
  })

  it('锚随终态消费：下一回合 user_message 重新锚定，时长不跨回合累计', () => {
    const state = {
      subagentViews: { child1: { items: [] as ScrollEntry[], fetchState: 'idle' } },
    }
    applySubagentViewEvent(makeSet(state), 'child1', {
      type: 'user_message',
      text: 'go',
    } as AcpEvent)
    vi.setSystemTime(new Date('2026-01-01T00:00:01.500Z'))
    applySubagentViewEvent(makeSet(state), 'child1', { type: 'cancelled' } as AcpEvent)
    // 第二回合 3s 后开始、3.5s 后收到 done——时长按第二回合的锚算。
    vi.setSystemTime(new Date('2026-01-01T00:00:03.000Z'))
    applySubagentViewEvent(makeSet(state), 'child1', {
      type: 'user_message',
      text: 'again',
    } as AcpEvent)
    vi.setSystemTime(new Date('2026-01-01T00:00:03.500Z'))
    applySubagentViewEvent(makeSet(state), 'child1', { type: 'done' } as AcpEvent)
    const items = state.subagentViews['child1']!.items
    const e = lastOf(items)
    expect(e.kind === 'session_event' && e.text).toBe('Worked for 0.5s')
  })

  it('无锚（回放路径直接调 subagentViewAppend）→ done/cancelled 走固定文案回退', () => {
    const state = {
      subagentViews: { child1: { items: [] as ScrollEntry[], fetchState: 'idle' } },
    }
    applySubagentViewEvent(makeSet(state), 'child1', { type: 'done' } as AcpEvent)
    const e = lastOf(state.subagentViews['child1']!.items)
    expect(e.kind === 'session_event' && e.text).toBe('— turn completed —')
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

/** read 三件套：调用 / 元数据 / 终态。 */
const subagentReadTriple = (): AcpEvent[] => [
  anonCall({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_sub_1',
    title: 'read_file',
    rawInput: { limit: 30, offset: 7, target_file: READ_PATH },
    _meta: { 'x.ai/tool': { kind: 'read', label: 'Read', name: 'read_file' } },
  }),
  anonCall({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_sub_1',
    kind: 'read',
    title: `Read \`${READ_PATH}\``,
    rawInput: { limit: 30, offset: 7, target_file: READ_PATH, variant: 'ReadFile' },
    _meta: { 'x.ai/tool': { kind: 'read', label: 'Read', name: 'read_file' } },
  }),
  anonCall({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_sub_1',
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

describe('subagentViewAppend — 工具行更新与状态合并', () => {
  it('read 三件套并成一格：状态收口、内容落行、标题保留路径', () => {
    let items: ScrollEntry[] = []
    for (const ev of subagentReadTriple()) items = subagentViewAppend(items, ev)

    const tools = toolsOf(items)
    expect(tools.length).toBe(1)
    const detail = extractToolDetail(tools[0]!.raw!, tools[0]!.kindName)
    expect(tools[0]!.status).toBe('completed')
    expect(tools[0]!.title).toBe(`Read \`${READ_PATH}\``)
    expect((detail as { content?: string }).content).toContain('SubagentEntry')
  })
})