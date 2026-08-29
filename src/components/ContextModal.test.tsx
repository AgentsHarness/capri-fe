import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { transport } from '../api/client'
import { useChatStore } from '../store/chat'
import { ContextModal } from './ContextModal'

vi.mock('../api/client', () => ({
  transport: {
    sessionInfoExt: vi.fn(),
    onEvent: vi.fn(),
  },
}))

const extMock = vi.mocked(transport.sessionInfoExt)

beforeEach(() => {
  useChatStore.setState({
    contextOpen: true,
    closeContext: vi.fn(),
  })
  extMock.mockReset()
})

describe('ContextModal', () => {
  it('未打开 → 不渲染', () => {
    useChatStore.setState({ contextOpen: false })
    const { container } = render(<ContextModal />)
    expect(container.firstChild).toBeNull()
  })

  it('加载中 → 加载提示', () => {
    extMock.mockReturnValue(new Promise(() => {}))
    render(<ContextModal />)
    expect(screen.getByText('加载中…')).toBeInTheDocument()
  })

  it('完整数据 → 总量/模型/分段条/图例行/auto-compact', async () => {
    extMock.mockResolvedValue({
      sessionId: 's1',
      cwd: '/tmp',
      model: 'grok',
      modelDisplayName: 'super grok',
      context: {
        used: 60_000,
        total: 100_000,
        systemPromptTokens: 10_000,
        messageTokens: 40_000,
        toolDefinitionsCount: 5,
        toolDefinitionsTokens: 2_000,
        compactionCount: 2,
        turnCount: 2,
        toolCallCount: 3,
        messageCount: 2,
        freeTokens: 38_000,
        usagePct: 60,
        autoCompactThresholdPercent: 85,
        usageCategories: [
          { label: 'web', tokens: 1000, detail: 'x' },
          // 1.0.9+ agent 新增类别（usage_categories 的 AGENTS.md 行）：
          // FE 按通用行渲染，不依赖枚举。
          { label: 'AGENTS.md', tokens: 2000, detail: '1 file(s)' },
        ],
      },
    })
    render(<ContextModal />)
    await screen.findByText(/60K \/ 100K tokens \(60\.00%\)/)
    expect(screen.getByText(/super grok/)).toBeInTheDocument()
    expect(screen.getByText(/compacted ×2/)).toBeInTheDocument()
    expect(screen.getByText('System prompt')).toBeInTheDocument()
    expect(screen.getByText('Messages')).toBeInTheDocument()
    expect(screen.getByText('Reasoning & overhead')).toBeInTheDocument()
    expect(screen.getByText('Free')).toBeInTheDocument()
    // 图例行：System 10K · Messages 40K · overhead 10K · Free 38K
    expect(screen.getAllByText('10K tokens · 10.0%').length).toBe(2)
    expect(screen.getByText('40K tokens · 40.0%')).toBeInTheDocument()
    expect(screen.getByText('38K tokens · 38.0%')).toBeInTheDocument()
    // info 行：工具定义 detail
    expect(screen.getByText('5 tools')).toBeInTheDocument()
    expect(screen.getByText('web')).toBeInTheDocument()
    expect(screen.getByText('AGENTS.md')).toBeInTheDocument()
    // auto-compact 未触发
    expect(screen.getByText(/Auto-compact at 85% · ~25K tokens remaining/)).toBeInTheDocument()
  })

  it('usagePct ≥ 阈值 → triggered 文案', async () => {
    extMock.mockResolvedValue({
      context: {
        used: 90_000,
        total: 100_000,
        systemPromptTokens: 10_000,
        messageTokens: 40_000,
        freeTokens: 10_000,
        usagePct: 90,
        autoCompactThresholdPercent: 85,
      },
    })
    render(<ContextModal />)
    await screen.findByText(/Auto-compact triggers next turn \(at 85%\)/)
    // 超过总容量时 pct 夹到 100
    expect(screen.getByText(/\(90\.00%\)/)).toBeInTheDocument()
  })

  it('used > total → pct2 夹取到 100', async () => {
    extMock.mockResolvedValue({
      context: { used: 200_000, total: 100_000, usagePct: 0 },
    })
    render(<ContextModal />)
    await screen.findByText(/\(100\.00%\)/)
  })

  it('无 context 字段 → 暂无上下文明细', async () => {
    extMock.mockResolvedValue({ model: 'grok' })
    render(<ContextModal />)
    await screen.findByText('暂无上下文明细（会话未就绪或宿主未返回 context）')
  })

  it('返回数组等脏数据 → 防御性降级', async () => {
    extMock.mockResolvedValue([] as never)
    render(<ContextModal />)
    await screen.findByText('暂无上下文明细（会话未就绪或宿主未返回 context）')
  })

  it('请求失败 → 错误 + 重试成功', async () => {
    extMock.mockRejectedValueOnce(new Error('boom'))
    extMock.mockResolvedValueOnce({
      model: 'grok',
      context: { used: 10, total: 100, usagePct: 10 },
    })
    render(<ContextModal />)
    await screen.findByText('boom')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText(/10 \/ 100 tokens \(10\.00%\)/)
  })

  it('Esc → closeContext；背景点击 → closeContext', async () => {
    extMock.mockResolvedValue({})
    render(<ContextModal />)
    await waitFor(() => expect(extMock).toHaveBeenCalled())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useChatStore.getState().closeContext).toHaveBeenCalledTimes(1)

    const dialog = screen.getByRole('dialog', { name: 'context usage' })
    fireEvent.mouseDown(dialog)
    expect(useChatStore.getState().closeContext).toHaveBeenCalledTimes(2)
  })

  it('关闭后旧请求结果不落地（seq 守卫）', async () => {
    let resolveLater!: (v: unknown) => void
    extMock.mockReturnValue(new Promise((r) => (resolveLater = r)))
    const { unmount } = render(<ContextModal />)
    expect(extMock).toHaveBeenCalledTimes(1)
    unmount()
    // 重新打开发新请求
    extMock.mockResolvedValue({ model: 'grok' })
    const second = render(<ContextModal />)
    await waitFor(() => expect(extMock).toHaveBeenCalledTimes(2))
    // 旧请求迟到 → 丢弃
    resolveLater({ model: 'old', context: { used: 5, total: 100, usagePct: 5 } })
    await waitFor(() => {
      expect(second.queryByText('暂无上下文明细（会话未就绪或宿主未返回 context）')).toBeInTheDocument()
    })
  })

  it('锁定当前会话：sessionId 随请求带上（否则 host 填活动会话）', async () => {
    useChatStore.setState({ sessionId: 'sess-42' })
    extMock.mockResolvedValue({ model: 'grok' })
    render(<ContextModal />)
    await waitFor(() =>
      expect(extMock).toHaveBeenCalledWith({ sessionId: 'sess-42' }),
    )
  })

  it('footer 统计行：Turns · Tool calls · Compactions', async () => {
    extMock.mockResolvedValue({
      context: {
        used: 60_000,
        total: 100_000,
        usagePct: 60,
        turnCount: 5,
        toolCallCount: 12,
        compactionCount: 1,
      },
    })
    render(<ContextModal />)
    await screen.findByText(/Turns: 5 · Tool calls: 12 · Compactions: 1/)
  })

  it('usageCategories 非数组 → 忽略', async () => {
    extMock.mockResolvedValue({
      context: {
        used: 100,
        total: 1000,
        usageCategories: 'nope',
      } as never,
    })
    render(<ContextModal />)
    await screen.findByText(/100 \/ 1\.0K tokens \(10\.00%\)/)
  })
})