import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { transport } from '../api/client'
import { useChatStore } from '../store/chat'
import type { ScrollEntry } from '../api/types'
import { PlanViewerModal } from './PlanViewerModal'

vi.mock('../api/client', () => ({
  transport: {
    sessionPlan: vi.fn(),
    // chat store 导入链在模块顶层注册事件监听；本文件不测事件。
    onEvent: vi.fn(() => () => {}),
  },
}))

const planMock = vi.mocked(transport.sessionPlan)

/** exit_plan_mode 工具完成后的滚动区条目（plan 正文在 rawOutput 里）。 */
function toolEntryWithPlan(content: string): ScrollEntry {
  return {
    id: 't1',
    kind: 'tool',
    title: 'Plan mode exited',
    verb: 'Plan',
    status: 'completed',
    kindName: 'other',
    toolCallId: 'call-1',
    raw: {
      toolCallId: 'call-1',
      title: 'Plan mode exited',
      status: 'completed',
      kind: 'other',
      rawOutput: { type: 'ExitPlanMode', PlanReady: { plan_content: content } },
    },
  } as unknown as ScrollEntry
}

beforeEach(() => {
  useChatStore.setState({
    planViewerOpen: true,
    closePlanViewer: vi.fn(),
    sessionId: 's1',
    cwd: '/ws',
    todos: undefined,
    todoCounts: undefined,
    entries: [],
    xaiRequests: [],
  })
  planMock.mockReset()
  planMock.mockResolvedValue('')
})

describe('PlanViewerModal', () => {
  it('未打开 → 不渲染', () => {
    useChatStore.setState({ planViewerOpen: false })
    const { container } = render(<PlanViewerModal />)
    expect(container.firstChild).toBeNull()
  })

  it('plan.md 正文 → 按 markdown 渲染文档（不是任务清单）', async () => {
    planMock.mockResolvedValue('# 实施计划\n\n- 第一步\n')
    render(<PlanViewerModal />)
    await waitFor(() => expect(screen.getByText('实施计划')).toBeInTheDocument())
    expect(screen.getByText('第一步')).toBeInTheDocument()
    // 打开时拉的是当前会话的 plan.md。
    expect(planMock).toHaveBeenCalledWith('s1', '/ws')
    expect(screen.getByText('plan.md')).toBeInTheDocument()
    expect(screen.queryByText(/任务清单/)).not.toBeInTheDocument()
  })

  it('plan.md 为空 → 用待应答 exit_plan_mode 审批请求里的正文', async () => {
    useChatStore.setState({
      xaiRequests: [
        {
          requestId: 'r1',
          method: 'x.ai/exit_plan_mode',
          params: { planContent: '# 待审批的 plan\n正文' },
        },
      ] as never,
    })
    render(<PlanViewerModal />)
    await waitFor(() => expect(screen.getByText('待审批的 plan')).toBeInTheDocument())
  })

  it('旧 host 无 plan 端点 → 回退到滚动区 exit_plan_mode 工具输出', async () => {
    planMock.mockRejectedValue(new Error('404'))
    useChatStore.setState({ entries: [toolEntryWithPlan('# 已批准的 plan\n内容')] })
    render(<PlanViewerModal />)
    await waitFor(() => expect(screen.getByText('已批准的 plan')).toBeInTheDocument())
  })

  it('三级来源都没有 plan 正文 → 任务清单兜底，并说明它不是 plan', async () => {
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
    await waitFor(() => expect(screen.getByText('完成 A')).toBeInTheDocument())
    expect(screen.getByText('进行 B')).toBeInTheDocument()
    expect(screen.getByText('待办 C')).toBeInTheDocument()
    expect(screen.getByText('取消 D')).toBeInTheDocument()
    expect(screen.getByText('high')).toBeInTheDocument()
    expect(screen.getByText(/没有读到 plan 正文/)).toBeInTheDocument()
    expect(screen.getByText('1/3')).toBeInTheDocument()
    expect(screen.getByText('1 进行中 · 1 待办')).toBeInTheDocument()
  })

  it('plan 正文与任务清单同时存在 → 显示正文，徽标仍是完成数', async () => {
    planMock.mockResolvedValue('# 计划\n\n内容')
    useChatStore.setState({
      todos: [{ id: '1', content: '完成 A', status: 'completed' }],
      todoCounts: { total: 1, inProgress: 0, pending: 0, completed: 1 },
    })
    render(<PlanViewerModal />)
    await waitFor(() => expect(screen.getByText('计划')).toBeInTheDocument())
    expect(screen.getByText('1/1 完成')).toBeInTheDocument()
    expect(screen.queryByText('完成 A')).not.toBeInTheDocument()
  })

  it('既无 plan 也无任务清单 → 空态', async () => {
    render(<PlanViewerModal />)
    await waitFor(() =>
      expect(screen.getByText('当前会话还没有 plan')).toBeInTheDocument(),
    )
  })

  it('无会话 → 不请求 plan.md，直接走兜底', () => {
    useChatStore.setState({ sessionId: undefined, cwd: undefined })
    render(<PlanViewerModal />)
    expect(planMock).not.toHaveBeenCalled()
    expect(screen.getByText('当前会话还没有 plan')).toBeInTheDocument()
  })

  it('Esc 关闭', () => {
    render(<PlanViewerModal />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useChatStore.getState().closePlanViewer).toHaveBeenCalled()
  })
})
