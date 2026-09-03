import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueueStrip } from './QueueStrip'
import type { QueuedPrompt } from '../../store/promptQueue'

function makePrompt(id: string, text: string, overrides: Partial<QueuedPrompt> = {}): QueuedPrompt {
  return {
    id,
    text,
    blocks: [{ type: 'text', text }],
    ts: Date.now(),
    ...overrides,
  }
}

function makeNav(queue: QueuedPrompt[], overrides = {}) {
  return {
    queue,
    queuePanelOpen: true,
    setQueuePanelOpen: vi.fn(),
    queueEditIndex: null,
    queueEditDraft: '',
    queueSel: 0,
    setQueueSel: vi.fn(),
    queueFocus: false,
    setQueueFocus: vi.fn(),
    queueDrag: null,
    queuePanelRef: { current: null },
    onQueueGripPointerDown: vi.fn(),
    onQueueGripPointerMove: vi.fn(),
    onQueueGripPointerUp: vi.fn(),
    ...overrides,
  }
}

describe('QueueStrip', () => {
  it('队列空或面板关闭时渲染为 null', () => {
    const { container: c1 } = render(
      <QueueStrip
        nav={makeNav([])}
        sendQueuedItem={vi.fn()}
        headSteer={false}
      />,
    )
    expect(c1.firstChild).toBeNull()

    const { container: c2 } = render(
      <QueueStrip
        nav={makeNav([makePrompt('q1', 'first')], { queuePanelOpen: false })}
        sendQueuedItem={vi.fn()}
        headSteer={false}
      />,
    )
    expect(c2.firstChild).toBeNull()
  })

  it('headSteer 为 false 时：队首显示「队列」切换按钮（边框为 prompt-border）', () => {
    const onToggle = vi.fn()
    render(
      <QueueStrip
        nav={makeNav([makePrompt('q1', 'hello world')])}
        sendQueuedItem={vi.fn()}
        headSteer={false}
        onToggleMode={onToggle}
      />,
    )
    const btn = screen.getByRole('button', { name: '队列' })
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('text-gn-gutter')
    expect(btn.getAttribute('title')).toContain('当前为 queue（队列）')
    expect(btn).not.toBeDisabled()

    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('headSteer 为 true 时：队首显示「引导」切换按钮（青色高亮）', () => {
    const onToggle = vi.fn()
    render(
      <QueueStrip
        nav={makeNav([makePrompt('q1', 'hello world')])}
        sendQueuedItem={vi.fn()}
        headSteer={true}
        onToggleMode={onToggle}
      />,
    )
    const btn = screen.getByRole('button', { name: '引导' })
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('text-gn-cyan')
    expect(btn.getAttribute('title')).toContain('当前为 steer（引导）')
    expect(btn).not.toBeDisabled()

    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('togglingMode 为 true 时切换按钮处于 disabled 状态', () => {
    const onToggle = vi.fn()
    render(
      <QueueStrip
        nav={makeNav([makePrompt('q1', 'hello world')])}
        sendQueuedItem={vi.fn()}
        headSteer={false}
        onToggleMode={onToggle}
        togglingMode={true}
      />,
    )
    const btn = screen.getByRole('button', { name: '队列' })
    expect(btn).toBeDisabled()
  })

  it('点击切换按钮阻止事件冒泡，不触发行的选择 setQueueSel', () => {
    const onToggle = vi.fn()
    const setQueueSel = vi.fn()
    render(
      <QueueStrip
        nav={makeNav([makePrompt('q1', 'hello world')], { setQueueSel })}
        sendQueuedItem={vi.fn()}
        headSteer={true}
        onToggleMode={onToggle}
      />,
    )
    const btn = screen.getByRole('button', { name: '引导' })
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(setQueueSel).not.toHaveBeenCalled()
  })

  it('多行队列仅在队首显示模式按钮，后续行不显示', () => {
    render(
      <QueueStrip
        nav={makeNav([
          makePrompt('q1', 'first'),
          makePrompt('q2', 'second'),
        ])}
        sendQueuedItem={vi.fn()}
        headSteer={true}
      />,
    )
    // 只有一个「引导」按钮
    expect(screen.getAllByRole('button', { name: '引导' })).toHaveLength(1)
  })

  it('失败（degraded）队首行不显示模式按钮', () => {
    render(
      <QueueStrip
        nav={makeNav([makePrompt('q1', 'failed', { degraded: true })])}
        sendQueuedItem={vi.fn()}
        headSteer={true}
      />,
    )
    expect(screen.queryByRole('button', { name: '引导' })).toBeNull()
  })
})
