import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { InlineImages } from './InlineImages'

describe('InlineImages', () => {
  it('无图片 → null', () => {
    const { container } = render(
      <InlineImages images={[]} size="user" onOpen={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('user 尺寸：小缩略图样式 + mimeType alt + 点击打开查看器', () => {
    const onOpen = vi.fn()
    const { container } = render(
      <InlineImages
        images={[{ data: 'data:image/png;base64,AAA', mimeType: 'image/png' }]}
        size="user"
        onOpen={onOpen}
      />,
    )
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe('data:image/png;base64,AAA')
    expect(img!.getAttribute('alt')).toBe('image (image/png)')
    expect(img!.getAttribute('loading')).toBe('lazy')
    expect(img!.className).toContain('max-h-24')
    expect(img!.className).toContain('hover:scale-110')
    fireEvent.click(img!)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('assistant 尺寸：宽图布局；无 mimeType → 通用 alt', () => {
    const { container } = render(
      <InlineImages
        images={[{ data: 'data:image/jpeg;base64,BB' }]}
        size="assistant"
        onOpen={vi.fn()}
      />,
    )
    const img = container.querySelector('img')
    expect(img!.className).toContain('max-w-[65%]')
    expect(img!.className).not.toContain('max-h-24')
    expect(img!.getAttribute('alt')).toBe('image')
  })

  it('多图逐个渲染且各自可点', () => {
    const onOpen = vi.fn()
    const { container } = render(
      <InlineImages
        images={[
          { data: 'data:image/png;base64,1', mimeType: 'image/png' },
          { data: 'data:image/png;base64,2' },
        ]}
        size="user"
        onOpen={onOpen}
      />,
    )
    const imgs = container.querySelectorAll('img')
    expect(imgs).toHaveLength(2)
    fireEvent.click(imgs[1])
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})