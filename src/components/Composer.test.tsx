import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Composer } from './Composer'
import { useChatStore } from '../store/chat'
import { usePromptQueue } from '../store/promptQueue'
import { pushToast } from '../store/toast'
import { applyUiSettings } from '../store/settings'
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
    queueInterject: vi.fn(async () => {}),
    interject: vi.fn(async () => {}),
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

describe('Composer 插话会话隔离', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sessionId: 'session-A', cwd: '/test/cwd', conn: 'busy',
      historyLoading: false, newSessionPending: false, entries: [], pending: [],
    })
    usePromptQueue.setState({ queue: [], sending: false })
  })

  it('Ctrl+L 使用当前标签页会话，切换后使用新会话', () => {
    render(<Composer />)
    const input = screen.getByRole('textbox')
    for (const sessionId of ['session-A', 'session-B']) {
      act(() => useChatStore.setState({ sessionId }))
      fireEvent.change(input, { target: { value: `only ${sessionId}` } })
      fireEvent.keyDown(input, { key: 'l', ctrlKey: true })
      expect(transport.interject).toHaveBeenLastCalledWith({ text: `only ${sessionId}`, sessionId })
      expect(input).toHaveValue('')
    }
  })

  it.each(['missing', 'loading'])('%s 时不发送也不清空草稿', (state) => {
    useChatStore.setState(state === 'missing' ? { sessionId: '' } : { historyLoading: true })
    render(<Composer />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '保留草稿' } })
    fireEvent.keyDown(input, { key: 'l', ctrlKey: true })
    expect(transport.interject).not.toHaveBeenCalled()
    expect(input).toHaveValue('保留草稿')
    expect(pushToast).toHaveBeenCalled()
  })
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

  describe('触控/移动端焦点守卫与视觉状态', () => {
    const originalMatchMedia = window.matchMedia

    afterEach(() => {
      window.matchMedia = originalMatchMedia
    })

    it('触控设备下：未获真实焦点时 promptFocused 为 0，不虚假显示激活边框', () => {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('coarse'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
      useChatStore.setState({ focusMode: 'prompt' })

      const { container } = render(<Composer />)
      const chrome = container.querySelector('[data-prompt-focused]')
      expect(chrome?.getAttribute('data-prompt-focused')).toBe('0')

      const textarea = screen.getByRole('textbox')
      fireEvent.focus(textarea)
      expect(chrome?.getAttribute('data-prompt-focused')).toBe('1')

      fireEvent.blur(textarea)
      expect(chrome?.getAttribute('data-prompt-focused')).toBe('0')
    })

    it('触控设备下：focusMode 从 scrollback 切回 prompt 时，不自动弹起软键盘（不调用 focus）', () => {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('coarse'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
      useChatStore.setState({ focusMode: 'scrollback' })

      render(<Composer />)
      const textarea = screen.getByRole('textbox')
      const focusSpy = vi.spyOn(textarea, 'focus')

      useChatStore.setState({ focusMode: 'prompt' })
      expect(focusSpy).not.toHaveBeenCalled()
    })

    it('触控设备下：发送消息后自动调用 blur 收起输入法，不强占焦点', async () => {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('coarse'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
      useChatStore.setState({ historyLoading: false, conn: 'ready' })

      render(<Composer />)
      const textarea = screen.getByRole('textbox')
      const blurSpy = vi.spyOn(textarea, 'blur')

      fireEvent.change(textarea, { target: { value: '触控端发送' } })
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

      await waitFor(() => {
        expect(blurSpy).toHaveBeenCalled()
      })
    })

    it('触控设备下：渲染选图入口，选中的图片成为缩略图', async () => {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('coarse'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))

      const { container } = render(<Composer />)
      const picker = container.querySelector(
        'input[type=file]',
      ) as HTMLInputElement
      expect(picker).not.toBeNull()
      expect(picker.accept).toBe('image/*')

      const file = new File([new Uint8Array([1, 2, 3])], 'album.png', {
        type: 'image/png',
      })
      fireEvent.change(picker, { target: { files: [file] } })

      await waitFor(() =>
        expect(container.querySelector('img')?.getAttribute('alt')).toBe(
          'album.png',
        ),
      )
    })

    it('桌面设备下：不渲染选图入口（粘贴与拖拽已可用）', () => {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))

      const { container } = render(<Composer />)
      expect(container.querySelector('input[type=file]')).toBeNull()
      expect(screen.queryByLabelText('选择图片')).toBeNull()
    })

    it('桌面设备下：初次挂载不偷抢焦点，focusMode 切回 prompt 时响应聚焦', async () => {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
      useChatStore.setState({ focusMode: 'scrollback' })

      render(<Composer />)
      const textarea = screen.getByRole('textbox')
      const focusSpy = vi.spyOn(textarea, 'focus')

      // 桌面端状态实际切回 prompt 时聚焦
      act(() => {
        useChatStore.setState({ focusMode: 'prompt' })
      })
      await waitFor(() => {
        expect(focusSpy).toHaveBeenCalled()
      })
    })
  })
})

describe('Composer shell 模式（`!`）走 host 直连 bash 回合', () => {
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
      turnStartedAt: undefined,
      currentPromptId: undefined,
    })
    usePromptQueue.setState({ queue: [], sending: false })
  })

  it('Enter 提交命令：prompt 带块 _meta.bash_command，用户行标 isShell', async () => {
    render(<Composer />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    // `!` 进 shell 模式（前缀不进缓冲），再输入命令本体
    fireEvent.change(textarea, { target: { value: '!' } })
    expect(textarea.value).toBe('')
    fireEvent.change(textarea, { target: { value: 'git status' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(transport.prompt).toHaveBeenCalled())
    const [blocks] = vi.mocked(transport.prompt).mock.calls[0]
    expect(blocks).toEqual([
      { type: 'text', text: 'git status', _meta: { bash_command: 'git status' } },
    ])
    const userRow = useChatStore
      .getState()
      .entries.find((e) => e.kind === 'user')
    expect(userRow).toMatchObject({ kind: 'user', text: 'git status', isShell: true })
    // 命令输出由 host 的 Execute 工具行承载，本地不再塞临时行
    expect(useChatStore.getState().entries.filter((e) => e.kind === 'session_event')).toHaveLength(0)
    expect(textarea.value).toBe('')
  })
})

describe('Composer 立即发送拦截确认', () => {
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
      xaiRequests: [],
    })
    usePromptQueue.setState({
      queue: [],
      sending: false,
    })
  })

  it('存在 xaiRequests 时立即发送先弹窗拦截，确认后才真正调 queueInterject', async () => {
    useChatStore.setState({
      xaiRequests: [
        {
          requestId: 'r-ask',
          method: 'x.ai/ask_user_question',
          params: {},
        },
      ],
    })
    usePromptQueue.setState({
      queue: [
        {
          id: 'q1',
          text: '插队消息',
          blocks: [],
          version: 1,
          ts: Date.now(),
        },
      ],
    })

    render(<Composer />)
    const sendNowBtn = screen.getByTitle('立即发送这条')
    fireEvent.click(sendNowBtn)

    // 弹出确认弹窗，transport.queueInterject 尚未被调用
    expect(screen.getByRole('dialog', { name: '立即发送确认' })).not.toBeNull()
    expect(transport.queueInterject).not.toHaveBeenCalled()

    // 点击仍要立即发送
    fireEvent.click(screen.getByRole('button', { name: '仍要立即发送' }))
    expect(transport.queueInterject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'q1' }),
      'test-sess-1',
    )
  })
})

/**
 * 队首去向徽标：点击切换 [ui].follow_up_behavior（steer ↔ queue）。
 * 子组件 QueueStrip 只测了「点击会调 onToggleMode」，Composer 里这个
 * 回调自身的 RPC 往返与失败提示此前没有覆盖。
 */
describe('Composer 队首模式切换（follow_up_behavior）', () => {
  const promptRow = {
    id: 'q1',
    text: 'queued one',
    blocks: [{ type: 'text', text: 'queued one' }],
    ts: 1,
    version: 1,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sessionId: 'test-sess-1',
      cwd: '/test/cwd',
      conn: 'busy',
      historyLoading: false,
      newSessionPending: false,
      entries: [],
      pending: [],
      xaiRequests: [],
      queuePanelOpen: true,
    })
    usePromptQueue.setState({
      queue: [promptRow],
      sending: false,
    } as never)
  })

  it('当前是 queue → 点击发送 steer，并用应答回写 ui 设置', async () => {
    const updateSettings = vi.fn(async () => ({ ui: { follow_up_behavior: 'steer' } }))
    ;(transport as unknown as Record<string, unknown>).updateSettings = updateSettings

    render(<Composer />)
    fireEvent.click(screen.getByRole('button', { name: '队列' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      follow_up_behavior: 'steer',
    }))
  })

  it('当前是 steer → 点击切回 queue', async () => {
    const updateSettings = vi.fn(async () => ({ ui: { follow_up_behavior: 'queue' } }))
    ;(transport as unknown as Record<string, unknown>).updateSettings = updateSettings
    applyUiSettings({ follow_up_behavior: 'steer' })

    render(<Composer />)
    fireEvent.click(screen.getByRole('button', { name: '引导' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      follow_up_behavior: 'queue',
    }))
  })

  it('updateSettings 失败 → 弹 toast 且不抛错', async () => {
    const updateSettings = vi.fn(async () => {
      throw new Error('settings rpc failed')
    })
    ;(transport as unknown as Record<string, unknown>).updateSettings = updateSettings

    render(<Composer />)
    fireEvent.click(screen.getByRole('button', { name: '队列' }))

    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('settings rpc failed'))
  })

  it('非 Error 抛出物转成字符串提示', async () => {
    const updateSettings = vi.fn(async () => {
      throw 'plain boom'
    })
    ;(transport as unknown as Record<string, unknown>).updateSettings = updateSettings

    render(<Composer />)
    fireEvent.click(screen.getByRole('button', { name: '队列' }))

    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('plain boom'))
  })

  it('应答缺 ui 字段时不抛错', async () => {
    const updateSettings = vi.fn(async () => ({}))
    ;(transport as unknown as Record<string, unknown>).updateSettings = updateSettings

    render(<Composer />)
    fireEvent.click(screen.getByRole('button', { name: '队列' }))
    await waitFor(() => expect(updateSettings).toHaveBeenCalled())
  })
})

describe('Composer prompt stash caption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sessionId: 'session-A',
      cwd: '/test/cwd',
      conn: 'ready',
      historyLoading: false,
      newSessionPending: false,
      entries: [],
      pending: [],
    })
    usePromptQueue.setState({ queue: [], sending: false })
  })

  it('Ctrl+S 把 Stashed 断在 composer 右上角边框上', () => {
    render(<Composer />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'draft to park' } })
    fireEvent.keyDown(input, { key: 's', ctrlKey: true })
    const caption = screen.getByTestId('prompt-stash')
    expect(caption.textContent).toBe('Stashed')
    expect(caption.className).toContain('absolute')
    expect(caption.className).toContain('right-2')
    expect(caption.className).toContain('-top-[6px]')
    expect(input).toHaveValue('')
  })
})

