import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useChatStore } from '../store/chat'
import { RewindPicker } from './RewindPicker'
import type { RewindPoint } from '../api/types'

describe('RewindPicker', () => {
  const closeRewind = vi.fn()
  const rewindPoints = vi.fn()
  const rewindExecute = vi.fn()
  const cancelTurn = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    rewindPoints.mockResolvedValue([])
    useChatStore.setState({
      rewindOpen: true,
      closeRewind,
      sessionId: 'test-sess',
      conn: 'ready',
      rewindPoints,
      rewindExecute,
      cancelTurn,
    })
  })

  it('未打开时返回 null', () => {
    useChatStore.setState({ rewindOpen: false })
    const { container } = render(<RewindPicker />)
    expect(container.firstChild).toBeNull()
  })

  it('无 sessionId 时提示暂无活动会话', () => {
    useChatStore.setState({ sessionId: undefined })
    render(<RewindPicker />)
    expect(screen.getByText('暂无活动会话')).toBeInTheDocument()
  })

  it('会话处于 busy 状态时进入 cancel-offer 阶段', async () => {
    useChatStore.setState({ conn: 'busy' })
    render(<RewindPicker />)
    expect(screen.getByText('当前有回合正在运行')).toBeInTheDocument()
    expect(screen.getByText('取消当前回合并回退')).toBeInTheDocument()

    // 键盘触发 y
    fireEvent.keyDown(window, { key: 'y' })
    await waitFor(() => {
      expect(cancelTurn).toHaveBeenCalledWith({ cancelSubagents: true })
    })
  })

  it('成功加载回退点列表并渲染对应徽章与摘要', async () => {
    const mockPoints: RewindPoint[] = [
      {
        index: 2,
        summary: '添加了用户模块',
        timestamp: 1725400000000,
        hasFileChanges: true,
      },
      {
        index: 1,
        summary: '初始化项目',
        timestamp: 1725300000000,
        hasFileChanges: false,
      },
    ]
    rewindPoints.mockResolvedValueOnce(mockPoints)

    render(<RewindPicker />)

    await waitFor(() => {
      expect(screen.getByText('#2')).toBeInTheDocument()
      expect(screen.getByText('添加了用户模块')).toBeInTheDocument()
      expect(screen.getByText(/对话\+文件/)).toBeInTheDocument()

      expect(screen.getByText('#1')).toBeInTheDocument()
      expect(screen.getByText('初始化项目')).toBeInTheDocument()
      expect(screen.getByText(/仅对话/)).toBeInTheDocument()
    })
  })

  it('支持键盘 j/k 移动光标并按 Enter 选中进入确认阶段', async () => {
    const mockPoints: RewindPoint[] = [
      {
        index: 2,
        summary: '第二轮',
        timestamp: 1725400000000,
        hasFileChanges: true,
      },
      {
        index: 1,
        summary: '第一轮',
        timestamp: 1725300000000,
        hasFileChanges: false,
      },
    ]
    rewindPoints.mockResolvedValueOnce(mockPoints)

    render(<RewindPicker />)

    await waitFor(() => {
      expect(screen.getByText('第二轮')).toBeInTheDocument()
    })

    // 按下键移动到第一轮
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    // 按 Enter 选中
    fireEvent.keyDown(window, { key: 'Enter' })

    await waitFor(() => {
      expect(screen.getByText('回退范围')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '确认回退' })).toBeInTheDocument()
      expect(screen.getByText(/第一轮/)).toBeInTheDocument()
    })

    // 按 y 确认执行回退
    rewindExecute.mockResolvedValueOnce({
      targetPromptIndex: 1,
      conversationTruncated: true,
    })
    fireEvent.keyDown(window, { key: 'y' })

    await waitFor(() => {
      expect(rewindExecute).toHaveBeenCalledWith(1, 'conversation_only')
      expect(closeRewind).toHaveBeenCalled()
    })
  })

  it('回退产生外部文件冲突时展示 warning 阶段', async () => {
    const mockPoints: RewindPoint[] = [
      {
        index: 1,
        summary: '测试冲突',
        timestamp: 1725300000000,
        hasFileChanges: true,
      },
    ]
    rewindPoints.mockResolvedValueOnce(mockPoints)

    render(<RewindPicker />)

    await waitFor(() => {
      expect(screen.getByText('测试冲突')).toBeInTheDocument()
    })

    // 点击该行
    fireEvent.click(screen.getByText('测试冲突'))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认回退' })).toBeInTheDocument()
    })

    // 模拟执行返回 conflict
    rewindExecute.mockResolvedValueOnce({
      targetPromptIndex: 1,
      conversationTruncated: true,
      conflicts: [
        { path: 'src/main.ts', conflictType: 'modified_externally' },
      ],
    })

    fireEvent.keyDown(window, { key: 'y' })

    await waitFor(() => {
      expect(screen.getByText(/个文件与外部修改冲突/)).toBeInTheDocument()
      expect(screen.getByText('外部修改')).toBeInTheDocument()
      expect(screen.getByText('src/main.ts')).toBeInTheDocument()
    })

    // 点击知道了关闭
    fireEvent.click(screen.getByRole('button', { name: /知道了/ }))
    expect(closeRewind).toHaveBeenCalled()
  })

  it('弹窗内不渲染任何键盘按键 UI 元素（.gn-kbd）', async () => {
    const mockPoints: RewindPoint[] = [
      {
        index: 1,
        summary: '测试无键盘UI',
        timestamp: 1725300000000,
        hasFileChanges: true,
      },
    ]
    rewindPoints.mockResolvedValueOnce(mockPoints)
    const { container } = render(<RewindPicker />)

    await waitFor(() => {
      expect(screen.getByText('测试无键盘UI')).toBeInTheDocument()
    })

    // 检查整个弹窗内没有 .gn-kbd 按键符号展示
    expect(container.querySelectorAll('.gn-kbd')).toHaveLength(0)

    // 进入确认层
    fireEvent.click(screen.getByText('测试无键盘UI'))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认回退' })).toBeInTheDocument()
    })
    expect(container.querySelectorAll('.gn-kbd')).toHaveLength(0)
  })
})
