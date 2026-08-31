import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ScrollEntry } from '../../../api/types'
import { useChatStore } from '../../../store/chat'
import { EntryView } from '../EntryView'
import { HookGroupsDetail, StopHookSummary } from './HookRuns'

class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ROStub as unknown as typeof ResizeObserver
window.matchMedia = window.matchMedia ?? (() => ({ matches: false })) as never

const ok = { name: 'global/probe:session_start[0].hooks[0]', status: { type: 'success' as const, elapsedMs: 6 } }

beforeEach(() => {
  useChatStore.setState({
    entries: [],
    selectedId: null,
    toggleLifecycle: vi.fn((id: string) => {
      useChatStore.setState({
        entries: useChatStore.getState().entries.map((e) =>
          e.id === id && e.kind === 'lifecycle' ? { ...e, expanded: !e.expanded } : e,
        ),
      })
    }),
    toggleSessionEvent: vi.fn((id: string) => {
      useChatStore.setState({
        entries: useChatStore.getState().entries.map((e) =>
          e.id === id && e.kind === 'session_event' ? { ...e, open: !e.open } : e,
        ),
      })
    }),
    selectEntry: vi.fn(),
    toggleTool: vi.fn(),
    toggleThought: vi.fn(),
    toggleUser: vi.fn(),
    toggleBtw: vi.fn(),
    openViewer: vi.fn(),
    cancelSubagent: vi.fn(),
    killTask: vi.fn(),
  })
})

describe('LifecycleEntry', () => {
  it('默认折叠只显示事件名；展开露出 run 行', () => {
    const e: ScrollEntry = {
      id: 'l1',
      kind: 'lifecycle',
      event: 'session_start',
      runs: [ok],
      expanded: false,
    }
    useChatStore.setState({ entries: [e] })
    const { rerender } = render(
      <EntryView e={e} selected={false} pendingFreeze={false} now={0} />,
    )
    expect(screen.getByText('session_start')).toBeInTheDocument()
    expect(screen.getByText(/hooks:/)).toBeInTheDocument()
    expect(screen.queryByText(ok.name)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('option'))
    const expanded = useChatStore.getState().entries[0]
    rerender(<EntryView e={expanded} selected={false} pendingFreeze={false} now={0} />)
    expect(screen.getByText(ok.name)).toBeInTheDocument()
  })
})

describe('SessionEventEntry stop summary', () => {
  it('标记行右对齐 `stop  [hooks: N]`；展开露出 run', () => {
    const e: ScrollEntry = {
      id: 'm1',
      kind: 'session_event',
      text: 'Worked for 1.2s',
      stopHooks: [{ event: 'stop', runs: [ok] }],
      open: false,
    }
    useChatStore.setState({ entries: [e] })
    const { rerender } = render(
      <EntryView e={e} selected={false} pendingFreeze={false} now={0} />,
    )
    expect(screen.getByText('Worked for 1.2s')).toBeInTheDocument()
    expect(screen.getByText('stop')).toBeInTheDocument()
    expect(screen.getByText(/hooks:/)).toBeInTheDocument()
    expect(screen.queryByText(ok.name)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('option'))
    const opened = useChatStore.getState().entries[0]
    rerender(<EntryView e={opened} selected={false} pendingFreeze={false} now={0} />)
    expect(screen.getByText(ok.name)).toBeInTheDocument()
  })
})

describe('StopHookSummary / HookGroupsDetail', () => {
  it('单组不重复表头；多组才分开标事件名', () => {
    const { rerender } = render(
      <HookGroupsDetail
        groups={[{ event: 'stop', runs: [ok] }]}
      />,
    )
    expect(screen.queryByText('stop')).not.toBeInTheDocument()
    expect(screen.getByText(ok.name)).toBeInTheDocument()

    rerender(
      <HookGroupsDetail
        groups={[
          { event: 'stop_failure', runs: [{ name: 'fail', status: { type: 'failed', error: 'x' } }] },
          { event: 'stop', runs: [ok] },
        ]}
      />,
    )
    expect(screen.getByText('stop_failure')).toBeInTheDocument()
    expect(screen.getByText('stop')).toBeInTheDocument()
  })

  it('全 skipped 的组不渲染摘要', () => {
    const { container } = render(
      <StopHookSummary
        groups={[{ event: 'stop', runs: [{ name: 'h', status: { type: 'skipped' } }] }]}
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('两组中一组全 skipped 仍按多组带表头（TUI stop_hooks.len() 判定）', () => {
    const { rerender } = render(<HookGroupsDetail groups={[]} />)
    rerender(
      <HookGroupsDetail
        groups={[
          // 全 skipped 的一组整组不渲染（TUI render_hooks_expanded 同），
          // 但原始组数=2 → 剩余组仍带表头（TUI stop_hooks.len() 判定）。
          { event: 'stop_failure', runs: [{ name: 'f', status: { type: 'skipped' } }] },
          { event: 'stop', runs: [ok] },
        ]}
      />,
    )
    expect(screen.getByText('stop')).toBeInTheDocument()
    expect(screen.queryByText('stop_failure')).not.toBeInTheDocument()
  })
})
