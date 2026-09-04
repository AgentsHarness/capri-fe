import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PromptHistoryMenu } from './PromptHistoryMenu'
import type { HistoryItem } from './promptHistory'

// 显示顺序与 TUI 一致：最旧在顶（index 0）、最新在底（最后一项）。
const items: HistoryItem[] = [
  { text: '/clear', ts: 1700000002000 },
  { text: 'ls -la', ts: 1700000001000, shell: true },
  { text: '解释一下这个仓库', ts: 1700000000000 },
]

// jsdom 没有 scrollIntoView —— 选中行滚动由组件 effect 调用。
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterAll(() => {
  // @ts-expect-error 恢复原型
  delete Element.prototype.scrollIntoView
})

describe('PromptHistoryMenu', () => {
  const noop = vi.fn()

  it('渲染历史行、表头与位置计数（位置/总数），shell 行带 ! 前缀', () => {
    render(
      <PromptHistoryMenu history={items} selected={0} onHover={noop} onPick={noop} />,
    )
    expect(screen.getByText('/clear')).toBeInTheDocument()
    expect(screen.getByText('ls -la')).toBeInTheDocument()
    expect(screen.getByText('解释一下这个仓库')).toBeInTheDocument()
    expect(screen.getByText('提示历史')).toBeInTheDocument()
    expect(screen.getByText('1/3')).toBeInTheDocument()
    // shell 历史行以 `! ` 前缀标识（cyan），普通行没有。
    const shellRow = screen.getByText('ls -la').closest('button')!
    const plainRow = screen.getByText('/clear').closest('button')!
    expect(shellRow.textContent).toContain('! ')
    expect(plainRow.textContent).not.toContain('!')
  })

  it('选中最新一条（底部行）时计数为 N/N', () => {
    render(
      <PromptHistoryMenu history={items} selected={2} onHover={noop} onPick={noop} />,
    )
    expect(screen.getByText('3/3')).toBeInTheDocument()
  })

  it('选中行带 data-sel="1" 并触发 onHover', () => {
    const onHover = vi.fn()
    render(
      <PromptHistoryMenu history={items} selected={1} onHover={onHover} onPick={noop} />,
    )
    const rows = screen.getAllByRole('button')
    expect(rows[1].dataset.sel).toBe('1')
    expect(rows[0].dataset.sel).toBe('0')
    fireEvent.mouseEnter(rows[0])
    expect(onHover).toHaveBeenCalledWith(0)
  })

  it('点击行 → onPick 该项；selected 变化时滚动到选中行', () => {
    const onPick = vi.fn()
    const { rerender } = render(
      <PromptHistoryMenu history={items} selected={0} onHover={noop} onPick={onPick} />,
    )
    fireEvent.click(screen.getByText('ls -la'))
    expect(onPick).toHaveBeenCalledWith(items[1])

    rerender(
      <PromptHistoryMenu history={items} selected={2} onHover={noop} onPick={onPick} />,
    )
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('选中行：选区底色 + 文字加粗 + 行尾 ↵，未选中行三者皆无', () => {
    render(
      <PromptHistoryMenu history={items} selected={0} onHover={noop} onPick={noop} />,
    )
    const rows = screen.getAllByRole('button')
    const sel = rows.find((r) => r.dataset.sel === '1')!
    const unsel = rows.find((r) => r.dataset.sel === '0')!
    expect(sel.className).toContain('gn-menu-sel')
    expect(unsel.className).not.toContain('gn-menu-sel')
    // ↵ 只出现在选中行（"这行就是 Enter 要填入的"）。
    expect(sel.textContent).toContain('↵')
    expect(unsel.textContent).not.toContain('↵')
    // 行文本只有选中行加粗。
    const selText = screen.getByText('/clear')
    const unselText = screen.getByText('ls -la')
    expect(selText.className).toContain('font-semibold')
    expect(unselText.className).not.toContain('font-semibold')
  })

  it('页脚不渲染冗余键盘提示行', () => {
    render(
      <PromptHistoryMenu history={items} selected={0} onHover={noop} onPick={noop} />,
    )
    expect(screen.queryByText(/↑\/↓ 选择/)).toBeNull()
  })
})
