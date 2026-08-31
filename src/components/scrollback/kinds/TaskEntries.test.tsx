import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ScrollEntry } from '../../../api/types'
import type { EntryChrome } from '../chrome'
import { SubagentEntry } from './TaskEntries'

// AccentRail 依赖 ResizeObserver / matchMedia（jsdom 均未实现）。
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ROStub as unknown as typeof ResizeObserver
window.matchMedia = window.matchMedia ?? (() => ({ matches: false })) as never

/** 最小 chrome：SubagentEntry 只消费 shell.selected / openViewer /
 *  cancelSubagent；其余字段给安全默认值。 */
function makeChrome(
  e: ScrollEntry,
  openViewer = vi.fn(),
  cancelSubagent = vi.fn(),
): EntryChrome {
  return {
    shell: {
      e,
      selected: false,
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
    killTask: () => {},
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