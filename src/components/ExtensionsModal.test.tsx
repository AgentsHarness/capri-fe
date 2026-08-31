import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useChatStore } from '../store/chat'

// transport 直连 host：单测里全部换成可控 mock。
const { transportMock } = vi.hoisted(() => ({
  transportMock: {
    extensions: vi.fn(),
    hooksList: vi.fn(),
    hooksAction: vi.fn(),
    skillsList: vi.fn(),
    skillsToggle: vi.fn(),
    workflowsList: vi.fn(),
    // historyPins 等模块加载期注册 onEvent 回调
    onEvent: vi.fn(() => () => {}),
  },
}))
vi.mock('../api/client', () => ({ transport: transportMock }))

import { ExtensionsModal } from './ExtensionsModal'

/** Agent 实时注册表（x.ai/hooks/list 形，源 = TUI /hooks 面板）。 */
const liveHooks = {
  hooks: [
    {
      name: 'global/spawn-log:PostToolUse[0].hooks[0]',
      event: 'post_tool_use',
      handlerType: 'command',
      matcher: 'spawn_subagent|send_subagent_message',
      command: '$HOME/.grok/bin/spawn-subagent-log.py',
      timeoutMs: 5000,
      sourceDir: '/Users/x/.grok/hooks',
    },
    {
      name: 'global/spawn-log:PreToolUse[0].hooks[0]',
      event: 'pre_tool_use',
      matcher: 'spawn_subagent|send_subagent_message',
      command: '$HOME/.grok/bin/spawn-subagent-log.py',
      sourceDir: '/Users/x/.grok/hooks',
      disabled: false,
    },
    {
      name: 'project/guard:Stop[0].hooks[0]',
      event: 'stop',
      command: 'bin/verify.sh',
      sourceDir: '/repo/.grok/hooks',
      disabled: true,
    },
  ],
  projectTrusted: true,
  loadErrors: [],
}

/** GET /api/extensions 本地扫描（legacy 形，hooks 无 agent 时回退用）。 */
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
    transportMock.hooksList.mockReset().mockResolvedValue(liveHooks)
    transportMock.hooksAction.mockReset().mockResolvedValue({})
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

  it('打开即拉取：hooks 走 agent 实时注册表（TUI 同源），按来源分组', async () => {
    render(<ExtensionsModal />)
    expect(await screen.findByText('on:pre_tool_use /spawn_subagent|send_subagent_message')).not.toBeNull()
    expect(transportMock.hooksList).toHaveBeenCalled()
    expect(transportMock.extensions).toHaveBeenCalled()
    expect(transportMock.skillsList).toHaveBeenCalledWith({ cwd: '/repo' })
    // 行描述：→ command（TUI hook_row_desc）——pre/post 两条同命令
    expect(screen.getAllByText('→ $HOME/.grok/bin/spawn-subagent-log.py').length).toBeGreaterThanOrEqual(2)
    // 来源分组：Global 在 Project 前（kind 1 < 0 ？不：Project=0 在前）
    expect(screen.getByText('Global hooks')).not.toBeNull()
    expect(screen.getByText('Project hooks')).not.toBeNull()
    const dialog = screen.getByRole('dialog', { name: 'extensions' })
    expect(dialog.textContent!.indexOf('Project hooks')).toBeLessThan(
      dialog.textContent!.indexOf('Global hooks'),
    )
    // 组内 A-Z：post 在 pre 前
    expect(dialog.textContent!.indexOf('on:post_tool_use')).toBeLessThan(
      dialog.textContent!.indexOf('on:pre_tool_use'),
    )
  })

  it('hooks 列表：禁用条目显示 [disabled] 徽标', async () => {
    render(<ExtensionsModal />)
    await screen.findByText('on:pre_tool_use /spawn_subagent|send_subagent_message')
    expect(screen.getByText('[disabled]')).not.toBeNull()
  })

  it('hooks「重载 hooks（热加载）」→ x.ai/hooks/action reload + 重新拉取', async () => {
    render(<ExtensionsModal />)
    await screen.findByText('on:pre_tool_use /spawn_subagent|send_subagent_message')
    fireEvent.click(screen.getByText('重载 hooks（热加载）'))
    expect(transportMock.hooksAction).toHaveBeenCalledWith({ action: { type: 'reload' } })
    await act(async () => {})
    expect(transportMock.hooksList).toHaveBeenCalledTimes(2)
  })

  it('重载按钮与状态过滤条（All/Enabled/Disabled）同行', async () => {
    render(<ExtensionsModal />)
    await screen.findByText('重载 hooks（热加载）')
    const allBtn = screen.getByRole('button', { name: 'All' })
    const reloadBtn = screen.getByRole('button', { name: '重载 hooks（热加载）' })
    // 同一过滤条容器（All 左，重载 ml-auto 右对齐）
    expect(reloadBtn.closest('div')).toBe(allBtn.closest('div'))
  })

  it('hooks 启停 → x.ai/hooks/action enable/disable + 重新拉取', async () => {
    render(<ExtensionsModal />)
    await screen.findByText('on:pre_tool_use /spawn_subagent|send_subagent_message')
    // 组内 A-Z 第一行是 post（on:post 在 on:pre 前）→ 停用
    const offBtn = screen.getAllByRole('button', { name: '停用' })[0]
    fireEvent.click(offBtn)
    expect(transportMock.hooksAction).toHaveBeenCalledWith({
      action: { type: 'disable', hook_name: 'global/spawn-log:PostToolUse[0].hooks[0]' },
    })
    await act(async () => {})
    expect(transportMock.hooksList).toHaveBeenCalledTimes(2)
    // guard（disabled）→ 启用
    fireEvent.click(screen.getByRole('button', { name: '启用' }))
    expect(transportMock.hooksAction).toHaveBeenLastCalledWith({
      action: { type: 'enable', hook_name: 'project/guard:Stop[0].hooks[0]' },
    })
  })

  it('hooks 启停失败 → 行内错误', async () => {
    transportMock.hooksAction.mockRejectedValue(new Error('managed policy refuses'))
    render(<ExtensionsModal />)
    await screen.findByText('on:pre_tool_use /spawn_subagent|send_subagent_message')
    fireEvent.click(screen.getAllByRole('button', { name: '停用' })[0])
    expect(
      await screen.findByText(/停用失败（global\/spawn-log:PostToolUse\[0\]\.hooks\[0\]）: managed policy refuses/),
    ).not.toBeNull()
  })

  it('状态过滤：Enabled / Disabled（status 未知的条目始终可见）', async () => {
    render(<ExtensionsModal />)
    await screen.findByText('on:pre_tool_use /spawn_subagent|send_subagent_message')
    clickText('Disabled')
    // pre 明确 enabled → 被过滤；post（状态未知）恒可见；guard disabled 显示
    expect(screen.queryByText('on:pre_tool_use /spawn_subagent|send_subagent_message')).toBeNull()
    expect(screen.getByText('on:post_tool_use /spawn_subagent|send_subagent_message')).not.toBeNull()
    expect(screen.getByText('on:stop')).not.toBeNull()
    clickText('All')
    expect(screen.getByText('on:pre_tool_use /spawn_subagent|send_subagent_message')).not.toBeNull()
  })

  it('agent hooks 不可达 → 回退本地磁盘扫描（legacy 行仍显示）', async () => {
    transportMock.hooksList.mockRejectedValue(new Error('agent 挂了'))
    render(<ExtensionsModal />)
    expect(await screen.findByText('a-hook')).not.toBeNull()
    expect(screen.getByText('b-hook')).not.toBeNull()
    // 无错误横幅（fallback 不算失败）；legacy 行仍是 → command 描述
    expect(screen.getByText('→ cmd b')).not.toBeNull()
  })

  it('拉取失败（hooks + 本地都挂）→ 错误 + 重试', async () => {
    transportMock.extensions.mockRejectedValueOnce(new Error('net down'))
    transportMock.hooksList.mockRejectedValueOnce(new Error('net down'))
    render(<ExtensionsModal />)
    expect((await screen.findByRole('dialog', { name: 'extensions' })).textContent).toContain(
      'net down',
    )
    clickText('重试')
    expect(await screen.findByText('on:pre_tool_use /spawn_subagent|send_subagent_message')).not.toBeNull()
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
    await screen.findByText('on:pre_tool_use /spawn_subagent|send_subagent_message')
    expect(transportMock.hooksList).toHaveBeenCalledTimes(1)
    useChatStore.setState({ hooksVersion: 1 })
    await act(async () => {})
    expect(transportMock.hooksList).toHaveBeenCalledTimes(2)
  })

  it('Esc / 背景点击关闭', async () => {
    const first = render(<ExtensionsModal />)
    await screen.findByText('on:pre_tool_use /spawn_subagent|send_subagent_message')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useChatStore.getState().extensionsOpen).toBe(false)
    first.unmount()
    setup()
    render(<ExtensionsModal />)
    await screen.findByText('on:pre_tool_use /spawn_subagent|send_subagent_message')
    const overlay = screen.getByRole('dialog', { name: 'extensions' })
    fireEvent.mouseDown(overlay)
    expect(useChatStore.getState().extensionsOpen).toBe(false)
  })
})