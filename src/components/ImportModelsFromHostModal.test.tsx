import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ImportModelsFromHostModal } from './ImportModelsFromHostModal'
import type { CustomModelConfig, HostInfo } from '../api/types'
import { useToastStore } from '../store/toast'

const remoteModels: CustomModelConfig[] = [
  {
    id: 'ds-chat',
    model: 'deepseek-chat',
    base_url: 'https://api.deepseek.com/v1',
    name: 'DeepSeek Chat',
    api_key: 'sk-remote-secret',
    context_window: 128000,
  },
  {
    id: 'ds-reasoner',
    model: 'deepseek-reasoner',
    base_url: 'https://api.deepseek.com/v1',
    name: 'DeepSeek Reasoner',
    api_key: 'sk-remote-reasoner',
  },
]

const transportMock = vi.hoisted(() => ({
  listCustomModelsFromHost: vi.fn(
    async (_hostId: string) => [] as CustomModelConfig[],
  ),
  listCustomModels: vi.fn(async () => [] as CustomModelConfig[]),
  upsertCustomModel: vi.fn(async (_cfg: CustomModelConfig) => ({ ok: true }) as unknown),
}))

vi.mock('../api/client', () => ({ transport: transportMock }))

const hosts: HostInfo[] = [
  { hostId: 'mine', hostName: 'MacBook', online: true },
  { hostId: 'vps', hostName: 'VPS', online: true },
  { hostId: 'stale', hostName: '旧机器', online: false },
]

function renderModal(overrides: Partial<Parameters<typeof ImportModelsFromHostModal>[0]> = {}) {
  return render(
    <ImportModelsFromHostModal
      isOpen
      onClose={vi.fn()}
      targetHostId="mine"
      targetHostName="MacBook"
      hosts={hosts}
      onImported={vi.fn()}
      {...overrides}
    />,
  )
}

describe('ImportModelsFromHostModal', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
    vi.clearAllMocks()
    vi.mocked(transportMock.listCustomModelsFromHost).mockResolvedValue(remoteModels)
    vi.mocked(transportMock.listCustomModels).mockResolvedValue([])
    // clearAllMocks 不清实现：逐条显式复位，免得上一条的失败桩漏到这一条。
    vi.mocked(transportMock.upsertCustomModel).mockImplementation(async () => ({ ok: true }))
  })

  it('源候选剔除当前 Host，离线 Host 标注但仍可选', async () => {
    renderModal()
    const select = screen.getByLabelText(/源 Host/) as HTMLSelectElement
    const labels = Array.from(select.options).map((o) => o.textContent)
    expect(labels).toEqual(['VPS', '旧机器（离线）'])
    expect(labels.some((l) => l.includes('MacBook'))).toBe(false)
  })

  it('默认只勾「新建」；已存在的条目默认跳过（要覆盖得手动勾）', async () => {
    vi.mocked(transportMock.listCustomModels).mockResolvedValue([
      { id: 'ds-chat', model: 'deepseek-chat', base_url: 'https://api.deepseek.com/v1' },
    ])
    renderModal()
    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    // 第一个是「复制密钥」总开关，其余按行序：ds-chat=overwrite、ds-reasoner=new
    const rowBoxes = boxes.slice(1)
    expect(rowBoxes[0].checked).toBe(false)
    expect(rowBoxes[1].checked).toBe(true)
    expect(screen.getByText('将覆盖')).toBeDefined()
    // 只勾了新建那一条：覆盖提示不出现
    expect(screen.queryByText(/含 \d+ 个覆盖/)).toBeNull()
    expect(screen.getByRole('button', { name: /导入所选模型 \(1\)/ })).toBeDefined()
  })

  it('勾上覆盖行后按钮如实报出覆盖数量', async () => {
    vi.mocked(transportMock.listCustomModels).mockResolvedValue([
      { id: 'ds-chat', model: 'deepseek-chat', base_url: 'https://api.deepseek.com/v1' },
    ])
    renderModal()
    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    expect(screen.getByRole('button', { name: /导入所选模型/ })).toHaveProperty(
      'disabled',
      false,
    )
    expect(screen.getByText(/含 1 个覆盖/)).toBeDefined()
  })

  it('slug 冲突行与无效行禁用勾选，并写明原因', async () => {
    vi.mocked(transportMock.listCustomModels).mockResolvedValue([
      // 同 slug 属于别的 id：host 侧必拒
      { id: 'other-entry', model: 'deepseek-chat', base_url: 'https://api.example.com/v1' },
    ])
    renderModal()
    await waitFor(() => {
      expect(screen.getByText('slug 冲突')).toBeDefined()
    })
    expect(screen.getByText(/已被目标上的 \[model\.other-entry\] 使用/)).toBeDefined()
    const rowBox = screen.getAllByRole('checkbox')[1] as HTMLInputElement
    expect(rowBox.disabled).toBe(true)
    fireEvent.click(rowBox)
    // 点了也不进选择集（按钮仍因 ds-reasoner 可导入而启用，但覆盖数为 0）
    expect(screen.queryByText(/含 \d+ 个覆盖/)).toBeNull()
  })

  it('关掉密钥开关后写入 payload 不含密钥字段', async () => {
    renderModal()
    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })
    fireEvent.click(screen.getByText(/同时复制密钥类字段/))
    fireEvent.click(screen.getByRole('button', { name: /导入所选模型/ }))
    await waitFor(() => {
      expect(transportMock.upsertCustomModel).toHaveBeenCalledTimes(2)
    })
    for (const call of vi.mocked(transportMock.upsertCustomModel).mock.calls) {
      expect(call[0]).not.toHaveProperty('api_key')
    }
  })

  it('默认复制密钥：写入 payload 带源 api_key', async () => {
    renderModal()
    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })
    fireEvent.click(screen.getByRole('button', { name: /导入所选模型/ }))
    await waitFor(() => {
      expect(transportMock.upsertCustomModel).toHaveBeenCalledTimes(2)
    })
    const payloads = vi.mocked(transportMock.upsertCustomModel).mock.calls.map((c) => c[0])
    expect(payloads.find((p) => p.id === 'ds-chat')?.api_key).toBe('sk-remote-secret')
  })

  it('部分失败：不关窗、失败行显示原因，成功项照样落盘', async () => {
    vi.mocked(transportMock.upsertCustomModel).mockImplementation(async (cfg) => {
      if (cfg.id === 'ds-chat') throw new Error('路由 slug 已被占用')
      return { ok: true }
    })
    const onImported = vi.fn()
    const onClose = vi.fn()
    renderModal({ onImported, onClose })
    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })
    fireEvent.click(screen.getByRole('button', { name: /导入所选模型/ }))
    await waitFor(() => {
      expect(screen.getByText(/写入失败：路由 slug 已被占用/)).toBeDefined()
    })
    // 成功的那个已落盘，失败的不许被静默吞掉：窗口留着让用户看清哪条挂了
    expect(vi.mocked(transportMock.upsertCustomModel).mock.calls.map((c) => c[0].id)).toEqual([
      'ds-chat',
      'ds-reasoner',
    ])
    expect(onImported).toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // 成功那行不该被标成失败
    expect(screen.getAllByText(/写入失败/)).toHaveLength(1)
  })

  it('全部成功：关窗并提示已热加载', async () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    await waitFor(() => {
      expect(screen.getByText('DeepSeek Chat')).toBeDefined()
    })
    fireEvent.click(screen.getByRole('button', { name: /导入所选模型/ }))
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
    })
    const toasts = useToastStore.getState().toasts
    expect(toasts.some((t) => t.text.includes('导入 2 个模型'))).toBe(true)
  })

  it('目标列表是重新读的（不用面板缓存）：覆盖判定基于本次读到的目标状态', async () => {
    renderModal()
    await waitFor(() => {
      expect(transportMock.listCustomModels).toHaveBeenCalled()
    })
    expect(transportMock.listCustomModelsFromHost).toHaveBeenCalledWith('vps')
    expect(transportMock.listCustomModels).toHaveBeenCalled()
  })

  it('读取源失败：显示 host 自己的说法，不静默当空列表', async () => {
    vi.mocked(transportMock.listCustomModelsFromHost).mockRejectedValue(
      new Error('host vps 当前离线'),
    )
    renderModal()
    await waitFor(() => {
      expect(screen.getByText(/host vps 当前离线/)).toBeDefined()
    })
  })

  it('没有其他 Host：无从选择，按钮不可用', async () => {
    renderModal({ hosts: [{ hostId: 'mine', hostName: 'MacBook', online: true }] })
    expect((screen.getByLabelText(/源 Host/) as HTMLSelectElement).value).toBe('')
    expect(screen.getByRole('button', { name: /导入所选模型/ })).toHaveProperty(
      'disabled',
      true,
    )
    expect(transportMock.listCustomModelsFromHost).not.toHaveBeenCalled()
  })
})
