import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { transport } from '../../api/client'
import { useChatStore } from '../../store/chat'
import { EmptyStatePicker } from './EmptyState'
import { resetWorktreeGateCache } from './useWorktreeGate'

vi.mock('../../api/client', () => ({
  transport: {
    gitRepoRoot: vi.fn(),
    gitBranches: vi.fn(),
    // worktree 现在只在发送时创建；picker 侧不该碰这个端点（用例断言）。
    gitWorktreeCreate: vi.fn(),
    // historyPins 在模块顶层注册 prefs_changed 监听（chat store 导入链）；
    // 本文件不测 prefs，给个 no-op。
    onEvent: vi.fn(() => () => {}),
  },
}))

vi.mock('../ui/DirectoryPickerModal', () => ({
  DirectoryPickerModal: ({
    open,
    initial,
    onClose,
    onPick,
  }: {
    open: boolean
    initial?: string
    onClose: () => void
    onPick: (cwd: string) => void
  }) => (
    <div data-testid="dir-modal" data-open={open} data-initial={initial ?? ''}>
      <button onClick={() => onPick('/tmp/picked')}>pick</button>
      <button onClick={onClose}>close</button>
    </div>
  ),
}))

const repoRootMock = vi.mocked(transport.gitRepoRoot)
const branchesMock = vi.mocked(transport.gitBranches)
const wtCreateMock = vi.mocked(transport.gitWorktreeCreate)

describe('EmptyStatePicker', () => {
  beforeEach(() => {
    useChatStore.setState({
      emptyCwd: undefined,
      emptyWorktree: false,
      emptyWorktreePath: undefined,
      emptyWorktreeBusy: false,
      workspaces: [],
      sessions: [],
    })
    resetWorktreeGateCache()
    repoRootMock.mockReset()
    branchesMock.mockReset()
    wtCreateMock.mockReset()
    // 默认：branches 探针不表态（非仓库目录上 agent 就是报错），让
    // gitRepoRoot 单独决定门控结果。
    branchesMock.mockRejectedValue(new Error('-32603 Internal error') as never)
  })

  it('渲染 AGENTS / HERNESS 字符画（两段 pre）与引导文案', () => {
    const { container } = render(<EmptyStatePicker />)
    // 字符画是 figlet 风格 ASCII（非字母组块），断言两段 pre 与关键行。
    const pres = container.querySelectorAll('pre')
    expect(pres).toHaveLength(2)
    expect(pres[0].textContent).toContain('|___/')
    expect(pres[1].textContent).toContain('\\__,_|_|')
    expect(screen.getByText('for Grok Build')).toBeInTheDocument()
    // 未选目录 → 引导提示
    expect(
      screen.getByText('发送消息即可从此工作目录开始新对话'),
    ).toBeInTheDocument()
  })

  it('已选 emptyCwd → 显示目录路径', () => {
    useChatStore.setState({ emptyCwd: '~/ccwork/acp-fe' })
    const { container } = render(<EmptyStatePicker />)
    expect(container.textContent).toContain('~/ccwork/acp-fe')
  })

  it('点击「选择工作目录」→ 打开 DirectoryPickerModal；pick 写回 store', () => {
    const { container } = render(<EmptyStatePicker />)
    fireEvent.click(screen.getByText('选择工作目录'))
    const modal = container.querySelector('[data-testid="dir-modal"]')
    expect(modal?.getAttribute('data-open')).toBe('true')
    expect(modal?.getAttribute('data-initial')).toBe('')
    fireEvent.click(screen.getByText('pick'))
    expect(useChatStore.getState().emptyCwd).toBe('/tmp/picked')
    // pick 后 modal 仍开着（由 onClose 关闭）
    expect(container.querySelector('[data-testid="dir-modal"]')).not.toBeNull()
  })

  it('modal 关闭 → onClose 收起', () => {
    const { container } = render(<EmptyStatePicker />)
    fireEvent.click(screen.getByText('选择工作目录'))
    fireEvent.click(screen.getByText('close'))
    expect(
      container.querySelector('[data-testid="dir-modal"]')?.getAttribute('data-open'),
    ).toBe('false')
  })

  describe('快速选择（侧边栏已有目录）', () => {
    it('没有已知工作区 → 不渲染入口', () => {
      render(<EmptyStatePicker />)
      expect(screen.queryByText('快速选择')).toBeNull()
    })

    it('列出 workspace 与 live 会话的目录（去重、跳过空 cwd），点选写回 emptyCwd', () => {
      useChatStore.setState({
        workspaces: [
          {
            cwd: '/repo/a',
            label: 'a',
            sessions: [{ sessionId: 's1', cwd: '/repo/a' }],
          },
        ],
        sessions: [
          { sessionId: 's2', cwd: '/repo/b' },
          { sessionId: 's3', cwd: '/repo/a' },
          { sessionId: 's4' },
        ],
      })
      render(<EmptyStatePicker />)
      fireEvent.click(screen.getByText('快速选择'))
      const menu = screen.getByText('最近的工作目录').parentElement as HTMLElement
      const items = within(menu).getAllByRole('menuitem')
      expect(items).toHaveLength(2)
      // 每项两行：侧边栏短名（repoNameFromCwd）+ 完整路径。
      const label = (b: HTMLElement) => b.querySelectorAll('span span')[0]?.textContent
      const path = (b: HTMLElement) => b.querySelectorAll('span span')[1]?.textContent
      expect(items.map((b) => [label(b), path(b)])).toEqual([
        ['repo-a', '/repo/a'],
        ['repo-b', '/repo/b'],
      ])
      fireEvent.click(items[1]!)
      expect(useChatStore.getState().emptyCwd).toBe('/repo/b')
      // 选完收起菜单
      expect(screen.queryByText('最近的工作目录')).toBeNull()
    })

    it('点选当前已被选中的目录也照常收起菜单', () => {
      useChatStore.setState({
        emptyCwd: '/repo/a',
        workspaces: [{ cwd: '/repo/a', label: 'a', sessions: [] }],
      })
      render(<EmptyStatePicker />)
      fireEvent.click(screen.getByText('快速选择'))
      fireEvent.click(screen.getByRole('menuitem'))
      expect(useChatStore.getState().emptyCwd).toBe('/repo/a')
      expect(screen.queryByText('最近的工作目录')).toBeNull()
    })
  })

  describe('「使用 Worktree」开关', () => {
    it('emptyCwd 为空 → 完全不渲染开关，也不发探测请求', () => {
      render(<EmptyStatePicker />)
      expect(screen.queryByRole('button', { name: /Worktree/ })).toBeNull()
      expect(repoRootMock).not.toHaveBeenCalled()
    })

    it('git 仓库中 → 开关可点；按下只翻状态，不立刻建 worktree', async () => {
      useChatStore.setState({ emptyCwd: '/repo' })
      repoRootMock.mockResolvedValue({ gitRoot: '/repo' } as never)
      render(<EmptyStatePicker />)
      const btn = await screen.findByRole('button', { name: '使用 Worktree' })
      expect(btn).not.toBeDisabled()
      expect(btn.getAttribute('aria-pressed')).toBe('false')
      expect(repoRootMock).toHaveBeenCalledWith({ cwd: '/repo' })

      fireEvent.click(btn)
      expect(useChatStore.getState().emptyWorktree).toBe(true)
      // 关键契约：按下开关时不发建 worktree 请求（那是首条消息的事）。
      expect(wtCreateMock).not.toHaveBeenCalled()
      const off = screen.getByRole('button', { name: '关闭 Worktree' })
      expect(off.getAttribute('aria-pressed')).toBe('true')
    })

    it('再次按下 → 关闭状态并清掉自定义路径', async () => {
      useChatStore.setState({ emptyCwd: '/repo', emptyWorktree: true, emptyWorktreePath: '/wt/x' })
      repoRootMock.mockResolvedValue({ gitRoot: '/repo' } as never)
      render(<EmptyStatePicker />)
      const off = await screen.findByRole('button', { name: '关闭 Worktree' })
      // 开启时显示路径输入框（预填已有路径）
      expect(screen.getByPlaceholderText(/worktree 路径/)).toHaveValue('/wt/x')
      fireEvent.click(off)
      expect(useChatStore.getState().emptyWorktree).toBe(false)
      expect(useChatStore.getState().emptyWorktreePath).toBeUndefined()
      expect(screen.queryByPlaceholderText(/worktree 路径/)).toBeNull()
    })

    it('自定义路径输入写进 store，供发送时带上', async () => {
      useChatStore.setState({ emptyCwd: '/repo', emptyWorktree: true })
      repoRootMock.mockResolvedValue({ gitRoot: '/repo' } as never)
      render(<EmptyStatePicker />)
      fireEvent.change(await screen.findByPlaceholderText(/worktree 路径/), {
        target: { value: '/wt/x' },
      })
      expect(useChatStore.getState().emptyWorktreePath).toBe('/wt/x')
    })

    it('创建在飞 → 提示改成进行中且开关/路径输入禁用（不能重复触发）', async () => {
      useChatStore.setState({ emptyCwd: '/repo', emptyWorktree: true, emptyWorktreeBusy: true })
      repoRootMock.mockResolvedValue({ gitRoot: '/repo' } as never)
      render(<EmptyStatePicker />)
      expect(await screen.findByText('正在创建 worktree…')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '关闭 Worktree' })).toBeDisabled()
      expect(screen.getByPlaceholderText(/worktree 路径/)).toBeDisabled()
    })

    it('非 git 仓库 → 开关置灰且不可点，title 说明原因', async () => {
      useChatStore.setState({ emptyCwd: '/plain-dir' })
      repoRootMock.mockResolvedValue({} as never)
      render(<EmptyStatePicker />)
      const btn = await screen.findByRole('button', { name: '使用 Worktree' })
      expect(btn).toBeDisabled()
      expect(btn.getAttribute('title')).toBe('该目录不是 git 仓库')
      fireEvent.click(btn)
      expect(useChatStore.getState().emptyWorktree).toBeFalsy()
    })

    it('gitRepoRoot 抛错 → 开关置灰且不可点', async () => {
      useChatStore.setState({ emptyCwd: '/probe-err' })
      repoRootMock.mockRejectedValue(new Error('probe down') as never)
      render(<EmptyStatePicker />)
      const btn = await screen.findByRole('button', { name: '使用 Worktree' })
      expect(btn).toBeDisabled()
      expect(btn.getAttribute('title')).toContain('probe down')
    })

    it('旧 host：gitRepoRoot 报 Invalid params，gitBranches 给出 repoRoot → 开关仍可用', async () => {
      useChatStore.setState({ emptyCwd: '/repo' })
      repoRootMock.mockRejectedValue(new Error('Invalid params') as never)
      branchesMock.mockResolvedValue({ branches: [], repoRoot: '/repo' } as never)
      render(<EmptyStatePicker />)
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '使用 Worktree' })).not.toBeDisabled(),
      )
    })

    it('目录换成非 git 仓库 → 开关自动复位（不让按钮停在做不到的状态）', async () => {
      useChatStore.setState({ emptyCwd: '/repo', emptyWorktree: true })
      repoRootMock.mockResolvedValue({ gitRoot: '/repo' } as never)
      render(<EmptyStatePicker />)
      await screen.findByRole('button', { name: '关闭 Worktree' })

      useChatStore.setState({ emptyCwd: '/plain-dir' })
      repoRootMock.mockResolvedValue({} as never)
      await waitFor(() => {
        const btn = screen.getByRole('button', { name: '使用 Worktree' })
        expect(btn).toBeDisabled()
      })
      expect(useChatStore.getState().emptyWorktree).toBe(false)
    })
  })
})
