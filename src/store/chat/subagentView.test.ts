import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpEvent } from '../../api/types'
import { sealSubagentStreaming, subagentViewAppend } from './subagentView'

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