import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SettingsModal } from './SettingsModal'
import { useChatStore } from '../store/chat'
import { useToastStore } from '../store/toast'

const settingsMock = vi.hoisted(() => ({
  settings: vi.fn(),
  updateSettings: vi.fn(),
  setMode: vi.fn(async () => undefined),
  listCustomModels: vi.fn(async () => []),
  upsertCustomModel: vi.fn(async () => undefined),
  deleteCustomModel: vi.fn(async () => ({ defaultCleared: false })),
  onEvent: () => () => {},
  getHubUrl: () => '',
}))

vi.mock('../api/client', () => ({ transport: settingsMock }))

import { transport } from '../api/client'

const uiData = {
  permission_mode: 'ask',
  approval_mode: 'ask',
  yolo: false,
  page_flip_on_send: true,
  collapsed_edit_blocks: false,
  remember_tool_approvals: true,
  extra_ui_key: 'custom',
}

function openModal() {
  useChatStore.getState().openSettings()
}

beforeEach(() => {
  useChatStore.setState({
    settingsOpen: false,
    sessionId: 'sess-1',
    yoloMode: false,
    autoMode: false,
    permissionMode: undefined,
  })
  useToastStore.setState({ toasts: [] })
  vi.mocked(transport.settings).mockReset()
  vi.mocked(transport.updateSettings).mockReset()
  vi.mocked(transport.setMode).mockReset()
  vi.mocked(transport.listCustomModels).mockReset()
  vi.mocked(transport.settings).mockResolvedValue({
    ui: { ...uiData },
  })
  vi.mocked(transport.updateSettings).mockImplementation(async (patch) => ({
    ui: { ...uiData, ...patch },
  }))
  vi.mocked(transport.listCustomModels).mockResolvedValue([])
})

describe('SettingsModal', () => {
  it('未打开 → null；F2 打开', () => {
    const { container } = render(<SettingsModal />)
    expect(container.firstChild).toBeNull()
    fireEvent.keyDown(window, { key: 'F2' })
    expect(useChatStore.getState().settingsOpen).toBe(true)
  })

  it('F2 在输入框聚焦时忽略；带修饰键忽略', () => {
    render(<SettingsModal />)
    const input = document.createElement('input')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: 'F2' })
    expect(useChatStore.getState().settingsOpen).toBe(false)
    fireEvent.keyDown(window, { key: 'F2', metaKey: true })
    expect(useChatStore.getState().settingsOpen).toBe(false)
    fireEvent.keyDown(window, { key: 'F2' })
    expect(useChatStore.getState().settingsOpen).toBe(true)
    input.remove()
  })

  it('加载中显示 加载设置…', async () => {
    let resolveSettings: (v: unknown) => void = () => {}
    vi.mocked(transport.settings).mockReturnValue(
      new Promise((res) => {
        resolveSettings = res
      }) as never,
    )
    openModal()
    render(<SettingsModal />)
    expect(screen.getByText('加载设置…')).not.toBeNull()
    resolveSettings({ ui: { ...uiData } })
    await waitFor(() => expect(screen.queryByText('加载设置…')).toBeNull())
  })

  it('渲染分组与只读值；consumed ui keys 不重复出现在 dump', async () => {
    vi.mocked(transport.settings).mockResolvedValue({
      ui: { ...uiData },
      session: { some_value: 'hello' },
      models: { key1: { nested: true } },
      cli: { flag: true },
    })
    openModal()
    render(<SettingsModal />)
    await waitFor(() => expect(screen.getByText('[ui] UI')).not.toBeNull())
    expect(screen.getByText('[session] Session')).not.toBeNull()
    expect(screen.getByText('[models] Models')).not.toBeNull()
    expect(screen.getByText('[cli] CLI')).not.toBeNull()
    // dump 行：extra_ui_key 展示（consumed 键只出现在「本端行为」区）
    expect(screen.getByText('extra_ui_key')).not.toBeNull()
    expect(screen.getByTitle('page_flip_on_send')).not.toBeNull()
    expect(screen.getByText('hello')).not.toBeNull()
    expect(screen.getByText('{"nested":true}')).not.toBeNull()
    // bool 只读徽标
    expect(screen.getByTitle('on（只读）')).not.toBeNull()
  })

  it('权限 pills：当前态高亮 + 点击 patch permission_mode', async () => {
    openModal()
    render(<SettingsModal />)
    await waitFor(() => expect(screen.getByText('permission_mode')).not.toBeNull())
    fireEvent.click(screen.getByText('auto'))
    await waitFor(() => {
      expect(transport.updateSettings).toHaveBeenCalledWith({ permission_mode: 'auto' })
    })
    // applyLivePermission：setMode('auto') + store 切 auto
    expect(transport.setMode).toHaveBeenCalledWith('auto', 'sess-1')
    expect(useChatStore.getState().autoMode).toBe(true)
    expect(useChatStore.getState().yoloMode).toBe(false)
  })

  it('always-approve：依次尝试三个 mode id，成功置 yolo', async () => {
    vi.mocked(transport.setMode)
      .mockRejectedValueOnce(new Error('no'))
      .mockResolvedValueOnce(undefined)
    openModal()
    render(<SettingsModal />)
    await waitFor(() => expect(screen.getByText('always-approve')).not.toBeNull())
    fireEvent.click(screen.getByText('always-approve'))
    await waitFor(() => {
      expect(useChatStore.getState().yoloMode).toBe(true)
    })
    expect(transport.setMode).toHaveBeenNthCalledWith(1, 'always-approve', 'sess-1')
    expect(transport.setMode).toHaveBeenNthCalledWith(2, 'always_approve', 'sess-1')
    expect(useChatStore.getState().permissionMode).toBe('always-approve')
  })

  it('always-approve 全部失败 → 错误 toast', async () => {
    vi.mocked(transport.setMode).mockRejectedValue(new Error('boom'))
    openModal()
    render(<SettingsModal />)
    await waitFor(() => expect(screen.getByText('always-approve')).not.toBeNull())
    fireEvent.click(screen.getByText('always-approve'))
    await waitFor(() => {
      expect(useToastStore.getState().toasts.length).toBe(1)
    })
    expect(useToastStore.getState().toasts[0].text).toContain('未能切到 always-approve')
    expect(useChatStore.getState().yoloMode).toBe(false)
  })

  it('bool 行切换 patch 并写入 settings 缓存', async () => {
    openModal()
    render(<SettingsModal />)
    await waitFor(() => expect(screen.getByTitle('collapsed_edit_blocks')).not.toBeNull())
    fireEvent.click(screen.getByTitle(/diff 收成/))
    await waitFor(() => {
      expect(transport.updateSettings).toHaveBeenCalledWith({ collapsed_edit_blocks: true })
    })
    // 按钮标 busy 后恢复 on
    expect(screen.getByTitle(/diff 收成/).textContent).toContain('on')
  })

  it('updateSettings 失败 → toast', async () => {
    vi.mocked(transport.updateSettings).mockRejectedValue(new Error('patch failed'))
    openModal()
    render(<SettingsModal />)
    await waitFor(() => expect(screen.getByTitle('collapsed_edit_blocks')).not.toBeNull())
    fireEvent.click(screen.getByTitle(/diff 收成/))
    await waitFor(() => {
      expect(useToastStore.getState().toasts[0]?.text).toBe('patch failed')
    })
  })

  it('加载失败 → 错误 + 重试', async () => {
    vi.mocked(transport.settings).mockRejectedValueOnce(new Error('net down')).mockResolvedValueOnce({
      ui: { ...uiData },
    })
    openModal()
    render(<SettingsModal />)
    await waitFor(() => expect(screen.getByText('net down')).not.toBeNull())
    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => expect(screen.getByText('本端行为')).not.toBeNull())
  })

  it('Esc 关闭', async () => {
    openModal()
    render(<SettingsModal />)
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useChatStore.getState().settingsOpen).toBe(false)
  })

  it('esc 按钮关闭', async () => {
    openModal()
    render(<SettingsModal />)
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull())
    fireEvent.click(screen.getByText('esc'))
    expect(useChatStore.getState().settingsOpen).toBe(false)
  })

  it('backdrop mousedown 关闭（点击面板内部不关）', async () => {
    openModal()
    const { container } = render(<SettingsModal />)
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull())
    fireEvent.mouseDown(container.firstChild as Element)
    expect(useChatStore.getState().settingsOpen).toBe(false)
    useChatStore.getState().openSettings()
    const { container: c2 } = render(<SettingsModal />)
    await waitFor(() => expect(c2.firstChild).not.toBeNull())
    const panel = c2.querySelector('[tabindex="-1"]') as Element
    fireEvent.mouseDown(panel)
    expect(useChatStore.getState().settingsOpen).toBe(true)
  })

  it('前端偏好：collapse_tool_groups 切换', async () => {
    openModal()
    render(<SettingsModal />)
    await waitFor(() => expect(screen.getByTitle('collapse_tool_groups')).not.toBeNull())
    const btn = () => screen.getByTitle('控制 scrollback 里 toolcall 分组是否折叠，改动即时生效')
    // 默认 on；点击关闭
    expect(btn().textContent).toContain('on')
    fireEvent.click(btn())
    expect(btn().textContent).toContain('off')
  })
})