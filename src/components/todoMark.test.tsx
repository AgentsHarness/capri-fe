import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { CheckMarkIcon, TodoMark } from './todoMark'

describe('TodoMark', () => {
  it('四种状态各自的标记', () => {
    const done = render(<TodoMark status="completed" />)
    expect(done.container.querySelector('svg')).not.toBeNull()

    const doing = render(<TodoMark status="in_progress" />)
    expect(doing.container.textContent).toBe('▶')

    const cancelled = render(<TodoMark status="cancelled" />)
    expect(cancelled.container.querySelector('svg')).not.toBeNull()

    const pending = render(<TodoMark status="pending" />)
    expect(pending.container.textContent).toBe('□')
  })

  it('CheckMarkIcon 独立渲染', () => {
    const { container } = render(<CheckMarkIcon />)
    expect(container.querySelector('svg path')).not.toBeNull()
  })
})