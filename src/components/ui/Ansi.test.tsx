import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Ansi } from './Ansi'

describe('Ansi', () => {
  it('普通文本原样渲染（XML 转义防注入）', () => {
    const { container } = render(<Ansi text={'a <b> & "c"' as never} />)
    expect(container.querySelector('span')!.innerHTML).toContain('&lt;b&gt;')
  })

  it('SGR 颜色序列转成 span 样式', () => {
    const { container } = render(<Ansi text={'\x1b[31mred\x1b[0m plain' as never} />)
    const html = container.querySelector('span')!.innerHTML
    expect(html).toContain('color:')
    expect(html).toContain('red')
  })

  it('OSC / 非 m 结尾 CSI 被剥离', () => {
    const { container } = render(
      <Ansi text={'\x1b]2;~/ccwork\x07\x1b[2K\r\x1b[31mred\x1b[0m' as never} />,
    )
    const html = container.querySelector('span')!.innerHTML
    expect(html).not.toContain('~/ccwork')
    expect(html).toContain('red')
  })

  it('bold 序列处理', () => {
    const { container } = render(<Ansi text={'\x1b[1mbold\x1b[0m' as never} />)
    expect(container.querySelector('span')!.innerHTML).toContain('bold')
  })

  it('className 透传', () => {
    const { container } = render(<Ansi text="x" className="custom-cls" />)
    expect(container.querySelector('span')!.className).toBe('custom-cls')
  })
})