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

/** 打开「工作目录」下拉：触发器是空状态里唯一带 aria-haspopup 的按钮。 */
function openCwdMenu() {
  const trigger = screen
    .getAllByRole('button')
    .find((b) => b.getAttribute('aria-haspopup') === 'menu')
  if (!trigger) throw new Error('找不到工作目录下拉触发器')
  fireEvent.click(trigger)
  // 面板根（.gn-menu）：列表在内部滚动区，尾行「选择其他目录…」在滚动区之外。
  return document.querySelector('.gn-menu') as HTMLElement
}

/** 空状态里的工作目录触发器（有无已知目录都存在）。 */
function cwdTrigger() {
  return screen.getByRole('button', { name: /工作目录/ })
}

describe('EmptyStatePicker', () => {
  beforeEach(() => {
    useChatStore.setState({
      emptyCwd: undefined,
      emptyWorktree: false,
      emptyWorktreeLabel: undefined,
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

  it('已选 emptyCwd → 触发器显示短名，下方显示完整路径', () => {
    useChatStore.setState({ emptyCwd: '~/ccwork/acp-fe' })
    const { container } = render(<EmptyStatePicker />)
    expect(container.textContent).toContain('~/ccwork/acp-fe')
    // 触发器本身用侧边栏短名（末两段），不把整条路径塞进按钮。
    expect(screen.getByRole('button', { name: /acp-fe/ }).textContent).not.toContain('~/ccwork')
  })

  it('没有已知目录 → 触发器直接打开浏览弹窗（不弹只有一个选项的下拉）', () => {
    const { container } = render(<EmptyStatePicker />)
    expect(cwdTrigger().getAttribute('aria-haspopup')).toBeNull()
    fireEvent.click(cwdTrigger())
    expect(container.querySelector('[data-testid="dir-modal"]')?.getAttribute('data-open')).toBe(
      'true',
    )
    expect(container.querySelector('.gn-menu')).toBeNull()
    fireEvent.click(screen.getByText('pick'))
    expect(useChatStore.getState().emptyCwd).toBe('/tmp/picked')
  })

  it('有已知目录 → 下拉末行「选择其他目录…」打开浏览弹窗，并先收起菜单', () => {
    useChatStore.setState({ workspaces: [{ cwd: '/repo/a', label: 'a', sessions: [] }] })
    const { container } = render(<EmptyStatePicker />)
    const menu = openCwdMenu()
    fireEvent.click(within(menu).getByText('选择其他目录…'))
    expect(container.querySelector('[data-testid="dir-modal"]')?.getAttribute('data-open')).toBe(
      'true',
    )
    // 菜单在打开浏览弹窗前收起，避免两层浮层叠着。
    expect(container.querySelector('.gn-menu')).toBeNull()
  })

  it('尾行在滚动区之外：目录再多也不会被滚出面板', () => {
    // 面板高度上限挂在内部滚动区上；尾行是它的兄弟节点，常驻底部。
    useChatStore.setState({
      workspaces: Array.from({ length: 12 }, (_, i) => ({
        cwd: `/repo/${i}`,
        label: `${i}`,
        sessions: [],
      })),
    })
    render(<EmptyStatePicker />)
    const menu = openCwdMenu()
    const footer = within(menu).getByText('选择其他目录…')
    const scroller = menu.querySelector('.max-h-\\[55vh\\]')
    expect(scroller).not.toBeNull()
    expect(scroller!.contains(footer)).toBe(false)
    expect(menu.contains(footer)).toBe(true)
  })

  it('modal 中选中目录 → 写回 emptyCwd 并在触发器上显示', () => {
    useChatStore.setState({ workspaces: [{ cwd: '/repo/a', label: 'a', sessions: [] }] })
    const { container } = render(<EmptyStatePicker />)
    fireEvent.click(within(openCwdMenu()).getByText('选择其他目录…'))
    fireEvent.click(screen.getByText('pick'))
    expect(useChatStore.getState().emptyCwd).toBe('/tmp/picked')
    expect(cwdTrigger().textContent).toContain('tmp-picked')
    expect(container.querySelector('[data-testid="dir-modal"]')).not.toBeNull()
  })

  it('modal 关闭 → onClose 收起', () => {
    const { container } = render(<EmptyStatePicker />)
    fireEvent.click(cwdTrigger())
    fireEvent.click(screen.getByText('close'))
    expect(
      container.querySelector('[data-testid="dir-modal"]')?.getAttribute('data-open'),
    ).toBe('false')
  })

  describe('工作目录下拉', () => {
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
      const menu = openCwdMenu()
      const items = within(menu).getAllByRole('menuitem')
      // 目录各一条 + 末尾的「选择其他目录…」。
      expect(items).toHaveLength(3)
      // 每项两行：侧边栏短名（repoNameFromCwd）+ 完整路径。
      const name = (b: HTMLElement) => b.querySelectorAll('span span')[0]?.textContent
      const path = (b: HTMLElement) => b.querySelectorAll('span span')[1]?.textContent
      expect(items.slice(0, 2).map((b) => [name(b), path(b)])).toEqual([
        ['repo-a', '/repo/a'],
        ['repo-b', '/repo/b'],
      ])
      fireEvent.click(items[1]!)
      expect(useChatStore.getState().emptyCwd).toBe('/repo/b')
      // 选完收起菜单
      expect(screen.queryByText('选择其他目录…')).toBeNull()
    })

    it('点选当前已被选中的目录也照常收起菜单', () => {
      useChatStore.setState({
        emptyCwd: '/repo/a',
        workspaces: [{ cwd: '/repo/a', label: 'a', sessions: [] }],
      })
      render(<EmptyStatePicker />)
      const menu = openCwdMenu()
      fireEvent.click(within(menu).getAllByRole('menuitem')[0]!)
      expect(useChatStore.getState().emptyCwd).toBe('/repo/a')
      expect(screen.queryByText('选择其他目录…')).toBeNull()
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

    it('再次按下 → 关闭状态并清掉名称', async () => {
      useChatStore.setState({ emptyCwd: '/repo', emptyWorktree: true, emptyWorktreeLabel: 'my-wt' })
      repoRootMock.mockResolvedValue({ gitRoot: '/repo' } as never)
      render(<EmptyStatePicker />)
      const off = await screen.findByRole('button', { name: '关闭 Worktree' })
      // 开启时显示名称输入框（预填已有名称）
      expect(screen.getByLabelText('worktree 名称')).toHaveValue('my-wt')
      fireEvent.click(off)
      expect(useChatStore.getState().emptyWorktree).toBe(false)
      expect(useChatStore.getState().emptyWorktreeLabel).toBeUndefined()
      expect(screen.queryByLabelText('worktree 名称')).toBeNull()
    })

    it('名称输入写进 store，供发送时作为 label 带上', async () => {
      useChatStore.setState({ emptyCwd: '/repo', emptyWorktree: true })
      repoRootMock.mockResolvedValue({ gitRoot: '/repo' } as never)
      render(<EmptyStatePicker />)
      fireEvent.change(await screen.findByLabelText('worktree 名称'), {
        target: { value: 'fix login' },
      })
      expect(useChatStore.getState().emptyWorktreeLabel).toBe('fix login')
    })

    it('创建在飞 → 提示改成进行中且开关/名称输入禁用（不能重复触发）', async () => {
      useChatStore.setState({ emptyCwd: '/repo', emptyWorktree: true, emptyWorktreeBusy: true })
      repoRootMock.mockResolvedValue({ gitRoot: '/repo' } as never)
      render(<EmptyStatePicker />)
      expect(await screen.findByText('正在创建 worktree…')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '关闭 Worktree' })).toBeDisabled()
      expect(screen.getByLabelText('worktree 名称')).toBeDisabled()
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
      expect(useChatStore.getState().emptyWorktreeLabel).toBeUndefined()
    })
  })
})
