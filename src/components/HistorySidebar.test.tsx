import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useChatStore } from '../store/chat'
import { HistorySidebar } from './HistorySidebar'

beforeEach(() => {
  useChatStore.setState({
    refreshSessions: vi.fn(),
    refreshWorkspaces: vi.fn(),
    resetToEmpty: vi.fn(),
    sidebarCollapsed: false,
  })
})

describe('HistorySidebar', () => {
  it('挂载即刷新会话与工作区', () => {
    render(<HistorySidebar />)
    expect(useChatStore.getState().refreshSessions).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().refreshWorkspaces).toHaveBeenCalledTimes(1)
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

  it('collapsed → 收窄为 0 宽', () => {
    useChatStore.setState({ sidebarCollapsed: true })
    const { container } = render(<HistorySidebar />)
    expect(container.querySelector('aside')?.className).toContain('w-0')
  })

  it('展开态 → w-72', () => {
    const { container } = render(<HistorySidebar />)
    expect(container.querySelector('aside')?.className).toContain('w-72')
  })
})