import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThemePicker, ThemeOptions } from './ThemePicker'
import { useThemeStore } from '../store/theme'

describe('ThemeOptions', () => {
  it('渲染全部主题选项；点击切换主题并回调 onSelect', () => {
    const onSelect = vi.fn()
    render(<ThemeOptions onSelect={onSelect} />)
    fireEvent.click(screen.getByText('Tokyo Night'))
    expect(useThemeStore.getState().preference).toBe('tokyonight')
    expect(onSelect).toHaveBeenCalledWith('tokyonight')
  })

  it('当前主题高亮标记', () => {
    useThemeStore.getState().setTheme('grokday')
    const { container } = render(<ThemeOptions />)
    expect(container.textContent).toContain('Grok Day ·')
  })
})

describe('ThemePicker', () => {
  it('默认显示当前主题名；点击展开；选择后收起', () => {
    useThemeStore.getState().setTheme('groknight')
    render(<ThemePicker />)
    expect(screen.getByText('Grok Night')).not.toBeNull()
    fireEvent.click(screen.getByTitle('Theme'))
    // 菜单打开后出现 theme 标题与选项
    expect(screen.getByText('Auto')).not.toBeNull()
    fireEvent.click(screen.getByText('Rose Pine Moon'))
    expect(useThemeStore.getState().preference).toBe('rosepine-moon')
    // 菜单已收起：选项不再可见（触发关闭的 backdrop 消失）
    expect(screen.queryByRole('button', { name: /close theme menu/i })).toBeNull()
  })
})