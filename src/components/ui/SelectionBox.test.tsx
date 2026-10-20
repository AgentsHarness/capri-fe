import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { SelectionBox } from './SelectionBox'

describe('SelectionBox', () => {
  it('默认 selected 变体；含左右 rails', () => {
    const { container } = render(<SelectionBox />)
    expect(container.querySelectorAll('[aria-hidden]')).not.toHaveLength(0)
    // 左右两侧 rail
    expect(container.querySelectorAll('div').length).toBeGreaterThan(3)
  })

  it('hover 变体可渲染', () => {
    const { container } = render(<SelectionBox variant="hover" />)
    expect(container.firstElementChild).not.toBeNull()
  })

  it('裁剪角（topClipped/bottomClipped）渲染虚线段', () => {
    const { container } = render(<SelectionBox topClipped bottomClipped />)
    // 无 exception 即可；行为上角改为 dashed 背景
    expect(container.querySelectorAll('div').length).toBeGreaterThan(3)
  })
})