import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FilePickerMenu } from './FilePickerMenu'
import type { FileSearchMatch } from '../store/chat'

const matches: FileSearchMatch[] = [
  { path: 'src/components/SlashMenu.tsx' },
  { path: 'src/components/Composer.tsx' },
] as FileSearchMatch[]

// jsdom 没有 scrollIntoView —— 选中行滚动由组件 effect 调用。
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterAll(() => {
  // @ts-expect-error 恢复原型
  delete Element.prototype.scrollIntoView
})

describe('FilePickerMenu', () => {
  const noop = vi.fn()

  it('选中行与斜杠菜单共用行样式（选区底色 + 文字提亮）', () => {
    render(
      <FilePickerMenu
        query="slash"
        matches={matches}
        done
        selected={1}
        onHover={noop}
        onPick={noop}
      />,
    )
    const rows = screen.getAllByRole('button')
    expect(rows[0].dataset.sel).toBe('0')
    expect(rows[1].dataset.sel).toBe('1')
    expect(rows[1].className).toContain('gn-menu-sel')
    expect(rows[0].className).not.toContain('gn-menu-sel')
    const path = (r: HTMLElement) => r.querySelector('span')!
    expect(path(rows[1]).className).toContain('text-gn-fg')
    expect(path(rows[0]).className).toContain('text-gn-fg2')
  })

  it('页脚给出位置计数，hover/点击仍走原回调', () => {
    const onHover = vi.fn()
    const onPick = vi.fn()
    render(
      <FilePickerMenu
        query="slash"
        matches={matches}
        done
        total={40}
        selected={0}
        onHover={onHover}
        onPick={onPick}
      />,
    )
    // 计数只在表头右侧：位置/返回数，服务端还有更多时带上总数
    expect(screen.getByText('1/2 共 40')).toBeInTheDocument()
    expect(screen.queryByText(/个匹配/)).not.toBeInTheDocument()
    expect(screen.queryByText('@ 前缀触发')).not.toBeInTheDocument()
    const rows = screen.getAllByRole('button')
    fireEvent.mouseEnter(rows[1])
    expect(onHover).toHaveBeenCalledWith(1)
    fireEvent.click(rows[1])
    expect(onPick).toHaveBeenCalledWith('src/components/Composer.tsx')
  })

  it('空查询 → 输入以过滤提示，无位置计数', () => {
    render(
      <FilePickerMenu
        query=""
        matches={[]}
        done
        selected={0}
        onHover={noop}
        onPick={noop}
      />,
    )
    expect(screen.getByText('输入以过滤文件（相对工作目录路径）')).toBeInTheDocument()
    expect(screen.queryByText(/\/\s*\d+$/)).not.toBeInTheDocument()
  })
})
