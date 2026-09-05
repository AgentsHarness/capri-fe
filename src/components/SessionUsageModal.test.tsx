import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { transport } from '../api/client'
import { useChatStore } from '../store/chat'
import { SessionUsageModal } from './SessionUsageModal'

vi.mock('../api/client', () => ({
  transport: {
    sessionUsage: vi.fn(),
    onEvent: vi.fn(),
  },
}))

const usageMock = vi.mocked(transport.sessionUsage)

beforeEach(() => {
  useChatStore.setState({
    sessionUsageOpen: true,
    closeSessionUsage: vi.fn(),
    sessionId: 'sess-42',
    contextOpen: false,
    sessionInfoOpen: false,
  })
  usageMock.mockReset()
})

describe('SessionUsageModal', () => {
  it('未打开 → 不渲染', () => {
    useChatStore.setState({ sessionUsageOpen: false })
    const { container } = render(<SessionUsageModal />)
    expect(container.firstChild).toBeNull()
  })

  it('请求显式带上当前 sessionId（防 host 填自己的活动会话）', async () => {
    usageMock.mockResolvedValue({})
    render(<SessionUsageModal />)
    await waitFor(() =>
      expect(usageMock).toHaveBeenCalledWith({ sessionId: 'sess-42' }),
    )
  })

  it('无活动会话 → 暂无活动会话，不发请求', () => {
    useChatStore.setState({ sessionId: undefined })
    render(<SessionUsageModal />)
    expect(screen.getByText('暂无活动会话')).toBeInTheDocument()
    expect(usageMock).not.toHaveBeenCalled()
  })

  it('加载中 → 加载提示', () => {
    usageMock.mockReturnValue(new Promise(() => {}))
    render(<SessionUsageModal />)
    expect(screen.getByText('加载中…')).toBeInTheDocument()
  })

  it('空账本 → 尚未产生模型调用', async () => {
    usageMock.mockResolvedValue({})
    render(<SessionUsageModal />)
    expect(await screen.findByText('本会话尚未产生模型调用')).toBeInTheDocument()
  })

  it('空账本且 incomplete → 可能少计', async () => {
    usageMock.mockResolvedValue({ usageIsIncomplete: true })
    render(<SessionUsageModal />)
    expect(
      await screen.findByText('尚未记录用量，但追踪不完整，可能少计'),
    ).toBeInTheDocument()
  })

  it('完整数据 → token / 调用 / 费用（千分位 + $x.xxxx）', async () => {
    usageMock.mockResolvedValue({
      inputTokens: 1_234_567,
      cachedReadTokens: 1_000_000,
      outputTokens: 45_678,
      reasoningTokens: 12_000,
      totalTokens: 1_280_245,
      modelCalls: 42,
      apiDurationMs: 192_000,
      costUsdTicks: 12_345_000_000,
    })
    render(<SessionUsageModal />)
    await screen.findByText(/1,234,567 \(1,000,000 cached\)/)
    expect(screen.getByText(/45,678 \(12,000 reasoning\)/)).toBeInTheDocument()
    expect(screen.getByText('1,280,245')).toBeInTheDocument()
    expect(screen.getByText(/42 · API time: 3m12s/)).toBeInTheDocument()
    expect(screen.getByText('$1.2345')).toBeInTheDocument()
    expect(screen.queryByText('by model')).not.toBeInTheDocument()
  })

  it('缺 cost 视为未知，绝不显示 $0', async () => {
    usageMock.mockResolvedValue({
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      modelCalls: 1,
      apiDurationMs: 1000,
    })
    render(<SessionUsageModal />)
    expect(await screen.findByText('not available (not reported)')).toBeInTheDocument()
    expect(screen.queryByText('$0')).not.toBeInTheDocument()
    expect(screen.queryByText('$0.0000')).not.toBeInTheDocument()
  })

  it('partial cost → not reported for some calls', async () => {
    usageMock.mockResolvedValue({
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      modelCalls: 1,
      costIsPartial: true,
    })
    render(<SessionUsageModal />)
    expect(
      await screen.findByText('not available (not reported for some calls)'),
    ).toBeInTheDocument()
  })

  it('多模型 → by model 行', async () => {
    usageMock.mockResolvedValue({
      inputTokens: 150,
      outputTokens: 15,
      totalTokens: 165,
      modelCalls: 2,
      modelUsage: {
        'grok-build': { inputTokens: 100, outputTokens: 10 },
        'grok-4': { inputTokens: 50, outputTokens: 5, costUsdTicks: 1e10 },
      },
    })
    render(<SessionUsageModal />)
    await screen.findByText('by model')
    expect(screen.getByText('grok-build')).toBeInTheDocument()
    expect(screen.getByText(/100 in \/ 10 out/)).toBeInTheDocument()
    expect(screen.getByText('grok-4')).toBeInTheDocument()
    expect(screen.getByText(/50 in \/ 5 out · \$1\.0000/)).toBeInTheDocument()
  })

  it('incomplete 有数据 → 底部提示可能少计', async () => {
    usageMock.mockResolvedValue({
      inputTokens: 10,
      outputTokens: 1,
      totalTokens: 11,
      modelCalls: 1,
      usageIsIncomplete: true,
    })
    render(<SessionUsageModal />)
    expect(await screen.findByText('用量不完整，可能少计')).toBeInTheDocument()
  })

  it('请求失败 → 错误 + 重试成功', async () => {
    usageMock.mockRejectedValueOnce(new Error('boom'))
    usageMock.mockResolvedValueOnce({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      modelCalls: 1,
    })
    render(<SessionUsageModal />)
    await screen.findByText('boom')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText(/10 \(0 cached\)/)
  })

  it('Esc → closeSessionUsage；背景点击 → closeSessionUsage', async () => {
    usageMock.mockResolvedValue({})
    render(<SessionUsageModal />)
    await waitFor(() => expect(usageMock).toHaveBeenCalled())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useChatStore.getState().closeSessionUsage).toHaveBeenCalledTimes(1)

    const dialog = screen.getByRole('dialog', { name: 'session usage' })
    fireEvent.mouseDown(dialog)
    expect(useChatStore.getState().closeSessionUsage).toHaveBeenCalledTimes(2)
  })

  it('header tab → 打开 context 弹窗并关掉自己', async () => {
    usageMock.mockResolvedValue({})
    render(<SessionUsageModal />)
    await waitFor(() => expect(usageMock).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('tab', { name: 'Context usage' }))
    expect(useChatStore.getState().contextOpen).toBe(true)
    expect(useChatStore.getState().sessionUsageOpen).toBe(false)
    expect(useChatStore.getState().sessionInfoOpen).toBe(false)
  })

  it('关闭后旧请求结果不落地（seq 守卫）', async () => {
    let resolveLater!: (v: {
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
      modelCalls?: number
    }) => void
    usageMock.mockReturnValue(new Promise((r) => (resolveLater = r)))
    const { unmount } = render(<SessionUsageModal />)
    expect(usageMock).toHaveBeenCalledTimes(1)
    unmount()
    usageMock.mockResolvedValue({})
    useChatStore.setState({ sessionUsageOpen: true, sessionId: 'sess-42' })
    const second = render(<SessionUsageModal />)
    await waitFor(() => expect(usageMock).toHaveBeenCalledTimes(2))
    resolveLater({
      inputTokens: 99,
      outputTokens: 1,
      totalTokens: 100,
      modelCalls: 1,
    })
    await waitFor(() => {
      expect(second.queryByText('本会话尚未产生模型调用')).toBeInTheDocument()
    })
    expect(second.queryByText(/99/)).not.toBeInTheDocument()
  })
})
