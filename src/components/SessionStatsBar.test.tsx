import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useChatStore } from '../store/chat'
import { SessionStatsBar } from './SessionStatsBar'

beforeEach(() => {
  useChatStore.setState({
    sessionStats: undefined,
    sessionId: undefined,
    cwd: undefined,
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