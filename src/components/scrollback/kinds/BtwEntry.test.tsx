import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ScrollEntry } from '../../../api/types'
import type { EntryChrome } from '../chrome'
import { BtwEntry } from './MiscEntries'

// AccentRail 依赖 ResizeObserver / matchMedia（jsdom 均未实现）。
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ROStub as unknown as typeof ResizeObserver
window.matchMedia = window.matchMedia ?? (() => ({ matches: false })) as never

/** 最小 chrome：BtwEntry 只消费 shell / bullet / toggleBtw；其余字段给安全默认值。 */
function makeChrome(
  e: ScrollEntry,
  selected = true,
): EntryChrome & { openViewer: ReturnType<typeof vi.fn> } {
  const openViewer = vi.fn()
  const chrome = {
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
    cancelSubagent: () => {},
    killTask: () => {},
    liveText: undefined,
    thoughtText: undefined,
    bodyRef: { current: null },
    inMini: false,
  } as EntryChrome & { openViewer: ReturnType<typeof vi.fn> }
  return chrome
}

const btw = (
  o: Partial<Extract<ScrollEntry, { kind: 'btw' }>>,
): Extract<ScrollEntry, { kind: 'btw' }> =>
  ({ id: 'b1', kind: 'btw', question: '还有几步？', ...o }) as Extract<
    ScrollEntry,
    { kind: 'btw' }
  >

describe('BtwEntry', () => {
  it('折叠（默认）：只显示 /btw <问题> 一行，不显示答案正文', () => {
    render(<BtwEntry e={btw({ answer: '两步' })} chrome={makeChrome(btw({ answer: '两步' }))} />)
    expect(screen.getByText('/btw 还有几步？')).toBeInTheDocument()
    expect(screen.queryByText('两步')).not.toBeInTheDocument()
  })

  it('展开：头部一行 + markdown 答案', () => {
    render(
      <BtwEntry
        e={btw({ answer: '**两步**', open: true })}
        chrome={makeChrome(btw({ answer: '**两步**', open: true }))}
      />,
    )
    expect(screen.getByText('/btw 还有几步？')).toBeInTheDocument()
    expect(screen.getByText('两步')).toBeInTheDocument()
  })

  it('错误态直接可见（展开显示完整错误；折叠行内截断露出错误）', () => {
    const err = 'session not found: s1'
    render(
      <BtwEntry
        e={btw({ error: err, open: true })}
        chrome={makeChrome(btw({ error: err, open: true }))}
      />,
    )
    expect(screen.getByText(err)).toBeInTheDocument()

    render(
      <BtwEntry e={btw({ error: err })} chrome={makeChrome(btw({ error: err }))} />,
    )
    expect(screen.getAllByText(err).length).toBeGreaterThan(0)
  })

  it('进行中：展开态显示等待提示', () => {
    render(
      <BtwEntry
        e={btw({ streaming: true, open: true })}
        chrome={makeChrome(btw({ streaming: true, open: true }))}
      />,
    )
    expect(screen.getByText('等待回答…')).toBeInTheDocument()
  })

  it('展开显示「查看」，点击调 openViewer；折叠态无「查看」', () => {
    const e = btw({ answer: '两步', open: true })
    const chrome = makeChrome(e)
    const { unmount } = render(<BtwEntry e={e} chrome={chrome} />)
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(chrome.openViewer).toHaveBeenCalledWith('b1')
    unmount()

    const folded = btw({ open: false })
    render(<BtwEntry e={folded} chrome={makeChrome(folded)} />)
    expect(screen.queryByRole('button', { name: '查看' })).not.toBeInTheDocument()
  })
})