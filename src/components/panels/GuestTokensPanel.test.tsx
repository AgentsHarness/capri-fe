import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GuestTokensPanel } from './GuestTokensPanel'
import { useChatStore } from '../../store/chat'

const { transportMock } = vi.hoisted(() => ({
  transportMock: {
    getConnectionMode: vi.fn(() => 'hub'),
    listGuestTokens: vi.fn(),
    createGuestToken: vi.fn(),
    updateGuestToken: vi.fn(),
    deleteGuestToken: vi.fn(),
    addGuestSessions: vi.fn(),
    removeGuestSessions: vi.fn(),
    refreshGuestToken: vi.fn(),
    listHostSessions: vi.fn(),
    getAccessToken: vi.fn(() => 'admin'),
    onEvent: vi.fn(() => () => {}),
  },
}))
vi.mock('../../api/client', () => ({ transport: transportMock }))
vi.mock('../../store/toast', () => ({ pushToast: vi.fn() }))

const token = (over: Record<string, unknown> = {}) => ({
  id: 'g_1',
  token: 'g_secret_token_value',
  label: '给小王',
  createdAt: 1760000000,
  expiresAt: 0,
  revoked: false,
  sessions: [
    {
      hostId: 'h1',
      hostName: 'Office Mac',
      sessionId: 's1',
      cwd: '/repo/acp-fe',
      title: '访客模式设计',
      addedAt: 1760000000,
    },
    {
      hostId: 'h2',
      hostName: 'VPS',
      sessionId: 's9',
      cwd: '/srv/api',
      title: '已删掉的会话',
      addedAt: 1760000100,
      stale: true,
    },
  ],
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => {}) },
  })
  useChatStore.setState({
    hosts: [
      { hostId: 'h1', hostName: 'Office Mac', online: true },
      { hostId: 'h2', hostName: 'VPS', online: false },
    ],
  })
})

describe('GuestTokensPanel', () => {
  it('列表渲染：标签、会话数、到期、吊销标记；stale 会话标灰并提示', async () => {
    transportMock.listGuestTokens.mockResolvedValue([
      token(),
      token({ id: 'g_2', label: '外部评审', revoked: true, sessions: [] }),
    ])
    render(<GuestTokensPanel />)
    await waitFor(() => expect(screen.getByText('给小王')).toBeInTheDocument())
    expect(screen.getByText('外部评审')).toBeInTheDocument()
    expect(screen.getByText('已吊销')).toBeInTheDocument()
    expect(screen.getByText('2 个会话 · 永久')).toBeInTheDocument()
    expect(screen.getByText('0 个会话 · 永久')).toBeInTheDocument()

    // 展开会话表：stale 行带「已失效」
    fireEvent.click(screen.getByText('给小王'))
    await waitFor(() => expect(screen.getByText('已失效')).toBeInTheDocument())
    expect(screen.getByText('访客模式设计')).toBeInTheDocument()
    expect(screen.getByText('/srv/api')).toBeInTheDocument()
  })

  it('移除会话：调用 removeGuestSessions 并只带 (hostId, sessionId)', async () => {
    transportMock.listGuestTokens.mockResolvedValue([token()])
    transportMock.removeGuestSessions.mockResolvedValue(token({ sessions: [] }))
    render(<GuestTokensPanel />)
    await waitFor(() => expect(screen.getByText('给小王')).toBeInTheDocument())
    fireEvent.click(screen.getByText('给小王'))

    const removes = await screen.findAllByText('移除')
    // 第二行是 stale 的那条
    fireEvent.click(removes[1])
    await waitFor(() =>
      expect(transportMock.removeGuestSessions).toHaveBeenCalledWith('g_1', [
        { hostId: 'h2', sessionId: 's9' },
      ]),
    )
  })

  it('复制链接：写剪贴板的是 #g=<token> 分享链接', async () => {
    transportMock.listGuestTokens.mockResolvedValue([token()])
    render(<GuestTokensPanel />)
    await waitFor(() => expect(screen.getByText('给小王')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /链接/ }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        `${location.origin}${location.pathname}#g=g_secret_token_value`,
      ),
    )
  })

  it('刷新：调 refreshGuestToken 并回填 stale 状态', async () => {
    transportMock.listGuestTokens.mockResolvedValue([token()])
    transportMock.refreshGuestToken.mockResolvedValue(
      token({ sessions: [{ ...token().sessions[0], title: '刷新后的标题' }] }),
    )
    render(<GuestTokensPanel />)
    await waitFor(() => expect(screen.getByText('给小王')).toBeInTheDocument())
    fireEvent.click(screen.getByText('给小王'))
    fireEvent.click(screen.getByRole('button', { name: /刷新$/ }))
    await waitFor(() =>
      expect(transportMock.refreshGuestToken).toHaveBeenCalledWith('g_1'),
    )
    await waitFor(() => expect(screen.getByText('刷新后的标题')).toBeInTheDocument())
  })

  it('添加会话：host 下拉读的是该 host 的会话，多选后 addGuestSessions 带快照', async () => {
    transportMock.listGuestTokens.mockResolvedValue([token({ sessions: [] })])
    transportMock.listHostSessions.mockResolvedValue([
      { sessionId: 's1', cwd: '/repo/acp-fe', title: '访客模式设计' },
      { sessionId: 's2', cwd: '/repo/other', title: '另一个' },
    ])
    transportMock.addGuestSessions.mockResolvedValue(
      token({ sessions: [{ hostId: 'h1', hostName: 'Office Mac', sessionId: 's1', cwd: '/repo/acp-fe' }] }),
    )
    render(<GuestTokensPanel />)
    await waitFor(() => expect(screen.getByText('给小王')).toBeInTheDocument())
    fireEvent.click(screen.getByText('给小王'))
    fireEvent.click(screen.getByText('添加会话'))

    await waitFor(() => expect(transportMock.listHostSessions).toHaveBeenCalledWith('h1'))
    const boxes = await screen.findAllByRole('checkbox')
    fireEvent.click(boxes[0])
    fireEvent.click(screen.getByRole('button', { name: /加入/ }))

    await waitFor(() =>
      expect(transportMock.addGuestSessions).toHaveBeenCalledWith('g_1', [
        {
          hostId: 'h1',
          hostName: 'Office Mac',
          sessionId: 's1',
          cwd: '/repo/acp-fe',
          title: '访客模式设计',
        },
      ]),
    )
  })

  it('本地直连模式：整块替换成「仅 Hub 模式支持分享」', async () => {
    transportMock.getConnectionMode.mockReturnValue('local')
    render(<GuestTokensPanel />)
    expect(screen.getByText(/仅 Hub 模式支持分享/)).toBeInTheDocument()
    expect(transportMock.listGuestTokens).not.toHaveBeenCalled()
  })
})
