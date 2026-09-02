import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { WorkspaceBar, TopBar } from './TopBar'
import { useChatStore } from '../store/chat'
import { usePromptQueue } from '../store/promptQueue'
import { useThemeStore } from '../store/theme'

/** 已验证的本机近路候选（hostId → route），TopBar 用它逐行标「直连 / 中继」。 */
const localRoutes = new Map<
  string,
  { base: string; port: number; authRequired: boolean }
>()
/** 显式通路选择（hostId → 'auto' | 'relay'）。 */
const routeChoices = new Map<string, string>()
/** 门禁那把：默认空 = 未登录（退出入口整体不显示）。 */
let accessToken = ''

vi.mock('../api/client', () => ({
  transport: {
    onEvent: () => () => {},
    listSessions: vi.fn(async () => ({ sessions: [] })),
    pairingCode: vi.fn(async () => ({ code: 'PAIR-CODE-123', ttl: 300 })),
    getHubUrl: vi.fn(() => ''),
    getLocalRoute: (hostId: string) => localRoutes.get(hostId) ?? null,
    // 通路三态：有候选 + 没显式选中继 = 直连；有候选但选了中继 / 无候选 = 中继
    // （钥匙链路的 pending 态由 localTransport 自己的用例覆盖）
    activeRouteFor: (hostId: string) =>
      localRoutes.has(hostId) && routeChoices.get(hostId) !== 'relay' ? 'direct' : 'relay',
    hasLocalCandidate: (hostId: string) => localRoutes.has(hostId),
    getRouteChoice: (hostId: string) => routeChoices.get(hostId) ?? 'auto',
    setRouteChoice: vi.fn(),
    getAccessToken: () => accessToken,
    sessionSearch: vi.fn(async () => ({ results: [] })),
  },
}))

function resetChat(over: Record<string, unknown> = {}) {
  localRoutes.clear()
  routeChoices.clear()
  accessToken = ''
  useChatStore.setState({
    hostName: '',
    hostId: '',
    hosts: [],
    mode: 'local',
    selectedHostId: '',
    conn: 'connecting',
    layerErrors: {},
    gitInfo: undefined,
    cwd: '',
    homeDir: '/home/user',
    usage: undefined,
    goalState: undefined,
    todos: [],
    entries: [],
    topTasks: [],
    scheduledTasks: [],
    models: [],
    modelName: '',
    tasksBarOpen: false,
    queuePanelOpen: false,
    historyOpen: false,
    sidebarCollapsed: false,
    openExtensions: vi.fn(),
    openUsage: vi.fn(),
    openSettings: vi.fn(),
    resetToEmpty: vi.fn(),
    switchHost: vi.fn(async () => undefined),
    ...over,
  })
  usePromptQueue.setState({ queue: [], sessionId: undefined })
}

describe('WorkspaceBar', () => {
  beforeEach(() => resetChat())

  it('渲染 git 分支 + cwd；worktree 徽标与主仓库后缀', () => {
    resetChat({
      gitInfo: {
        branch: 'main',
        isWorktree: true,
        mainRepo: '/home/user/repos/other',
      },
      cwd: '/home/user/repos/acp-fe',
    })
    const { container } = render(<WorkspaceBar />)
    expect(container.textContent).toContain('main')
    expect(container.textContent).toContain('wt')
    expect(container.textContent).toContain('(worktree of')
    expect(container.textContent).toContain('repos/other')
  })

  it('detached HEAD 显示 detached；无 git 分支则不渲染', () => {
    resetChat({ gitInfo: { branch: '(detached)' }, cwd: '/tmp/x' })
    const { container, rerender } = render(<WorkspaceBar />)
    expect(container.textContent).toContain('detached')
    resetChat({ gitInfo: undefined, cwd: '/tmp/x' })
    rerender(<WorkspaceBar />)
    expect(container.textContent).not.toContain('detached')
    expect(container.textContent).toContain('/tmp/x')
  })

  it('fadeHidden：内容 aria-hidden + inert，栏仍在', () => {
    resetChat({ cwd: '/tmp/x' })
    const { container, rerender } = render(<WorkspaceBar fadeHidden />)
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
    rerender(<WorkspaceBar />)
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  it('首个运行任务出现时自动打开任务条；全部结束后自动关闭', () => {
    const { rerender } = render(<WorkspaceBar />)
    expect(useChatStore.getState().tasksBarOpen).toBe(false)
    resetChat({
      entries: [
        {
          id: 't1',
          kind: 'bg_task',
          taskId: 'tk',
          title: 'run',
          command: 'run',
          running: true,
        },
      ],
    })
    rerender(<WorkspaceBar />)
    expect(useChatStore.getState().tasksBarOpen).toBe(true)
    resetChat({})
    rerender(<WorkspaceBar />)
    expect(useChatStore.getState().tasksBarOpen).toBe(false)
  })

  it('调度任务到达自动打开任务条', () => {
    render(<WorkspaceBar />)
    const { rerender } = render(<WorkspaceBar />)
    resetChat({ scheduledTasks: [{ taskId: 's1', prompt: 'p', interval: '5m' }] })
    rerender(<WorkspaceBar />)
    expect(useChatStore.getState().tasksBarOpen).toBe(true)
  })

  it('上下文芯片：usage 优先，否则 size 回退模型 contextWindow', () => {
    resetChat({ usage: { used: 3000, size: 100000 } })
    const { container, rerender } = render(<WorkspaceBar />)
    expect(container.textContent).toContain('3.0K/100K')
    resetChat({
      usage: { used: 3000 },
      models: [{ modelId: 'm1', name: 'M1', contextWindow: 88888 }],
      modelName: 'M1',
    })
    rerender(<WorkspaceBar />)
    expect(container.textContent).toContain('3.0K/89K')
  })

  it('McpChip 回调 onOpenMcp；RunningChip 切换任务条', () => {
    const onOpenMcp = vi.fn()
    resetChat({
      mcpServers: [{ name: 'a', status: 'ready' }],
      entries: [
        {
          id: 't1',
          kind: 'bg_task',
          taskId: 'tk',
          title: 'run',
          command: 'run',
          running: true,
        },
      ],
    })
    render(<WorkspaceBar onOpenMcp={onOpenMcp} />)
    fireEvent.click(screen.getByTitle(/MCP 服务器/))
    expect(onOpenMcp).toHaveBeenCalled()
    // 首个任务出现 → 任务条自动打开 → chip 标题为「隐藏」态
    fireEvent.click(screen.getByTitle(/隐藏运行中的任务列表/))
    expect(useChatStore.getState().tasksBarOpen).toBe(false)
    // 重新打开：任务条内容可见
    fireEvent.click(screen.getByTitle(/显示运行中的后台任务/))
    expect(screen.getByLabelText(/Running tasks/)).not.toBeNull()
  })
})

describe('TopBar', () => {
  beforeEach(() => resetChat())

  it('本地模式：静态 Localhost 标签，无下拉', () => {
    render(<TopBar />)
    expect(screen.getByText('Localhost')).not.toBeNull()
    expect(screen.queryByTitle(/右键可管理/)).toBeNull()
  })

  it('非本地：host 切换器显示连接状态标签', () => {
    resetChat({
      mode: 'hub',
      hostName: 'MyHost',
      selectedHostId: 'h1',
      hosts: [{ hostId: 'h1', hostName: 'MyHost', online: true }],
      conn: 'ready',
    })
    render(<TopBar />)
    fireEvent.click(screen.getByTitle(/右键可管理/))
    expect(screen.getByText('hosts')).not.toBeNull()
    // 切换 host（title 带通路提示）
    fireEvent.click(screen.getByTitle(/切换到 MyHost（.*右键可管理）/))
    expect(useChatStore.getState().switchHost).toHaveBeenCalledWith('h1')
  })

  it('host 列表行标记直连 / 中继通路；无近路候选的不显示通道', () => {
    resetChat({
      mode: 'hub',
      hostName: 'H1',
      selectedHostId: 'h1',
      hosts: [
        { hostId: 'h1', hostName: 'H1', online: true },
        { hostId: 'h2', hostName: 'H2', online: true },
        { hostId: 'h3', hostName: 'H3', online: true },
      ],
      conn: 'ready',
    })
    // resetChat 会清空近路表，测本机标记前再登记一次
    localRoutes.set('h1', {
      base: 'http://127.0.0.1:8765',
      port: 8765,
      authRequired: false,
    })
    // h3 有近路候选但显式选了中继——通道标记照常显示
    localRoutes.set('h3', {
      base: 'http://127.0.0.1:9000',
      port: 9000,
      authRequired: false,
    })
    routeChoices.set('h3', 'relay')
    render(<TopBar />)
    fireEvent.click(screen.getByTitle(/右键可管理/))
    // 有近路候选的行标通道：h1 直连、h3 中继
    expect(screen.getByText('直连')).not.toBeNull()
    expect(screen.getByText('中继')).not.toBeNull()
    expect(screen.getByTitle(/直连 http:\/\/127\.0\.0\.1:8765/)).not.toBeNull()
    expect(screen.getByTitle(/经 Hub 中继/)).not.toBeNull()
    // h2 无近路候选：行内不标通道，悬停提示也不带通路信息
    const h2 = screen.getByTitle(/切换到 H2/)
    expect(h2.getAttribute('title')).not.toContain('中继')
    expect(h2.closest('div')?.textContent).not.toMatch(/直连|待验证|中继/)
    expect(screen.getAllByText(/直连|待验证|中继/)).toHaveLength(2)
  })

  it('host 列表行显示实时状态（思考中/待处理/启动中/空闲）', () => {
    resetChat({
      mode: 'hub',
      hostName: 'H1',
      selectedHostId: 'h1',
      hosts: [
        { hostId: 'h1', hostName: 'H1', online: true, busy: true },
        { hostId: 'h2', hostName: 'H2', online: true, busy: false, pendingCount: 2 },
        { hostId: 'h3', hostName: 'H3', online: true, booting: true },
        { hostId: 'h4', hostName: 'H4', online: true, busy: false, pendingCount: 0 },
        { hostId: 'h5', hostName: 'H5', online: false, busy: true },
        { hostId: 'h6', hostName: 'H6', online: true }, // 旧 hub 无状态字段
      ],
      conn: 'ready',
    })
    const { container } = render(<TopBar />)
    fireEvent.click(screen.getByTitle(/右键可管理/))
    expect(screen.getByText('思考中')).not.toBeNull()
    expect(screen.getByText('待处理')).not.toBeNull()
    expect(screen.getByText('启动中')).not.toBeNull()
    expect(screen.getByText('空闲')).not.toBeNull()
    // 离线 host 与旧 hub host 不显示状态文字（also title 不带状态）
    expect(container.textContent).not.toContain('h5 · 思考中')
    expect(container.textContent).not.toContain('h6 · 空闲')
    // 思考中行：蓝色呼吸点
    const dots = container.querySelectorAll('span.h-1\\.5')
    expect(dots[0]?.className).toContain('bg-gn-blue')
    expect(dots[0]?.className).toContain('animate-pulse')
  })

  it('conn error → error 标签；layerErrors → ⚠ 异常', () => {
    const { rerender } = render(<TopBar />)
    expect(screen.getByText('Localhost')).not.toBeNull()
    resetChat({
      mode: 'hub',
      conn: 'connecting',
      hostName: 'H',
      hosts: [{ hostId: 'h1', hostName: 'H', online: true }],
    })
    rerender(<TopBar />)
    expect(screen.getByText('connecting')).not.toBeNull()
    resetChat({
      mode: 'hub',
      conn: 'error',
      hostName: 'H',
      hosts: [{ hostId: 'h1', hostName: 'H', online: true }],
    })
    rerender(<TopBar />)
    expect(screen.getByText('error')).not.toBeNull()
    resetChat({
      mode: 'hub',
      conn: 'ready',
      hostName: 'H',
      hosts: [{ hostId: 'h1', hostName: 'H', online: true }],
      layerErrors: { host: { level: 'error', message: 'host down', at: 1 } },
    })
    rerender(<TopBar />)
    expect(screen.getByText('⚠ 异常')).not.toBeNull()
  })

  it('host 下拉：右键当前 host 弹出操作菜单 → 打开修改名称弹窗', () => {
    resetChat({
      mode: 'hub',
      conn: 'ready',
      hostName: 'H',
      selectedHostId: 'h1',
      hosts: [{ hostId: 'h1', hostName: 'H', online: true }],
    })
    render(<TopBar />)
    fireEvent.contextMenu(screen.getByTitle(/右键可管理/))
    expect(screen.getByText('修改名称')).not.toBeNull()
    fireEvent.click(screen.getByText('修改名称'))
    expect(screen.getByText('修改 Host 名称')).not.toBeNull()
  })

  it('host 下拉：添加 Host 打开配对码弹窗', async () => {
    resetChat({
      mode: 'hub',
      conn: 'ready',
      hosts: [],
      hostId: 'local',
      hostName: 'Local Host',
    })
    render(<TopBar />)
    fireEvent.click(screen.getByTitle(/右键可管理/))
    fireEvent.click(screen.getByTitle(/获取新配对码/))
    await vi.waitFor(() => {
      expect(screen.getByText('PAIR-CODE-123')).not.toBeNull()
    })
  })

  it('退出登录在 host 下拉里（「添加 Host」下面），右上角不再有', () => {
    const onLogout = vi.fn()
    resetChat({
      mode: 'hub',
      conn: 'ready',
      hostName: 'H',
      selectedHostId: 'h1',
      hosts: [{ hostId: 'h1', hostName: 'H', online: true }],
    })
    accessToken = 'hub-key'
    const { container } = render(<TopBar onLogout={onLogout} />)
    // 收起时整个 header 里不该有退出入口。
    expect(container.querySelector('header')?.textContent).not.toContain('退出')
    fireEvent.click(screen.getByTitle(/右键可管理/))
    const add = screen.getByTitle('获取新配对码，在另一台机器上接入 hub')
    const out = screen.getByTitle('退出登录（清掉本机保存的 Hub 密钥；各台 Host 的近路钥匙保留）')
    // 顺序：退出登录紧跟在添加 Host 之后。
    expect(out.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    fireEvent.click(out)
    expect(onLogout).toHaveBeenCalled()
  })

  it('纯 local 模式没有 host 下拉，退出仍留在右上角', () => {
    const onLogout = vi.fn()
    resetChat({ mode: 'local', conn: 'ready', hostName: 'H' })
    accessToken = 'host-key'
    render(<TopBar onLogout={onLogout} />)
    expect(screen.queryByTitle(/右键可管理/)).toBeNull()
    fireEvent.click(screen.getByTitle('退出登录（清掉本机保存的 Hub 密钥；各台 Host 的近路钥匙保留）'))
    expect(onLogout).toHaveBeenCalled()
  })

  it('未登录（无门禁密钥）时不显示退出入口', () => {
    resetChat({
      mode: 'hub',
      conn: 'ready',
      hostName: 'H',
      hosts: [{ hostId: 'h1', hostName: 'H', online: true }],
    })
    const onLogout = vi.fn()
    const { container } = render(<TopBar onLogout={onLogout} />)
    fireEvent.click(screen.getByTitle(/右键可管理/))
    expect(container.textContent).not.toContain('退出')
    expect(onLogout).not.toHaveBeenCalled()
  })

  it('桌面操作按钮：mcp / git / ext / usage / settings', () => {
    const onOpenMcp = vi.fn()
    const onOpenGit = vi.fn()
    render(<TopBar onOpenMcp={onOpenMcp} onOpenGit={onOpenGit} />)
    fireEvent.click(screen.getByTitle('MCP 服务器状态'))
    expect(onOpenMcp).toHaveBeenCalled()
    fireEvent.click(screen.getByTitle('Git 面板 — 工作区状态 / diff / 提交'))
    expect(onOpenGit).toHaveBeenCalled()
    fireEvent.click(screen.getByTitle('扩展（/hooks /plugins /skills /marketplace）'))
    expect(useChatStore.getState().openExtensions).toHaveBeenCalledWith('hooks')
    fireEvent.click(screen.getByTitle('usage — token 用量聚合（按模型/时间窗口）+ billing credits'))
    expect(useChatStore.getState().openUsage).toHaveBeenCalled()
    fireEvent.click(screen.getByTitle('设置（F2）'))
    expect(useChatStore.getState().openSettings).toHaveBeenCalled()
  })

  it('侧边栏折叠按钮切换', () => {
    render(<TopBar />)
    fireEvent.click(screen.getByTitle('折叠会话侧边栏'))
    expect(useChatStore.getState().sidebarCollapsed).toBe(true)
    fireEvent.click(screen.getByTitle('展开会话侧边栏'))
    expect(useChatStore.getState().sidebarCollapsed).toBe(false)
  })

  it('移动端 new 按钮 → resetToEmpty', () => {
    render(<TopBar />)
    fireEvent.click(screen.getByTitle(/新建会话/))
    expect(useChatStore.getState().resetToEmpty).toHaveBeenCalled()
  })

  it('移动端历史按钮 → openHistory；面板出现会话列表', async () => {
    render(<TopBar />)
    fireEvent.click(screen.getByTitle('加载历史会话'))
    await vi.waitFor(() => {
      expect(useChatStore.getState().historyOpen).toBe(true)
      expect(screen.getByText('没有历史会话')).not.toBeNull()
    })
  })

  it('移动端历史下拉：搜索按钮展开搜索框，命中接管列表，收起后归位', async () => {
    render(<TopBar />)
    fireEvent.click(screen.getByTitle('加载历史会话'))
    await vi.waitFor(() => {
      expect(screen.getByText('没有历史会话')).not.toBeNull()
    })
    // 下拉头部有搜索按钮（与桌面侧边栏同款，移动端带文字大热区）。
    const searchBtn = screen.getByRole('button', { name: '搜索历史会话' })
    expect(searchBtn.textContent).toContain('搜索')
    expect(screen.getByTitle('刷新会话列表').textContent).toContain('刷新')
    fireEvent.click(searchBtn)
    const input = screen.getByPlaceholderText('全文搜索历史会话…')
    // 查询生效 → 分组列表让位给命中列表（空结果文案来自搜索框）。
    fireEvent.change(input, { target: { value: 'foo' } })
    await vi.waitFor(() => {
      expect(screen.queryByText('没有历史会话')).toBeNull()
      expect(screen.getByText('没有匹配的会话')).not.toBeNull()
    })
    // 收起下拉后重新打开：搜索归位为收起态（无输入框）。
    fireEvent.click(screen.getByRole('button', { name: 'close' }))
    fireEvent.click(screen.getByTitle('加载历史会话'))
    expect(screen.queryByPlaceholderText('全文搜索历史会话…')).toBeNull()
    await vi.waitFor(() => {
      expect(screen.getByText('没有历史会话')).not.toBeNull()
    })
  })

  it('移动端 ⋮ 菜单：主题手风琴 + 操作项', async () => {
    render(<TopBar />)
    fireEvent.click(screen.getByTitle('更多操作：theme / mcp / git / ext / settings'))
    const menu = screen.getByText('more').parentElement!
    fireEvent.click(within(menu).getByTitle('展开主题选项'))
    const tokyo = screen.getByText('Tokyo Night')
    fireEvent.click(tokyo)
    expect(useThemeStore.getState().preference).toBe('tokyonight')
    // 菜单已关闭（onSelect 收起）
    expect(screen.queryByText('more')).toBeNull()
    // 再次打开并点击 usage
    fireEvent.click(screen.getByTitle('更多操作：theme / mcp / git / ext / settings'))
    const menu2 = screen.getByText('more').parentElement!
    fireEvent.click(within(menu2).getAllByText('usage')[0])
    expect(useChatStore.getState().openUsage).toHaveBeenCalled()
  })
})