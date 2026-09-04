import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { CustomModelsPanel } from './CustomModelsPanel'

const sampleModels = [
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
})
