import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useChatStore } from '../store/chat'
import { BlockViewer } from './BlockViewer'
import type { ScrollEntry } from '../api/types'

/**
 * 只走 viewerTask（顶部任务条 / 历史回放的「仅任务视图」）这条入口：
 * 它不依赖 entries 里的行，而是把 ViewerTask 合成成一条 bg_task 条目。
 * 这条路径此前完全没有测试，是 BlockViewer 分支覆盖的主要缺口。
 *
 * 注意标题栏的两层结构：`title` 是状态动词（Task running / completed /
 * failed），任务名与命令走 `subtitle`，所以断言要落在 subtitle/正文上。
 */
function openTaskView(patch: Partial<Record<string, unknown>> = {}) {
  useChatStore.setState({
    viewerEntryId: null,
    viewerTask: {
      taskId: 'task-abcdef123456',
      command: 'sleep 30',
      output: 'first line\nsecond line',
      running: true,
      sessionId: 'sess-1',
      cwd: '/work',
      ...patch,
    },
  } as never)
}

const closeViewer = () => vi.mocked(useChatStore.getState().closeViewer)

describe('BlockViewer 仅任务视图（viewerTask）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      entries: [],
      refreshTaskOutput: vi.fn().mockResolvedValue(undefined),
      closeViewer: vi.fn(),
      cwd: '/work',
      historyCwd: undefined,
    } as never)
  })

  afterEach(() => {
    useChatStore.setState({ viewerTask: undefined, viewerEntryId: null } as never)
  })

  it('运行中的任务：标题是状态动词，任务名与命令进正文', () => {
    openTaskView({ title: 'My Build Task' })
    render(<BlockViewer />)
    expect(screen.getByRole('dialog', { name: 'Task running' })).toBeInTheDocument()
    expect(document.body.textContent).toContain('My Build Task')
    expect(document.body.textContent).toContain('sleep 30')
  })

  it('没有标题时用 taskId 前 8 位兜底（可见于正文）', () => {
    openTaskView()
    render(<BlockViewer />)
    expect(document.body.textContent).toContain('task-abc')
  })

  it('已完成的任务标题是 Task completed', () => {
    openTaskView({ running: false, completed: true })
    render(<BlockViewer />)
    expect(screen.getByRole('dialog', { name: 'Task completed' })).toBeInTheDocument()
  })

  it('失败的任务标题是 Task failed', () => {
    openTaskView({ running: false, failed: true })
    render(<BlockViewer />)
    expect(screen.getByRole('dialog', { name: 'Task failed' })).toBeInTheDocument()
  })

  it('运行中的任务会被轮询（首帧立即拉一次）', () => {
    openTaskView({ running: true })
    render(<BlockViewer />)
    expect(useChatStore.getState().refreshTaskOutput).toHaveBeenCalledWith(
      'task-abcdef123456',
      'sess-1',
      '/work',
    )
  })

  it('运行中的任务按周期间隔继续轮询', () => {
    vi.useFakeTimers()
    try {
      openTaskView({ running: true })
      render(<BlockViewer />)
      const spy = vi.mocked(useChatStore.getState().refreshTaskOutput)
      expect(spy).toHaveBeenCalledTimes(1)
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(spy.mock.calls.length).toBeGreaterThan(1)
      // 两次调用都带上会话与 cwd（任务视图靠它们做会话内重建）
      expect(spy).toHaveBeenLastCalledWith('task-abcdef123456', 'sess-1', '/work')
    } finally {
      vi.useRealTimers()
    }
  })

  it('已结束的任务不轮询', () => {
    openTaskView({ running: false, completed: true })
    render(<BlockViewer />)
    expect(useChatStore.getState().refreshTaskOutput).not.toHaveBeenCalled()
  })

  it('任务没有 output 字段时不抛错', () => {
    openTaskView({ output: undefined })
    expect(() => render(<BlockViewer />)).not.toThrow()
  })

  it('任务 output 为空字符串时不抛错', () => {
    openTaskView({ output: '' })
    expect(() => render(<BlockViewer />)).not.toThrow()
  })

  it('Esc 关闭视图', () => {
    openTaskView()
    render(<BlockViewer />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(closeViewer()).toHaveBeenCalled()
  })

  it('点击背景遮罩关闭，点击面板内部不关闭', () => {
    openTaskView()
    render(<BlockViewer />)
    // role=dialog 的节点就是遮罩层：它自身带 onMouseDown 判断
    // e.target === e.currentTarget，点面板内部（子元素）不该关。
    const backdrop = screen.getByRole('dialog', { name: 'Task running' })
    fireEvent.mouseDown(backdrop.firstElementChild!)
    expect(closeViewer()).not.toHaveBeenCalled()
    fireEvent.mouseDown(backdrop)
    expect(closeViewer()).toHaveBeenCalledTimes(1)
  })

  it('打开时锁定 body 滚动，关闭后恢复', () => {
    const before = document.body.style.overflow
    openTaskView()
    const { unmount } = render(<BlockViewer />)
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).toBe(before)
  })

  it('既无 viewerEntryId 也无 viewerTask 时不渲染任何东西', () => {
    useChatStore.setState({ viewerEntryId: null, viewerTask: undefined } as never)
    const { container } = render(<BlockViewer />)
    expect(container.firstChild).toBeNull()
  })

  it('viewerEntryId 指向不存在的条目、且不在任务视图 → 不渲染', () => {
    useChatStore.setState({
      viewerEntryId: 'missing-id',
      viewerTask: undefined,
      entries: [],
    } as never)
    const { container } = render(<BlockViewer />)
    expect(container.firstChild).toBeNull()
  })
})

describe('BlockViewer 任务视图与条目视图的取舍', () => {
  const entry = {
    id: 'e-bg',
    kind: 'bg_task',
    title: 'Entry Task',
    status: 'completed',
    running: false,
    taskId: 'task-entry',
    command: 'entry command',
  } as ScrollEntry

  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      entries: [entry],
      refreshTaskOutput: vi.fn().mockResolvedValue(undefined),
      closeViewer: vi.fn(),
      cwd: '/work',
      historyCwd: undefined,
    } as never)
  })

  afterEach(() => {
    useChatStore.setState({ viewerTask: undefined, viewerEntryId: null } as never)
  })

  it('viewerTask 存在时优先于 viewerEntryId 对应的条目', () => {
    useChatStore.setState({
      viewerEntryId: 'e-bg',
      viewerTask: { taskId: 'task-from-strip', title: 'From Strip', running: true },
    } as never)
    render(<BlockViewer />)
    expect(screen.getByRole('dialog', { name: 'Task running' })).toBeInTheDocument()
    expect(document.body.textContent).toContain('From Strip')
    expect(document.body.textContent).not.toContain('entry command')
  })

  it('只有条目时用条目自身的命令与状态', () => {
    useChatStore.setState({ viewerEntryId: 'e-bg', viewerTask: undefined } as never)
    render(<BlockViewer />)
    expect(screen.getByRole('dialog', { name: 'Task completed' })).toBeInTheDocument()
    expect(document.body.textContent).toContain('entry command')
  })

  it('已结束的条目视图不触发轮询', () => {
    useChatStore.setState({ viewerEntryId: 'e-bg', viewerTask: undefined } as never)
    render(<BlockViewer />)
    expect(useChatStore.getState().refreshTaskOutput).not.toHaveBeenCalled()
  })
})
