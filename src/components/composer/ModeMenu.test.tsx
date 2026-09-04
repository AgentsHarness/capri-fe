import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ModeMenu } from './ModeMenu'
import type { useModeMenu } from './useModeMenu'

describe('ModeMenu', () => {
  const switchPerm = vi.fn()
  const togglePlan = vi.fn()
  const mockMenu = {
    modeOpen: true,
    setModeOpen: vi.fn(),
    modeRef: { current: null },
    modeBtnRef: { current: null },
    modeMenuPos: { bottom: 40, right: 20, maxH: 320, width: 280 },
    currentPermId: 'normal',
    currentPermLabel: 'normal',
    currentModeLabel: 'plan',
    inPlan: true,
    switchPerm,
    togglePlan,
  } as unknown as ReturnType<typeof useModeMenu>

  it('具有 MODE 与 PERMISSION 分组标题，且列表项结构与样式完全统一（无图标）', () => {
    const { container } = render(
      <ModeMenu
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    const panel = container.firstElementChild as HTMLElement
    expect(panel).toHaveClass('gn-modal-panel', 'flex', 'flex-col')
    expect(panel.style.bottom).toBe('40px')
    expect(panel.style.right).toBe('20px')

    expect(screen.getByText('MODE')).toBeInTheDocument()
    expect(screen.getByText('Plan')).toBeInTheDocument()
    expect(screen.getByText('PERMISSION')).toBeInTheDocument()
    expect(screen.getByText('Normal')).toBeInTheDocument()
    expect(screen.getByText('Auto')).toBeInTheDocument()
    expect(screen.getByText('Always-Approve')).toBeInTheDocument()

    // 确认无 svg / img 图标
    expect(container.querySelectorAll('svg')).toHaveLength(0)
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })

  it('点击 Plan 开关行触发 togglePlan', () => {
    render(
      <ModeMenu
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    const planBtn = screen.getByText('Plan').closest('button')!
    fireEvent.click(planBtn)
    expect(togglePlan).toHaveBeenCalledTimes(1)
  })

  it('高亮生效中的模式与权限，点击其他权限触发 switchPerm', () => {
    render(
      <ModeMenu
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    // Plan 和 Normal 均显示「生效中」
    const activeMarks = screen.getAllByText('生效中')
    expect(activeMarks.length).toBeGreaterThanOrEqual(1)

    const normalBtn = screen.getByText('Normal').closest('button')
    expect(normalBtn).toHaveClass('bg-gn-bg-highlight/60')

    const planBtn = screen.getByText('Plan').closest('button')
    expect(planBtn).toHaveClass('bg-gn-bg-highlight/60')

    const autoBtn = screen.getByText('Auto').closest('button')!
    fireEvent.click(autoBtn)
    expect(switchPerm).toHaveBeenCalledWith('auto')
  })
})
