import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ScrollEntry } from '../../../api/types'
import type { EntryChrome } from '../chrome'
import { SubagentEntry, BgTaskEntry } from './TaskEntries'

// AccentRail 依赖 ResizeObserver / matchMedia（jsdom 均未实现）。
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ROStub as unknown as typeof ResizeObserver
window.matchMedia = window.matchMedia ?? (() => ({ matches: false })) as never

/** 最小 chrome：TaskEntries 各渲染器只消费 shell.selected / openViewer /
 *  cancelSubagent / killTask；其余字段给安全默认值。 */
function makeChrome(
  e: ScrollEntry,
  openViewer = vi.fn(),
  cancelSubagent = vi.fn(),
  killTask = vi.fn(),
  selected = false,
): EntryChrome {
  return {
    shell: {
      e,
      selected,
      hovered: false,
      onHover: () => {},
      onSelect: () => {},
      pendingFreeze: false,
      now: 0,
      dense: false,
      denseNext: false,
      densePrev: false,
      inGroup: false,
    },
    bullet: { color: '#000' },
    caret: null,
    bulletGlyph: undefined,
    rowBtn: '',
    openViewer,
    toggleTool: () => {},
    toggleThought: () => {},
    toggleUser: () => {},
    toggleBtw: () => {},
    cancelSubagent,
    killTask,
    liveText: undefined,
    thoughtText: undefined,
    bodyRef: { current: null },
    inMini: false,
  } as EntryChrome
}

const subagentEntry = (
  o: Partial<Extract<ScrollEntry, { kind: 'subagent' }>> & { id: string },
): Extract<ScrollEntry, { kind: 'subagent' }> =>
  ({ kind: 'subagent', status: 'started', title: 'spawn', ...o }) as Extract<
    ScrollEntry,
    { kind: 'subagent' }
  >

describe('SubagentEntry — 整行单击弹查看器', () => {
  it('单击行任意处直接 openViewer（不再需要先选中再点查看）', () => {
    const e = subagentEntry({ id: 'sa1', status: 'completed' })
    const openViewer = vi.fn()
    const { container } = render(
      <SubagentEntry e={e} chrome={makeChrome(e, openViewer)} />,
    )
    fireEvent.click(container.querySelector('[data-entry-id="sa1"]')!)
    expect(openViewer).toHaveBeenCalledWith('sa1')
  })

  it('不再渲染「查看」按钮（展开入口已去掉）', () => {
    const e = subagentEntry({ id: 'sa1', status: 'completed' })
    const { container } = render(<SubagentEntry e={e} chrome={makeChrome(e)} />)
    expect(screen.queryByRole('button', { name: /查看/ })).toBeNull()
    expect(container.querySelector('[data-entry-id="sa1"]')).not.toBeNull()
  })

  it('运行中的行点 cancel：只取消，不弹查看器', () => {
    const e = subagentEntry({
      id: 'sa1',
      status: 'started',
      running: true,
      subagentId: 'sub-1',
    })
    const openViewer = vi.fn()
    const cancelSubagent = vi.fn()
    render(<SubagentEntry e={e} chrome={makeChrome(e, openViewer, cancelSubagent)} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel/ }))
    expect(cancelSubagent).toHaveBeenCalledWith('sub-1')
    expect(openViewer).not.toHaveBeenCalled()
  })
})

const bgTaskEntry = (
  o: Partial<Extract<ScrollEntry, { kind: 'bg_task' }>> & { id: string },
): Extract<ScrollEntry, { kind: 'bg_task' }> =>
  ({
    kind: 'bg_task',
    status: 'completed',
    title: 'npm run build',
    ...o,
  }) as Extract<ScrollEntry, { kind: 'bg_task' }>

describe('BgTaskEntry — 与 Agent 行同形态', () => {
  it('单击行任意处直接 openViewer（同样不需要先选中再点查看）', () => {
    const e = bgTaskEntry({ id: 'bg1' })
    const openViewer = vi.fn()
    const { container } = render(
      <BgTaskEntry e={e} chrome={makeChrome(e, openViewer)} />,
    )
    fireEvent.click(container.querySelector('[data-entry-id="bg1"]')!)
    expect(openViewer).toHaveBeenCalledWith('bg1')
  })

  it('不渲染「查看」按钮（选中态也不出现）', () => {
    const e = bgTaskEntry({ id: 'bg1' })
    const closed = render(<BgTaskEntry e={e} chrome={makeChrome(e, vi.fn())} />)
    const sel = render(
      <BgTaskEntry
        e={e}
        chrome={makeChrome(e, vi.fn(), vi.fn(), vi.fn(), true)}
      />,
    )
    for (const { container } of [closed, sel]) {
      const hasViewBtn = [...container.querySelectorAll('button')].some((b) =>
        /查看/.test(b.textContent ?? ''),
      )
      expect(hasViewBtn).toBe(false)
    }
  })

  it('运行中的行点 kill：只终止任务，不弹查看器', () => {
    const e = bgTaskEntry({
      id: 'bg1',
      status: 'started',
      running: true,
      taskId: 't-1',
    })
    const openViewer = vi.fn()
    const killTask = vi.fn()
    render(
      <BgTaskEntry
        e={e}
        chrome={makeChrome(e, openViewer, vi.fn(), killTask)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /kill/ }))
    expect(killTask).toHaveBeenCalledWith('t-1')
    expect(openViewer).not.toHaveBeenCalled()
  })
})