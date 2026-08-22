import { describe, expect, it, vi } from 'vitest'
import { appendEntry, entryTimestamp, extractSessionUpdate } from './entries'

describe('extractSessionUpdate', () => {
  it('envelope / 扁平 wire 两种形态', () => {
    expect(extractSessionUpdate({ update: { sessionUpdate: 'agent_message_chunk', a: 1 } })).toEqual({
      tag: 'agent_message_chunk',
      fields: { sessionUpdate: 'agent_message_chunk', a: 1 },
    })
    expect(extractSessionUpdate({ sessionUpdate: 'task_backgrounded', b: 2 })).toEqual({
      tag: 'task_backgrounded',
      fields: { sessionUpdate: 'task_backgrounded', b: 2 },
    })
    expect(extractSessionUpdate(undefined)).toEqual({ tag: undefined, fields: {} })
    expect(extractSessionUpdate({ update: 'not-an-object' })).toEqual({ tag: undefined, fields: 'not-an-object' as never })
  })
})

describe('appendEntry', () => {
  it('生成 id 并追加', () => {
    const set = vi.fn()
    appendEntry(set as never, { kind: 'session_event', text: 'x' })
    const updater = set.mock.calls[0][0] as (s: { entries: unknown[] }) => { entries: unknown[] }
    const next = updater({ entries: [{ id: 'a', kind: 'user', text: 'q' }] })
    expect(next.entries).toHaveLength(2)
    expect((next.entries[1] as { id: string; kind: string }).id).toMatch(/^e_\d+_\d+$/)
    expect((next.entries[1] as { kind: string }).kind).toBe('session_event')
  })
})

describe('entryTimestamp', () => {
  it('user/assistant/image 用 ts；thought/tool/subagent 用 startedAt；其余 undefined', () => {
    expect(entryTimestamp({ id: '1', kind: 'user', text: 'x', ts: 10 })).toBe(10)
    expect(entryTimestamp({ id: '2', kind: 'assistant', text: 'x', ts: 20 })).toBe(20)
    expect(entryTimestamp({ id: '3', kind: 'image', data: 'd', ts: 30 })).toBe(30)
    expect(entryTimestamp({ id: '4', kind: 'thought', text: 'x', startedAt: 40 })).toBe(40)
    expect(entryTimestamp({ id: '5', kind: 'tool', title: 't', verb: 'v', startedAt: 50 })).toBe(50)
    expect(entryTimestamp({ id: '6', kind: 'subagent', title: 's', status: 'started', startedAt: 60 })).toBe(60)
    expect(entryTimestamp({ id: '7', kind: 'error', text: 'e' })).toBeUndefined()
    expect(entryTimestamp({ id: '8', kind: 'user', text: 'x' })).toBeUndefined()
  })
})