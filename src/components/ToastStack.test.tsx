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
      vi.advanceTimersByTime(2000)
    })
    expect(container.textContent).toContain('auto dismiss')
    act(() => {
      vi.advanceTimersByTime(1100)
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

  it('移动端居中与网页端靠右定位 class 存在', () => {
    pushToast('layout check', 'pos-1')
    const { container } = render(<ToastStack />)
    const region = container.querySelector('[role="region"]')
    expect(region).not.toBeNull()
    // 移动端：top-3 居中
    expect(region?.className).toContain('top-3')
    expect(region?.className).toContain('left-1/2')
    expect(region?.className).toContain('-translate-x-1/2')
    // 网页端：sm:top-14 sm:right-6
    expect(region?.className).toContain('sm:top-14')
    expect(region?.className).toContain('sm:right-6')
  })

  it('根据状态类型渲染对应的语义样式与动画 class', () => {
    useToastStore.setState({ toasts: [] })
    pushToast('保存失败', { id: 'err', type: 'error' })
    pushToast('已复制成功', { id: 'suc', type: 'success' })
    const { container } = render(<ToastStack />)

    const cards = container.querySelectorAll('.gn-toast-card')
    expect(cards).toHaveLength(2)
    // 包含动画与进度条
    expect(cards[0].className).toContain('border-l-gn-red')
    expect(cards[1].className).toContain('border-l-gn-green')
    expect(container.querySelectorAll('.gn-toast-progress')).toHaveLength(2)
  })

  it('剥离开头的 🔔 前缀使文本更加整洁', () => {
    useToastStore.setState({ toasts: [] })
    pushToast('🔔 需要审批：bash', 'notif-1')
    const { container } = render(<ToastStack />)
    expect(container.textContent).toContain('需要审批：bash')
    expect(container.textContent).not.toContain('🔔')
  })
})