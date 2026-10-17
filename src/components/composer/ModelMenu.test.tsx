import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    // 多窗口菜单：模型自己声明的可选窗口（agent 只声明时才发这个键）。
    contextWindow: 256000,
    contextWindows: [256000, 500000],
    contextWindowSelection: 500000,
  },
  {
    modelId: 'deepseek-chat',
    name: 'DeepSeek Chat',
  },
]

/**
 * 累积点击用的一组模型：非选中行有两类要挑（档位 + 窗口），以及一行什么都
 * 不用挑。单独一份，避免与 sampleModels 的同名 chip（low/256k）撞在一起
 * 让 getByRole 命中多个元素。
 */
const accumulateModels: ModelOption[] = [
  {
    modelId: 'grok-4',
    name: 'Grok 4',
    reasoningEfforts: [
      { id: 'low', label: 'low', value: 'low' },
      { id: 'high', label: 'high', value: 'high', default: true },
    ],
    contextWindow: 256000,
    contextWindows: [256000, 500000],
    contextWindowSelection: 500000,
  },
  {
    modelId: 'gemini-3',
    name: 'Gemini 3',
    reasoningEfforts: [
      { id: 'med', label: 'med', value: 'med', default: true },
      { id: 'ultra', label: 'ultra', value: 'ultra' },
    ],
    contextWindow: 1000000,
    contextWindows: [400000, 1000000],
  },
  {
    modelId: 'plain',
    name: 'Plain Model',
  },
]

describe('ModelMenu', () => {
  const switchModel = vi.fn()
  const pickOption = vi.fn()
  const setSetAsDefault = vi.fn()
  const mockMenu = {
    reasoningEffort: 'high',
    setAsDefault: false,
    setSetAsDefault,
    switchModel,
    pickOption,
    draftEffort: () => undefined,
    draftWindow: () => undefined,
    effortActive: (opt: { id: string; value: string }) => opt.value === 'high',
    modelActive: (m: ModelOption) => m.modelId === 'grok-4',
    modelOpen: true,
    setModelOpen: vi.fn(),
    modelRef: { current: null },
    modelBtnRef: { current: null },
    modelMenuPos: { bottom: 40, right: 20, maxH: 320, width: 280 },
  } as unknown as ReturnType<typeof useModelMenu>

  beforeEach(() => {
    switchModel.mockClear()
    pickOption.mockClear()
    setSetAsDefault.mockClear()
  })

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

  it('点击模型行触发 switchModel，带默认或当前 effort，不指定窗口', () => {
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

  it('点击 effort chip 切换到指定推理强度（不带窗口，沿用会话选择）', () => {
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

  it('formatEffortLabel 在 value/id 是标准档位词时优先于错位 label', () => {
    // config.toml 曾写出 label=medium/value=high 的错位条目：显示必须跟随 value
    expect(formatEffortLabel({ id: 'high', label: 'medium', value: 'high' })).toBe('high')
    expect(formatEffortLabel({ id: 'max', label: 'high', value: 'max' })).toBe('max')
    // value 归一化（去连字符）后是标准词时同样优先（x-high → xhigh，id=high 不是标准匹配目标）
    expect(formatEffortLabel({ id: 'high', label: 'X-High', value: 'x-high' })).toBe('xhigh')
    // value/id 都不是标准词时才回落到 label 子串匹配
    expect(formatEffortLabel({ id: 'tier1', label: 'High Effort', value: 'tier1' })).toBe('high')
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

  it('只渲染目录为该模型声明的窗口 chips（不写死尺寸）', () => {
    render(
      <ModelMenu
        models={sampleModels}
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    // grok-4 声明 [256000, 500000]：只出这两颗，绝不出现本地预设
    // （1000k 从没被这个模型声明过，点它会被 agent 整次拒收）。
    expect(screen.getByRole('button', { name: '256k' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '500k' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '1000k' })).not.toBeInTheDocument()
    // deepseek-chat 没有 contextWindows → 它的行不出窗口 chips。
    expect(screen.queryByText('默认')).not.toBeInTheDocument()
  })

  it('点某一行自己的窗口 chip → switchModel 带该窗口', () => {
    render(
      <ModelMenu
        models={sampleModels}
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '256k' }))
    expect(switchModel).toHaveBeenCalledWith('grok-4', 'high', 256000)
  })

  it('非选中模型：点一个类别不切换，走 pickOption 累积', () => {
    render(
      <ModelMenu
        models={accumulateModels}
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    // Gemini 3 有档位 + 窗口两类 → categories=2。
    fireEvent.click(screen.getByRole('button', { name: 'ultra' }))
    expect(switchModel).not.toHaveBeenCalled()
    expect(pickOption).toHaveBeenCalledWith('gemini-3', 2, { effort: 'ultra' }, 'med')

    pickOption.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '1m' }))
    expect(switchModel).not.toHaveBeenCalled()
    expect(pickOption).toHaveBeenCalledWith('gemini-3', 2, { window: 1000000 }, 'med')
  })

  it('非选中模型：点名字在有类别要挑时不提交', () => {
    render(
      <ModelMenu
        models={accumulateModels}
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    fireEvent.click(screen.getByText('Gemini 3'))
    expect(switchModel).not.toHaveBeenCalled()
  })

  it('非选中且无类别可挑的模型：点名字直接切换', () => {
    render(
      <ModelMenu
        models={accumulateModels}
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    fireEvent.click(screen.getByText('Plain Model'))
    expect(switchModel).toHaveBeenCalledWith('plain', undefined)
  })

  it('选中模型：点 chip 仍立即切换（不累积）', () => {
    render(
      <ModelMenu
        models={accumulateModels}
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'low' }))
    expect(switchModel).toHaveBeenCalledWith('grok-4', 'low')
    expect(pickOption).not.toHaveBeenCalled()
  })

  it('只有单个窗口的模型不出菜单（TUI has_selectable_windows：len > 1）', () => {
    const single: ModelOption[] = [
      { modelId: 'solo', name: 'Solo', contextWindow: 500000, contextWindows: [500000] },
    ]
    render(
      <ModelMenu
        models={single}
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    expect(screen.getByText('Solo')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '500k' })).not.toBeInTheDocument()
  })

  it('窗口 chip 不带「上下文」标签，只有按钮本身', () => {
    render(
      <ModelMenu
        models={sampleModels}
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    expect(screen.queryByText('上下文')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '256k' })).toBeInTheDocument()
  })

  it('激活模型的当前窗口 chip 高亮（contextWindowSelection 优先于默认值）', () => {
    render(
      <ModelMenu
        models={sampleModels}
        pos={{ bottom: 40, right: 20, maxH: 320, width: 280 }}
        menu={mockMenu}
      />,
    )

    // sampleModels 的 grok-4：默认 256000、会话选择 500000 → 高亮 500k
    expect(screen.getByRole('button', { name: '500k' })).toHaveClass(
      'border-gn-cyan',
      'text-gn-cyan',
    )
    expect(screen.getByRole('button', { name: '256k' })).toHaveClass(
      'border-gn-prompt-border/60',
      'text-gn-muted',
    )
  })
})
