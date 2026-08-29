import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { transport } from '../../api/client'
import { useChatStore } from '../../store/chat'
import { EmptyStatePicker } from './EmptyState'
import { resetWorktreeGateCache } from './useWorktreeGate'

vi.mock('../../api/client', () => ({
  transport: {
    gitRepoRoot: vi.fn(),
    gitWorktreeCreate: vi.fn(),
    // historyPins 在模块顶层注册 prefs_changed 监听（chat store 导入链）；
    // 本文件不测 prefs，给个 no-op。
    onEvent: vi.fn(() => () => {}),
  },
}))

vi.mock('../DirectoryPickerModal', () => ({
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
const wtCreateMock = vi.mocked(transport.gitWorktreeCreate)

describe('EmptyStatePicker', () => {
  beforeEach(() => {
    useChatStore.setState({ emptyCwd: undefined })
    resetWorktreeGateCache()
    repoRootMock.mockReset()
    wtCreateMock.mockReset()
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

  describe('「在新 worktree 中开始」', () => {
    it('emptyCwd 为空 → 完全不渲染入口，也不发探测请求', () => {
      render(<EmptyStatePicker />)
      expect(
        screen.queryByRole('button', { name: /在新 worktree 中开始/ }),
      ).toBeNull()
      expect(repoRootMock).not.toHaveBeenCalled()
      expect(wtCreateMock).not.toHaveBeenCalled()
    })

    it('emptyCwd 在 git 仓库中 → 渲染可用入口；点击调 gitWorktreeCreate 并把返回路径写进 emptyCwd', async () => {
      useChatStore.setState({ emptyCwd: '/repo' })
      repoRootMock.mockResolvedValue({ gitRoot: '/repo' } as never)
      wtCreateMock.mockResolvedValue({
        status: 'creating',
        sessionId: 's1',
        worktreePath: '/repo-wt',
      } as never)
      render(<EmptyStatePicker />)
      const btn = await screen.findByRole('button', { name: /在新 worktree 中开始/ })
      expect(btn).not.toBeDisabled()
      expect(repoRootMock).toHaveBeenCalledWith({ cwd: '/repo' })
      fireEvent.click(btn)
      await waitFor(() => {
        expect(wtCreateMock).toHaveBeenCalledWith({
          sourcePath: '/repo',
          copyMode: 'dirty',
        })
        expect(useChatStore.getState().emptyCwd).toBe('/repo-wt')
        expect(useChatStore.getState().statusText).toContain('worktree')
      })
    })

    it('gitRepoRoot 返回空（非 git 仓库）→ 入口置灰且不可点击，title 说明原因', async () => {
      useChatStore.setState({ emptyCwd: '/plain-dir' })
      repoRootMock.mockResolvedValue({} as never)
      render(<EmptyStatePicker />)
      const btn = await screen.findByRole('button', { name: /在新 worktree 中开始/ })
      expect(btn).toBeDisabled()
      expect(btn.getAttribute('title')).toBe('该目录不是 git 仓库')
      fireEvent.click(btn)
      expect(wtCreateMock).not.toHaveBeenCalled()
    })

    it('gitRepoRoot 抛错 → 入口置灰且不可点击', async () => {
      useChatStore.setState({ emptyCwd: '/probe-err' })
      repoRootMock.mockRejectedValue(new Error('probe down') as never)
      render(<EmptyStatePicker />)
      const btn = await screen.findByRole('button', { name: /在新 worktree 中开始/ })
      expect(btn).toBeDisabled()
      expect(btn.getAttribute('title')).toContain('probe down')
      fireEvent.click(btn)
      expect(wtCreateMock).not.toHaveBeenCalled()
    })

    it('进行中重复点击不会发第二次请求；失败时原位显示错误并可重试', async () => {
      useChatStore.setState({ emptyCwd: '/repo' })
      repoRootMock.mockResolvedValue({ gitRoot: '/repo' } as never)
      wtCreateMock.mockRejectedValueOnce(new Error('暂无活动会话'))
      wtCreateMock.mockResolvedValueOnce({
        status: 'creating',
        worktreePath: '/repo-wt',
      } as never)
      render(<EmptyStatePicker />)
      const btn = await screen.findByRole('button', { name: /在新 worktree 中开始/ })
      // 第一次点击：失败 → 原位错误 + 重试
      fireEvent.click(btn)
      expect(await screen.findByText('暂无活动会话')).toBeInTheDocument()
      expect(wtCreateMock).toHaveBeenCalledTimes(1)
      // 重试成功 → emptyCwd 写回；中间不再有额外请求
      fireEvent.click(screen.getByText('重试'))
      await waitFor(() => expect(useChatStore.getState().emptyCwd).toBe('/repo-wt'))
      expect(wtCreateMock).toHaveBeenCalledTimes(2)
    })

    it('进行中按钮禁用：悬而未决时第二次点击不发请求', async () => {
      useChatStore.setState({ emptyCwd: '/repo' })
      repoRootMock.mockResolvedValue({ gitRoot: '/repo' } as never)
      let resolveCreate!: (v: unknown) => void
      wtCreateMock.mockReturnValueOnce(
        new Promise((r) => {
          resolveCreate = r
        }) as never,
      )
      render(<EmptyStatePicker />)
      const btn = await screen.findByRole('button', { name: /在新 worktree 中开始/ })
      fireEvent.click(btn)
      // 进行中：按钮换成「正在创建 worktree…」且禁用
      expect(
        screen.getByRole('button', { name: /正在创建 worktree/ }),
      ).toBeDisabled()
      fireEvent.click(btn)
      fireEvent.click(screen.getByRole('button', { name: /正在创建 worktree/ }))
      await waitFor(() => expect(wtCreateMock).toHaveBeenCalledTimes(1))
      resolveCreate({ status: 'creating', worktreePath: '/repo-wt' })
      await waitFor(() => expect(useChatStore.getState().emptyCwd).toBe('/repo-wt'))
      expect(wtCreateMock).toHaveBeenCalledTimes(1)
    })

    it('填入自定义 worktree 路径 → 随请求带上 worktreePath；留空不带', async () => {
      useChatStore.setState({ emptyCwd: '/repo' })
      repoRootMock.mockResolvedValue({ gitRoot: '/repo' } as never)
      wtCreateMock.mockResolvedValue({ status: 'creating', worktreePath: '/wt/x' } as never)
      render(<EmptyStatePicker />)
      const btn = await screen.findByRole('button', { name: /在新 worktree 中开始/ })
      fireEvent.change(screen.getByPlaceholderText(/worktree 路径/), {
        target: { value: '/wt/x' },
      })
      fireEvent.click(btn)
      await waitFor(() =>
        expect(wtCreateMock).toHaveBeenCalledWith({
          sourcePath: '/repo',
          worktreePath: '/wt/x',
          copyMode: 'dirty',
        }),
      )
    })

    it('同 cwd 不重复探测（结果按 cwd 缓存）；cwd 变化重新探测', async () => {
      useChatStore.setState({ emptyCwd: '/repo' })
      repoRootMock.mockResolvedValue({ gitRoot: '/repo' } as never)
      const { rerender } = render(<EmptyStatePicker />)
      await screen.findByRole('button', { name: /在新 worktree 中开始/ })
      rerender(<EmptyStatePicker />)
      await screen.findByRole('button', { name: /在新 worktree 中开始/ })
      expect(repoRootMock).toHaveBeenCalledTimes(1)
      // cwd 变化 → 重新探测新目录
      useChatStore.setState({ emptyCwd: '/repo2' })
      repoRootMock.mockResolvedValue({ gitRoot: '/repo2' } as never)
      rerender(<EmptyStatePicker />)
      await waitFor(() => expect(repoRootMock).toHaveBeenCalledWith({ cwd: '/repo2' }))
      expect(repoRootMock).toHaveBeenCalledTimes(2)
    })
  })
})