import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { GuestShell } from './App'
import { useChatStore } from './store/chat'

/**
 * 访客壳的组成就是它的权限边界：Composer 以只读态挂载（看得到、输入不了），
 * 侧栏、审批/问题卡、设置/MCP/Git/usage 等任何写入口都不挂。这里用轻量替身
 * 验证「挂了什么、没挂什么」，不渲染真实组件树（Scrollback 会拖进整条历史管线）。
 */
vi.mock('./api/client', () => ({
  transport: {
    onEvent: () => () => {},
    connect: vi.fn(),
    disconnect: vi.fn(),
    getConnectionMode: vi.fn(() => 'hub'),
    getHost: vi.fn(() => 'h1'),
    isGuest: vi.fn(() => true),
    discoverLocalHost: vi.fn(async () => null),
    getLocalHostId: vi.fn(() => null),
    refreshGitInfo: vi.fn(),
  },
}))
vi.mock('./hooks/useScrollbackKeys', () => ({ useScrollbackKeys: vi.fn() }))
vi.mock('./components/shell/GuestTopBar', () => ({
  GuestTopBar: ({ onExit }: { onExit: () => void }) => (
    <button type="button" onClick={onExit}>
      guest-topbar
    </button>
  ),
}))
vi.mock('./components/scrollback/Scrollback', () => ({
  Scrollback: ({ guest }: { guest?: boolean }) => (
    <div data-testid="scrollback">{guest ? 'scrollback-guest' : 'scrollback-admin'}</div>
  ),
}))
vi.mock('./components/shell/BlockViewer', () => ({ BlockViewer: () => <div>block-viewer</div> }))
vi.mock('./components/ui/ToastStack', () => ({ ToastStack: () => <div>toasts</div> }))
vi.mock('./components/session/SessionStatsBar', () => ({
  SessionStatsBar: () => <div>session-stats</div>,
}))
vi.mock('./components/composer/Composer', () => ({
  Composer: ({ guest }: { guest?: boolean }) => (
    <div>{guest ? 'composer-guest' : 'composer-admin'}</div>
  ),
}))
vi.mock('./components/session/HistorySidebar', () => ({
  HistorySidebar: () => <div>sidebar-should-not-mount</div>,
}))
vi.mock('./components/panels/SettingsModal', () => ({
  SettingsModal: () => <div>settings-should-not-mount</div>,
}))
vi.mock('./components/panels/McpPanel', () => ({
  McpPanel: () => <div>mcp-should-not-mount</div>,
}))
vi.mock('./components/panels/GitPanel', () => ({
  GitPanel: () => <div>git-should-not-mount</div>,
}))
vi.mock('./components/approvals/ApprovalStrip', () => ({
  ApprovalStrip: () => <div>approval-should-not-mount</div>,
}))
vi.mock('./components/approvals/QuestionModal', () => ({
  QuestionModal: () => <div>question-should-not-mount</div>,
}))

const first = {
  hostId: 'h1',
  hostName: 'H1',
  sessionId: 's1',
  cwd: '/w1',
  title: 'one',
}

beforeEach(() => {
  useChatStore.setState({
    guestIdentity: {
      role: 'guest',
      guest: { id: 'g_1', label: '给小王', expiresAt: 0 },
      sessions: [first],
    },
    guestSessions: [first],
    sessionId: undefined,
    cwd: undefined,
    switchGuestSession: vi.fn(async () => {}),
    init: (() => () => {}) as never,
  })
})

describe('GuestShell', () => {
  it('挂顶栏 / 滚动区 / 只读 Composer / 查看器 / toast，不挂任何写入口', async () => {
    render(<GuestShell onExit={() => {}} />)
    expect(screen.getByText('guest-topbar')).toBeInTheDocument()
    // Composer 可见，但以 guest 只读态挂载（输入框禁用、无写入口）——
    // 会话状态也长在它的状态行里，不再另挂一条独立的只读状态线。
    expect(screen.getByText('composer-guest')).toBeInTheDocument()
    expect(screen.queryByText('composer-admin')).toBeNull()
    expect(screen.getByTestId('scrollback').textContent).toBe('scrollback-guest')
    expect(screen.getByText('block-viewer')).toBeInTheDocument()
    expect(screen.getByText('toasts')).toBeInTheDocument()
    // 会话统计条是只读聚合（/api/session-stats 在访客白名单里），照常挂载。
    expect(screen.getByText('session-stats')).toBeInTheDocument()
    for (const absent of [
      'sidebar-should-not-mount',
      'settings-should-not-mount',
      'mcp-should-not-mount',
      'git-should-not-mount',
      'approval-should-not-mount',
      'question-should-not-mount',
    ]) {
      expect(screen.queryByText(absent)).toBeNull()
    }
  })

  it('首次进入默认选中白名单第一条（只读加载）', async () => {
    render(<GuestShell onExit={() => {}} />)
    const sw = useChatStore.getState().switchGuestSession
    await waitFor(() => expect(sw).toHaveBeenCalledWith(first))
  })

  it('已加载出历史时不重复切换（刷新/重连不重置视图）', async () => {
    useChatStore.setState({
      sessionId: 's1',
      cwd: '/w1',
      historyLoadedAt: Date.now(),
      entries: [{ id: 'e1', kind: 'user', text: 'hi' }],
    })
    render(<GuestShell onExit={() => {}} />)
    await new Promise((r) => setTimeout(r, 0))
    expect(useChatStore.getState().switchGuestSession).not.toHaveBeenCalled()
  })
})

import { fireEvent } from '@testing-library/react'

describe('GuestShell 退出', () => {
  it('退出按顶栏按钮就调用 onExit（恢复/回门禁由 App 决定）', async () => {
    const onExit = vi.fn()
    render(<GuestShell onExit={onExit} />)
    fireEvent.click(screen.getByText('guest-topbar'))
    expect(onExit).toHaveBeenCalledTimes(1)
  })
})
