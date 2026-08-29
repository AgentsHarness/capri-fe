import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useChatStore } from '../store/chat'
import { PlanViewerModal } from './PlanViewerModal'

beforeEach(() => {
  useChatStore.setState({
    planViewerOpen: true,
    closePlanViewer: vi.fn(),
    todos: undefined,
    todoCounts: undefined,
  })
})

describe('PlanViewerModal', () => {
  it('未打开 → 不渲染', () => {
    useChatStore.setState({ planViewerOpen: false })
    const { container } = render(<PlanViewerModal />)
    expect(container.firstChild).toBeNull()
  })

  it('无 plan → 空态', () => {
    render(<PlanViewerModal />)
    expect(screen.getByText('当前会话还没有 plan')).toBeInTheDocument()
  })

  it('有 plan → 渲染全部条目（含 cancelled）与计数徽标', () => {
    useChatStore.setState({
      todos: [
        { id: '1', content: '完成 A', status: 'completed' },
        { id: '2', content: '进行 B', status: 'in_progress' },
        { id: '3', content: '待办 C', status: 'pending', priority: 'high' },
        { id: '4', content: '取消 D', status: 'cancelled' },
      ],
      // planTodos counts：cancelled 不计入 total（与状态条徽标语义一致）。
      todoCounts: { total: 3, inProgress: 1, pending: 1, completed: 1 },
    })
    render(<PlanViewerModal />)
    // 4 条全部渲染。
    expect(screen.getByText('完成 A')).toBeInTheDocument()
    expect(screen.getByText('进行 B')).toBeInTheDocument()
    expect(screen.getByText('待办 C')).toBeInTheDocument()
    expect(screen.getByText('取消 D')).toBeInTheDocument()
    expect(screen.getByText('high')).toBeInTheDocument()
    // 计数徽标：completed/total（cancelled 排除在 total 外）。
    expect(screen.getByText('1/3')).toBeInTheDocument()
    expect(screen.getByText('1 进行中 · 1 待办')).toBeInTheDocument()
  })

  it('Esc 关闭', () => {
    render(<PlanViewerModal />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useChatStore.getState().closePlanViewer).toHaveBeenCalled()
  })
})