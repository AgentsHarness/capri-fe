import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { SessionStateIcon } from './SessionStateIcon'

describe('SessionStateIcon', () => {
  it('active + 非 pending → 自转的加载图标（CSS 动画，不再是 braille 字符）', () => {
    const { container } = render(<SessionStateIcon state="active" pending={false} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('width')).toBe('12') // 与待办徽标同尺寸
    expect(container.querySelector('span')?.className).toContain('text-gn-cyan')
    expect(svg?.classList.contains('animate-spin')).toBe(true)
    expect(container.textContent).toBe('')
  })

  it('pending → 实心菱形（主动画图标）', () => {
    const { container } = render(<SessionStateIcon state="idle" pending />)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('svg')?.classList.contains('animate-spin')).toBe(false)
  })

  it('idle → 不画图标，只留等宽占位（标题列仍对齐）', () => {
    const { container } = render(<SessionStateIcon state="idle" pending={false} />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toBe('')
    expect(container.querySelector('span')?.className).toContain('w-[1.25em]')
  })
})
