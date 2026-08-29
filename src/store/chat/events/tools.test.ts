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
const FIND = 'find ~/.grok -maxdepth 2 -type d | head -50'

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

const callRename = (command: string): ToolCall =>
  ({
    sessionUpdate: 'tool_call_update',
    toolCallId: '',
    kind: 'execute',
    title: 'Execute `' + command + '`',
    content: [{ type: 'content', content: { type: 'text', text: 'probe' } }],
    locations: [],
    rawInput: { variant: 'Bash', command, description: 'probe', is_background: false },
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

describe('tool_call_update 空 toolCallId 认领', () => {
  it('匿名行按真实 wire 序列收口（pending → completed）', () => {
    const { state, feed, tool } = makeStore()
    feed({ type: 'tool_call', toolCall: callStart(LS) } as AcpEvent)
    expect(tool()?.status).toBe('pending')
    expect(tool()?.verb).toBe('Running')

    feed({ type: 'tool_call_update', toolCallUpdate: callRename(LS) } as AcpEvent)
    feed({ type: 'tool_call_update', toolCallUpdate: callDone(LS, 'total 448\n') } as AcpEvent)

    expect(tool()).toMatchObject({ status: 'completed', verb: 'Run', title: LS })
    // 精确命中：raw 合并进来，rename 的 Execute 标题与 rawOutput 都在行上。
    expect((tool() as { raw: ToolCall }).raw?.rawOutput).toBeTruthy()
    expect(state.statusText).toBe('Waiting for response…')
    expect((tool() as { finishedAt?: number }).finishedAt).toBeTypeOf('number')
  })

  it('并行批次完成顺序颠倒也只各归各行，不串台', () => {
    const { feed, tool } = makeStore()
    feed({ type: 'tool_call', toolCall: callStart(LS) } as AcpEvent)
    feed({ type: 'tool_call', toolCall: callStart(FIND) } as AcpEvent)
    // 第二条先完成（FIFO 会误伤第一条，精确匹配不会）。
    feed({ type: 'tool_call_update', toolCallUpdate: callDone(FIND, '/Users/benin/.grok\n') } as AcpEvent)

    expect(tool(0)?.status).toBe('pending')
    expect(tool(1)?.status).toBe('completed')
    feed({ type: 'tool_call_update', toolCallUpdate: callDone(LS, 'total 448\n') } as AcpEvent)
    expect(tool(0)?.status).toBe('completed')
  })

  it('认不到 command 时按最早未收口行只收状态，不合并 raw', () => {
    const { feed, tool } = makeStore()
    feed({ type: 'tool_call', toolCall: callStart(LS) } as AcpEvent)
    const raw0 = (tool() as { raw: ToolCall }).raw
    // 列表型工具的终态 update 不带 command/path（只有 rawOutput.Content）。
    feed({
      type: 'tool_call_update',
      toolCallUpdate: {
        sessionUpdate: 'tool_call_update',
        toolCallId: '',
        status: 'completed',
        rawOutput: { type: 'ListDir', Content: { content: '- /Users/benin/ccwork/\n' } },
      },
    } as unknown as AcpEvent)
    expect(tool()).toMatchObject({ status: 'completed', verb: 'Run' })
    expect((tool() as { raw: ToolCall }).raw).toBe(raw0)
  })

  it('无未收口匿名行时不凭空造行', () => {
    const { state, feed } = makeStore()
    feed({ type: 'tool_call_update', toolCallUpdate: callDone(LS, 'x') } as AcpEvent)
    expect(state.entries).toHaveLength(0)
  })

  it('非终态的匿名流式增量不改行', () => {
    const { feed, tool } = makeStore()
    feed({ type: 'tool_call', toolCall: callStart(LS) } as AcpEvent)
    feed({
      type: 'tool_call_update',
      toolCallUpdate: {
        sessionUpdate: 'tool_call_update',
        toolCallId: '',
        rawOutput: { type: 'Bash', command: 'unrelated-cmd', output_for_prompt: 'partial' },
      },
    } as unknown as AcpEvent)
    expect(tool()).toMatchObject({ status: 'pending', verb: 'Running' })
  })

  it('迟到分类为后台执行：撤掉匿名行并把日志折进 bg_task', () => {
    const { state, feed } = makeStore({
      entries: [
        {
          id: 'bg1',
          kind: 'bg_task',
          title: 'serve',
          status: 'started',
          running: true,
          taskId: 't1',
          command: LS,
        } as ScrollEntry,
      ],
      bgTaskIndex: { t1: 'bg1' },
    })
    feed({ type: 'tool_call', toolCall: callStart(LS) } as AcpEvent)
    feed({
      type: 'tool_call_update',
      toolCallUpdate: {
        ...callRename(LS),
        rawInput: { variant: 'Bash', command: LS, is_background: true },
        rawOutput: { type: 'Bash', command: LS, output_for_prompt: 'vite ready' },
      },
    } as unknown as AcpEvent)
    expect(state.entries.filter((e) => e.kind === 'tool')).toHaveLength(0)
    const bg = state.entries.find((e) => e.id === 'bg1') as { output?: string }
    expect(bg.output).toBe('vite ready')
  })

  it('带 id 的 update 仍走 toolIndex（回归）', () => {
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
    // 匿名行不会被带 id 的 update 认领，反之亦然。
    expect(state.entries.filter((e) => e.kind === 'tool')).toHaveLength(1)
  })

  it('非当前会话的匿名 update 不动本视图', () => {
    const { state, feed } = makeStore()
    feed({ type: 'tool_call', toolCall: callStart(LS) } as AcpEvent)
    feed({
      type: 'tool_call_update',
      toolCallUpdate: callDone(LS, 'x'),
      sessionId: 'other',
    } as unknown as AcpEvent)
    expect(state.entries.filter((e) => e.kind === 'tool')[0]).toMatchObject({
      status: 'pending',
    })
  })
})
