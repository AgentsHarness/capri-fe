import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ShareGuestModal, type ShareTarget } from './ShareGuestModal'

const { transportMock } = vi.hoisted(() => ({
  transportMock: {
    listGuestTokens: vi.fn(async () => [] as unknown[]),
    createGuestToken: vi.fn(),
    addGuestSessions: vi.fn(),
    updateGuestToken: vi.fn(),
    deleteGuestToken: vi.fn(),
    removeGuestSessions: vi.fn(),
    refreshGuestToken: vi.fn(),
    accessRole: vi.fn(),
    guestSessions: vi.fn(),
    listHostSessions: vi.fn(),
    getConnectionMode: vi.fn(() => 'hub'),
    getAccessToken: vi.fn(() => 'admin'),
    updateSettings: vi.fn(),
    settings: vi.fn(),
  },
}))
vi.mock('../../api/client', () => ({ transport: transportMock }))
vi.mock('../../store/toast', () => ({ pushToast: vi.fn() }))

const record = (over: Record<string, unknown> = {}) => ({
  id: 'g_1',
  token: 'g_3b1e64hex',
  label: '给小王',
  createdAt: 1760000000,
  expiresAt: 0,
  revoked: false,
  sessions: [{ hostId: 'h1', hostName: 'H1', sessionId: 's1', cwd: '/w1', title: 'one' }],
  ...over,
})

const target: ShareTarget = {
  hostId: 'h1',
  hostName: 'Office Mac',
  sessionId: 's1',
  cwd: '/repo/acp-fe',
  title: '访客模式设计',
}

beforeEach(() => {
  vi.clearAllMocks()
  transportMock.listGuestTokens.mockResolvedValue([])
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => {}) },
  })
})

describe('ShareGuestModal', () => {
  it('新建令牌：createGuestToken 收到这一个会话（含 host/session/cwd/title）', async () => {
    transportMock.createGuestToken.mockResolvedValue(record())
    render(<ShareGuestModal target={target} onClose={() => {}} />)
    await waitFor(() => expect(transportMock.listGuestTokens).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('令牌标签'), { target: { value: '给小王' } })
    fireEvent.click(screen.getByText('确认并生成链接'))

    await waitFor(() => expect(transportMock.createGuestToken).toHaveBeenCalled())
    const arg = transportMock.createGuestToken.mock.calls[0][0]
    expect(arg.label).toBe('给小王')
    expect(arg.sessions).toEqual([
      {
        hostId: 'h1',
        hostName: 'Office Mac',
        sessionId: 's1',
        cwd: '/repo/acp-fe',
        title: '访客模式设计',
      },
    ])
    // 默认有效期 1 天：换算成绝对 epoch 秒
    expect(arg.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('选已有令牌：addGuestSessions 带上同一会话条目', async () => {
    transportMock.listGuestTokens.mockResolvedValue([record({ label: '外部评审', sessions: [] })])
    transportMock.addGuestSessions.mockResolvedValue(record({ label: '外部评审' }))
    render(<ShareGuestModal target={target} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('外部评审')).toBeInTheDocument())

    fireEvent.click(screen.getByText('外部评审'))
    fireEvent.click(screen.getByText('确认并生成链接'))

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
    expect(transportMock.createGuestToken).not.toHaveBeenCalled()
  })

  it('令牌已包含该会话：不进写入路径，直接展示链接', async () => {
    transportMock.listGuestTokens.mockResolvedValue([record()])
    render(<ShareGuestModal target={target} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('给小王')).toBeInTheDocument())

    fireEvent.click(screen.getByText('给小王'))
    expect(screen.getByText('该令牌已包含此会话')).toBeInTheDocument()
    fireEvent.click(screen.getByText('查看链接'))

    await waitFor(() => expect(screen.getByRole('dialog', { name: '分享只读链接' })).toBeInTheDocument())
    expect(screen.getByTitle(/^.*#g=g_3b1e64hex$/)).toBeInTheDocument()
    expect(transportMock.addGuestSessions).not.toHaveBeenCalled()
    expect(transportMock.createGuestToken).not.toHaveBeenCalled()
  })

  it('结果区展示分享链接（#g=）、访问地址与完整密钥；复制写剪贴板', async () => {
    transportMock.createGuestToken.mockResolvedValue(record())
    render(<ShareGuestModal target={target} onClose={() => {}} />)
    await waitFor(() => expect(transportMock.listGuestTokens).toHaveBeenCalled())
    fireEvent.click(screen.getByText('确认并生成链接'))
    await waitFor(() => expect(screen.getByTitle(/^.*#g=g_3b1e64hex$/)).toBeInTheDocument())

    const link = `${location.origin}${location.pathname}#g=g_3b1e64hex`
    expect(screen.getByTitle(link)).toBeInTheDocument()
    expect(screen.getByTitle('g_3b1e64hex')).toBeInTheDocument()
    expect(screen.getByTitle(`${location.origin}${location.pathname}`)).toBeInTheDocument()
    // 到期 = 永久
    expect(screen.getByText(/到期：永久/)).toBeInTheDocument()

    const copies = screen.getAllByRole('button', { name: /复制|已复制/ })
    fireEvent.click(copies[0])
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(link),
    )
    await waitFor(() => expect(screen.getAllByText('已复制').length).toBeGreaterThan(0))
  })

  it('创建失败：错误就地显示，不进入结果区', async () => {
    transportMock.createGuestToken.mockRejectedValue(new Error('仅管理员可管理访客令牌'))
    render(<ShareGuestModal target={target} onClose={() => {}} />)
    await waitFor(() => expect(transportMock.listGuestTokens).toHaveBeenCalled())
    fireEvent.click(screen.getByText('确认并生成链接'))
    await waitFor(() =>
      expect(screen.getByText('仅管理员可管理访客令牌')).toBeInTheDocument(),
    )
    expect(screen.queryByTitle(/^.*#g=/)).toBeNull()
  })
})
