import { beforeEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { AcpEvent, ScrollEntry, ToolCall } from '../../../api/types'
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

// 工具调用的三段真实 wire。
const events: AcpEvent[] = [
  {
    type: 'tool_call',
    toolCall: {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc_test_1',
      title: 'run_terminal_command',
      rawInput: { command: CMD, description: '列出 ~/.grok 目录内容' },
      _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute' } },
    },
  } as unknown as AcpEvent,
  {
    type: 'tool_call_update',
    toolCallUpdate: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc_test_1',
      kind: 'execute',
      title: 'Execute `' + CMD + '`',
      rawInput: { variant: 'Bash', command: CMD, is_background: false },
    } as unknown as ToolCall,
  } as unknown as AcpEvent,
  {
    type: 'tool_call_update',
    toolCallUpdate: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc_test_1',
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

describe('工具行的渲染（store → DOM）', () => {
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

  it('SKILL.md 读取 → 行头 "Skill {name}"，不显示 Read 动词与文件路径', () => {
    const feed = useChatStore.getState().handleEvent
    feed({
      type: 'tool_call',
      toolCall: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-skill',
        title: 'read_file',
        kind: 'read',
        rawInput: { target_file: '/Users/benin/.grok/skills/deploy/SKILL.md' },
      },
    } as unknown as AcpEvent)
    const entry = useChatStore.getState().entries[0]
    expect(entry?.kind).toBe('tool')
    const r = render(
      <EntryView e={entry!} selected={false} pendingFreeze={false} now={Date.now()} />,
    )
    // span 之间没有空白字符，textContent 是 "Skill" + "deploy" 的拼接。
    expect(headerText(r.container)).toMatch(/Skill\s*deploy/)
    expect(headerText(r.container)).not.toContain('SKILL.md')
    expect(headerText(r.container)).not.toContain('Read')
    r.unmount()
  })
})

/** 直接构造 tool 条目（跳过 store），验证 TUI 行头复刻规则。 */
function toolEntry(
  over: Partial<Extract<ScrollEntry, { kind: 'tool' }>> & {
    rawInput: Record<string, unknown>
    /** wire 上的 tool_call title（宿主 stamped，如 "Skill: deploy"）。 */
    rawTitle?: string
  },
): ScrollEntry {
  const { rawInput, rawTitle, ...rest } = over
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'tool',
    title: rawTitle ?? (rawInput.path as string) ?? (rawInput.tool_name as string) ?? '',
    verb: 'v',
    status: 'completed',
    ...rest,
    raw: { toolCallId: 'x', title: rawTitle, rawInput } as never,
  } as ScrollEntry
}

function renderHeader(e: ScrollEntry): string {
  const r = render(
    <EntryView e={e} selected={false} pendingFreeze={false} now={Date.now()} />,
  )
  const text = headerText(r.container)
  r.unmount()
  return text
}

describe('TUI 行头复刻（surface / 名词改写）', () => {
  beforeEach(() => {
    useChatStore.setState({ cwd: '/Users/benin/ccwork/acp-fe', historyCwd: undefined })
  })

  it('折叠 read 行只显示文件名，不打印目录', () => {
    const text = renderHeader(
      toolEntry({
        kindName: 'read',
        rawInput: { path: '/Users/benin/ccwork/acp-fe/src/scrollback/toolDetail.ts' },
      }),
    )
    expect(text).toMatch(/Read\s*toolDetail\.ts/)
    expect(text).not.toContain('/Users/benin')
    expect(text).not.toContain('src/scrollback')
  })

  it('行内展开 → cwd 相对路径', () => {
    const text = renderHeader(
      toolEntry({
        kindName: 'read',
        expanded: true,
        rawInput: { path: '/Users/benin/ccwork/acp-fe/src/scrollback/toolDetail.ts' },
      }),
    )
    expect(text).toContain('src/scrollback/toolDetail.ts')
    expect(text).not.toContain('/Users/benin')
  })

  it('cwd 外的路径 → 规范化绝对路径（不硬凑相对）', () => {
    const text = renderHeader(
      toolEntry({
        kindName: 'read',
        rawInput: { path: '/etc/./hosts' },
      }),
    )
    expect(text).toMatch(/Read\s*hosts/)
  })

  it('MCP 调用行 → Server 名词 + Action', () => {
    const text = renderHeader(
      toolEntry({ kindName: 'mcp', rawInput: { tool_name: 'linear__save_issue' } }),
    )
    expect(text).toMatch(/Linear\s*Save Issue/)
    expect(text).not.toContain('Ran')
  })

  it('子代理消息行 → 整句标题，无 verb 前缀', () => {
    const text = renderHeader(
      toolEntry({
        kindName: 'active_agent_message',
        rawTitle: 'Sending message to subagent',
        status: 'completed',
        rawInput: { message: 'hi' },
      }),
    )
    expect(text).toBe('Sent message to subagent')
  })

  it('Skill 工具调用行 → "Skill: name" 拆成名词与内容', () => {
    const text = renderHeader(
      toolEntry({
        kindName: 'skill',
        rawTitle: 'Skill: deploy',
        rawInput: { skill: 'deploy', variant: 'Skill' },
      }),
    )
    expect(text).toMatch(/Skill\s*deploy/)
    expect(text).not.toContain('Ran')
  })

  it('write 工具 → Creating 名词（TUI with_prefix("Creating ")）', () => {
    const text = renderHeader(
      toolEntry({ kindName: 'write', rawInput: { file_path: '/x/y/new.ts' } }),
    )
    expect(text).toMatch(/Creating\s*new\.ts/)
  })

  it('workflows/*.rhai → "Editing workflow {stem}"', () => {
    const text = renderHeader(
      toolEntry({
        kindName: 'edit',
        rawInput: { file_path: '/x/.grok/workflows/review-changes.rhai' },
      }),
    )
    expect(text).toMatch(/Editing workflow\s*review-changes/)
    expect(text).not.toContain('.rhai')
  })

  it('括号 suffix 紧跟路径，不被 flex-1 顶到行尾', () => {
    const r = render(
      <EntryView
        e={toolEntry({
          kindName: 'search',
          rawInput: { pattern: 'foo' },
        })}
        selected={false}
        pendingFreeze={false}
        now={Date.now()}
      />,
    )
    const btn = r.container.querySelector('button')
    expect(btn?.textContent).toContain('(no matches)')
    const suffix = [...(btn?.querySelectorAll('span') ?? [])].find((s) =>
      (s.textContent ?? '').includes('(no matches)'),
    )
    expect(suffix).toBeTruthy()
    expect(suffix!.className).not.toMatch(/\bml-auto\b/)
    // 路径容器是 suffix 的前一个兄弟；flex-1 会把中间空档撑开、() 靠右。
    const path = suffix!.previousElementSibling
    expect(path?.className ?? '').not.toMatch(/\bflex-1\b/)
    r.unmount()
  })
})

// host 在裁正文前折进行头标记的数字（_meta.lite.edits / .files），
// 折叠行在 lite 档就能显示 (+N/−M) 与 (N matches in M files)。
describe('lite 标记兜底折叠行后缀（store → DOM）', () => {
  function liteRow(over: Partial<Extract<ScrollEntry, { kind: 'tool' }>>): ScrollEntry {
    return {
      id: `t-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'tool',
      verb: 'v',
      status: 'completed',
      title: '',
      ...over,
    } as ScrollEntry
  }

  it('edit 正文被裁 → 折叠行仍显示 (+70/−3)', () => {
    const text = renderHeader(
      liteRow({
        kindName: 'edit',
        toolCallId: 'e1',
        msgSeq: 177,
        msgSeqEnd: 177,
        liteOmitted: 29944,
        raw: {
          toolCallId: 'e1',
          kind: 'edit',
          status: 'completed',
          title: 'Edit `/a/historyFill.ts`',
          rawInput: { file_path: '/a/historyFill.ts' },
          rawOutput: { type: 'SearchReplace', EditsApplied: { absolute_path: '/a/historyFill.ts' } },
          _meta: { lite: { omitted: 29944, msgSeqEnd: 177, edits: { ins: 70, del: 3 } } },
        } as unknown as ToolCall,
      }),
    )
    expect(text).toContain('(+70/−3)')
  })

  it('grep 正文被裁 → 折叠行仍显示 (55 matches in 13 files)', () => {
    const text = renderHeader(
      liteRow({
        kindName: 'search',
        toolCallId: 'g1',
        liteOmitted: 25486,
        raw: {
          toolCallId: 'g1',
          kind: 'search',
          status: 'completed',
          title: 'grep lite',
          rawInput: { pattern: 'lite', glob: '*.{ts,tsx}' },
          rawOutput: { type: 'GrepSearch', match_count: 55 },
          _meta: { lite: { omitted: 25486, files: 13 } },
        } as unknown as ToolCall,
      }),
    )
    expect(text).toContain('(55 matches in 13 files)')
  })
})
