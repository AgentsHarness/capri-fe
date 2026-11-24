import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkspaceBar } from './WorkspaceBar'
import { useChatStore } from '../../store/chat'
import { usePromptQueue } from '../../store/promptQueue'

/** GET /api/subscribers（订阅者详情面板）。 */
const { listSubscribers } = vi.hoisted(() => ({
  listSubscribers: vi.fn(async () => [] as unknown[]),
}))

/** 已验证的本机近路候选（hostId → route），顶栏用它逐行标「直连 / 中继」。 */
const localRoutes = new Map<
  string,
  { base: string; port: number; authRequired: boolean }
>()
/** 显式通路选择（hostId → 'auto' | 'relay'）。 */
const routeChoices = new Map<string, string>()
/** 门禁那把：默认空 = 未登录（退出入口整体不显示）。 */
let accessToken = ''

vi.mock('../../api/client', () => ({
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
    hubStats: vi.fn(async () => ({})),
    listSubscribers,
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
    feSubscribers: undefined,
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

  it('单行不换行布局与芯片横向滑轨容器', () => {
    resetChat({ cwd: '/Volumes/SD10/' })
    const { container } = render(<WorkspaceBar />)
    const bar = container.querySelector('.h-\\[37px\\]')
    expect(bar).not.toBeNull()
    expect(bar?.className).toContain('flex-nowrap')
    const chipCluster = bar?.querySelector('.overflow-x-auto')
    expect(chipCluster).not.toBeNull()
    expect(chipCluster?.className).toContain('flex-nowrap')
    expect(chipCluster?.className).toContain('gn-no-scrollbar')
    // 包含移动端精简目录名 SD10 与完整路径 /Volumes/SD10/
    expect(container.textContent).toContain('SD10')
    expect(container.textContent).toContain('/Volumes/SD10/')
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

  it('上下文芯片回退用会话选中的窗口，不是模型默认', () => {
    // 选中 500k（模型默认 256k）：芯片分母必须跟着选中值，否则与模型菜单里
    // 高亮的 chip 自相矛盾。
    resetChat({
      usage: { used: 3000 },
      models: [
        {
          modelId: 'm1',
          name: 'M1',
          contextWindow: 256000,
          contextWindows: [256000, 500000],
          contextWindowSelection: 500000,
        },
      ],
      modelName: 'M1',
    })
    const { container } = render(<WorkspaceBar />)
    expect(container.textContent).toContain('3.0K/500K')
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
