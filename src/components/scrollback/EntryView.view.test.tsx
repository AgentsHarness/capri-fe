import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ScrollEntry, ToolCall } from '../../api/types'
import { useChatStore } from '../../store/chat'
import { EntryView } from './EntryView'
import { entryExpanded } from '../../scrollback/entryState'

class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ROStub as unknown as typeof ResizeObserver
window.matchMedia = window.matchMedia ?? (() => ({ matches: false })) as never

const OUT = 'total 448\ndrwxr-xr-x  2 benin  staff\n'

function toolEntry(id: string, over: Partial<ScrollEntry> = {}): ScrollEntry {
  return {
    id,
    kind: 'tool',
    title: 'Execute `ls -la`',
    kindName: 'execute',
    verb: 'Ran',
    status: 'completed',
    expanded: false,
    raw: {
      toolCallId: `tc-${id}`,
      title: 'Execute `ls -la`',
      kind: 'execute',
      status: 'completed',
      rawInput: { command: 'ls -la' },
      content: [{ type: 'text', text: OUT }],
      rawOutput: { type: 'Bash', command: 'ls -la', output: OUT, exit_code: 0 },
    } as unknown as ToolCall,
    ...over,
  } as ScrollEntry
}

const toolExpanded = (id: string) => {
  const e = useChatStore.getState().entries.find((x) => x.id === id)
  return e?.kind === 'tool' && e.expanded === true
}

beforeEach(() => {
  useChatStore.setState({
    entries: [],
    toolIndex: {},
    selectedId: null,
    sessionId: 's1',
    conn: 'ready',
    openViewer: vi.fn(),
  })
})

describe('标题单击立刻折叠 / 展开后「查看」弹窗', () => {
  it('点标题行同一帧就展开，不等待', () => {
    const e = toolEntry('t1')
    useChatStore.setState({ entries: [e] })
    render(<EntryView e={e} selected={false} pendingFreeze={false} now={0} />)
    expect(toolExpanded('t1')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    expect(toolExpanded('t1')).toBe(true)
  })

  it('折叠态不显示「查看」（选中/悬停也不出）', () => {
    const e = toolEntry('t1')
    useChatStore.setState({ entries: [e] })
    const r = render(
      <EntryView e={e} selected pendingFreeze={false} now={0} />,
    )
    expect(screen.queryByRole('button', { name: '查看' })).not.toBeInTheDocument()
    fireEvent.mouseEnter(r.container.querySelector('[data-entry-id="t1"]')!)
    expect(screen.queryByRole('button', { name: '查看' })).not.toBeInTheDocument()
  })

  it('展开后显示「查看」；点击打开弹窗且不折叠', () => {
    const e = toolEntry('t1', { expanded: true })
    useChatStore.setState({ entries: [e] })
    render(<EntryView e={e} selected={false} pendingFreeze={false} now={0} />)
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(useChatStore.getState().openViewer).toHaveBeenCalledWith('t1')
    expect(toolExpanded('t1')).toBe(true)
  })

  it('点展开后的正文立刻收起', () => {
    const e = toolEntry('t1', { expanded: true })
    useChatStore.setState({ entries: [e] })
    render(<EntryView e={e} selected pendingFreeze={false} now={0} />)
    fireEvent.click(screen.getByText(/total 448/))
    expect(toolExpanded('t1')).toBe(false)
  })

  it('思考块点正文同样立刻收起', () => {
    const e = {
      id: 'th1',
      kind: 'thought',
      text: 'reasoning about the thing',
      displayMode: 'expanded',
    } as ScrollEntry
    useChatStore.setState({ entries: [e] })
    render(<EntryView e={e} selected pendingFreeze={false} now={0} />)
    fireEvent.click(screen.getByText('reasoning about the thing'))
    const th = useChatStore.getState().entries.find((x) => x.id === 'th1')
    expect(th && 'displayMode' in th ? th.displayMode : undefined).toBe(
      'collapsed',
    )
  })

  it('流式思考（未收口）也显示「查看」且打开弹窗', () => {
    const e = {
      id: 'th1',
      kind: 'thought',
      text: 'reasoning so far',
      streaming: true,
    } as ScrollEntry
    useChatStore.setState({ entries: [e] })
    render(<EntryView e={e} selected={false} pendingFreeze={false} now={0} />)
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(useChatStore.getState().openViewer).toHaveBeenCalledWith('th1')
  })

  it('btw 展开显示「查看」且点击打开弹窗', () => {
    const e = {
      id: 'b1',
      kind: 'btw',
      question: '还有几步？',
      answer: '两步',
      open: true,
    } as ScrollEntry
    useChatStore.setState({ entries: [e] })
    render(<EntryView e={e} selected={false} pendingFreeze={false} now={0} />)
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(useChatStore.getState().openViewer).toHaveBeenCalledWith('b1')
  })

  it('正文里拖拽选词不收起', () => {
    const e = toolEntry('t1', { expanded: true })
    useChatStore.setState({ entries: [e] })
    render(<EntryView e={e} selected pendingFreeze={false} now={0} />)
    const body = screen.getByText(/total 448/)
    fireEvent.mouseDown(body, { clientX: 0, clientY: 0, button: 0 })
    fireEvent.click(body, { clientX: 120, clientY: 8, detail: 1 })
    expect(toolExpanded('t1')).toBe(true)
  })
})

/**
 * lite 占位行只在展开态出现：折叠卡本来就不画正文，每张裁过的卡都插一行
 * 「输出已省略」会把 lite 会话的滚动区撑成占位列表；展开（toggleTool）与
 * 「查看」都会按需补全，届时才需要它。
 */
describe('lite 占位行的可见范围', () => {
  const liteTool = (over: Partial<ScrollEntry> = {}) =>
    toolEntry('lite1', {
      raw: {
        toolCallId: 'tc-lite1',
        title: 'Execute `ls -la`',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'ls -la' },
        rawOutput: { type: 'Bash', command: 'ls -la', output: { omitted: 4096 } },
        _meta: { lite: { omitted: 4096, fields: ['rawOutput.output'] } },
      } as unknown as ToolCall,
      liteOmitted: 4096,
      msgSeq: 1,
      msgSeqEnd: 2,
      ...over,
    })

  it('折叠态不插占位行', () => {
    const e = liteTool({ expanded: false })
    useChatStore.setState({ entries: [e] })
    render(<EntryView e={e} selected={false} pendingFreeze={false} now={0} />)
    expect(screen.queryByText(/输出已省略/)).toBeNull()
  })

  it('展开态显示占位行，且裁掉的正文不渲染', () => {
    const e = liteTool({ expanded: true })
    useChatStore.setState({ entries: [e] })
    render(<EntryView e={e} selected={false} pendingFreeze={false} now={0} />)
    expect(screen.getByText(/输出已省略/)).toBeTruthy()
    expect(screen.queryByText(/total 448/)).toBeNull()
    expect(screen.queryByRole('button', { name: '[加载]' })).toBeNull()
  })

  it('加载中不显示按钮；失败才出现 [重试]', () => {
    const loading = liteTool({ expanded: true, liteState: 'loading' })
    useChatStore.setState({ entries: [loading] })
    const r = render(<EntryView e={loading} selected={false} pendingFreeze={false} now={0} />)
    expect(screen.getByText(/正在加载工具输出/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '[加载]' })).toBeNull()
    expect(screen.queryByRole('button', { name: '[重试]' })).toBeNull()

    const failed = liteTool({ expanded: true, liteState: 'error' })
    useChatStore.setState({ entries: [failed] })
    r.rerender(<EntryView e={failed} selected={false} pendingFreeze={false} now={0} />)
    expect(screen.getByRole('button', { name: '[重试]' })).toBeTruthy()
  })
})

describe('memory capture 调试块（TUI MemoryCaptureBlock）', () => {
  const captureEntry = (over: Partial<ScrollEntry> = {}): ScrollEntry =>
    ({
      id: 'mc1',
      kind: 'session_event',
      text: '模型生成的记忆调试输出：第 2-4 回合共 1 条观察',
      memoryCapture: {
        fromTurn: 2,
        throughTurn: 4,
        observations: [
          {
            statement: 'Use the focused test target.',
            body: 'The full suite is expensive.',
            path: '/tmp/memory/observation.md',
          },
        ],
      },
      ...over,
    }) as ScrollEntry

  it('默认折叠：只有标题行；点开后给出语句、正文、路径与不可信标记', () => {
    const e = captureEntry()
    useChatStore.setState({ entries: [e] })
    const r = render(<EntryView e={e} selected={false} pendingFreeze={false} now={0} />)
    expect(screen.getByText(/模型生成的记忆调试输出/)).toBeInTheDocument()
    expect(screen.queryByText('Use the focused test target.')).toBeNull()
    expect(screen.queryByText('/tmp/memory/observation.md')).toBeNull()

    // 单击整块折叠（与 recap 同一条 open 通路）。
    fireEvent.click(screen.getByText(/模型生成的记忆调试输出/))
    const opened = useChatStore.getState().entries[0]
    expect(entryExpanded(opened)).toBe(true)

    r.rerender(<EntryView e={opened} selected={false} pendingFreeze={false} now={0} />)
    expect(screen.getByText('不可信模型生成观察 1')).toBeInTheDocument()
    expect(screen.getByText('Use the focused test target.')).toBeInTheDocument()
    expect(screen.getByText('The full suite is expensive.')).toBeInTheDocument()
    expect(screen.getByText('/tmp/memory/observation.md')).toBeInTheDocument()
  })

  it('普通 session_event（无载荷）仍不可折叠', () => {
    const e = { id: 'se1', kind: 'session_event', text: '记忆捕获排队中：第 1-1 回合' } as ScrollEntry
    useChatStore.setState({ entries: [e] })
    render(<EntryView e={e} selected={false} pendingFreeze={false} now={0} />)
    fireEvent.click(screen.getByText(/记忆捕获排队中/))
    expect(screen.queryByText('不可信模型生成观察 1')).toBeNull()
  })
})
