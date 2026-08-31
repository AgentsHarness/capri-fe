import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ScrollEntry, ToolCall } from '../../api/types'
import { useChatStore } from '../../store/chat'
import { EntryView } from './EntryView'

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
