import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SlashMenu } from './SlashMenu'
import type { SlashCommand, SlashMatch } from '../commands/registry'

const cmdA: SlashCommand = {
  name: 'context',
  description: '查看上下文使用情况',
  argHint: 'N?',
  run: vi.fn(),
}
const cmdB: SlashCommand = {
  name: 'agentcmd',
  description: 'agent 提供的命令',
  source: 'agent',
  aliases: ['ac'],
  run: vi.fn(),
}

function matches(): SlashMatch[] {
  return [
    { cmd: cmdA, score: 0 },
    { cmd: cmdB, score: 2 },
  ]
}

// jsdom 没有 scrollIntoView —— 选中行滚动由组件 effect 调用。
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterAll(() => {
  // @ts-expect-error 恢复原型
  delete Element.prototype.scrollIntoView
})

describe('SlashMenu', () => {
  const noop = vi.fn()

  it('渲染命令行：名称/别名/参数提示/描述/agent 标记', () => {
    render(
      <SlashMenu input="/co" selected={0} matches={matches()} onHover={noop} onPick={noop} />,
    )
    expect(screen.getByText('/context')).toBeInTheDocument()
    expect(screen.getByText('/agentcmd')).toBeInTheDocument()
    expect(screen.getByText('/ac')).toBeInTheDocument()
    expect(screen.getByText('N?')).toBeInTheDocument()
    expect(screen.getByText('查看上下文使用情况')).toBeInTheDocument()
    expect(screen.getByText('[agent]')).toBeInTheDocument()
    // 表头右侧是 `位置/总数`（不再单报总数），页脚只留键盘提示
    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(screen.queryByText(/条匹配/)).not.toBeInTheDocument()
    expect(screen.queryByText('/ 前缀触发')).not.toBeInTheDocument()
  })

  it('选中行带 data-sel="1" 并触发 onHover', () => {
    const onHover = vi.fn()
    render(
      <SlashMenu input="/co" selected={1} matches={matches()} onHover={onHover} onPick={noop} />,
    )
    const rows = screen.getAllByRole('button')
    expect(rows[0].dataset.sel).toBe('0')
    expect(rows[1].dataset.sel).toBe('1')
    fireEvent.mouseEnter(rows[0])
    expect(onHover).toHaveBeenCalledWith(0)
  })

  it('点击行 → onPick 该命令；selected 变化时滚动到选中行', () => {
    const onPick = vi.fn()
    const { rerender } = render(
      <SlashMenu input="/co" selected={0} matches={matches()} onHover={noop} onPick={onPick} />,
    )
    fireEvent.click(screen.getByText('/context'))
    expect(onPick).toHaveBeenCalledWith(cmdA)

    rerender(
      <SlashMenu input="/co" selected={1} matches={matches()} onHover={noop} onPick={onPick} />,
    )
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('有匹配 → 操作提示 + 位置计数，转义写法在 title 里', () => {
    render(
      <SlashMenu input="/co" selected={1} matches={matches()} onHover={noop} onPick={noop} />,
    )
    const hint = screen.getByText(/↑\/↓ 选择 · Enter\/Tab 执行 · Esc 关闭/)
    expect(hint).toBeInTheDocument()
    expect(hint.getAttribute('title')).toContain(String.raw`\/`)
    expect(hint.getAttribute('title')).toContain('空格')
    expect(screen.getByText('2/2')).toBeInTheDocument()
  })

  it('无匹配 → 页脚说明 Enter 按原文发送（不再是错误）', () => {
    render(
      <SlashMenu input="/xyz foo" selected={0} matches={[]} onHover={noop} onPick={noop} />,
    )
    expect(screen.getByText(/Enter 按原文发送 \/xyz/)).toBeInTheDocument()
    expect(screen.getByText('没有匹配的命令')).toBeInTheDocument()
    expect(screen.queryByText(/未知命令/)).not.toBeInTheDocument()
  })

  it('首词撞上命令 → 页脚「作为原文发送」把草稿交给外层转义', () => {
    const onLiteral = vi.fn()
    render(
      <SlashMenu
        input="/co"
        selected={0}
        matches={matches()}
        onHover={noop}
        onPick={noop}
        onLiteral={onLiteral}
      />,
    )
    fireEvent.click(screen.getByText('作为原文发送'))
    expect(onLiteral).toHaveBeenCalled()
  })

  it('纯 `/`、无匹配、未传 onLiteral 三种情况都不渲染「作为原文发送」', () => {
    const onLiteral = vi.fn()
    const { rerender } = render(
      <SlashMenu
        input="/"
        selected={0}
        matches={matches()}
        onHover={noop}
        onPick={noop}
        onLiteral={onLiteral}
      />,
    )
    expect(screen.queryByText('作为原文发送')).not.toBeInTheDocument()
    rerender(
      <SlashMenu
        input="/xyz"
        selected={0}
        matches={[]}
        onHover={noop}
        onPick={noop}
        onLiteral={onLiteral}
      />,
    )
    expect(screen.queryByText('作为原文发送')).not.toBeInTheDocument()
    rerender(
      <SlashMenu input="/co" selected={0} matches={matches()} onHover={noop} onPick={noop} />,
    )
    expect(screen.queryByText('作为原文发送')).not.toBeInTheDocument()
  })

  it('选中行：选区底色 + 命令名加粗 + 行尾 ↵，未选中行三者皆无', () => {
    render(
      <SlashMenu input="/co" selected={0} matches={matches()} onHover={noop} onPick={noop} />,
    )
    const rows = screen.getAllByRole('button')
    const sel = rows.find((r) => r.dataset.sel === '1')!
    const unsel = rows.find((r) => r.dataset.sel === '0')!
    expect(sel.className).toContain('gn-menu-sel')
    expect(unsel.className).not.toContain('gn-menu-sel')
    // ↵ 只出现在选中行（"这行就是 Enter 要执行的"）。
    expect(sel.textContent).toContain('↵')
    expect(unsel.textContent).not.toContain('↵')
    // 命令名只有选中行加粗（去掉指针列与竖栏后最主要的区分手段）。
    const name = (r: HTMLElement) => r.querySelector('span')!
    expect(name(sel).className).toContain('font-semibold')
    expect(name(unsel).className).not.toContain('font-semibold')
  })

  it('纯“/”（query 为空）→ 不显示未知命令', () => {
    render(
      <SlashMenu input="/" selected={0} matches={[]} onHover={noop} onPick={noop} />,
    )
    expect(screen.getByText(/↑\/↓ 选择 · Enter\/Tab 执行 · Esc 关闭/)).toBeInTheDocument()
    expect(screen.getByText('/ 前缀触发')).toBeInTheDocument()
  })

  it('无别名/参数提示的命令只渲染名称与描述', () => {
    const plain: SlashCommand = { name: 'plan', description: '计划模式', run: vi.fn() }
    render(
      <SlashMenu input="/plan" selected={0} matches={[{ cmd: plain, score: 0 }]} onHover={noop} onPick={noop} />,
    )
    const row = screen.getByText('/plan')
    expect(row).toBeInTheDocument()
    expect(screen.getByText('计划模式')).toBeInTheDocument()
  })
})