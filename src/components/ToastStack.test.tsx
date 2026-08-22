import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useToastStore, pushToast } from '../store/toast'
import { ToastStack } from './ToastStack'

describe('ToastStack', () => {
  it('空 toast → null', () => {
    const { container } = render(<ToastStack />)
    expect(container.firstChild).toBeNull()
  })

  it('有 toast → 渲染文本 + 手动关闭', () => {
    pushToast('hello toast', 't1')
    const { container } = render(<ToastStack />)
    expect(container.textContent).toContain('hello toast')
    fireEvent.click(screen.getByLabelText('关闭提醒'))
    expect(container.textContent).not.toContain('hello toast')
  })

  it('ttl 后自动消失', () => {
    vi.useFakeTimers()
    pushToast('auto dismiss', 't2')
    const { container } = render(<ToastStack />)
    act(() => {
      vi.advanceTimersByTime(6100)
    })
    expect(container.textContent).not.toContain('auto dismiss')
    vi.useRealTimers()
  })

  it('pushToast 限定栈容量（最多 4 条）', () => {
    useToastStore.setState({ toasts: [] })
    for (let i = 0; i < 6; i++) pushToast(`toast ${i}`, `tid${i}`)
    expect(useToastStore.getState().toasts).toHaveLength(4)
    expect(useToastStore.getState().toasts[0].text).toBe('toast 2')
  })
})