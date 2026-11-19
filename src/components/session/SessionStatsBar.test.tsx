import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent, screen } from '@testing-library/react'
import { useChatStore } from '../../store/chat'
import { SessionStatsBar } from './SessionStatsBar'

beforeEach(() => {
  useChatStore.setState({
    sessionStats: undefined,
    sessionId: undefined,
    cwd: undefined,
    conn: 'ready',
    turnStartedAt: undefined,
    openThoughtId: undefined,
    refreshSessionStats: vi.fn(),
  })
})

function setStats(stats: Partial<NonNullable<ReturnType<typeof useChatStore.getState>['sessionStats']>>) {
  useChatStore.setState({
    sessionStats: {
      turns: 0,
      steps: 0,
      llmDurationMs: 0,
      cacheHitRate: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedReadTokens: 0,
      modelCalls: 0,
      ...stats,
    },
  })
}

describe('SessionStatsBar', () => {
  it('无 stats → 仅保底间距占位', () => {
    const { container } = render(<SessionStatsBar />)
    expect(container.firstChild).toHaveClass('pb-4')
    expect(container.textContent).toBe('')
  })

  it('全零 stats → 同样不渲染内容', () => {
    setStats({})
    const { container } = render(<SessionStatsBar />)
    expect(container.firstChild).toHaveClass('pb-4')
    expect(container.textContent).toBe('')
  })

  it('完整 stats → 各分段展示', () => {
    setStats({
      turns: 3,
      steps: 5,
      llmDurationMs: 183000,
      toolDurationMs: 121000,
      firstTokenAvgMs: 3000,
      tokensPerSec: 5711.3,
      cacheHitRate: 0.98,
      inputTokens: 1_700_000,
      outputTokens: 24_000,
    })
    const { container } = render(<SessionStatsBar />)
    expect(container.textContent).toContain('3 轮 5 步')
    expect(container.textContent).toContain('LLM 3m3s 工具调用 2m1s')
    expect(container.textContent).toContain('首 token 平均 3 s · 5.7K tok/s')
    expect(container.textContent).toContain('缓存命中 98 %')
    expect(container.textContent).toContain('输入 1.7M tok · 输出 24K tok')
  })

  it('耗时/吞吐缺失 → 对应分段隐藏', () => {
    setStats({ turns: 1, steps: 2, inputTokens: 100, outputTokens: 200 })
    const { container } = render(<SessionStatsBar />)
    const text = container.textContent ?? ''
    expect(text).toContain('1 轮 2 步')
    expect(text).toContain('输入 100 tok · 输出 200 tok')
    expect(text).not.toContain('LLM')
    expect(text).not.toContain('首 token')
    expect(text).not.toContain('缓存命中')
  })

  it('tok/s 阈值：<1000 用整数，≥1000 用一位小数 K', () => {
    setStats({ turns: 1, steps: 1, tokensPerSec: 500 })
    const { container } = render(<SessionStatsBar />)
    expect(container.textContent).toContain('500 tok/s')

    setStats({ turns: 1, steps: 1, tokensPerSec: 1500 })
    const { container: c2 } = render(<SessionStatsBar />)
    expect(c2.textContent).toContain('1.5K tok/s')
  })

  it('仅轮/步有数（其他全缺）→ 单段也渲染', () => {
    setStats({ turns: 2, steps: 1 })
    const { container } = render(<SessionStatsBar />)
    const text = container.textContent ?? ''
    expect(text).toContain('2 轮 1 步')
    expect(text).not.toContain('|')
  })

  it('移动端摘要 chip：点击展开会话统计明细，再点收起', () => {
    setStats({
      turns: 3,
      steps: 5,
      llmDurationMs: 183000,
      toolDurationMs: 121000,
      firstTokenAvgMs: 3000,
      tokensPerSec: 5711.3,
    })
    render(<SessionStatsBar />)
    const chip = screen.getByRole('button', { name: /会话统计：3 轮 5 步 · 5\.7K tok\/s/ })
    expect(chip).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('模型用时')).toBeInTheDocument()
    expect(screen.getByText('工具调用用时')).toBeInTheDocument()
    expect(screen.getByText('首 token 平均（TTFT）')).toBeInTheDocument()
    expect(screen.getByText('输出速度（TPS）')).toBeInTheDocument()

    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('模型用时')).not.toBeInTheDocument()
  })

  it('移动端 Token chip：汇总为总量 + 命中率，明细拆出未缓存输入', () => {
    setStats({
      turns: 2,
      steps: 15,
      cacheHitRate: 0.75,
      inputTokens: 673_000,
      cachedReadTokens: 507_904,
      outputTokens: 76_810,
      totalTokens: 749_771,
    })
    render(<SessionStatsBar />)
    const chip = screen.getByRole('button', { name: /Token 用量：750K tok · 缓存命中 75%/ })
    fireEvent.click(chip)

    expect(screen.getByText('749,771 tok')).toBeInTheDocument()
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('165,096 tok')).toBeInTheDocument() // 673,000 − 507,904
    expect(screen.getByText('507,904 tok')).toBeInTheDocument()
    expect(screen.getByText('76,810 tok')).toBeInTheDocument()
  })

  it('移动端 chip 按可用指标降级：无 token 不出 Token chip，无命中率不显示缓存段', () => {
    setStats({ turns: 2, steps: 1 })
    const first = render(<SessionStatsBar />)
    expect(screen.getByRole('button', { name: /会话统计：2 轮 1 步/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Token 用量/ })).not.toBeInTheDocument()
    first.unmount()

    setStats({ turns: 1, steps: 2, inputTokens: 100, outputTokens: 200, totalTokens: 300 })
    render(<SessionStatsBar />)
    expect(screen.getByRole('button', { name: /Token 用量：300 tok/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /缓存命中/ })).not.toBeInTheDocument()
  })

  it('挂载 + 会话锚点变化时拉取统计', () => {
    const { unmount } = render(<SessionStatsBar />)
    expect(useChatStore.getState().refreshSessionStats).toHaveBeenCalledTimes(1)

    // sessionId 变化 → 再次拉取
    act(() => useChatStore.setState({ sessionId: 's1', cwd: '/a' }))
    expect(useChatStore.getState().refreshSessionStats).toHaveBeenCalledTimes(2)
    // 同锚点无变化 → 不重复
    act(() => useChatStore.setState({ sessionId: 's1', cwd: '/a' }))
    expect(useChatStore.getState().refreshSessionStats).toHaveBeenCalledTimes(2)
    // cwd 变化 → 拉取
    act(() => useChatStore.setState({ cwd: '/b' }))
    expect(useChatStore.getState().refreshSessionStats).toHaveBeenCalledTimes(3)
    unmount()
  })
})

describe('回合进行中的刷新', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('回合 live 时按周期拉取，回合结束后停止', async () => {
    useChatStore.setState({
      sessionId: 's1',
      cwd: '/a',
      conn: 'busy',
      turnStartedAt: 1000,
    })
    const refresh = useChatStore.getState().refreshSessionStats
    render(<SessionStatsBar />)
    // 挂载时的锚点兜底拉取。
    expect(refresh).toHaveBeenCalledTimes(1)

    // 首拍 3s，之后每 5s 一拍。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(refresh).toHaveBeenCalledTimes(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(refresh).toHaveBeenCalledTimes(3)

    // 回合收口 → 轮询解除，不再请求。
    act(() => useChatStore.setState({ conn: 'ready', turnStartedAt: undefined }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('上一发未返回时不叠加下一发', async () => {
    let release!: () => void
    const pending = new Promise<void>((r) => {
      release = r
    })
    const refresh = vi.fn(() => pending)
    useChatStore.setState({
      sessionId: 's1',
      cwd: '/a',
      conn: 'busy',
      turnStartedAt: 1000,
      refreshSessionStats: refresh,
    })
    render(<SessionStatsBar />)
    expect(refresh).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(refresh).toHaveBeenCalledTimes(2)
    // 请求挂住时定时器不再排下一拍。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(refresh).toHaveBeenCalledTimes(2)
    await act(async () => {
      release()
    })
  })

  it('标签页隐藏时跳过请求，回到前台立即补一拍', async () => {
    let visibility: DocumentVisibilityState = 'hidden'
    const own = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })
    try {
      useChatStore.setState({
        sessionId: 's1',
        cwd: '/a',
        conn: 'busy',
        turnStartedAt: 1000,
      })
      const refresh = useChatStore.getState().refreshSessionStats
      render(<SessionStatsBar />)
      expect(refresh).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000)
      })
      expect(refresh).toHaveBeenCalledTimes(1)

      visibility = 'visible'
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(refresh).toHaveBeenCalledTimes(2)
    } finally {
      if (own) Object.defineProperty(document, 'visibilityState', own)
      else delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState
    }
  })
})
