import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type { ScrollEntry } from '../../../api/types'
import type { EntryChrome } from '../chrome'
import { ImageEntry } from './MiscEntries'

// AccentRail 依赖 ResizeObserver / matchMedia（jsdom 均未实现）。
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ROStub as unknown as typeof ResizeObserver
window.matchMedia = window.matchMedia ?? ((() => ({ matches: false })) as never)

function makeChrome(
  e: ScrollEntry,
  over: Partial<EntryChrome> = {},
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
    openViewer: vi.fn(),
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
    ...over,
  }
}

const img: Extract<ScrollEntry, { kind: 'image' }> = {
  id: 'im1',
  kind: 'image',
  data: 'data:image/png;base64,AAA',
  mimeType: 'image/png',
}

describe('ImageEntry', () => {
  it('画廊行：缩略图铺满条目盒并 cover（不再按百分比收缩留白）', () => {
    const onOpenImage = vi.fn()
    const { container } = render(
      <ImageEntry e={img} chrome={makeChrome(img, { onOpenImage, galleryItem: true })} />,
    )
    const el = container.querySelector('img')!
    expect(el.className).toContain('h-24')
    expect(el.className).toContain('w-full')
    expect(el.className).toContain('object-cover')
    expect(el.className).not.toContain('max-w-[45%]')
    expect(el.className).not.toContain('object-contain')
    fireEvent.click(el)
    expect(onOpenImage).toHaveBeenCalledWith('im1')
  })

  it('非画廊（迷你 scrollback）：保持按比例缩略图，点击回退 openViewer', () => {
    const openViewer = vi.fn()
    const { container } = render(
      <ImageEntry e={img} chrome={makeChrome(img, { openViewer })} />,
    )
    const el = container.querySelector('img')!
    expect(el.className).toContain('h-24')
    expect(el.className).toContain('max-w-[45%]')
    expect(el.className).toContain('object-contain')
    expect(el.className).not.toContain('w-full')
    expect(el.className).not.toContain('object-cover')
    fireEvent.click(el)
    expect(openViewer).toHaveBeenCalledWith('im1')
  })
})
