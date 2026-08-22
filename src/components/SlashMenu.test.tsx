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
    expect(screen.getByText('/ 前缀触发 · 本地执行')).toBeInTheDocument()
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

  it('有匹配 → 常规操作提示', () => {
    render(
      <SlashMenu input="/co" selected={0} matches={matches()} onHover={noop} onPick={noop} />,
    )
    expect(screen.getByText('↑/↓ 选择 · Enter/Tab 执行 · Esc 关闭')).toBeInTheDocument()
  })

  it('无匹配且 query 非空 → 未知命令提示', () => {
    render(
      <SlashMenu input="/xyz foo" selected={0} matches={[]} onHover={noop} onPick={noop} />,
    )
    expect(screen.getByText(/未知命令 \/xyz/)).toBeInTheDocument()
  })

  it('纯“/”（query 为空）→ 不显示未知命令', () => {
    render(
      <SlashMenu input="/" selected={0} matches={[]} onHover={noop} onPick={noop} />,
    )
    expect(screen.getByText('↑/↓ 选择 · Enter/Tab 执行 · Esc 关闭')).toBeInTheDocument()
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