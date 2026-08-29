import { beforeEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { AcpEvent, ToolCall } from '../../../api/types'
import { useChatStore } from '../../../store/chat'
import { clearSuppressedTools } from '../../../store/chat/tools'
import { EntryView } from '../EntryView'

// AccentRail 依赖 ResizeObserver / matchMedia（jsdom 均未实现）。
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ROStub as unknown as typeof ResizeObserver
window.matchMedia = window.matchMedia ?? (() => ({ matches: false })) as never

const CMD = 'ls -la ~/.grok/ 2>/dev/null | head -50'

// 空 toolCallId 的三段真实 wire（兼容层漏了 call_id 的会话载荷）。
const events: AcpEvent[] = [
  {
    type: 'tool_call',
    toolCall: {
      sessionUpdate: 'tool_call',
      toolCallId: '',
      title: 'run_terminal_command',
      rawInput: { command: CMD, description: '列出 ~/.grok 目录内容' },
      _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute' } },
    },
  } as unknown as AcpEvent,
  {
    type: 'tool_call_update',
    toolCallUpdate: {
      sessionUpdate: 'tool_call_update',
      toolCallId: '',
      kind: 'execute',
      title: 'Execute `' + CMD + '`',
      rawInput: { variant: 'Bash', command: CMD, is_background: false },
    } as unknown as ToolCall,
  } as unknown as AcpEvent,
  {
    type: 'tool_call_update',
    toolCallUpdate: {
      sessionUpdate: 'tool_call_update',
      toolCallId: '',
      status: 'completed',
      rawOutput: { type: 'Bash', command: CMD, output_for_prompt: 'total 448\n', exit_code: 0 },
    } as unknown as ToolCall,
  } as unknown as AcpEvent,
]

beforeEach(() => {
  clearSuppressedTools()
  useChatStore.setState({
    entries: [],
    toolIndex: {},
    sessionId: 's1',
    conn: 'busy',
    turnStartedAt: Date.now(),
  })
})

function headerText(container: HTMLElement): string {
  return container.querySelector('button')?.textContent ?? ''
}

describe('匿名工具行的渲染（store → DOM）', () => {
  it('终态 update 到达前显示 Running，到达后收口', () => {
    const feed = useChatStore.getState().handleEvent

    for (const ev of events.slice(0, 1)) feed(ev)
    const running = useChatStore.getState().entries[0]
    expect(running?.kind).toBe('tool')
    const r = render(
      <EntryView e={running!} selected={false} pendingFreeze={false} now={Date.now()} />,
    )
    expect(headerText(r.container)).toMatch(/Running/)
    r.unmount()

    for (const ev of events.slice(1)) feed(ev)
    const done = useChatStore.getState().entries[0]
    expect(done?.kind === 'tool' && done.status).toBe('completed')
    const d = render(
      <EntryView e={done!} selected={false} pendingFreeze={false} now={Date.now()} />,
    )
    expect(headerText(d.container)).toContain('ls -la ~/.grok/')
    expect(headerText(d.container)).not.toMatch(/Running/)
    // 终态 update 的 rawOutput 合并进了行（折叠展开时可见日志）。
    expect((done as { raw?: ToolCall }).raw?.rawOutput).toBeTruthy()
  })
})
