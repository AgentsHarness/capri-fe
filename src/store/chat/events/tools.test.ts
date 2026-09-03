import { beforeEach, describe, expect, it } from 'vitest'
import type { AcpEvent, ScrollEntry, ToolCall } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { handleToolEvent } from './tools'
import { clearSuppressedTools } from '../tools'

/**
 * Wire payloads recorded from a session whose gateway returned function
 * calls with a blank call_id
 * (~/.grok/sessions/…/01a04c5b-afe2-74a2-90c6-161d5a5af810/updates.jsonl):
 * toolCallId is "" on every tool_call and tool_call_update, including the
 * completion ones.
 */
const LS = 'ls -la ~/.grok/ 2>/dev/null | head -50'

const callStart = (command: string): ToolCall =>
  ({
    sessionUpdate: 'tool_call',
    toolCallId: '',
    title: 'run_terminal_command',
    rawInput: { command, description: 'probe' },
    _meta: {
      'x.ai/tool': { name: 'run_terminal_command', kind: 'execute', label: 'Run Command' },
    },
  }) as unknown as ToolCall

const callDone = (command: string, output: string): ToolCall =>
  ({
    sessionUpdate: 'tool_call_update',
    toolCallId: '',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: output } }],
    rawOutput: { type: 'Bash', command, output_for_prompt: output, exit_code: 0 },
  }) as unknown as ToolCall

function makeStore(seed?: Partial<ChatState>) {
  const state = {
    sessionId: 's1',
    entries: [] as ScrollEntry[],
    toolIndex: {},
    bgTaskIndex: {},
    conn: 'busy',
    statusText: 'Responding…',
    ...seed,
  } as unknown as ChatState
  const set = ((partial: unknown) => {
    const patch =
      typeof partial === 'function'
        ? (partial as (s: ChatState) => Partial<ChatState>)(state)
        : (partial as Partial<ChatState>)
    Object.assign(state, patch)
  }) as SetState
  const feed = (ev: AcpEvent) => handleToolEvent(set, () => state, ev)
  return { state, feed, tool: (i = 0) => state.entries.filter((e) => e.kind === 'tool')[i] }
}

beforeEach(() => clearSuppressedTools())

describe('tool_call_update 带 id 走 toolIndex', () => {
  it('带 id 的 update 走 toolIndex 正常更新', () => {
    const { state, feed, tool } = makeStore()
    feed({
      type: 'tool_call',
      toolCall: { ...callStart(LS), toolCallId: 'call_1' },
    } as AcpEvent)
    feed({
      type: 'tool_call_update',
      toolCallUpdate: { ...callDone(LS, 'total 448\n'), toolCallId: 'call_1' },
    } as AcpEvent)
    expect(tool()).toMatchObject({ status: 'completed', verb: 'Run' })
    expect(state.entries.filter((e) => e.kind === 'tool')).toHaveLength(1)
  })

  it('host 合成 id 同样走 toolIndex', () => {
    const { state, feed, tool } = makeStore()
    const id = 'synth:call:1700000000000:0'
    feed({
      type: 'tool_call',
      toolCall: { ...callStart(LS), toolCallId: id },
    } as AcpEvent)
    feed({
      type: 'tool_call_update',
      toolCallUpdate: { ...callDone(LS, 'ok\n'), toolCallId: id },
    } as AcpEvent)
    expect(tool()).toMatchObject({ status: 'completed', toolCallId: id })
    expect(state.entries.filter((e) => e.kind === 'tool')).toHaveLength(1)
  })

  it('空 toolCallId 的 update 直接丢弃（host 负责注入）', () => {
    const { feed, tool } = makeStore()
    feed({
      type: 'tool_call',
      toolCall: { ...callStart(LS), toolCallId: 'synth:call:1:0' },
    } as AcpEvent)
    feed({
      type: 'tool_call_update',
      toolCallUpdate: callDone(LS, 'should-not-apply\n'),
    } as AcpEvent)
    expect(tool()).toMatchObject({ status: 'pending' })
    expect(tool()?.raw).not.toMatchObject({ status: 'completed' })
  })
})
