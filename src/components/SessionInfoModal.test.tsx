import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { transport } from '../api/client'
import { useChatStore } from '../store/chat'
import { SessionInfoModal } from './SessionInfoModal'

vi.mock('../api/client', () => ({
  transport: {
    sessionInfo: vi.fn(),
    sessionInfoExt: vi.fn(),
    sessionUsage: vi.fn(),
    sessionShare: vi.fn(),
    status: vi.fn(),
    onEvent: vi.fn(),
  },
}))

const hostMock = vi.mocked(transport.sessionInfo)
const extMock = vi.mocked(transport.sessionInfoExt)
const statusMock = vi.mocked(transport.status)
const usageMock = vi.mocked(transport.sessionUsage)

const HOST = {
  sessionId: 'sess-42',
  title: 'My session',
  cwd: '/tmp/proj',
  hostId: 'h1',
  hostName: 'mac',
  homeDir: '/tmp',
}

beforeEach(() => {
  useChatStore.setState({
    sessionInfoOpen: true,
    closeSessionInfo: vi.fn(),
    sessionId: 'sess-42',
  })
  hostMock.mockReset().mockResolvedValue({ ...HOST })
  extMock.mockReset().mockResolvedValue({})
  statusMock.mockReset().mockResolvedValue({})
  usageMock.mockReset().mockResolvedValue({})
})

describe('SessionInfoModal', () => {
  it('未打开 → 不渲染', () => {
    useChatStore.setState({ sessionInfoOpen: false })
    const { container } = render(<SessionInfoModal />)
    expect(container.firstChild).toBeNull()
  })

  it('两份请求都显式带上当前 sessionId（防 host 填自己的活动会话）', async () => {
    render(<SessionInfoModal />)
    await waitFor(() => {
      expect(hostMock).toHaveBeenCalledWith('sess-42')
      expect(extMock).toHaveBeenCalledWith({ sessionId: 'sess-42' })
    })
  })

  it('agent 侧行有数据时渲染：Conversation ID / API Backend / Turn', async () => {
    extMock.mockResolvedValue({
      conversationId: 'conv-9',
      apiBackend: 'gateway',
      turnIndex: 7,
      model: 'grok-x',
    })
    render(<SessionInfoModal />)
    await screen.findByText('conv-9')
    expect(screen.getByText('conversation id')).toBeInTheDocument()
    expect(screen.getByText('gateway')).toBeInTheDocument()
    expect(screen.getByText('turn')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('agent 快照字段缺失 → 只渲染 host 行，不崩', async () => {
    extMock.mockResolvedValue({})
    render(<SessionInfoModal />)
    await screen.findByText('My session')
    expect(screen.getByText('sess-42')).toBeInTheDocument()
    expect(screen.queryByText('conversation id')).not.toBeInTheDocument()
    expect(screen.queryByText('api backend')).not.toBeInTheDocument()
    expect(screen.queryByText('turn')).not.toBeInTheDocument()
    // status 空快照 → 无 Shell version 行。
    expect(screen.queryByText('shell version')).not.toBeInTheDocument()
  })

  it('agent 快照请求失败 → 降级提示 + host 行照常显示（不整弹窗报错）', async () => {
    extMock.mockRejectedValue(new Error('agent down'))
    render(<SessionInfoModal />)
    await screen.findByText(/agent 快照获取失败/)
    expect(screen.getByText('My session')).toBeInTheDocument()
    expect(screen.queryByText('重试')).not.toBeInTheDocument()
  })

  it('host 请求失败 → 错误 + 重试成功', async () => {
    hostMock.mockRejectedValueOnce(new Error('boom'))
    render(<SessionInfoModal />)
    await screen.findByText('boom')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText('My session')
  })

  it('Model 行：catalog name 优先于 resolved', async () => {
    extMock.mockResolvedValue({
      model: 'grok-x',
      modelDisplayName: 'Grok Name',
      resolvedModelId: 'r-1',
    })
    render(<SessionInfoModal />)
    await screen.findByText('Grok Name')
    expect(screen.queryByText(/grok-x/)).not.toBeInTheDocument()
  })

  it('Model 行：无 name 且 show_resolved → "model (resolved)"；authMeta 关掉后只显示 model', async () => {
    extMock.mockResolvedValue({ model: 'grok-x', resolvedModelId: 'r-1' })
    const { unmount } = render(<SessionInfoModal />)
    await screen.findByText('grok-x (r-1)')
    unmount()
    // show_resolved_model=false（authMeta，TUI 同源）→ 不追加 resolved。
    statusMock.mockResolvedValue({ authMeta: { show_resolved_model: false } })
    render(<SessionInfoModal />)
    await screen.findByText('grok-x')
    expect(screen.queryByText('grok-x (r-1)')).not.toBeInTheDocument()
  })

  it('Model Hash 行仅在 showModelFingerprint 时渲染', async () => {
    extMock.mockResolvedValue({ modelFingerprint: 'fp-1', showModelFingerprint: true })
    const { unmount } = render(<SessionInfoModal />)
    await screen.findByText('fp-1')
    unmount()
    extMock.mockResolvedValue({ modelFingerprint: 'fp-1' })
    render(<SessionInfoModal />)
    await screen.findByText('My session')
    expect(screen.queryByText('fp-1')).not.toBeInTheDocument()
  })

  it('Shell version 行：/api/status agentInfo._meta.agentVersion', async () => {
    statusMock.mockResolvedValue({
      agentInfo: { _meta: { agentVersion: '0.3.1' } },
    })
    render(<SessionInfoModal />)
    await screen.findByText('0.3.1')
    expect(screen.getByText('shell version')).toBeInTheDocument()
  })

  it('agent context 兜底：host 无 contextSize 时用快照 context 渲染 Context 行', async () => {
    hostMock.mockResolvedValue({ ...HOST, contextSize: undefined } as never)
    extMock.mockResolvedValue({ context: { used: 500, total: 2000 } } as never)
    render(<SessionInfoModal />)
    await screen.findByText(/500 \/ 2\.0K \(25%\)/)
  })

  it('footer 刷新 usage：锁定会话，且兼容 {usage:{…}} 嵌套响应', async () => {
    usageMock.mockResolvedValue({ usage: { totalTokens: 12345 } } as never)
    render(<SessionInfoModal />)
    await screen.findByText('My session')
    fireEvent.click(screen.getByRole('button', { name: '刷新 usage' }))
    await screen.findByText('usage')
    expect(screen.getByText('12K')).toBeInTheDocument()
    expect(usageMock).toHaveBeenCalledWith({ sessionId: 'sess-42' })
  })
})
