import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { IconGlyph } from './IconGlyph'
import { Glyphs } from '../theme/glyphs'

describe('IconGlyph', () => {
  it('已知 glyph 渲染 SVG 路径', () => {
    const { container } = render(<IconGlyph glyph={Glyphs.diamondFilled} />)
    expect(container.querySelector('svg path')).not.toBeNull()
  })

  it('未知 glyph 回退纯文本', () => {
    const { container } = render(<IconGlyph glyph="??unknown??" />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toBe('??unknown??')
  })

  it('默认 diamondFilled；animated 加 pulse class；color 写进 style', () => {
    const { container } = render(<IconGlyph animated color="red" />)
    const span = container.firstElementChild as HTMLElement
    expect(span.className).toContain('animate-pulse')
    expect(span.style.color).toBe('red')
  })
})