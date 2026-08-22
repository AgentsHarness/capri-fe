import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useChatStore } from '../../store/chat'
import { GroupHeaderView, type GroupHeaderViewProps } from './GroupHeaderView'

// AccentRail 依赖 ResizeObserver / matchMedia（jsdom 均未实现）。
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ROStub as unknown as typeof ResizeObserver
window.matchMedia = window.matchMedia ?? (() => ({ matches: false })) as never

function verbRow(over: Partial<GroupHeaderViewProps['row']> = {}): GroupHeaderViewProps['row'] {
  return {
    type: 'group_header',
    id: 'gh_r1',
    span: {
      range: { start: 0, end: 2 },
      kind: { type: 'verb', members: 2 },
      expanded: false,
      anchorId: 'r1',
    },
    label: { text: 'Read 2 files', running: false, failed: false },
    family: 'verb',
    ...over,
  }
}

function truncRow(): GroupHeaderViewProps['row'] {
  return {
    type: 'group_header',
    id: 'gh_t1',
    span: {
      range: { start: 0, end: 5 },
      kind: { type: 'truncation', participants: 5, hidden: 3 },
      expanded: false,
      anchorId: 't1',
    },
    label: { text: 'Ran 2 commands', running: false, failed: false },
    family: 'truncation',
  }
}

describe('GroupHeaderView', () => {
  beforeEach(() => {
    useChatStore.setState({ selectEntry: vi.fn() })
  })

  it('渲染 verb 组头 label；点击 → selectEntry + onToggle', () => {
    const onToggle = vi.fn()
    const { container } = render(
      <GroupHeaderView row={verbRow()} selected={false} pendingFreeze={false} now={0} onToggle={onToggle} />,
    )
    expect(screen.getByText('Read 2 files')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().selectEntry).toHaveBeenCalledWith('gh_r1')
    void container
  })

  it('truncation 组头渲染 label', () => {
    render(
      <GroupHeaderView row={truncRow()} selected={false} pendingFreeze={false} now={0} onToggle={vi.fn()} />,
    )
    expect(screen.getByText('Ran 2 commands')).toBeInTheDocument()
  })

  it('label 颜色跟随 failed / running', () => {
    const failed = render(
      <GroupHeaderView
        row={verbRow({ label: { text: 'Read 1 file', running: false, failed: true } })}
        selected={false}
        pendingFreeze={false}
        now={0}
        onToggle={vi.fn()}
      />,
    )
    const span = failed.container.querySelector('.truncate.font-bold') as HTMLElement
    expect(span.style.color).toBe('var(--color-gn-accent-error)')
  })

  it('折叠 + 选中 → › chevron；悬浮 → 同款；未选中 → ◈ 点阵菱形', () => {
    const idle = render(
      <GroupHeaderView row={verbRow()} selected={false} pendingFreeze={false} now={0} onToggle={vi.fn()} />,
    )
    const diamondD = 'M0.5 0.09 L0.91 0.5 L0.5 0.91 L0.09 0.5 Z M0.5 0.33 L0.67 0.5 L0.5 0.67 L0.33 0.5 Z'
    expect(idle.container.querySelector('svg path')?.getAttribute('d')).toBe(diamondD)

    const sel = render(
      <GroupHeaderView row={verbRow()} selected pendingFreeze={false} now={0} onToggle={vi.fn()} />,
    )
    const chevron = 'M0.36 0.18 L0.66 0.5 L0.36 0.82'
    expect(sel.container.querySelector('svg path')?.getAttribute('d')).toBe(chevron)
  })

  it('展开组 + 悬浮 → ⌄ chevronDown', () => {
    const row = verbRow({ span: { range: { start: 0, end: 2 }, kind: { type: 'verb', members: 2 }, expanded: true, anchorId: 'r1' } })
    const { container } = render(
      <GroupHeaderView row={row} selected={false} pendingFreeze={false} now={0} onToggle={vi.fn()} />,
    )
    const entry = container.querySelector('[data-entry-id]') as HTMLElement
    fireEvent.mouseEnter(entry)
    const chevronDown = 'M0.22 0.36 L0.5 0.66 L0.78 0.36'
    expect(container.querySelector('svg path')?.getAttribute('d')).toBe(chevronDown)
  })
})