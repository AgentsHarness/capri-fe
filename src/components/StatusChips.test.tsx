import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ScrollEntry, ToolCall } from '../api/types'
import { useChatStore } from '../store/chat'
import { flushScheduledPageFills } from '../store/chat/historyFill'
import { LiteFillChip } from './StatusChips'
import { WorkspaceBar } from './TopBar'
import { SPINNER_FRAMES } from '../theme/glyphs'

vi.mock('../store/chat/historyFill', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../store/chat/historyFill')>()
  return { ...mod, flushScheduledPageFills: vi.fn() }
})

/**
 * TopBar 的 lite 补全进度图标：有 lite 行欠着正文才出现，补齐 / 非 lite 页
 * 一律不渲染；点在途转 spinner；点击催发排队中的补全。
 */
function liteRow(over: Partial<ScrollEntry> = {}): ScrollEntry {
  return {
    id: 't1',
    kind: 'tool',
    title: 'Execute `ls -la`',
    kindName: 'execute',
    verb: 'Ran',
    status: 'completed',
    expanded: true,
    toolCallId: 'tc-1',
    msgSeq: 1,
    msgSeqEnd: 2,
    liteOmitted: 4096,
    raw: {
      toolCallId: 'tc-1',
      kind: 'execute',
      status: 'completed',
      rawOutput: { Bash: { output: { omitted: 4096 } } },
      _meta: { lite: { omitted: 4096, fields: ['rawOutput.output'] } },
    } as unknown as ToolCall,
    ...over,
  } as ScrollEntry
}

beforeEach(() => {
  vi.clearAllMocks()
  useChatStore.setState({
    entries: [],
    historyProjected: undefined,
    liteFillBusy: undefined,
    sessionId: 's1',
    cwd: '/w',
  })
})

describe('LiteFillChip', () => {
  it('lite 页还有欠着正文的行 → 显示菱形 + 行数', () => {
    useChatStore.setState({ entries: [liteRow()], historyProjected: 'lite' })
    render(<LiteFillChip />)
    const btn = screen.getByRole('button', { name: /精简回放：1 行工具正文待补全/ })
    expect(btn.textContent).toContain('1')
    expect(btn.textContent).toContain('◇')
  })

  it('全部补齐 → 不渲染', () => {
    useChatStore.setState({
      entries: [liteRow({ liteState: 'filled', liteOmitted: undefined })],
      historyProjected: 'lite',
    })
    const { container } = render(<LiteFillChip />)
    expect(container).toBeEmptyDOMElement()
  })

  // 图标只看「有没有行欠着正文」，不看 historyProjected 那一页的回显：
  // 滚动区里几页并存时，那个旗标可能属于另一页（开关关后重进会话则压根
  // 没有 liteOmitted 的行，自然也不显示）。
  it('最新一页不是 lite 也算数：只要还有欠正文的行就显示', () => {
    useChatStore.setState({ entries: [liteRow()], historyProjected: undefined })
    render(<LiteFillChip />)
    expect(screen.getByRole('button', { name: /精简回放：1 行工具正文待补全/ })).toBeTruthy()
  })

  it('开关关掉后的重进（条目不带 lite 字段）→ 不渲染', () => {
    const plain = liteRow({ liteOmitted: undefined, raw: { toolCallId: 'tc-1', kind: 'execute', status: 'completed', rawOutput: { Bash: { output: 'total 8' } } } as unknown as ToolCall })
    useChatStore.setState({ entries: [plain], historyProjected: undefined })
    const { container } = render(<LiteFillChip />)
    expect(container).toBeEmptyDOMElement()
  })

  it('补全在途 → 图标转 braille spinner', () => {
    useChatStore.setState({ entries: [liteRow()], historyProjected: 'lite', liteFillBusy: 1 })
    render(<LiteFillChip />)
    const btn = screen.getByRole('button', { name: /精简回放：1 行工具正文待补全/ })
    const glyph = btn.querySelector('span')?.textContent ?? ''
    expect(SPINNER_FRAMES).toContain(glyph)
  })

  it('有失败行 → 叉号 + 警告色，点击照样催发排队', () => {
    useChatStore.setState({
      entries: [liteRow({ liteState: 'error' })],
      historyProjected: 'lite',
    })
    render(<LiteFillChip />)
    const btn = screen.getByRole('button', { name: /精简回放：1 行工具正文待补全/ })
    expect(btn.textContent).toContain('✗')
    fireEvent.click(btn)
    expect(vi.mocked(flushScheduledPageFills)).toHaveBeenCalledTimes(1)
  })

  it('目录跳转在飞 → 同一芯片显示「跳转 N/M」+ spinner，不抢占 ◇ 待补全', () => {
    useChatStore.setState({
      historyJumpProgress: { current: 2, total: 5 },
    })
    const { container } = render(<LiteFillChip />)
    const chip = screen.getByLabelText('跳转中：第 2/5 轮')
    expect(chip.textContent).toContain('跳转 2/5')
    const glyph = chip.querySelector('span')?.textContent ?? ''
    expect(SPINNER_FRAMES).toContain(glyph)
    expect(container.querySelector('button')).toBeNull()
  })

  it('跳转落地、仍有 lite 行 → 芯片回到 ◇N 待补全', () => {
    useChatStore.setState({
      historyJumpProgress: undefined,
      entries: [liteRow()],
      historyProjected: 'lite',
    })
    render(<LiteFillChip />)
    expect(screen.getByRole('button', { name: /精简回放：1 行工具正文待补全/ })).toBeTruthy()
  })
})

/**
 * 芯片单独渲染通过不代表它在真实芯片簇里（那一簇在 WorkspaceBar，由
 * Scrollback 挂上去）。挂整个 WorkspaceBar 断言位置。
 */
describe('LiteFillChip 在 WorkspaceBar 簇里的位置', () => {
  it('出现在 context chip 之前', () => {
    useChatStore.setState({
      entries: [liteRow()],
      historyProjected: 'lite',
      usage: { used: 12000, size: 200000 },
    })
    render(<WorkspaceBar />)
    const lite = screen.getByRole('button', { name: /精简回放：1 行工具正文待补全/ })
    const context = screen.getByRole('button', { name: /上下文 6% · 打开 \/context 明细/ })
    // 文档顺序：lite 在 context 之前。
    expect(
      !!(lite.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true)
  })

  it('补齐之后芯片簇里就没有它了', () => {
    useChatStore.setState({
      entries: [liteRow({ liteState: 'filled', liteOmitted: undefined })],
      historyProjected: 'lite',
      usage: { used: 12000, size: 200000 },
    })
    render(<WorkspaceBar />)
    expect(screen.queryByRole('button', { name: /精简回放/ })).toBeNull()
  })
})
