import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SubscribersPanel } from './SubscribersPanel'
import { useChatStore } from '../store/chat'
import type { SubscriberRow } from '../api/types'

const { transportMock } = vi.hoisted(() => ({
  transportMock: {
    getConnectionMode: vi.fn(() => 'hub'),
    listSubscribers: vi.fn(),
    // store 模块加载时会注册若干模块级订阅，传输面必须存在。
    onEvent: vi.fn(() => () => {}),
  },
}))
vi.mock('../api/client', () => ({ transport: transportMock }))

const row = (over: Partial<SubscriberRow> = {}): SubscriberRow => ({
  id: 1,
  ip: '203.0.113.9',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  role: 'admin',
  hostId: 'h1',
  sessionId: 's1',
  connectedAt: Date.now() - 5 * 60_000,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  useChatStore.setState({
    mode: 'hub',
    feSubscribers: 2,
    feSubscriberId: 1,
    hosts: [{ hostId: 'h1', hostName: 'Office Mac', online: true }],
    sessions: [{ sessionId: 's1', cwd: '/repo', title: '订阅者面板设计' }],
    workspaces: [],
  })
})

describe('SubscribersPanel', () => {
  it('逐行显示地址 / 设备 / 身份 / host / 正在查看 / 连接时长', async () => {
    transportMock.listSubscribers.mockResolvedValue([
      row(),
      row({
        id: 2,
        ip: '198.51.100.4',
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        role: 'guest',
        guestId: 'g_abc123',
        guestLabel: '小王',
        hostId: 'h2',
        sessionId: 'unknown-session-xyz',
        connectedAt: Date.now() - 2 * 60 * 60_000,
      }),
    ])
    render(<SubscribersPanel onClose={() => {}} />)

    await waitFor(() => expect(screen.getByText('203.0.113.9')).toBeInTheDocument())
    expect(screen.getByText('Chrome · macOS')).toBeInTheDocument()
    expect(screen.getByText('Safari · iOS')).toBeInTheDocument()
    // 会话标题来自侧栏列表；列表里没有的会话用 id 前缀（不能空着）。
    expect(screen.getByText('订阅者面板设计')).toBeInTheDocument()
    expect(screen.getByText('unknown-sess…')).toBeInTheDocument()
    // host 名来自注册表，不能只露 id。
    expect(screen.getByText('Office Mac')).toBeInTheDocument()
    // 访客身份用 guests.json 的标签，管理员行标「本页」（行号 = hello 的 id）。
    expect(screen.getByText('小王')).toBeInTheDocument()
    expect(screen.getByText('本页')).toBeInTheDocument()
    expect(screen.getByText('5 分钟')).toBeInTheDocument()
    expect(screen.getByText('2 小时')).toBeInTheDocument()
    expect(screen.getByText('2 个连接')).toBeInTheDocument()
  })

  it('老 hub 没有 /api/subscribers：显示原因，数字仍留在标题', async () => {
    transportMock.listSubscribers.mockRejectedValue(
      new Error('Hub 不支持订阅者详情（请升级 hub）'),
    )
    render(<SubscribersPanel onClose={() => {}} />)
    await waitFor(() =>
      expect(screen.getByText('Hub 不支持订阅者详情（请升级 hub）')).toBeInTheDocument(),
    )
    expect(screen.getByText('2 个连接')).toBeInTheDocument()
  })

  it('空名单给出明确文案；刷新按钮重新拉取', async () => {
    transportMock.listSubscribers.mockResolvedValue([])
    render(<SubscribersPanel onClose={() => {}} />)
    await waitFor(() =>
      expect(screen.getByText('当前没有在线订阅者。')).toBeInTheDocument(),
    )
    expect(transportMock.listSubscribers).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTitle('重新读取订阅者名单'))
    await waitFor(() => expect(transportMock.listSubscribers).toHaveBeenCalledTimes(2))
  })

  it('Esc 关闭面板', async () => {
    transportMock.listSubscribers.mockResolvedValue([])
    const onClose = vi.fn()
    render(<SubscribersPanel onClose={onClose} />)
    await waitFor(() => expect(transportMock.listSubscribers).toHaveBeenCalled())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
