import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useChatStore } from '../../store/chat'
import { SIDEBAR_DEFAULT_WIDTH } from '../../lib/sidebarWidth'
import { HistorySidebar } from './HistorySidebar'

beforeEach(() => {
  localStorage.removeItem('capri-fe.sidebarWidth')
  useChatStore.setState({
    refreshSessionLists: vi.fn(),
    resetToEmpty: vi.fn(),
    sidebarCollapsed: false,
  })
})

describe('HistorySidebar', () => {
  it('挂载即刷新会话与工作区列表', () => {
    render(<HistorySidebar />)
    expect(useChatStore.getState().refreshSessionLists).toHaveBeenCalledTimes(1)
  })

  it('渲染头部 + 会话列表（空态）', () => {
    render(<HistorySidebar />)
    expect(screen.getByText('会话')).toBeInTheDocument()
    expect(screen.getByText('没有历史会话')).toBeInTheDocument()
  })

  it('new 按钮 → resetToEmpty', () => {
    render(<HistorySidebar />)
    fireEvent.click(screen.getByRole('button', { name: /new/ }))
    expect(useChatStore.getState().resetToEmpty).toHaveBeenCalled()
  })

  it('collapsed → 宽度归零且不渲染拖拽手柄', () => {
    useChatStore.setState({ sidebarCollapsed: true })
    const { container } = render(<HistorySidebar />)
    expect(container.querySelector('aside')?.style.width).toBe('0px')
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('展开态 → 默认宽度', () => {
    const { container } = render(<HistorySidebar />)
    expect(container.querySelector('aside')?.style.width).toBe(`${SIDEBAR_DEFAULT_WIDTH}px`)
  })

  it('拖拽右缘：宽度跟随光标并持久化', () => {
    const { container } = render(<HistorySidebar />)
    const aside = container.querySelector('aside')
    const handle = screen.getByRole('separator', { name: '调整会话侧边栏宽度' })

    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 360 })
    expect(aside?.style.width).toBe('348px')
    fireEvent.pointerUp(handle)

    expect(localStorage.getItem('capri-fe.sidebarWidth')).toBe('348')
  })

  it('拖拽越界时钳制在最小/最大宽度', () => {
    const { container } = render(<HistorySidebar />)
    const aside = container.querySelector('aside')
    const handle = screen.getByRole('separator', { name: '调整会话侧边栏宽度' })

    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: -1000 })
    expect(aside?.style.width).toBe('260px')
    fireEvent.pointerMove(handle, { clientX: 2000 })
    expect(aside?.style.width).toBe('560px')
    fireEvent.pointerUp(handle)
  })

  it('手柄键盘左右箭头各调 8px', () => {
    const { container } = render(<HistorySidebar />)
    const aside = container.querySelector('aside')
    const handle = screen.getByRole('separator', { name: '调整会话侧边栏宽度' })

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(aside?.style.width).toBe('296px')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(aside?.style.width).toBe('280px')
    expect(localStorage.getItem('capri-fe.sidebarWidth')).toBe('280')
  })
})
