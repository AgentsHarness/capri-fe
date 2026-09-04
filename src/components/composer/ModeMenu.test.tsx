import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ModeMenu } from './ModeMenu'
import type { useModeMenu } from './useModeMenu'

describe('ModeMenu', () => {
  const switchMode = vi.fn()
  const mockMenu = {
    modeOpen: true,
    setModeOpen: vi.fn(),
    modeRef: { current: null },
    modeBtnRef: { current: null },
    modeMenuPos: { bottom: 40, right: 20, maxH: 320, width: 260 },
    currentModeId: 'plan',
    currentModeLabel: 'plan',
    inPlan: true,
    switchMode,
  } as unknown as ReturnType<typeof useModeMenu>

  it('具有切换运行模式标题与 4 种纯文本模式选项（无图标）', () => {
    const { container } = render(
      <ModeMenu
        pos={{ bottom: 40, right: 20, maxH: 320, width: 260 }}
        menu={mockMenu}
      />,
    )

    const panel = container.firstElementChild as HTMLElement
    expect(panel).toHaveClass('gn-modal-panel', 'flex', 'flex-col')
    expect(panel.style.bottom).toBe('40px')
    expect(panel.style.right).toBe('20px')

    expect(screen.getByText('切换运行模式')).toBeInTheDocument()
    expect(screen.getByText('Normal')).toBeInTheDocument()
    expect(screen.getByText('Plan')).toBeInTheDocument()
    expect(screen.getByText('Auto')).toBeInTheDocument()
    expect(screen.getByText('Always-Approve')).toBeInTheDocument()

    // 确认无 svg / img 图标
    expect(container.querySelectorAll('svg')).toHaveLength(0)
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })

  it('高亮当前模式并显示生效中', () => {
    render(
      <ModeMenu
        pos={{ bottom: 40, right: 20, maxH: 320, width: 260 }}
        menu={mockMenu}
      />,
    )

    expect(screen.getByText('生效中')).toBeInTheDocument()
    const planButton = screen.getByText('Plan').closest('button')
    expect(planButton).toHaveClass('bg-gn-bg-highlight/60')
  })

  it('点击模式项触发 switchMode', () => {
    render(
      <ModeMenu
        pos={{ bottom: 40, right: 20, maxH: 320, width: 260 }}
        menu={mockMenu}
      />,
    )

    const normalBtn = screen.getByText('Normal').closest('button')!
    fireEvent.click(normalBtn)
    expect(switchMode).toHaveBeenCalledWith('normal')

    const autoBtn = screen.getByText('Auto').closest('button')!
    fireEvent.click(autoBtn)
    expect(switchMode).toHaveBeenCalledWith('auto')
  })
})
