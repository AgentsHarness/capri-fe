import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { transport } from '../api/client'
import { useChatStore } from '../store/chat'
import { UsageModal } from './UsageModal'

vi.mock('../api/client', () => ({
  transport: {
    billing: vi.fn(),
    usageReport: vi.fn(),
    onEvent: vi.fn(),
  },
}))

const billingMock = vi.mocked(transport.billing)
const usageMock = vi.mocked(transport.usageReport)

beforeEach(() => {
  useChatStore.setState({ usageOpen: true, closeUsage: vi.fn() })
  billingMock.mockReset()
  usageMock.mockReset()
})

const total = {
  totalTokens: 1_000_000,
  inputTokens: 600_000,
  outputTokens: 400_000,
  cachedReadTokens: 500_000,
  cacheCreationTokens: 100_000,
  reasoningTokens: 50_000,
  modelCalls: 10,
  turns: 20,
  cacheHitRate: 0.83,
}

describe('UsageModal', () => {
  it('未打开 → 不渲染', () => {
    useChatStore.setState({ usageOpen: false })
    const { container } = render(<UsageModal />)
    expect(container.firstChild).toBeNull()
  })

  it('加载中 → 两个区块各显示加载提示', () => {
    billingMock.mockReturnValue(new Promise(() => {}))
    usageMock.mockReturnValue(new Promise(() => {}))
    render(<UsageModal />)
    expect(screen.getAllByText('加载中…').length).toBe(2)
  })

  it('billing 配置齐全 → 配额/余额/层级/按需/周期', async () => {
    billingMock.mockResolvedValue({
      config: {
        creditUsagePercent: 92.5,
        prepaidBalance: { val: 12345 },
        currentPeriod: { start: '2026-01-01T00:00:00Z', end: '2026-01-31T00:00:00Z' },
      },
      subscriptionTier: 'pro',
      onDemandEnabled: true,
    })
    usageMock.mockResolvedValue({ total: total })
    render(<UsageModal />)
    expect(await screen.findByText('已用配额')).toBeInTheDocument()
    expect(screen.getByText('92.5%')).toBeInTheDocument()
    expect(screen.getByText('余额')).toBeInTheDocument()
    expect(screen.getByText('$123.45')).toBeInTheDocument()
    expect(screen.getByText('订阅层级')).toBeInTheDocument()
    expect(screen.getByText('按需计费')).toBeInTheDocument()
    expect(screen.getByText('已开启')).toBeInTheDocument()
    expect(screen.getByText('周期')).toBeInTheDocument()
  })

  it('billing 无配置 / 无可用字段', async () => {
    billingMock.mockResolvedValue({ config: null, subscriptionTier: '', onDemandEnabled: undefined })
    usageMock.mockResolvedValue({ total: total })
    const first = render(<UsageModal />)
    expect(await first.findByText('无 billing 配置（未登录或旧 agent）')).toBeInTheDocument()
    first.unmount()

    billingMock.mockResolvedValue({ config: {}, subscriptionTier: '', onDemandEnabled: undefined })
    const second = render(<UsageModal />)
    expect(await second.findByText('无 billing 配置（未登录或旧 agent）')).toBeInTheDocument()
    second.unmount()
  })

  it('billing 请求失败 → 错误 + 重试', async () => {
    billingMock.mockRejectedValueOnce(new Error('billing down'))
    billingMock.mockResolvedValueOnce({ config: { creditUsagePercent: 10 }, subscriptionTier: 'x' })
    usageMock.mockResolvedValue({ total: total })
    render(<UsageModal />)
    expect(await screen.findByText('billing down')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('已用配额')).toBeInTheDocument()
  })

  it('usage 聚合 → 总览格子 + 命中率 + 模型表（按 total 降序）', async () => {
    billingMock.mockResolvedValue({})
    usageMock.mockResolvedValue({
      sessions: 3,
      total,
      byModel: {
        'model-a': { totalTokens: 1_000 },
        'model-b': { totalTokens: 9_000, inputTokens: 100 },
      },
    })
    render(<UsageModal />)
    expect(await screen.findByText('3 会话 · 20 回合')).toBeInTheDocument()
    expect(screen.getByText('1.0M')).toBeInTheDocument() // 总 token
    expect(screen.getByText('600K')).toBeInTheDocument() // 输入
    expect(screen.getByText('400K')).toBeInTheDocument() // 输出
    expect(screen.getByText('500K')).toBeInTheDocument() // 缓存命中读
    expect(screen.getByText('100K')).toBeInTheDocument() // 缓存写入
    expect(screen.getByText('50K')).toBeInTheDocument() // 思考 token
    expect(screen.getByText('83.0%')).toBeInTheDocument() // 命中率
    // 模型行按 totalTokens 降序：model-b 在前
    const dataRows = screen.getAllByRole('row').slice(1)
    expect(dataRows[0]).toHaveTextContent('model-b')
    expect(dataRows[1]).toHaveTextContent('model-a')
  })

  it('usage 无 byModel → 无模型分组数据', async () => {
    billingMock.mockResolvedValue({})
    usageMock.mockResolvedValue({ sessions: 1, total: { totalTokens: 100 } })
    render(<UsageModal />)
    expect(await screen.findByText('无模型分组数据')).toBeInTheDocument()
  })

  it('usage 请求失败 → 错误 + 重试', async () => {
    billingMock.mockResolvedValue({})
    usageMock.mockRejectedValueOnce(new Error('usage down'))
    usageMock.mockResolvedValueOnce({ total: { totalTokens: 55 } })
    render(<UsageModal />)
    expect(await screen.findByText('usage down')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('55')).toBeInTheDocument()
  })

  it('usage 无数据 → 暂无数据', async () => {
    billingMock.mockResolvedValue({})
    usageMock.mockResolvedValue(undefined as never)
    render(<UsageModal />)
    expect(await screen.findByText('暂无数据（窗口内没有回合终态 usage）')).toBeInTheDocument()
  })

  it('窗口切换 → 带 from 重新拉取', async () => {
    billingMock.mockResolvedValue({})
    usageMock.mockResolvedValue({ total: { totalTokens: 1 } })
    render(<UsageModal />)
    await screen.findByText('1')
    fireEvent.click(screen.getByRole('button', { name: '24h' }))
    await waitFor(() => expect(usageMock).toHaveBeenCalledTimes(2))
    const fromArg = usageMock.mock.calls[1][0]?.from as number
    const expected = Math.floor(Date.now() / 1000) - 24 * 3600
    expect(Math.abs(fromArg - expected)).toBeLessThan(60)
  })

  it('刷新按钮 → 同时重拉 billing + usage', async () => {
    billingMock.mockResolvedValue({})
    usageMock.mockResolvedValue({ total: { totalTokens: 7 } })
    render(<UsageModal />)
    await screen.findByText('7')
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      expect(billingMock).toHaveBeenCalledTimes(2)
      expect(usageMock).toHaveBeenCalledTimes(2)
    })
  })

  it('Esc → close；背景点击 → close', async () => {
    billingMock.mockResolvedValue({})
    usageMock.mockResolvedValue({ total: { totalTokens: 7 } })
    render(<UsageModal />)
    await screen.findByText('7')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useChatStore.getState().closeUsage).toHaveBeenCalledTimes(1)

    const dialog = screen.getByRole('dialog', { name: 'usage' })
    fireEvent.mouseDown(dialog)
    expect(useChatStore.getState().closeUsage).toHaveBeenCalledTimes(2)
  })
})