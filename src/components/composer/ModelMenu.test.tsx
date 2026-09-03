import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ModelMenu, formatEffortLabel } from './ModelMenu'
import type { useModelMenu } from './useModelMenu'
import type { ModelOption } from '../../api/types'

const sampleModels: ModelOption[] = [
  {
    modelId: 'grok-4',
    name: 'Grok 4',
    reasoningEfforts: [
      { id: 'low', label: 'Low Effort', value: 'low' },
      { id: 'high', label: 'High Effort', value: 'high', default: true },
    ],
  },
  {
    modelId: 'deepseek-chat',
    name: 'DeepSeek Chat',
  },
]

describe('ModelMenu', () => {
  const switchModel = vi.fn()
  const setSetAsDefault = vi.fn()
  const mockMenu = {
    reasoningEffort: 'high',
    setAsDefault: false,
    setSetAsDefault,
    switchModel,
    effortActive: (opt: { id: string; value: string }) => opt.value === 'high',
    modelActive: (m: ModelOption) => m.modelId === 'grok-4',
    modelOpen: true,
    setModelOpen: vi.fn(),
    modelRef: { current: null },
    modelBtnRef: { current: null },
    modelMenuPos: { bottom: 40, right: 20, maxH: 320, width: 280 },
  } as unknown as ReturnType<typeof useModelMenu>

  it('具有独立的列表可滚动区（overflow-y-auto），外层保持 flex-col 与 gn-modal-panel', () => {
    const { container } = render(
      <ModelMenu
        models={sampleModels}
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    // 外层面板
    const panel = container.firstElementChild as HTMLElement
    expect(panel).toHaveClass('gn-modal-panel', 'flex', 'flex-col')
    expect(panel.style.maxHeight).toBe('320px')

    // 内部滚动列表
    const scrollArea = panel.querySelector('.overflow-y-auto')
    expect(scrollArea).toBeInTheDocument()
    expect(scrollArea).toHaveClass('min-h-0', 'flex-1')

    // 列表项渲染在滚动区内
    expect(scrollArea).toHaveTextContent('Grok 4')
    expect(scrollArea).toHaveTextContent('DeepSeek Chat')
  })

  it('点击模型触发 switchModel，带默认或当前 effort', () => {
    render(
      <ModelMenu
        models={sampleModels}
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    fireEvent.click(screen.getByText('DeepSeek Chat'))
    expect(switchModel).toHaveBeenCalledWith('deepseek-chat', undefined)
  })

  it('点击 effort chip 切换到指定推理强度', () => {
    render(
      <ModelMenu
        models={sampleModels}
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    fireEvent.click(screen.getByText('low'))
    expect(switchModel).toHaveBeenCalledWith('grok-4', 'low')
  })

  it('effort chips 具备边框且无底色，选中与未选中状态以边框和文字颜色区分', () => {
    render(
      <ModelMenu
        models={sampleModels}
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    // grok-4 的 high effort 处于选中态（on=true）：带品红边框与文字，无底色
    const highEffortBtn = screen.getByText('high')
    expect(highEffortBtn).toHaveClass('border', 'border-gn-magenta', 'text-gn-magenta')
    expect(highEffortBtn.className).not.toContain('bg-')

    // grok-4 的 low effort 处于未选中态（on=false）：仅带基础边框，无底色
    const lowEffortBtn = screen.getByText('low')
    expect(lowEffortBtn).toHaveClass('border', 'border-gn-prompt-border/60', 'text-gn-muted')
    expect(lowEffortBtn.className).not.toContain('bg-')
  })

  it('formatEffortLabel 过滤长字符，命中子串时收敛为 low/medium/high/xhigh/max/minimal', () => {
    expect(formatEffortLabel({ id: 'xhigh', label: 'Extra High Effort', value: 'xhigh' })).toBe('xhigh')
    expect(formatEffortLabel({ id: 'high', label: 'High Effort', value: 'high' })).toBe('high')
    expect(formatEffortLabel({ id: 'medium', label: 'Medium Effort', value: 'medium' })).toBe('medium')
    expect(formatEffortLabel({ id: 'low', label: 'Low Effort', value: 'low' })).toBe('low')
    expect(formatEffortLabel({ id: 'max', label: 'Max', value: 'max' })).toBe('max')
    expect(formatEffortLabel({ id: 'minimal', label: 'Minimal', value: 'minimal' })).toBe('minimal')
    expect(formatEffortLabel({ id: 'none', label: 'none', value: 'none' })).toBe('none')
  })

  it('efforts 严格按语义权重从小到大排序展示', () => {
    const mixedModel: ModelOption = {
      modelId: 'test-model',
      name: 'Test Model',
      reasoningEfforts: [
        { id: 'xhigh', label: 'Extra High Effort', value: 'xhigh' },
        { id: 'none', label: 'none', value: 'none' },
        { id: 'max', label: 'Max', value: 'max' },
        { id: 'low', label: 'Low Effort', value: 'low' },
        { id: 'high', label: 'High Effort', value: 'high' },
        { id: 'minimal', label: 'minimal', value: 'minimal' },
        { id: 'medium', label: 'Medium Effort', value: 'medium' },
      ],
    }

    render(
      <ModelMenu
        models={[mixedModel]}
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    const buttons = screen.getAllByRole('button').filter((b) =>
      ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(b.textContent || ''),
    )
    const labels = buttons.map((b) => b.textContent)
    expect(labels).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('勾选设为默认模型复选框', () => {
    render(
      <ModelMenu
        models={sampleModels}
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    const checkbox = screen.getByRole('checkbox', { name: /设为默认模型/ })
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)
    expect(setSetAsDefault).toHaveBeenCalledWith(true)
  })
})
