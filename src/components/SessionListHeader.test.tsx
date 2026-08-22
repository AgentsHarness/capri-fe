import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useChatStore } from '../store/chat'
import { useHistoryView } from '../store/historyView'
import { SessionListHeader } from './SessionListHeader'

beforeEach(() => {
  useChatStore.setState({
    refreshSessions: vi.fn(),
    refreshWorkspaces: vi.fn(),
    workspaceLoading: false,
  })
  useHistoryView.setState({ mode: 'workspace' })
})

describe('SessionListHeader', () => {
  it('渲染标题 + 形态切换 + 刷新按钮', () => {
    render(<SessionListHeader />)
    expect(screen.getByText('会话')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '目录视图' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '标记视图' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新会话列表' })).toBeInTheDocument()
  })

  it('形态切换写 historyView store', () => {
    render(<SessionListHeader />)
    fireEvent.click(screen.getByRole('button', { name: '标记视图' }))
    expect(useHistoryView.getState().mode).toBe('marked')
    expect(screen.getByRole('button', { name: '标记视图' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '目录视图' }))
    expect(useHistoryView.getState().mode).toBe('workspace')
  })

  it('点击刷新 → 触发两个 refresh；加载中显示 spinner', () => {
    render(<SessionListHeader />)
    fireEvent.click(screen.getByRole('button', { name: '刷新会话列表' }))
    const st = useChatStore.getState()
    expect(st.refreshSessions).toHaveBeenCalledTimes(1)
    expect(st.refreshWorkspaces).toHaveBeenCalledTimes(1)

    // 置 workspaceLoading=true → 转圈状态（跟随用户点击）
    act(() => useChatStore.setState({ workspaceLoading: true }))
    expect(screen.getByRole('button', { name: '正在刷新会话列表' })).toBeDisabled()
    expect(screen.getByText(/⠋|⠙|⠹/)).toBeInTheDocument()
  })

  it('加载完成后短暂显示 ✓ 再回落 idle（1200ms）', () => {
    vi.useFakeTimers()
    render(<SessionListHeader />)
    fireEvent.click(screen.getByRole('button', { name: '刷新会话列表' }))
    act(() => useChatStore.setState({ workspaceLoading: true }))
    act(() => useChatStore.setState({ workspaceLoading: false }))
    expect(screen.getByLabelText('刷新完成')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1200)
    })
    expect(screen.getByRole('button', { name: '刷新会话列表' })).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('非用户触发的自动刷新不占按钮状态', () => {
    render(<SessionListHeader />)
    act(() => useChatStore.setState({ workspaceLoading: true }))
    expect(screen.getByRole('button', { name: '刷新会话列表' })).toBeInTheDocument()
  })

  it('alignRight → ml-auto 定位', () => {
    const { container } = render(<SessionListHeader alignRight />)
    const iconWrap = container.querySelector('.ml-auto')
    expect(iconWrap).not.toBeNull()
  })

  it('卸载时清理 ✓ 回落定时器', () => {
    vi.useFakeTimers()
    const { unmount } = render(<SessionListHeader />)
    fireEvent.click(screen.getByRole('button', { name: '刷新会话列表' }))
    act(() => useChatStore.setState({ workspaceLoading: true }))
    act(() => useChatStore.setState({ workspaceLoading: false }))
    unmount()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    vi.useRealTimers()
  })
})