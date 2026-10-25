import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Composer } from './Composer'
import { useChatStore } from '../../store/chat'
import { usePromptQueue } from '../../store/promptQueue'
import { pushToast } from '../../store/toast'
import { applyUiSettings } from '../../store/settings'
import { transport } from '../../api/client'

vi.mock('../../api/client', () => ({
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
    isLocalDirect: vi.fn(() => false),
    lastLiveEventAt: vi.fn(() => undefined),
    listHosts: vi.fn(async () => ({ hosts: [] })),
    extensions: vi.fn(async () => ({ skills: [] })),
    queueInterject: vi.fn(async () => {}),
    interject: vi.fn(async () => {}),
  },
}))

vi.mock('../../store/toast', () => ({
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
      emptyWorktreeBusy: false,
      entries: [],
      pending: [],
    })
    usePromptQueue.setState({
      queue: [],
      sending: false,
    })
  })

  // 空状态首条消息建 worktree 期间再回车：不能重发（会白建第二个
  // worktree），也不能进 newSessionPending 的挂起桶——那条路径只在
  // 建会话成功后才补发，worktree 建失败时内容会永远挂着。
  it('建 worktree 在飞时按 Enter：提示并保留草稿，不挂起也不发送', () => {
    useChatStore.setState({ emptyWorktreeBusy: true })

    render(<Composer />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '首条消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(pushToast).toHaveBeenCalledWith('正在创建 worktree，请稍候')
    expect(textarea.value).toBe('首条消息')
    expect(transport.newSession).not.toHaveBeenCalled()
    expect(transport.prompt).not.toHaveBeenCalled()
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

  it('立即发送失败（链路断）→ 行标 degraded，不再是静默 no-op', async () => {
    ;(transport.queueInterject as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('host mba 已断开'),
    )
    usePromptQueue.setState({
      queue: [{ id: 'q1', text: '插队消息', blocks: [], version: 1, ts: Date.now() }],
    })

    render(<Composer />)
    fireEvent.click(screen.getByTitle('立即发送这条'))

    // 行留在镜像里，但被标成 FE-owned 失败行（可手动重发），并说明原因。
    await waitFor(() => {
      const row = usePromptQueue.getState().queue.find((q) => q.id === 'q1')
      expect(row?.degraded).toBe(true)
      expect(row?.errorText).toContain('已断开')
    })
    expect(pushToast).toHaveBeenCalledWith(expect.stringContaining('立即发送失败'))
  })

  it('队列属于别的会话（stale）→ 点击不发送，也不留下转圈', () => {
    usePromptQueue.setState({
      queue: [{ id: 'q1', text: '旧会话的排队', blocks: [], version: 1, ts: Date.now() }],
      sessionId: 'gone-sess',
    })

    render(<Composer />)
    fireEvent.click(screen.getByTitle('立即发送这条'))

    expect(transport.queueInterject).not.toHaveBeenCalled()
    expect(document.querySelector('svg.animate-spin')).toBeNull()
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

describe('Composer 状态行分层（操作回执 vs 连接/回合阶段）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sessionId: 's1',
      cwd: '/test/cwd',
      conn: 'ready',
      phaseText: '就绪',
      statusText: '',
      historyLoading: false,
      newSessionPending: false,
      entries: [],
      pending: [],
      topTasks: [],
      memoryCommandPending: undefined,
      recapPendingFor: undefined,
    })
  })

  /** 状态行只在「连接中 / busy / 有等待」时可见；用 connecting 让它现身。 */
  const renderIdleLine = () => render(<Composer />)

  it('连接中时优先显示操作回执', () => {
    act(() =>
      useChatStore.setState({
        conn: 'connecting',
        phaseText: '连接中…',
        statusText: '已切换到 plan 模式',
      }),
    )
    renderIdleLine()
    expect(screen.getByText('已切换到 plan 模式')).toBeInTheDocument()
    expect(screen.queryByText('连接中…')).toBeNull()
  })

  it('阶段事件改写 phaseText 后，回执仍留在状态行', () => {
    act(() =>
      useChatStore.setState({
        conn: 'connecting',
        phaseText: '连接中…',
        statusText: '已切换到 plan 模式',
      }),
    )
    renderIdleLine()
    // 连接流程后续只写 phaseText（就绪 / 启动中…）：回执不能被冲掉。
    act(() => useChatStore.setState({ phaseText: '启动中…' }))
    expect(screen.getByText('已切换到 plan 模式')).toBeInTheDocument()
  })

  it('没有回执时才回落到阶段文案', () => {
    act(() =>
      useChatStore.setState({ conn: 'connecting', statusText: '', phaseText: '连接中…' }),
    )
    renderIdleLine()
    expect(screen.getByText('连接中…')).toBeInTheDocument()
  })

  it('busy 臂没有活动条目时用 phaseText 兜底，不显示旧回执', () => {
    act(() =>
      useChatStore.setState({
        conn: 'busy',
        phaseText: 'Waiting for response…',
        statusText: '已切换到 plan 模式',
        turnStartedAt: Date.now(),
      }),
    )
    renderIdleLine()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Waiting for response…')
    expect(text).not.toContain('已切换到 plan 模式')
  })
})

/**
 * 「等待 Host 确认送达…」只对绕 hub 的请求有意义：直连本机没有
 * hub→host 那一跳，host 按健康处理，过了宽限期也照常显示阶段文案。
 */
describe('Composer 状态行：等回执提示只在中继时出现', () => {
  // 已超过 SEND_ACK_GRACE_MS（3s），仍没有受理回执。
  const ACK_OVERDUE_MS = 4_000

  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sessionId: 's1',
      cwd: '/test/cwd',
      conn: 'busy',
      phaseText: 'Waiting for response…',
      statusText: '',
      historyLoading: false,
      newSessionPending: false,
      entries: [],
      pending: [],
      topTasks: [],
      memoryCommandPending: undefined,
      recapPendingFor: undefined,
      promptAcceptedAt: undefined,
      currentPromptId: undefined,
      // 已经超过 SEND_ACK_GRACE_MS，仍没有受理回执。
      turnStartedAt: Date.now() - ACK_OVERDUE_MS,
    })
  })

  afterEach(() => {
    vi.mocked(transport.getConnectionMode).mockReturnValue('local')
    vi.mocked(transport.isLocalDirect).mockReturnValue(false)
  })

  /** 本端真发一条：transport.prompt 永不 resolve，promptAcceptedAt 保持空
   *  = 「还没拿到受理回执」的窗口。 */
  function sendPendingPrompt() {
    ;(transport.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise(() => {}),
    )
    useChatStore.setState({ conn: 'ready', turnStartedAt: undefined })
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'hi' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    // 宽限期按回合起点算：把本端刚锚定的回合拨回过去。
    act(() => useChatStore.setState({ turnStartedAt: Date.now() - ACK_OVERDUE_MS }))
  }

  it('hub 中继：本端发出、超时无回执 → 提示在等 Host 确认', () => {
    vi.mocked(transport.getConnectionMode).mockReturnValue('hub')
    vi.mocked(transport.isLocalDirect).mockReturnValue(false)
    render(<Composer />)
    sendPendingPrompt()
    expect(screen.getByText('等待 Host 确认送达…')).toBeInTheDocument()
  })

  it('hub 模式本机近路：直连不提示，显示阶段文案', () => {
    vi.mocked(transport.getConnectionMode).mockReturnValue('hub')
    vi.mocked(transport.isLocalDirect).mockReturnValue(true)
    render(<Composer />)
    sendPendingPrompt()
    expect(screen.queryByText('等待 Host 确认送达…')).toBeNull()
    expect(screen.getByText('Waiting for response…')).toBeInTheDocument()
  })

  it('纯 local：直连不提示，显示阶段文案', () => {
    vi.mocked(transport.getConnectionMode).mockReturnValue('local')
    render(<Composer />)
    sendPendingPrompt()
    expect(screen.queryByText('等待 Host 确认送达…')).toBeNull()
    expect(screen.getByText('Waiting for response…')).toBeInTheDocument()
  })

  it('host 自己开跑的回合（队列收养 / 回放）不提示在等回执', () => {
    vi.mocked(transport.getConnectionMode).mockReturnValue('hub')
    vi.mocked(transport.isLocalDirect).mockReturnValue(false)
    // adoptTurn / 回放：currentPromptId 有值、promptAcceptedAt 空，但本端
    // 从没发过这条——不许把 host 开的回合说成「等 Host 确认送达」。
    useChatStore.setState({
      conn: 'busy',
      phaseText: 'Waiting for response…',
      currentPromptId: 'adopted-q',
      promptAcceptedAt: undefined,
      turnStartedAt: Date.now() - ACK_OVERDUE_MS,
    })
    render(<Composer />)
    expect(screen.queryByText('等待 Host 确认送达…')).toBeNull()
    expect(screen.getByText('Waiting for response…')).toBeInTheDocument()
  })
})

/**
 * hub 的 busy 心跳是 1s 一拍；FE 静默 2s 后探一次 HostInfo.lastSeenAgeMs
 * （hub 本机时钟算好的年龄）：新鲜 = host 在思考（不报警），超过 3.5s =
 * 连接中断（状态行改文案）。
 */
describe('Composer 状态行：Host 心跳停了的重连提示', () => {
  // 已超过 SILENCE_PROBE_AFTER_MS（2s），探针该跑了。
  const SILENT_FOR_MS = 2_500
  const hostSeen = (agoMs: number) => ({
    hostId: 'h1',
    hostName: 'H1',
    online: true,
    // hub computes the age on its own clock — never against the browser clock.
    lastSeenAgeMs: agoMs,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(transport.getConnectionMode).mockReturnValue('hub')
    vi.mocked(transport.isLocalDirect).mockReturnValue(false)
    vi.mocked(transport.lastLiveEventAt).mockReturnValue(null)
    useChatStore.setState({
      sessionId: 's1',
      cwd: '/test/cwd',
      selectedHostId: 'h1',
      conn: 'busy',
      phaseText: 'Waiting for response…',
      statusText: '',
      historyLoading: false,
      newSessionPending: false,
      entries: [],
      pending: [],
      topTasks: [],
      memoryCommandPending: undefined,
      recapPendingFor: undefined,
      // 已受理：这条不是「等回执」，静默只归心跳探针判断。
      promptAcceptedAt: Date.now(),
      currentPromptId: 'p-1',
      turnStartedAt: Date.now() - SILENT_FOR_MS,
    })
  })

  afterEach(() => {
    vi.mocked(transport.listHosts).mockResolvedValue({ hosts: [] })
    vi.mocked(transport.lastLiveEventAt).mockReturnValue(null)
    vi.mocked(transport.getConnectionMode).mockReturnValue('local')
    vi.mocked(transport.isLocalDirect).mockReturnValue(false)
  })

  it('busy + 静默 + 心跳停住 → 状态行显示连接中断，正在重连', async () => {
    vi.mocked(transport.listHosts).mockResolvedValue({
      hosts: [hostSeen(5_000)],
    })
    render(<Composer />)
    expect(
      await screen.findByText('Host 连接中断，正在重连…'),
    ).toBeInTheDocument()
  })

  it('有活动标签时仍优先显示连接中断（不能让 Thinking… 盖住）', async () => {
    vi.mocked(transport.listHosts).mockResolvedValue({
      hosts: [hostSeen(5_000)],
    })
    useChatStore.setState({
      entries: [
        {
          id: 'th1',
          kind: 'thought',
          text: 'still thinking',
          streaming: true,
          startedAt: Date.now() - 1_000,
        },
      ],
    })
    render(<Composer />)
    expect(
      await screen.findByText('Host 连接中断，正在重连…'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Thinking…')).toBeNull()
  })

  it('心跳 age 新鲜（长时间思考 / 工具调用）→ 不误报断线，保留真实活动', async () => {
    vi.mocked(transport.listHosts).mockResolvedValue({
      hosts: [hostSeen(500)],
    })
    useChatStore.setState({
      entries: [
        {
          id: 'th2',
          kind: 'thought',
          text: 'still thinking',
          streaming: true,
          startedAt: Date.now() - 1_000,
        },
      ],
    })
    render(<Composer />)
    await waitFor(() => expect(transport.listHosts).toHaveBeenCalled())
    expect(screen.queryByText('Host 连接中断，正在重连…')).toBeNull()
    expect(screen.getByText('Thinking…')).toBeInTheDocument()
  })

  it('年龄读数来自 hub 自己的时钟，与本机时间戳无关 → 不误报断线', async () => {
    vi.mocked(transport.listHosts).mockResolvedValue({
      hosts: [hostSeen(500)],
    })
    render(<Composer />)
    await waitFor(() => expect(transport.listHosts).toHaveBeenCalled())
    expect(screen.queryByText('Host 连接中断，正在重连…')).toBeNull()
  })
})

describe('记忆命令状态行（TUI CommandRunning）', () => {
  const pending = (sessionId: string, label = 'Flushing memory…') => ({
    sessionId,
    label,
    startedAt: Date.now(),
  })

  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sessionId: 's1',
      cwd: '/test/cwd',
      conn: 'ready',
      statusText: '',
      historyLoading: false,
      newSessionPending: false,
      entries: [],
      pending: [],
      topTasks: [],
    })
  })

  it('/flush 在飞 → 状态行出 label；命令结束（清空）后消失', () => {
    useChatStore.setState({ memoryCommandPending: pending('s1') })
    render(<Composer />)
    expect(screen.getByText('Flushing memory…')).toBeInTheDocument()
    act(() => useChatStore.setState({ memoryCommandPending: undefined }))
    expect(screen.queryByText('Flushing memory…')).toBeNull()
  })

  it('命令属于别的会话 → 当前视图不显示它的状态行', () => {
    useChatStore.setState({ memoryCommandPending: pending('other', 'Consolidating memory…') })
    render(<Composer />)
    expect(screen.queryByText('Consolidating memory…')).toBeNull()
  })
})

describe('Composer 访客只读态', () => {
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
      focusMode: 'prompt',
    })
    usePromptQueue.setState({ queue: [], sending: false })
  })

  it('输入框禁用：键入 / 回车 / 粘贴都不改草稿、不发送', () => {
    render(<Composer guest />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea).toBeDisabled()
    expect(textarea).toHaveAttribute('placeholder', '访客模式')

    fireEvent.change(textarea, { target: { value: '访客输入' } })
    expect(textarea.value).toBe('')

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })
    expect(transport.prompt).not.toHaveBeenCalled()

    fireEvent.paste(textarea, { clipboardData: { getData: () => 'pasted' } })
    expect(textarea.value).toBe('')
  })

  it('模型 / 模式底栏禁用，不打开菜单', () => {
    render(<Composer guest />)
    const readOnlyLabels = screen.getAllByTitle(/访客只读/)
    expect(readOnlyLabels).toHaveLength(2)
    for (const btn of readOnlyLabels) expect(btn).toBeDisabled()
  })

  it('有 pending 时显示「正在等待 Human 响应…」并带计时，标明只读', () => {
    useChatStore.setState({
      guestSessionState: {
        sessionState: 'awaiting',
        busy: true,
        awaitingInput: true,
        pendingInput: { kind: 'permission', count: 1, receivedAt: Date.now() - 65_000 },
      },
      refreshGuestStatus: vi.fn(async () => {}),
    } as never)
    render(<Composer guest />)
    const line = screen.getByRole('status')
    expect(line.textContent).toContain('正在等待 Human 响应权限')
    // 计时来自 receivedAt：65 秒前到达 → 至少 1m（不是从挂载时刻从 0 数起）
    expect(line.textContent).toMatch(/1m/)
    // 只读：这一行没有任何可点的东西
    expect(line.querySelector('button')).toBeNull()
  })

  it('没有 pending 时访客复用管理员那套 statusText / 活动标签', () => {
    useChatStore.setState({
      guestSessionState: { sessionState: 'active', busy: true, awaitingInput: false },
      conn: 'busy',
      phaseText: 'Thinking…',
      statusText: '',
      entries: [],
      refreshGuestStatus: vi.fn(async () => {}),
    } as never)
    const { unmount } = render(<Composer guest />)
    // 活动臂与管理员同源：没有活动条目时回退到阶段文案本身
    expect(screen.getByRole('status').textContent).toContain('Thinking…')
    unmount()

    useChatStore.setState({
      guestSessionState: {
        sessionState: 'idle',
        busy: false,
        awaitingInput: false,
      },
      conn: 'connecting',
      phaseText: '只读 · 历史',
      statusText: '',
      refreshGuestStatus: vi.fn(async () => {}),
    } as never)
    render(<Composer guest />)
    // 空闲 + connecting → 管理员的空闲臂同样走阶段文案
    expect(screen.getByRole('status').textContent).toContain('只读 · 历史')
  })

  it('回放中不被「等 Human」盖住（那条是上一个会话的残留读数）', () => {
    useChatStore.setState({
      guestSessionState: {
        sessionState: 'awaiting',
        busy: true,
        awaitingInput: true,
        pendingInput: { kind: 'permission', count: 1 },
      },
      historyLoading: true,
      refreshGuestStatus: vi.fn(async () => {}),
    } as never)
    render(<Composer guest />)
    const line = screen.getByRole('status')
    expect(line.textContent).toContain('回放中')
    expect(line.textContent).not.toContain('Human')
  })

  it('访客渲染期间会去拉一次状态（管理员不拉）', () => {
    const refresh = vi.fn(async () => {})
    useChatStore.setState({
      guestSessionState: undefined,
      refreshGuestStatus: refresh,
    } as never)
    const { unmount } = render(<Composer guest />)
    expect(refresh).toHaveBeenCalled()
    unmount()

    refresh.mockClear()
    render(<Composer />)
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('Composer 底栏窄屏布局', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sessionId: 'session-A',
      cwd: '/test/cwd',
      conn: 'busy',
      historyLoading: false,
      newSessionPending: false,
      entries: [],
      pending: [],
      permissionMode: 'always-approve',
    })
    usePromptQueue.setState({ queue: [], sending: false })
  })

  it('模型槽可收缩，权限模式标签保持不收缩', () => {
    render(<Composer />)
    const modelBtn = screen.getByTitle(/点击切换模型/)
    const modelSlot = modelBtn.parentElement
    expect(modelSlot?.className).toContain('min-w-0')
    expect(modelSlot?.className).toContain('shrink')
    expect(modelSlot?.className).not.toContain('shrink-0')

    const modeBtn = screen.getByTitle(/当前模式: always-approve/)
    expect(modeBtn.parentElement?.className).toContain('shrink-0')
  })
})
