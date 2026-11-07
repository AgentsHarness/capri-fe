import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { hasOpenLightbox } from '../../lib/lightboxState'
import { ZoomableImage } from './ImageLightbox'

describe('ZoomableImage', () => {
  it('点击打开单图预览且不冒泡（不触发条目折叠），Esc 关闭', () => {
    const onParent = vi.fn()
    render(
      <div onClick={onParent}>
        <ZoomableImage
          src="data:image/png;base64,AAA"
          mimeType="image/png"
          className="max-h-[55vh]"
        />
      </div>,
    )
    fireEvent.click(screen.getByRole('img'))
    expect(onParent).not.toHaveBeenCalled()
    expect(hasOpenLightbox()).toBe(true)
    const dialog = screen.getByRole('dialog', { name: '图片预览 1/1' })
    expect(dialog.querySelector('img')!.getAttribute('src')).toBe(
      'data:image/png;base64,AAA',
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(hasOpenLightbox()).toBe(false)
  })

  it('父级接管点击（组级画廊）时不打开本地预览', () => {
    const onOpen = vi.fn()
    render(<ZoomableImage src="data:image/png;base64,AAA" onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('img'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
