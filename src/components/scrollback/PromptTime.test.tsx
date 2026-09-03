import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

// PromptTime 只读 chat store 的 showTimestamps；mock 掉真实 store。
vi.mock('../../store/chat', () => ({
  useChatStore: (selector: (s: { showTimestamps: boolean }) => unknown) =>
    selector({ showTimestamps: true }),
}))

import { PromptTime, UserSteerTime } from './PromptTime'

describe('PromptTime', () => {
  it('showTimestamps 且 ts 存在 → 渲染短/全两种格式', () => {
    const ts = new Date(2026, 7, 22, 20, 31, 45).getTime()
    const { container } = render(<PromptTime ts={ts} />)
    expect(container.textContent).toContain('20:31')
    expect(container.textContent).toContain('08/22 20:31:45')
  })

  it('ts 缺失 → null；shiftRight 调整 right 偏移', () => {
    const { container } = render(<PromptTime />)
    expect(container.firstChild).toBeNull()

    const ts = Date.now()
    const shifted = render(<PromptTime ts={ts} shiftRight />)
    const span = shifted.container.querySelector('span') as HTMLElement
    expect(span.style.right).toBe('20px')
    const left = render(<PromptTime ts={ts} />)
    expect((left.container.querySelector('span') as HTMLElement).style.right).toBe('8px')
  })

  it('UserSteerTime：引导徽标在时间左边', () => {
    const ts = new Date(2026, 7, 22, 20, 31, 0).getTime()
    const { container } = render(<UserSteerTime ts={ts} steer className="top-[14.5px]" />)
    expect(container.textContent).toMatch(/引导.*20:31/)
    const cluster = container.querySelector('.flex.items-center') as HTMLElement
    expect(cluster).not.toBeNull()
    expect(cluster.className).toContain('h-[1.35em]')
    expect(container.querySelector('.gn-pt')?.className).toContain('pointer-events-auto')
  })
})