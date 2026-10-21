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

describe('usage 事件的会话归属', () => {
  // 回合末的收尾 chunk 常晚于 turn_completed：busy 已清，若此时丢掉带
  // sid 的 usage，顶栏会停在上一轮的数，与 /session-info 弹窗的权威值
  // 分叉（实测 0500f：顶栏 113K vs 弹窗 115K）。
  it('空闲期带当前 sid 的 live usage 仍写进 usage', () => {
    const { state, feed } = makeStore({ conn: 'ready', statusText: '' })
    feed({ type: 'usage', sessionId: 's1', used: 118_007 } as AcpEvent)
    expect(state.usage).toEqual({ used: 118_007, size: undefined })
  })

  it('空闲期外来 sid 的 usage 被忽略', () => {
    const { state, feed } = makeStore({ conn: 'ready', statusText: '' })
    feed({ type: 'usage', sessionId: 'other', used: 1 } as AcpEvent)
    expect(state.usage).toBeUndefined()
  })

  it('空闲期无 sid 的 usage 仍按 busy 防线丢弃', () => {
    const { state, feed } = makeStore({ conn: 'ready', statusText: '', sessions: [] })
    feed({ type: 'usage', used: 1 } as AcpEvent)
    expect(state.usage).toBeUndefined()
  })

  it('loading 期间无 sid 的回放 usage 照常应用', () => {
    const { state, feed } = makeStore({
      conn: 'ready',
      statusText: '',
      historyLoading: true,
    })
    feed({ type: 'usage', used: 5, size: 10 } as AcpEvent)
    expect(state.usage).toEqual({ used: 5, size: 10 })
  })
})

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

  it('带 truncated: true 的直接执行命令更新不会被误判为孤儿并删除', () => {
    const { state, feed, tool } = makeStore()
    feed({
      type: 'tool_call',
      toolCall: {
        sessionUpdate: 'tool_call',
        toolCallId: 'bash-mode-1',
        title: 'Execute `ls`',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'ls', description: 'ls', is_background: false },
        _meta: { bash_mode: true },
      },
    } as AcpEvent)
    expect(state.entries.filter((e) => e.kind === 'tool')).toHaveLength(1)

    feed({
      type: 'tool_call_update',
      toolCallUpdate: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'bash-mode-1',
        status: 'completed',
        rawOutput: {
          type: 'Bash',
          command: 'ls',
          output: '... (16 lines)\nfile1\nfile2',
          truncated: true,
          exit_code: 0,
        },
      },
    } as AcpEvent)
    expect(state.entries.filter((e) => e.kind === 'tool')).toHaveLength(1)
    expect(tool()).toMatchObject({
      status: 'completed',
      title: 'ls',
      expanded: true,
      displayMode: 'expanded',
    })
    expect(tool()?.raw?.rawOutput).toMatchObject({
      output: '... (16 lines)\nfile1\nfile2',
      truncated: true,
    })
  })

  it('! 命令：终端全量 stdout 之后的截断摘要不覆盖全文', () => {
    const { feed, tool } = makeStore()
    const full = 'L01\nL02\nL03\nL04\nL05\nL06\nL07\nL08\nL09\nL10\nL11\nL12\n'
    const tail = '... (12 lines)\nL03\nL04\nL05\nL06\nL07\nL08\nL09\nL10\nL11\nL12'
    feed({
      type: 'tool_call',
      toolCall: {
        toolCallId: 'bash-mode-2',
        title: 'Execute `seq`',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'seq', is_background: false },
        _meta: { bash_mode: true },
      },
    } as AcpEvent)
    feed({
      type: 'tool_call_update',
      toolCallUpdate: {
        toolCallId: 'bash-mode-2',
        status: 'completed',
        rawOutput: {
          type: 'Bash',
          command: 'seq',
          output: [...full].map((c) => c.charCodeAt(0)),
          truncated: false,
          exit_code: 0,
        },
      },
    } as AcpEvent)
    feed({
      type: 'tool_call_update',
      toolCallUpdate: {
        toolCallId: 'bash-mode-2',
        status: 'completed',
        rawOutput: {
          type: 'Bash',
          command: 'seq',
          output: [...tail].map((c) => c.charCodeAt(0)),
          output_for_prompt: tail,
          truncated: true,
          exit_code: 0,
        },
      },
    } as AcpEvent)
    expect(tool()).toMatchObject({ status: 'completed', displayMode: 'expanded' })
    const ro = tool()?.raw?.rawOutput as { output?: unknown; truncated?: boolean }
    expect(new TextDecoder().decode(Uint8Array.from(ro.output as number[]))).toBe(full)
    expect(ro.truncated).toBe(false)
  })
})
