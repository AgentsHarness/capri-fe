import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { CustomModelsPanel } from './CustomModelsPanel'
import { useChatStore } from '../store/chat'
import type { CustomModelConfig, CustomModelFilters } from '../api/types'

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
  listModelFilters: vi.fn(async (): Promise<CustomModelFilters> => ({ hidden: [], disabled: [] })),
  setModelFilters: vi.fn(async () => ({ ok: true })),
  // 面板现在读 chat store（选中 host / host 列表）——它会连带加载 hub 偏好
  // 同步等模块级订阅，这些传输面必须存在（与 SettingsModal.test 同款）。
  onEvent: () => () => {},
  getHubUrl: () => '',
  prefsOrigin: () => '',
  getConnectionMode: () => 'hub' as const,
}))

vi.mock('../api/client', () => ({ transport: transportMock }))

describe('CustomModelsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(transportMock.listCustomModels).mockResolvedValue(sampleModels)
    vi.mocked(transportMock.listModelFilters).mockResolvedValue({ hidden: [], disabled: [] })
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

  it('hub 模式且有多台 Host 时显示「从其他 Host 导入」入口', async () => {
    useChatStore.setState({
      selectedHostId: 'mine',
      hosts: [
        { hostId: 'mine', hostName: '本机', online: true },
        { hostId: 'vps', hostName: 'VPS', online: true },
      ],
    })
    render(<CustomModelsPanel />)
    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })
    expect(screen.getByRole('button', { name: /从其他 Host 导入/ })).toBeDefined()
  })

  it('只有一台 Host 时不显示导入入口（没有源可读）', async () => {
    useChatStore.setState({
      selectedHostId: 'mine',
      hosts: [{ hostId: 'mine', hostName: '本机', online: true }],
    })
    render(<CustomModelsPanel />)
    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })
    expect(screen.queryByRole('button', { name: /从其他 Host 导入/ })).toBeNull()
  })

  it('local 模式不显示导入入口（没有第二台 Host 可问）', async () => {
    const spy = vi
      .spyOn(transportMock, 'getConnectionMode')
      .mockReturnValue('local' as never)
    useChatStore.setState({
      selectedHostId: 'mine',
      hosts: [
        { hostId: 'mine', hostName: '本机', online: true },
        { hostId: 'vps', hostName: 'VPS', online: true },
      ],
    })
    try {
      render(<CustomModelsPanel />)
      await waitFor(() => {
        expect(screen.getByText('DeepSeek Chat')).toBeDefined()
      })
      expect(screen.queryByRole('button', { name: /从其他 Host 导入/ })).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('换 Host 会重读列表（`?host=` 变了，旧列表不能留在屏幕上）', async () => {
    useChatStore.setState({ selectedHostId: 'mine', hosts: [] })
    render(<CustomModelsPanel />)
    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })
    const callsBefore = vi.mocked(transportMock.listCustomModels).mock.calls.length
    useChatStore.setState({ selectedHostId: 'vps' })
    await waitFor(() => {
      expect(vi.mocked(transportMock.listCustomModels).mock.calls.length).toBeGreaterThan(
        callsBefore,
      )
    })
  })

  // ── 目录过滤（[models] hidden_models / disabled_models）──

  it('主视图有规则时显示单行摘要，点「编辑过滤」进二级视图；未保存点返回丢弃草稿', async () => {
    vi.mocked(transportMock.listModelFilters).mockResolvedValue({
      hidden: ['grok-4.6'],
      disabled: ['grok-4.5'],
    })
    render(<CustomModelsPanel />)

    await waitFor(() => {
      expect(screen.getByText(/已隐藏 1 项（grok-4.6）/)).toBeDefined()
    })
    expect(screen.getByText(/已禁用 1 项（grok-4.5）/)).toBeDefined()
    // 主视图默认不展开两个过滤输入框
    expect(screen.queryByPlaceholderText('grok-4.6 或 grok-*')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '编辑过滤' }))
    expect(screen.getByText('grok-4.6')).toBeDefined()
    expect(screen.getByText('grok-4.5')).toBeDefined()

    // 加一条只改本地草稿：不进请求体。
    const hiddenBlock = screen.getByText(/hidden_models（隐藏/).parentElement as HTMLElement
    fireEvent.change(within(hiddenBlock).getByPlaceholderText('grok-4.6 或 grok-*'), {
      target: { value: 'grok-*' },
    })
    fireEvent.click(within(hiddenBlock).getByRole('button', { name: '添加' }))
    expect(screen.getByText('grok-*')).toBeDefined()
    expect(transportMock.setModelFilters).not.toHaveBeenCalled()

    // 点返回回到列表，未保存的 grok-* 被丢弃，再打开只剩原规则
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /目录过滤/ }))
    expect(screen.queryByText('grok-*')).toBeNull()
  })

  it('保存目录过滤把两份名单一起写出去，保存后回到模型列表并更新摘要', async () => {
    render(<CustomModelsPanel />)
    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })
    // 零规则时底部不显示过滤摘要条
    expect(screen.queryByRole('button', { name: '编辑过滤' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /目录过滤/ }))

    const hiddenBlock = screen.getByText(/hidden_models（隐藏/).parentElement as HTMLElement
    fireEvent.change(within(hiddenBlock).getByPlaceholderText('grok-4.6 或 grok-*'), {
      target: { value: 'grok-*, claude-*' },
    })
    fireEvent.keyDown(within(hiddenBlock).getByPlaceholderText('grok-4.6 或 grok-*'), {
      key: 'Enter',
    })
    const disabledBlock = screen.getByText(/disabled_models（禁用/).parentElement as HTMLElement
    fireEvent.change(within(disabledBlock).getByPlaceholderText('grok-4.5 或 grok-*'), {
      target: { value: 'grok-4.5' },
    })
    fireEvent.click(within(disabledBlock).getByRole('button', { name: '添加' }))

    fireEvent.click(screen.getByRole('button', { name: '保存目录过滤' }))

    await waitFor(() => {
      expect(transportMock.setModelFilters).toHaveBeenCalledWith({
        hidden: ['grok-*', 'claude-*'],
        disabled: ['grok-4.5'],
      })
    })
    // 保存成功后回到主列表，底部摘要条反映最新规则
    expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    expect(screen.getByText(/已隐藏 2 项（grok-\*, claude-\*）/)).toBeDefined()
  })

  it('删掉 chip 后保存，被删的模式不再出现在请求体里', async () => {
    vi.mocked(transportMock.listModelFilters).mockResolvedValue({
      hidden: ['grok-4.6'],
      disabled: [],
    })
    render(<CustomModelsPanel />)
    await waitFor(() => {
      expect(screen.getByText(/已隐藏 1 项（grok-4.6）/)).toBeDefined()
    })

    fireEvent.click(screen.getByRole('button', { name: /目录过滤/ }))
    fireEvent.click(screen.getByLabelText('删除 grok-4.6'))
    fireEvent.click(screen.getByRole('button', { name: '保存目录过滤' }))

    await waitFor(() => {
      expect(transportMock.setModelFilters).toHaveBeenCalledWith({ hidden: [], disabled: [] })
    })
  })

  it('host 读不出过滤名单时：主列表不受影响，点进「目录过滤」降级为提示且不给保存按钮', async () => {
    vi.mocked(transportMock.listModelFilters).mockRejectedValue(new Error('list model filters failed (404)'))
    render(<CustomModelsPanel />)

    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })

    fireEvent.click(screen.getByRole('button', { name: /目录过滤/ }))
    expect(screen.getByText(/不可用：list model filters failed \(404\)/)).toBeDefined()
    expect(screen.queryByRole('button', { name: /保存目录过滤/ })).toBeNull()
  })
})
