import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from './Composer'
import { useChatStore } from '../store/chat'
import { usePromptQueue } from '../store/promptQueue'
import { pushToast } from '../store/toast'
import { transport } from '../api/client'

vi.mock('../api/client', () => ({
  transport: {
    prompt: vi.fn(async () => {}),
    newSession: vi.fn(),
    gitInfo: vi.fn(),
    sessionResume: vi.fn(),
    sessionStats: vi.fn(),
    sessionRunningTasks: vi.fn(),
    loadSessionHistory: vi.fn(),
    queueStatus: vi.fn(),
    status: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    getConnectionMode: vi.fn(() => 'local'),
    lastLiveEventAt: vi.fn(() => undefined),
    extensions: vi.fn(async () => ({ skills: [] })),
  },
}))

vi.mock('../store/toast', () => ({
  pushToast: vi.fn(),
  dismissToast: vi.fn(),
}))

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterAll(() => {
  // @ts-expect-error cleanup mock
  delete Element.prototype.scrollIntoView
})

describe('Composer 切换会话中发送不吞内容', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sessionId: 'test-sess-1',
      cwd: '/test/cwd',
      conn: 'ready',
      historyLoading: false,
      newSessionPending: false,
      entries: [],
      pending: [],
    })
    usePromptQueue.setState({
      queue: [],
      sending: false,
    })
  })

  it('正在切换会话（historyLoading 为 true）时按 Enter：弹出提示且保留输入框内容', () => {
    useChatStore.setState({ historyLoading: true })

    render(<Composer />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: '我的重要提问内容' } })
    expect(textarea.value).toBe('我的重要提问内容')

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    // 弹出切换提示，输入框内容不被清空吞掉
    expect(pushToast).toHaveBeenCalledWith('正在切换会话，请稍候再发送')
    expect(textarea.value).toBe('我的重要提问内容')
    expect(transport.prompt).not.toHaveBeenCalled()
  })

  it('正在切换会话且当前为 busy 时按 Enter：弹出提示且保留输入框内容，不入队', () => {
    useChatStore.setState({ historyLoading: true, conn: 'busy' })

    render(<Composer />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: 'busy 时的排队内容' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(pushToast).toHaveBeenCalledWith('正在切换会话，请稍候再发送')
    expect(textarea.value).toBe('busy 时的排队内容')
    expect(usePromptQueue.getState().queue).toHaveLength(0)
  })

  it('正在切换会话时按 Ctrl+Enter：弹出提示且保留输入框内容', () => {
    useChatStore.setState({ historyLoading: true })

    render(<Composer />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: '急迫内容' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', ctrlKey: true })

    expect(pushToast).toHaveBeenCalledWith('正在切换会话，请稍候再发送')
    expect(textarea.value).toBe('急迫内容')
    expect(transport.prompt).not.toHaveBeenCalled()
  })

  it('切换会话结束（historyLoading 为 false）后按 Enter：正常发送并清空输入框', async () => {
    useChatStore.setState({ historyLoading: false })

    render(<Composer />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: '可以正常发送的消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(pushToast).not.toHaveBeenCalled()
    expect(textarea.value).toBe('')
    expect(transport.prompt).toHaveBeenCalled()
  })
})
