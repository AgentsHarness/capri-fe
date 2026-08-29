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

  it('提供 onToggleSearch 时渲染搜索按钮并回调；缺省不渲染', () => {
    const onToggle = vi.fn()
    const { rerender } = render(
      <SessionListHeader onToggleSearch={onToggle} />,
    )
    const btn = screen.getByRole('button', { name: '搜索历史会话' })
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
    rerender(<SessionListHeader onToggleSearch={onToggle} searchOpen />)
    expect(screen.getByRole('button', { name: '关闭会话搜索' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // 不传 onToggleSearch：缺省无搜索按钮（无搜索入口的嵌入方）。
    render(<SessionListHeader />)
    expect(screen.queryByRole('button', { name: '搜索历史会话' })).toBeNull()
  })

  it('alignRight → ml-auto 定位', () => {
    const { container } = render(<SessionListHeader alignRight />)
    const iconWrap = container.querySelector('.ml-auto')
    expect(iconWrap).not.toBeNull()
  })

  it('labeled：刷新/搜索带文字大热区，回调与状态机不变', () => {
    const onToggle = vi.fn()
    render(<SessionListHeader labeled onToggleSearch={onToggle} />)
    // 刷新：可见文字 + min-h-6 热区，点击仍触发刷新。
    const refresh = screen.getByRole('button', { name: '刷新会话列表' })
    expect(refresh).toHaveClass('min-h-6')
    expect(refresh.textContent).toContain('刷新')
    fireEvent.click(refresh)
    expect(useChatStore.getState().refreshSessions).toHaveBeenCalledTimes(1)
    // 搜索：可见文字，展开后文字切换为「收起」。
    const search = screen.getByRole('button', { name: '搜索历史会话' })
    expect(search).toHaveClass('min-h-6')
    expect(search.textContent).toContain('搜索')
    fireEvent.click(search)
    expect(onToggle).toHaveBeenCalledTimes(1)
    // 标题与形态切换文字统一 11px（与按钮一致）。
    expect(screen.getByText('会话')).toHaveClass('text-[11px]')
    expect(screen.getByRole('button', { name: '目录视图' })).toHaveClass('text-[11px]')
    expect(screen.getByRole('button', { name: '标记视图' })).toHaveClass('text-[11px]')
    render(
      <SessionListHeader labeled onToggleSearch={onToggle} searchOpen />,
    )
    expect(screen.getByRole('button', { name: '关闭会话搜索' }).textContent).toContain(
      '收起',
    )
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