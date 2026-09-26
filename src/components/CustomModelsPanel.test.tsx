import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { CustomModelsPanel } from './CustomModelsPanel'
import type { CustomModelConfig } from '../api/types'

const sampleModels: CustomModelConfig[] = [
  {
    id: 'ds-chat',
    model: 'deepseek-chat',
    base_url: 'https://api.deepseek.com/v1',
    name: 'DeepSeek Chat',
    context_window: 128000,
    supports_reasoning_effort: true,
  },
  {
    id: 'gpt-4o',
    model: 'gpt-4o',
    base_url: 'https://api.openai.com/v1',
    name: 'GPT-4o',
    api_backend: 'responses' as const,
  },
  {
    id: 'claude-sonnet',
    model: 'claude-3-5-sonnet',
    base_url: 'https://api.anthropic.com/v1',
    name: 'Claude Sonnet',
    supports_backend_search: true,
  },
]

const transportMock = vi.hoisted(() => ({
  listCustomModels: vi.fn(async () => sampleModels),
  upsertCustomModel: vi.fn(async () => ({ ok: true })),
  deleteCustomModel: vi.fn(async () => ({ defaultCleared: false })),
  setDefaultModel: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../api/client', () => ({ transport: transportMock }))

describe('CustomModelsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(transportMock.listCustomModels).mockResolvedValue(sampleModels)
  })

  it('renders existing custom models and quick add button', async () => {
    render(<CustomModelsPanel />)

    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })

    // Plain text buttons without icons
    expect(screen.getAllByRole('button', { name: '编辑' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '删除' }).length).toBeGreaterThan(0)

    expect(screen.getByRole('button', { name: /新增模型/ })).toBeDefined()
    const quickAddBtn = screen.getByRole('button', { name: /快速添加/ })
    expect(quickAddBtn).toBeDefined()

    // Click quick add button
    fireEvent.click(quickAddBtn)

    // Quick add modal should open
    expect(screen.getByText('快速拉取并添加模型')).toBeDefined()

    // Close button
    const closeBtn = screen.getByTitle('关闭 (Esc)')
    fireEvent.click(closeBtn)

    await waitFor(() => {
      expect(screen.queryByText('快速拉取并添加模型')).toBeNull()
    })
  })

  it('filters models via search input', async () => {
    render(<CustomModelsPanel />)

    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })

    const searchInput = screen.getByPlaceholderText('搜索模型、Slug 或 Base URL…')
    expect(searchInput).toBeDefined()

    // Search for "claude"
    fireEvent.change(searchInput, { target: { value: 'claude' } })

    expect(screen.getByText('Claude Sonnet')).toBeDefined()
    expect(screen.queryByText('DeepSeek Chat')).toBeNull()
    expect(screen.queryByText('GPT-4o')).toBeNull()

    // Clear search
    fireEvent.change(searchInput, { target: { value: '' } })
    expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    expect(screen.getByText('GPT-4o')).toBeDefined()
  })

  it('renders models stably sorted by display name or id', async () => {
    render(<CustomModelsPanel />)

    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })

    const rows = screen.getAllByRole('button', { name: '编辑' }).map((btn) => {
      const row = btn.closest('div[class*="justify-between"]') as HTMLElement
      return within(row).getByText(/Claude Sonnet|DeepSeek Chat|GPT-4o/).textContent
    })
    expect(rows).toEqual(['Claude Sonnet', 'DeepSeek Chat', 'GPT-4o'])
  })

  it('supports modifying model id and renames model on save', async () => {
    render(<CustomModelsPanel />)

    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })

    // Click edit on model ds-chat (DeepSeek Chat)
    const row = screen.getByText('DeepSeek Chat').closest('div[class*="justify-between"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '编辑' }))

    // Verify id input is NOT disabled and has initial value
    const idInput = screen.getByDisplayValue('ds-chat') as HTMLInputElement
    expect(idInput.disabled).toBe(false)

    // Change id from ds-chat to ds-chat-v2
    fireEvent.change(idInput, { target: { value: 'ds-chat-v2' } })
    expect(idInput.value).toBe('ds-chat-v2')

    // Rename preview hint should appear
    expect(screen.getByText('保存=重命名 [model.ds-chat] → [model.ds-chat-v2]')).toBeDefined()

    // Click save button
    const saveBtn = screen.getByRole('button', { name: '保存修改' })
    expect((saveBtn as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(saveBtn)

    await waitFor(() => {
      // deleteCustomModel should be called with old id
      expect(transportMock.deleteCustomModel).toHaveBeenCalledWith('ds-chat')
      // upsertCustomModel should be called with new id
      expect(transportMock.upsertCustomModel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ds-chat-v2',
          model: 'deepseek-chat',
        }),
      )
    })
  })

  it('shows collision warning and disables save if modified id collides with another model', async () => {
    render(<CustomModelsPanel />)

    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })

    // Edit ds-chat
    const row = screen.getByText('DeepSeek Chat').closest('div[class*="justify-between"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '编辑' }))

    const idInput = screen.getByDisplayValue('ds-chat') as HTMLInputElement
    // Change id to gpt-4o which already exists
    fireEvent.change(idInput, { target: { value: 'gpt-4o' } })

    expect(screen.getByText(/id「gpt-4o」已存在/)).toBeDefined()
    const saveBtn = screen.getByRole('button', { name: '保存修改' }) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
  })

  it('re-applies default model when renamed model was configured as default', async () => {
    vi.mocked(transportMock.deleteCustomModel).mockResolvedValue({ defaultCleared: true })
    render(<CustomModelsPanel />)

    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })

    const row = screen.getByText('DeepSeek Chat').closest('div[class*="justify-between"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '编辑' }))

    const idInput = screen.getByDisplayValue('ds-chat') as HTMLInputElement
    fireEvent.change(idInput, { target: { value: 'ds-chat-renamed' } })

    const saveBtn = screen.getByRole('button', { name: '保存修改' })
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(transportMock.deleteCustomModel).toHaveBeenCalledWith('ds-chat')
      expect(transportMock.upsertCustomModel).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ds-chat-renamed' }),
      )
      expect(transportMock.setDefaultModel).toHaveBeenCalledWith('ds-chat-renamed', undefined)
    })
  })

  it('does not delete model when saving without changing id', async () => {
    render(<CustomModelsPanel />)

    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })

    const row = screen.getByText('DeepSeek Chat').closest('div[class*="justify-between"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '编辑' }))

    // Change only the display name, keep id ds-chat
    const nameInput = screen.getByDisplayValue('DeepSeek Chat') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'DeepSeek Chat Modified' } })

    const saveBtn = screen.getByRole('button', { name: '保存修改' })
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(transportMock.deleteCustomModel).not.toHaveBeenCalled()
      expect(transportMock.upsertCustomModel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ds-chat',
          name: 'DeepSeek Chat Modified',
        }),
      )
    })
  })

  it('copies a model into a prefilled new-entry form and saves without deleting the source', async () => {
    render(<CustomModelsPanel />)

    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })

    const row = screen.getByText('DeepSeek Chat').closest('div[class*="justify-between"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '复制' }))

    // 表单以「新建」语义打开：id 预填 -copy 后缀，按钮是「新增」而非「保存修改」
    expect(screen.getByDisplayValue('ds-chat-copy')).toBeDefined()
    expect(screen.getByDisplayValue('https://api.deepseek.com/v1')).toBeDefined()
    expect(screen.getByRole('button', { name: '新增' })).toBeDefined()

    // 路由 slug 原样保留 → 与源条目冲突，保存被拦住，提示改 slug
    expect(screen.getByText(/已被其他条目使用，不能重复配置/)).toBeDefined()
    const saveBtn = screen.getByRole('button', { name: '新增' }) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)

    fireEvent.change(screen.getByDisplayValue('deepseek-chat'), { target: { value: 'deepseek-chat-v2' } })
    expect(saveBtn.disabled).toBe(false)
    fireEvent.click(saveBtn)

    await waitFor(() => {
      // 复制保存走新增路径：不删除源条目
      expect(transportMock.deleteCustomModel).not.toHaveBeenCalled()
      // 整份配置原样带入，只有 id 和改过的 slug 变化
      expect(transportMock.upsertCustomModel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ds-chat-copy',
          model: 'deepseek-chat-v2',
          base_url: 'https://api.deepseek.com/v1',
          name: 'DeepSeek Chat',
          context_window: 128000,
          supports_reasoning_effort: true,
        }),
      )
    })
  })

  it('deduplicates the copy id when -copy is already taken', async () => {
    vi.mocked(transportMock.listCustomModels).mockResolvedValue([
      ...sampleModels,
      {
        id: 'ds-chat-copy',
        model: 'deepseek-reasoner',
        base_url: 'https://api.deepseek.com/v1',
        name: 'DeepSeek Chat Copy',
        api_backend: 'responses' as const,
      },
    ])
    render(<CustomModelsPanel />)

    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat Copy')).toBeDefined()
    })

    const row = screen.getByText('DeepSeek Chat').closest('div[class*="justify-between"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '复制' }))

    expect(screen.getByDisplayValue('ds-chat-copy2')).toBeDefined()
  })

  it('keeps at most one default effort checked in the efforts editor', async () => {
    // 编辑一个配置了多个档位的模型
    vi.mocked(transportMock.listCustomModels).mockResolvedValue([
      {
        id: 'efforts-model',
        model: 'efforts-model',
        base_url: 'https://api.example.com/v1',
        name: 'Efforts Model',
        reasoning_efforts: [
          { value: 'low' },
          { value: 'high', default: true },
          { value: 'max' },
        ],
      },
    ])
    render(<CustomModelsPanel />)

    await waitFor(() => {
      expect(screen.getByText('Efforts Model')).toBeDefined()
    })

    const row = screen.getByText('Efforts Model').closest('div[class*="justify-between"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '编辑' }))

    // 三行的默认勾选状态：high 选中，low/max 未选中
    const checkboxes = screen
      .getAllByRole('checkbox')
      .filter((c) => (c.closest('label')?.textContent ?? '').includes('默认'))
    expect(checkboxes.map((c) => (c as HTMLInputElement).checked)).toEqual([false, true, false])

    // 勾选 low 的默认 → high 自动取消，仍然只有一个默认
    fireEvent.click(checkboxes[0])
    const after = screen
      .getAllByRole('checkbox')
      .filter((c) => (c.closest('label')?.textContent ?? '').includes('默认'))
    expect(after.map((c) => (c as HTMLInputElement).checked)).toEqual([true, false, false])

    // 保存后写回的配置只有一个 default 档
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => {
      expect(transportMock.upsertCustomModel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'efforts-model',
          reasoning_efforts: [
            { value: 'low', default: true },
            { value: 'high' },
            { value: 'max' },
          ],
        }),
      )
    })
  })

  it('normalizes multiple default efforts to the first when opening an existing config', async () => {
    // 配置里多标 default（shell 只认第一个）→ 打开编辑表单时归一展示
    vi.mocked(transportMock.listCustomModels).mockResolvedValue([
      {
        id: 'multi-default',
        model: 'multi-default',
        base_url: 'https://api.example.com/v1',
        name: 'Multi Default',
        reasoning_efforts: [
          { value: 'low', default: true },
          { value: 'high', default: true },
        ],
      },
    ])
    render(<CustomModelsPanel />)

    await waitFor(() => {
      expect(screen.getByText('Multi Default')).toBeDefined()
    })

    const row = screen.getByText('Multi Default').closest('div[class*="justify-between"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '编辑' }))

    const checkboxes = screen
      .getAllByRole('checkbox')
      .filter((c) => (c.closest('label')?.textContent ?? '').includes('默认'))
    expect(checkboxes.map((c) => (c as HTMLInputElement).checked)).toEqual([true, false])
  })
})
