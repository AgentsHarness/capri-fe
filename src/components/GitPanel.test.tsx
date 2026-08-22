import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { GitStatusData } from '../api/types'

// ── store / api client mock ──
const h = vi.hoisted(() => {
  const chatState: Record<string, unknown> = {}
  return {
    chatState,
    setStateSpy: vi.fn(),
    transport: {
      gitStatus: vi.fn(),
      gitBranches: vi.fn(),
      gitDiffs: vi.fn(),
      gitFiles: vi.fn(),
      gitDiscard: vi.fn(),
      gitUnstage: vi.fn(),
      gitStage: vi.fn(),
      gitCommit: vi.fn(),
      gitStash: vi.fn(),
      gitCheckout: vi.fn(),
      onEvent: vi.fn(),
    },
  }
})

vi.mock('../store/chat', () => ({
  useChatStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel(h.chatState),
    { getState: () => h.chatState, setState: h.setStateSpy },
  ),
}))

vi.mock('../api/client', () => ({
  transport: h.transport,
}))

import { GitPanel } from './GitPanel'

const { transport } = h

function setStore(patch: Record<string, unknown>) {
  Object.assign(h.chatState, patch)
}

const statusData: GitStatusData = {
  branch: 'main',
  ahead: 2,
  behind: 1,
  staged: [{ path: 'a.ts', type: 'edit', additions: 1, deletions: 2 }],
  unstaged: [
    { path: 'b.ts', type: 'untracked', additions: 3, deletions: 0 },
    { path: 'c.ts', type: 'edit', additions: 5, deletions: 6 },
  ],
}

beforeEach(() => {
  for (const k of Object.keys(h.chatState)) delete h.chatState[k]
  setStore({ cwd: '/work', gitInfo: undefined })
  transport.gitStatus.mockReset().mockResolvedValue(statusData)
  transport.gitBranches.mockReset().mockResolvedValue({
    branches: [
      { name: 'main', current: true },
      { name: 'dev', upstream: 'origin/dev' },
    ],
  })
  transport.gitDiffs.mockReset().mockResolvedValue({ files: [] })
  transport.gitFiles.mockReset().mockResolvedValue({ files: [] })
  transport.gitDiscard.mockReset().mockResolvedValue(undefined)
  transport.gitUnstage.mockReset().mockResolvedValue(undefined)
  transport.gitStage.mockReset().mockResolvedValue(undefined)
  transport.gitCommit.mockReset().mockResolvedValue(undefined)
  transport.gitStash.mockReset().mockResolvedValue(undefined)
  transport.gitCheckout.mockReset().mockResolvedValue(undefined)
  transport.onEvent.mockReset().mockReturnValue(vi.fn())
})

describe('GitPanel — 打开/关闭与状态', () => {
  it('open=false → null', () => {
    const { container } = render(<GitPanel open={false} onClose={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('打开拉取 status + branches；渲染分支计数与行状态', async () => {
    render(<GitPanel open onClose={() => {}} />)
    expect(await screen.findByText('a.ts')).not.toBeNull()
    expect(screen.getByText('b.ts')).not.toBeNull()
    expect(screen.getByText('c.ts')).not.toBeNull()
    expect(screen.getByTitle('main')).not.toBeNull()
    expect(screen.getByText('↑2')).not.toBeNull()
    expect(screen.getByText('↓1')).not.toBeNull()
    expect(screen.getByText('1 staged · 1 modified · 1 untracked')).not.toBeNull()
    expect(screen.getByText('分支 · 2')).not.toBeNull()
    expect(screen.getByRole('button', { name: /dev/ })).not.toBeNull()
    expect(transport.gitStatus).toHaveBeenCalledWith({ cwd: '/work', includeUntracked: true })
    expect(transport.gitBranches).toHaveBeenCalledWith({ cwd: '/work' })
  })

  it('status 失败 → 错误视图 + 重试；非 git 仓库提示', async () => {
    transport.gitStatus.mockRejectedValueOnce(new Error('git err'))
    const { container } = render(<GitPanel open onClose={() => {}} />)
    // 错误视图 + 底部 footer 各显示一次
    expect((await screen.findAllByText('git err')).length).toBeGreaterThanOrEqual(2)
    expect(container.textContent).toContain('host 调用失败')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('a.ts')).not.toBeNull()

    transport.gitStatus.mockRejectedValueOnce(new Error('fatal: not a git repository (or any parent up to /)'))
    const { container: c2 } = render(<GitPanel open onClose={() => {}} />)
    expect((await screen.findAllByText(/not a git repository/)).length).toBeGreaterThanOrEqual(2)
    expect(c2.textContent).toContain('当前目录不是 git 仓库')
  })

  it('gitInfo 兜底分支名（status 无 branch 时）', async () => {
    setStore({ gitInfo: { branch: 'fallback-branch' } })
    transport.gitStatus.mockResolvedValue({
      staged: [],
      unstaged: [],
    } as GitStatusData)
    const { container } = render(<GitPanel open onClose={() => {}} />)
    expect(await screen.findByText('fallback-branch')).not.toBeNull()
    expect(container.textContent).not.toContain('detached')
  })

  it('工作区无改动 → 空态', async () => {
    transport.gitStatus.mockResolvedValue({ branch: 'main', staged: [], unstaged: [] })
    render(<GitPanel open onClose={() => {}} />)
    expect(await screen.findByText('工作区没有改动 ✓')).not.toBeNull()
  })

  it('Esc / 背景点击关闭', async () => {
    const onClose = vi.fn()
    const { container } = render(<GitPanel open onClose={onClose} />)
    await screen.findByText('a.ts')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    const dialog = container.querySelector('div[role="dialog"]')!
    fireEvent.mouseDown(dialog.firstElementChild!) // 面板内不关
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.mouseDown(dialog) // 背景关闭
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('sessions_changed / git_head_changed 事件触发静默刷新', async () => {
    let evHandler: ((ev: { type: string }) => void) | null = null
    transport.onEvent.mockImplementation((cb: (ev: { type: string }) => void) => {
      evHandler = cb
      return vi.fn()
    })
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    act(() => evHandler?.({ type: 'sessions_changed' }))
    await waitFor(() => expect(transport.gitStatus).toHaveBeenCalledTimes(2))
  })
})

describe('GitPanel — diff 预览', () => {
  it('选择文件 → gitDiffs；patch 渲染为 diff 行', async () => {
    transport.gitDiffs.mockResolvedValue({
      files: [
        {
          path: 'a.ts',
          type: 'edit',
          additions: 1,
          deletions: 1,
          patch: 'diff --git a/a.ts b/a.ts\nindex 12..34\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old line\n+new line',
        },
      ],
    })
    render(<GitPanel open onClose={() => {}} />)
    fireEvent.click(await screen.findByText('a.ts'))
    expect(await screen.findByText(/diff · a.ts/)).not.toBeNull()
    expect(screen.getByText('old line')).not.toBeNull()
    expect(screen.getByText('new line')).not.toBeNull()
    expect(transport.gitDiffs).toHaveBeenCalledWith({
      cwd: '/work',
      from: 'HEAD',
      to: 'working',
      paths: ['a.ts'],
    })
  })

  it('untracked 文件 → gitFiles 工作区内容预览', async () => {
    transport.gitDiffs.mockResolvedValue({ files: [] })
    transport.gitFiles.mockResolvedValue({
      files: [{ path: 'b.ts', version: 'working', content: 'alpha\nbeta\n' }],
    })
    render(<GitPanel open onClose={() => {}} />)
    fireEvent.click(await screen.findByText('b.ts'))
    expect(await screen.findByText('alpha')).not.toBeNull()
    expect(screen.getByText(/untracked 文件/)).not.toBeNull()
    expect(transport.gitFiles).toHaveBeenCalledWith({
      cwd: '/work',
      paths: ['b.ts'],
      version: 'working',
    })
  })

  it('untracked 二进制 → 无内容预览提示', async () => {
    transport.gitDiffs.mockResolvedValue({ files: [] })
    transport.gitFiles.mockResolvedValue({
      files: [{ path: 'b.ts', version: 'working', content: '', isBinary: true }],
    })
    render(<GitPanel open onClose={() => {}} />)
    fireEvent.click(await screen.findByText('b.ts'))
    expect(await screen.findByText('二进制文件，无内容预览')).not.toBeNull()
  })

  it('无 patch → 仅统计提示', async () => {
    transport.gitDiffs.mockResolvedValue({
      files: [{ path: 'a.ts', type: 'edit', additions: 1, deletions: 2 }],
    })
    render(<GitPanel open onClose={() => {}} />)
    fireEvent.click(await screen.findByText('a.ts'))
    expect(await screen.findByText(/host 未返回 patch 内容/)).not.toBeNull()
    expect(screen.getByText('（无 diff 内容）')).not.toBeNull()
  })

  it('gitDiffs 失败 → diff error 行', async () => {
    transport.gitDiffs.mockRejectedValue(new Error('diff boom'))
    render(<GitPanel open onClose={() => {}} />)
    fireEvent.click(await screen.findByText('a.ts'))
    expect(await screen.findByText('diff boom')).not.toBeNull()
  })

  it('再次点击取消选中 → 回到占位', async () => {
    transport.gitDiffs.mockResolvedValue({
      files: [
        {
          path: 'a.ts',
          type: 'edit',
          additions: 1,
          deletions: 1,
          patch: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-x\n+y',
        },
      ],
    })
    render(<GitPanel open onClose={() => {}} />)
    const row = await screen.findByText('a.ts')
    fireEvent.click(row)
    await screen.findByText(/diff · a.ts/)
    fireEvent.click(row)
    expect(await screen.findByText('选择左侧文件查看 diff')).not.toBeNull()
  })
})

describe('GitPanel — 操作按钮', () => {
  it('stage / unstage 调用对应 RPC', async () => {
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'unstage' }))
    await waitFor(() =>
      expect(transport.gitUnstage).toHaveBeenCalledWith({ cwd: '/work', paths: ['a.ts'] }),
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'stage' })[0])
    await waitFor(() =>
      expect(transport.gitStage).toHaveBeenCalledWith({ cwd: '/work', paths: ['c.ts'] }),
    )
  })

  it('discard 两段确认：第二次点击确认才提交', async () => {
    render(<GitPanel open onClose={() => {}} />)
    const discard = await screen.findAllByRole('button', { name: 'discard' })
    fireEvent.click(discard[1]) // c.ts modified
    expect(screen.getByRole('button', { name: '确认？' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '确认？' }))
    expect(transport.gitDiscard).toHaveBeenCalledWith({ cwd: '/work', paths: ['c.ts'] })
  })

  it('discard 确认窗口超时后失效', async () => {
    render(<GitPanel open onClose={() => {}} />)
    const discard = await screen.findAllByRole('button', { name: 'discard' })
    vi.useFakeTimers()
    fireEvent.click(discard[1])
    act(() => {
      vi.advanceTimersByTime(2100)
    })
    expect(screen.queryByRole('button', { name: '确认？' })).toBeNull()
    fireEvent.click(discard[1])
    expect(transport.gitDiscard).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('untracked discard 带 includeUntracked', async () => {
    render(<GitPanel open onClose={() => {}} />)
    // 行排序：staged(a.ts) → modified(c.ts) → untracked(b.ts)
    const discard = await screen.findAllByRole('button', { name: 'discard' })
    fireEvent.click(discard[2]) // b.ts untracked
    fireEvent.click(screen.getByRole('button', { name: '确认？' }))
    await waitFor(() =>
      expect(transport.gitDiscard).toHaveBeenCalledWith({
        cwd: '/work',
        paths: ['b.ts'],
        includeUntracked: true,
      }),
    )
  })

  it('commit：按钮与 Enter 提交；amend 附带 amend 标记', async () => {
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    const input = screen.getByPlaceholderText('提交信息（Enter 提交）')
    fireEvent.change(input, { target: { value: 'fix: 修 bug' } })
    fireEvent.click(screen.getByRole('button', { name: 'commit' }))
    await waitFor(() =>
      expect(transport.gitCommit).toHaveBeenCalledWith({
        cwd: '/work',
        message: 'fix: 修 bug',
      }),
    )
    fireEvent.change(input, { target: { value: 'amend it' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'amend' }))
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(transport.gitCommit).toHaveBeenCalledWith({
        cwd: '/work',
        message: 'amend it',
        amend: true,
      }),
    )
  })

  it('stash 按钮 → gitStash', async () => {
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'stash' }))
    await waitFor(() => expect(transport.gitStash).toHaveBeenCalledWith({ cwd: '/work' }))
  })

  it('checkout 两段确认 → gitCheckout + 分支刷新', async () => {
    render(<GitPanel open onClose={() => {}} />)
    const dev = await screen.findByRole('button', { name: /dev/ })
    fireEvent.click(dev)
    fireEvent.click(dev)
    await waitFor(() =>
      expect(transport.gitCheckout).toHaveBeenCalledWith({ cwd: '/work', branch: 'dev' }),
    )
    await waitFor(() => expect(transport.gitBranches).toHaveBeenCalledTimes(2))
  })

  it('当前分支按钮禁用；操作失败 → opError 行', async () => {
    transport.gitStage.mockRejectedValue(new Error('stage boom'))
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    expect(screen.getByRole('button', { name: /main/ })).toBeDisabled()
    fireEvent.click(screen.getAllByRole('button', { name: 'stage' })[0])
    expect(await screen.findByText(/stage c\.ts 失败: stage boom/)).not.toBeNull()
  })
})