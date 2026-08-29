import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useChatStore } from '../store/chat'

// transport 直连 host：单测里全部换成可控 mock。
const { transportMock } = vi.hoisted(() => ({
  transportMock: {
    extensions: vi.fn(),
    skillsList: vi.fn(),
    skillsToggle: vi.fn(),
    workflowsList: vi.fn(),
    // historyPins 等模块加载期注册 onEvent 回调
    onEvent: vi.fn(() => () => {}),
  },
}))
vi.mock('../api/client', () => ({ transport: transportMock }))

import { ExtensionsModal } from './ExtensionsModal'

const payload = {
  hooks: [
    { name: 'b-hook', command: 'cmd b', enabled: true },
    { name: 'a-hook', event: 'pre_tool_use' },
  ],
  plugins: [{ name: 'plug', source: 'github.com/x', enabled: false }],
  skills: [
    { name: 'local-s', scope: 'project', path: '/x/SKILL.md', enabled: true },
    { name: 'local-s2', scope: 'user' },
  ],
}

function setup(overrides: Record<string, unknown> = {}) {
  useChatStore.setState({
    extensionsOpen: true,
    extensionsTab: 'hooks',
    closeExtensions: useChatStore.getState().closeExtensions,
    openExtensions: useChatStore.getState().openExtensions,
    hooksVersion: 0,
    cwd: '/repo',
    statusText: '',
    ...overrides,
  })
}

function clickText(text: string) {
  fireEvent.click(screen.getByText(text).closest('button') as HTMLElement)
}

describe('ExtensionsModal', () => {
  beforeEach(() => {
    transportMock.extensions.mockReset().mockResolvedValue(payload)
    transportMock.skillsList.mockReset().mockResolvedValue([])
    transportMock.skillsToggle.mockReset().mockResolvedValue({})
    transportMock.workflowsList.mockReset().mockResolvedValue({
      workflows: [
        { name: 'b-wf', description: 'touches ci', source: 'user', path: '/x/.grok/workflows/b-wf.rhai' },
        { name: 'a-wf', description: 'docs', source: 'user', when_to_use: '调研时' },
      ],
    })
    setup()
  })

  it('未打开 → null', () => {
    setup({ extensionsOpen: false })
    const { container } = render(<ExtensionsModal />)
    expect(container.firstChild).toBeNull()
  })

  it('打开即拉取（extensions + agent skills）；hooks A-Z 平铺 + 命令/事件', async () => {
    render(<ExtensionsModal />)
    expect(await screen.findByText('a-hook')).not.toBeNull()
    expect(transportMock.extensions).toHaveBeenCalled()
    expect(transportMock.skillsList).toHaveBeenCalledWith({ cwd: '/repo' })
    expect(screen.getByText('cmd b')).not.toBeNull()
    expect(screen.getByText('event: pre_tool_use')).not.toBeNull()
    // A-Z 排序：a-hook 在 b-hook 前面
    const dialog = screen.getByRole('dialog', { name: 'extensions' })
    expect(dialog.textContent!.indexOf('a-hook')).toBeLessThan(
      dialog.textContent!.indexOf('b-hook'),
    )
  })

  it('hooks 的「启停」按钮 → 只读提示', async () => {
    render(<ExtensionsModal />)
    await screen.findByText('a-hook')
    fireEvent.click(screen.getAllByText('启停')[0].closest('button') as HTMLElement)
    expect(screen.getByText('启停 hooks 需在 TUI/配置中修改，当前为只读')).not.toBeNull()
  })

  it('状态过滤：Enabled / Disabled（无 enabled 字段的条目始终可见）', async () => {
    render(<ExtensionsModal />)
    await screen.findByText('a-hook')
    clickText('Disabled')
    expect(screen.queryByText('b-hook')).toBeNull()
    expect(screen.getByText('a-hook')).not.toBeNull()
    clickText('All')
    expect(screen.getByText('b-hook')).not.toBeNull()
  })

  it('拉取失败 → 错误 + 重试', async () => {
    transportMock.extensions.mockRejectedValueOnce(new Error('net down'))
    render(<ExtensionsModal />)
    expect((await screen.findByRole('dialog', { name: 'extensions' })).textContent).toContain(
      'net down',
    )
    clickText('重试')
    expect(await screen.findByText('a-hook')).not.toBeNull()
  })

  it('切换 tabs：plugins（按 source 分组）/ marketplace（无过滤条）', async () => {
    render(<ExtensionsModal />)
    clickText('plugins')
    expect(await screen.findByText('plug')).not.toBeNull()
    // source 出现在组头 + 插件行
    expect(screen.getAllByText('github.com/x').length).toBeGreaterThan(0)
    // marketplace：占位文案 + 无状态过滤条
    clickText('marketplace')
    expect(screen.getByText(/市场浏览与安装依赖插件生态 API/)).not.toBeNull()
    expect(screen.queryByText('Enabled')).toBeNull()
  })

  it('skills tab：本地 + agent 注册表合并，agent 覆盖 enabled；启停调 skillsToggle', async () => {
    transportMock.skillsList.mockResolvedValue([
      { name: 'local-s', scope: 'user', enabled: false },
      { name: 'agent-s', scope: 'bundled' },
    ])
    render(<ExtensionsModal />)
    clickText('skills')
    // agent 侧覆盖后 local-s 变为禁用态 → 「启用」按钮
    const enable = await screen.findByRole('button', { name: '启用' })
    fireEvent.click(enable)
    expect(transportMock.skillsToggle).toHaveBeenCalledWith({
      name: 'local-s',
      enabled: true,
      cwd: '/repo',
    })
    await act(async () => {})
    expect(useChatStore.getState().statusText).toBe('已启用 skill local-s')
    // 成功翻转后按钮变「禁用」（local-s 与 agent-s 各一）
    expect(screen.getAllByRole('button', { name: '禁用' }).length).toBeGreaterThan(0)
  })

  it('skill 启停失败 → 行内错误', async () => {
    transportMock.skillsList.mockResolvedValue([{ name: 'agent-only', scope: 'bundled' }])
    transportMock.skillsToggle.mockRejectedValue(new Error('nope'))
    render(<ExtensionsModal />)
    clickText('skills')
    fireEvent.click(await screen.findByRole('button', { name: '禁用' }))
    expect(await screen.findByText('agent-only: nope')).not.toBeNull()
  })

  it('agent skills 加载失败 → 提示横幅（本地结果仍显示）', async () => {
    transportMock.skillsList.mockRejectedValue(new Error('agent 挂了'))
    render(<ExtensionsModal />)
    clickText('skills')
    expect(await screen.findByText(/agent skills 加载失败: agent 挂了/)).not.toBeNull()
    expect(screen.getByText('local-s')).not.toBeNull()
  })

  it('skills 分组可折叠（Project / User 顺序）', async () => {
    render(<ExtensionsModal />)
    clickText('skills')
    expect(await screen.findByText('Project')).not.toBeNull()
    expect(screen.getByText('User')).not.toBeNull()
    // Project 在 User 前（TUI scope 顺序）
    const dialog = screen.getByRole('dialog', { name: 'extensions' })
    expect(dialog.textContent!.indexOf('Project')).toBeLessThan(
      dialog.textContent!.indexOf('User'),
    )
    clickText('Project')
    expect(screen.queryByText('local-s')).toBeNull()
    clickText('Project')
    expect(screen.getByText('local-s')).not.toBeNull()
  })

  it('workflows tab：目录浏览（A–Z 平铺，name/描述/source/when to use/path）', async () => {
    setup({ sessionId: 'sess-1' })
    render(<ExtensionsModal />)
    clickText('workflows')
    expect(await screen.findByText('a-wf')).not.toBeNull()
    expect(transportMock.workflowsList).toHaveBeenCalledWith({ sessionId: 'sess-1' })
    expect(screen.getByText('touches ci')).not.toBeNull()
    // 无状态过滤条（TUI Workflows tab 恒 StatusFilter::All）
    expect(screen.queryByText('Enabled')).toBeNull()
    // A–Z：a-wf 在 b-wf 前面
    const dialog = screen.getByRole('dialog', { name: 'extensions' })
    expect(dialog.textContent!.indexOf('a-wf')).toBeLessThan(
      dialog.textContent!.indexOf('b-wf'),
    )
    expect(screen.getByText('when to use · 调研时')).not.toBeNull()
    expect(screen.getByText('/x/.grok/workflows/b-wf.rhai')).not.toBeNull()
  })

  it('workflows tab：加载态', async () => {
    transportMock.workflowsList.mockReturnValue(new Promise(() => {}))
    render(<ExtensionsModal />)
    clickText('workflows')
    expect(await screen.findByText('加载 workflows…')).not.toBeNull()
  })

  it('workflows tab：空态（gate 关闭 / 无已安装 workflow 同样为空）', async () => {
    transportMock.workflowsList.mockResolvedValue({ workflows: [] })
    render(<ExtensionsModal />)
    clickText('workflows')
    expect(await screen.findByText(/暂无已安装的 workflows/)).not.toBeNull()
  })

  it('workflows tab：请求失败 → 错误 + 重试', async () => {
    transportMock.workflowsList.mockRejectedValueOnce(new Error('wf net down'))
    render(<ExtensionsModal />)
    clickText('workflows')
    expect(await screen.findByText('wf net down')).not.toBeNull()
    clickText('重试')
    expect(await screen.findByText('a-wf')).not.toBeNull()
  })

  it('hooksVersion 变化 → 重新拉取', async () => {
    render(<ExtensionsModal />)
    await screen.findByText('a-hook')
    expect(transportMock.extensions).toHaveBeenCalledTimes(1)
    useChatStore.setState({ hooksVersion: 1 })
    await act(async () => {})
    expect(transportMock.extensions).toHaveBeenCalledTimes(2)
  })

  it('Esc / 背景点击关闭', async () => {
    const first = render(<ExtensionsModal />)
    await screen.findByText('a-hook')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useChatStore.getState().extensionsOpen).toBe(false)
    first.unmount()
    setup()
    render(<ExtensionsModal />)
    await screen.findByText('a-hook')
    const overlay = screen.getByRole('dialog', { name: 'extensions' })
    fireEvent.mouseDown(overlay)
    expect(useChatStore.getState().extensionsOpen).toBe(false)
  })
})