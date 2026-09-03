import { describe, expect, it } from 'vitest'
import type { ScrollEntry, ToolCall } from '../../api/types'
import { extractToolBodies, applyToolBodies } from './historyFill'

const SYNTH = 'synth:call:1700000000000:0'

function env(seq: number, update: Record<string, unknown>): unknown {
  return { msgSeq: seq, params: { update } }
}

describe('host 合成 toolCallId 的 FE 消费', () => {
  it('extractToolBodies 按合成 id 合并正文；空 id 丢弃', () => {
    const bodies = extractToolBodies([
      env(0, {
        sessionUpdate: 'tool_call',
        toolCallId: SYNTH,
        title: 'run_terminal_command',
        rawInput: { command: 'echo hi' },
      }),
      env(1, {
        sessionUpdate: 'tool_call_update',
        toolCallId: SYNTH,
        status: 'completed',
        rawOutput: { type: 'Bash', command: 'echo hi', output: 'hi\n' },
        content: [{ type: 'text', text: 'hi' }],
      }),
      env(2, {
        sessionUpdate: 'tool_call_update',
        toolCallId: '',
        status: 'completed',
        rawOutput: { type: 'Bash', command: 'echo leaked', output: 'nope' },
      }),
    ])
    expect(bodies.size).toBe(1)
    expect(bodies.get(SYNTH)?.hasRawOutput).toBe(true)
    expect(bodies.get(SYNTH)?.hasContent).toBe(true)
    expect((bodies.get(SYNTH)?.rawOutput as { output: string }).output).toBe('hi\n')
  })

  it('applyToolBodies 按条目 toolCallId 回填并标 filled', () => {
    const bodies = extractToolBodies([
      env(1, {
        sessionUpdate: 'tool_call_update',
        toolCallId: SYNTH,
        rawOutput: { type: 'Bash', command: 'echo hi', output: 'hi\n' },
        content: [{ type: 'text', text: 'hi' }],
      }),
    ])
    const entries: ScrollEntry[] = [
      {
        id: 't1',
        kind: 'tool',
        title: 'echo hi',
        verb: 'Ran',
        toolCallId: SYNTH,
        status: 'completed',
        msgSeq: 0,
        msgSeqEnd: 1,
        liteOmitted: 80,
        raw: {
          toolCallId: SYNTH,
          kind: 'execute',
          status: 'completed',
          rawOutput: { omitted: 40 },
          content: [{ type: 'text', omitted: 40 }],
          _meta: { lite: { omitted: 80, fields: ['rawOutput', 'content'] } },
        } as ToolCall,
      },
    ]
    const once = applyToolBodies(entries, bodies)
    const row = once[0] as Extract<ScrollEntry, { kind: 'tool' }>
    expect(row.liteState).toBe('filled')
    expect((row.raw as ToolCall).rawOutput).toEqual({
      type: 'Bash',
      command: 'echo hi',
      output: 'hi\n',
    })
    expect(((row.raw as ToolCall)._meta as { lite?: unknown }).lite).toBeUndefined()
    expect(applyToolBodies(once, bodies)).toBe(once)
  })

  it('不同合成 id 的两次调用正文互不覆盖', () => {
    const a = 'synth:call:1000:0'
    const b = 'synth:call:2000:0'
    const bodies = extractToolBodies([
      env(0, {
        sessionUpdate: 'tool_call',
        toolCallId: a,
        rawOutput: { type: 'ReadFile', content: 'A' },
      }),
      env(1, {
        sessionUpdate: 'tool_call',
        toolCallId: b,
        rawOutput: { type: 'ReadFile', content: 'B' },
      }),
    ])
    expect((bodies.get(a)?.rawOutput as { content: string }).content).toBe('A')
    expect((bodies.get(b)?.rawOutput as { content: string }).content).toBe('B')
  })
})
