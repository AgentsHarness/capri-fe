import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { InlineImages } from './InlineImages'

describe('InlineImages', () => {
  it('无图片 → null', () => {
    const { container } = render(
      <InlineImages images={[]} size="user" onOpen={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('user 尺寸：等高缩略图 + mimeType alt + 点击弹出放大预览（不走 onOpen）', () => {
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
    expect(img!.className).toContain('h-24')
    // 无 hover 缩放/图片级外框（hover/选中框由条目 SelectionBox 统一绘制）
    expect(img!.className).not.toContain('hover:scale')
    expect(img!.className).not.toContain('outline')
    fireEvent.click(img!)
    expect(onOpen).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()
    const preview = dialog.querySelector('img')
    expect(preview!.getAttribute('src')).toBe('data:image/png;base64,AAA')
    // Esc 关闭
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('user 尺寸：多图画廊可 ‹ › 切换，计数器更新', () => {
    const { container } = render(
      <InlineImages
        images={[
          { data: 'data:image/png;base64,1', mimeType: 'image/png' },
          { data: 'data:image/png;base64,2' },
        ]}
        size="user"
        onOpen={vi.fn()}
      />,
    )
    const imgs = container.querySelectorAll('img')
    expect(imgs).toHaveLength(2)
    fireEvent.click(imgs[1])
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('img')!.getAttribute('src')).toBe(
      'data:image/png;base64,2',
    )
    expect(dialog.textContent).toContain('2 / 2')
    fireEvent.click(screen.getByRole('button', { name: '上一张' }))
    expect(dialog.querySelector('img')!.getAttribute('src')).toBe(
      'data:image/png;base64,1',
    )
    expect(dialog.textContent).toContain('1 / 2')
    // 到第一张后上一张置灰；再点不关闭预览、不越界
    fireEvent.click(screen.getByRole('button', { name: '上一张' }))
    const prevBtn = document.querySelector(
      '[aria-label="上一张"]',
    ) as HTMLButtonElement
    expect(prevBtn.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(prevBtn)
    expect(screen.getByRole('dialog').textContent).toContain('1 / 2')
  })

  it('assistant 尺寸：宽图布局；无 mimeType → 通用 alt；点击仍走 onOpen', () => {
    const onOpen = vi.fn()
    const { container } = render(
      <InlineImages
        images={[{ data: 'data:image/jpeg;base64,BB' }]}
        size="assistant"
        onOpen={onOpen}
      />,
    )
    const img = container.querySelector('img')
    expect(img!.className).toContain('max-w-[65%]')
    expect(img!.className).not.toContain('h-24')
    expect(img!.getAttribute('alt')).toBe('image')
    fireEvent.click(img!)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
