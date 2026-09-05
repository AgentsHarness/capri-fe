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
      gitLog: vi.fn(),
      gitPush: vi.fn(),
      gitPull: vi.fn(),
      gitFetch: vi.fn(),
      gitInit: vi.fn(),
      gitStashList: vi.fn(),
      gitStashPop: vi.fn(),
      gitStashDrop: vi.fn(),
      gitBranchCreate: vi.fn(),
      gitBranchDelete: vi.fn(),
      gitStageContent: vi.fn(),
      gitRepoState: vi.fn(),
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
  transport.gitLog.mockReset().mockResolvedValue({
    ok: true,
    commits: [
      {
        hash: '1234567890abcdef',
        shortHash: '1234567',
        author: 'Alice',
        email: 'alice@example.com',
        timestamp: 1600000000,
        date: '2020-09-13T12:26:40.000Z',
        message: 'feat: add awesome feature',
        refs: 'HEAD -> main, origin/main',
      },
    ],
  })
  transport.gitPush.mockReset().mockResolvedValue({ ok: true })
  transport.gitPull.mockReset().mockResolvedValue({ ok: true })
  transport.gitFetch.mockReset().mockResolvedValue({ ok: true })
  transport.gitInit.mockReset().mockResolvedValue({ ok: true })
  transport.gitStashList.mockReset().mockResolvedValue({
    ok: true,
    stashes: [
      {
        index: 0,
        ref: 'stash@{0}',
        hash: 'abc1234',
        date: '2026-09-05T10:15:00+08:00',
        message: 'WIP on main',
      },
    ],
  })
  transport.gitStashPop.mockReset().mockResolvedValue({ ok: true })
  transport.gitStashDrop.mockReset().mockResolvedValue({ ok: true })
  transport.gitBranchCreate.mockReset().mockResolvedValue({ ok: true })
  transport.gitBranchDelete.mockReset().mockResolvedValue({ ok: true })
  transport.gitStageContent.mockReset().mockResolvedValue(undefined)
  transport.gitRepoState.mockReset().mockResolvedValue({
    mergeInProgress: false,
    rebaseInProgress: false,
    cherryPickInProgress: false,
    conflicts: [],
    conflictCount: 0,
  })
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
    expect(screen.getByText('已暂存')).not.toBeNull()
    expect(screen.getByText('已修改')).not.toBeNull()
    expect(screen.getByText('未跟踪')).not.toBeNull()
    expect(transport.gitStatus).toHaveBeenCalledWith({ cwd: '/work', includeUntracked: true })
    expect(transport.gitBranches).toHaveBeenCalledWith({ cwd: '/work' })
    // 打开时静默 fetch，使 ahead/behind 反映远端真实状态
    await waitFor(() => expect(transport.gitFetch).toHaveBeenCalledWith({ cwd: '/work' }))
    // HEAD 锚点 chip（含提交主题 + 复制提示）
    expect(await screen.findByTitle(/点击复制完整哈希/)).not.toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: '分支与同步' }))
    expect(await screen.findByText('分支 · 2')).not.toBeNull()
    expect(screen.getByRole('button', { name: /dev/ })).not.toBeNull()
  })

  it('status 失败 → 错误视图 + 重试；非 git 仓库提示', async () => {
    // 打开时会触发两次 gitStatus（首次 + 静默 fetch 后补刷），用持续 rejection
    // 保证错误视图稳定。
    transport.gitStatus.mockRejectedValue(new Error('git err'))
    const { container } = render(<GitPanel open onClose={() => {}} />)
    expect((await screen.findAllByText('git err')).length).toBeGreaterThanOrEqual(1)
    expect(container.textContent).toContain('host 调用失败')
    transport.gitStatus.mockResolvedValue(statusData)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('a.ts')).not.toBeNull()

    transport.gitStatus.mockRejectedValue(new Error('fatal: not a git repository (or any parent up to /)'))
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
    // 3 次 = 打开时 1 次 + 静默 fetch 后补刷 1 次 + 事件触发 1 次
    await waitFor(() => expect(transport.gitStatus).toHaveBeenCalledTimes(3))
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
    // 验证 @@ 块信息不重复出现（之前曾出现 hunk header 与 diff row 双重渲染）
    expect(screen.getAllByText(/@@ -1 \+1 @@/)).toHaveLength(1)
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
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('tab', { name: '分支与同步' }))
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
    fireEvent.click(screen.getAllByRole('button', { name: 'stage' })[0])
    expect(await screen.findByText(/stage c\.ts 失败: stage boom/)).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '分支与同步' }))
    expect(screen.getByRole('button', { name: /main/ })).toBeDisabled()
  })
})

describe('GitPanel — 移动端多Tab与高级特性', () => {
  it('全部暂存 (Stage All) 与 全部取消 (Unstage All)', async () => {
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: '全部暂存' }))
    await waitFor(() =>
      expect(transport.gitStage).toHaveBeenCalledWith({
        cwd: '/work',
        paths: ['c.ts', 'b.ts'],
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: '全部取消' }))
    await waitFor(() =>
      expect(transport.gitUnstage).toHaveBeenCalledWith({
        cwd: '/work',
        paths: ['a.ts'],
      }),
    )
  })

  it('AI 生成 Commit 信息', async () => {
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    const aiBtn = screen.getByRole('button', { name: /AI 描述/ })
    fireEvent.click(aiBtn)
    const input = screen.getByPlaceholderText('提交信息（Enter 提交）') as HTMLInputElement
    expect(input.value).toMatch(/^feat: update a\.ts/)
  })

  it('Hunk 块级暂存', async () => {
    transport.gitDiffs.mockResolvedValue({
      files: [
        {
          path: 'c.ts',
          type: 'edit',
          additions: 1,
          deletions: 1,
          patch: 'diff --git a/c.ts b/c.ts\n@@ -1,3 +1,3 @@\n-old code\n+new awesome code',
        },
      ],
    })
    render(<GitPanel open onClose={() => {}} />)
    fireEvent.click(await screen.findByText('c.ts'))
    const stageHunkBtn = await screen.findByRole('button', { name: '暂存此块' })
    fireEvent.click(stageHunkBtn)
    await waitFor(() => {
      expect(transport.gitStageContent).toHaveBeenCalled()
      expect(transport.gitStage).toHaveBeenCalledWith({
        cwd: '/work',
        paths: ['c.ts'],
      })
    })
  })

  it('切换到历史 Tab (log) → 显示 commit 列表', async () => {
    const { container } = render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('tab', { name: '历史' }))
    const detailPlaceholder = await screen.findByText('选择左侧提交查看详细信息')
    expect(detailPlaceholder).toHaveClass('sm:w-[320px]', 'sm:shrink-0')
    // HEAD 锚点 chip 与提交行可能出现同文案（同一提交），用 getAllByText
    expect((await screen.findAllByText('feat: add awesome feature')).length).toBeGreaterThanOrEqual(1)
    expect(container.querySelector('svg circle')).not.toBeNull()
    expect(screen.getAllByText('1234567').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Alice')).not.toBeNull()
    expect(transport.gitLog).toHaveBeenCalledWith({ cwd: '/work', maxCount: 30 })
  })

  it('切换到分支与同步 Tab (sync) → Fetch / Pull / Push 操作', async () => {
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('tab', { name: '分支与同步' }))
    expect(await screen.findByText('远程仓库同步')).not.toBeNull()

    // Fetch
    fireEvent.click(screen.getByRole('button', { name: /Fetch/ }))
    await waitFor(() => expect(transport.gitFetch).toHaveBeenCalledWith({ cwd: '/work' }))

    // Pull
    fireEvent.click(screen.getByRole('button', { name: /Pull/ }))
    await waitFor(() => expect(transport.gitPull).toHaveBeenCalledWith({ cwd: '/work' }))

    // Push
    fireEvent.click(screen.getByRole('button', { name: /Push/ }))
    await waitFor(() => expect(transport.gitPush).toHaveBeenCalledWith({ cwd: '/work' }))
  })

  it('新建分支与删除分支', async () => {
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('tab', { name: '分支与同步' }))

    const input = await screen.findByPlaceholderText('新分支名称')
    fireEvent.change(input, { target: { value: 'feature/mobile-git' } })
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    await waitFor(() =>
      expect(transport.gitBranchCreate).toHaveBeenCalledWith({
        cwd: '/work',
        branch: 'feature/mobile-git',
        checkout: true,
      }),
    )

    // 删除 dev 分支（非当前分支）
    const deleteBtns = screen.getAllByTitle('删除此分支')
    fireEvent.click(deleteBtns[0])
    await waitFor(() =>
      expect(transport.gitBranchDelete).toHaveBeenCalledWith({
        cwd: '/work',
        branch: 'dev',
        force: true,
      }),
    )
  })

  it('Stash 列表管理：Pop 与 Drop', async () => {
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('tab', { name: '分支与同步' }))

    expect(await screen.findByText('WIP on main')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pop' }))
    await waitFor(() =>
      expect(transport.gitStashPop).toHaveBeenCalledWith({
        cwd: '/work',
        index: 'stash@{0}',
      }),
    )

    // Drop 两段确认
    fireEvent.click(screen.getByRole('button', { name: 'Drop' }))
    expect(screen.getByRole('button', { name: '确认？' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '确认？' }))
    await waitFor(() =>
      expect(transport.gitStashDrop).toHaveBeenCalledWith({
        cwd: '/work',
        index: 'stash@{0}',
      }),
    )
  })

  it('非 git 仓库提示与一键初始化，且隐藏其他功能', async () => {
    // 持续 rejection：打开后会补刷一次 status，Once 会让非仓库视图闪没。
    transport.gitStatus.mockRejectedValue(new Error('fatal: not a git repository (or any parent up to /)'))
    render(<GitPanel open onClose={() => {}} />)
    expect(await screen.findByText('当前目录不是 git 仓库')).not.toBeNull()
    // Tab 导航按钮不应显示
    expect(screen.queryByRole('tab', { name: '历史' })).toBeNull()
    expect(screen.queryByRole('tab', { name: '分支与同步' })).toBeNull()
    // 底部提交栏不应显示
    expect(screen.queryByPlaceholderText('提交信息（Enter 提交）')).toBeNull()
    expect(screen.queryByRole('button', { name: 'commit' })).toBeNull()

    const initBtn = screen.getByRole('button', { name: /初始化 Git 仓库/ })
    fireEvent.click(initBtn)
    await waitFor(() => expect(transport.gitInit).toHaveBeenCalledWith({ cwd: '/work' }))
  })

  it('IDEA 风格提交历史：支持按关键字过滤与查看详情', async () => {
    transport.gitLog.mockResolvedValue({
      ok: true,
      commits: [
        {
          hash: 'aaa111222333444',
          shortHash: 'aaa1112',
          author: 'Alice',
          email: 'alice@x.ai',
          timestamp: 1600000000,
          date: '2020-09-13T12:26:40.000Z',
          message: 'feat(ui): idea git log layout',
          body: '多行 body 说明第一行\n第二行',
          refs: 'HEAD -> main',
        },
        {
          hash: 'bbb222333444555',
          shortHash: 'bbb2223',
          author: 'Bob',
          email: 'bob@x.ai',
          timestamp: 1600000010,
          date: '2020-09-13T12:26:50.000Z',
          message: 'fix: duplicate hunk header',
        },
      ],
    })
    transport.gitDiffs.mockResolvedValue({
      files: [
        {
          path: 'src/ui.ts',
          type: 'edit',
          additions: 2,
          deletions: 1,
          patch: '@@ -1,3 +1,4 @@\n-old line\n+new line\n ctx line\n',
        },
      ],
    })
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('tab', { name: '历史' }))

    // 默认展示全部提交（HEAD 锚点 chip 会重复首个提交的主题）
    expect((await screen.findAllByText('feat(ui): idea git log layout')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('fix: duplicate hunk header')).not.toBeNull()
    expect(screen.getByText('HEAD -> main')).not.toBeNull()

    // 日期统一格式化为本地 "YYYY-MM-DD HH:mm"
    const dateTexts = screen.getAllByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(dateTexts.length).toBeGreaterThanOrEqual(2)

    // 过滤功能（只匹配列表行：限定 button.group 内的消息 span）
    const searchInput = screen.getByPlaceholderText('搜索提交信息、作者、哈希...')
    fireEvent.change(searchInput, { target: { value: 'duplicate' } })
    expect(
      screen.queryByText('feat(ui): idea git log layout', { selector: 'button.group span.truncate' }),
    ).toBeNull()
    expect(screen.getByText('fix: duplicate hunk header')).not.toBeNull()

    // 清空过滤
    fireEvent.change(searchInput, { target: { value: '' } })
    expect(screen.getAllByText('feat(ui): idea git log layout').length).toBeGreaterThanOrEqual(1)

    // 点击提交查看详情与 diff
    const selectedCommitText = screen
      .getAllByText('feat(ui): idea git log layout')
      .find((el) => el.closest('button.group'))!
    fireEvent.click(selectedCommitText)
    expect(await screen.findByText(/提交：/)).not.toBeNull()
    expect(selectedCommitText.closest('button')).toHaveClass('ring-1', 'ring-inset', 'ring-gn-cyan/60')
    // 完整提交信息 body 展示（RTL 默认归一化换行，用正则匹配）
    expect(screen.getByText(/多行 body 说明第一行/)).not.toBeNull()
    expect(screen.getByText(/第二行$/)).not.toBeNull()

    // 展开文件查看 patch
    fireEvent.click(screen.getByTitle('src/ui.ts'))
    expect(await screen.findByText('new line')).not.toBeNull()
    expect(screen.getByText('old line')).not.toBeNull()

    // 验证图谱节点与垂直历史连线
    const circles = document.querySelectorAll('[data-testid="git-graph-node"]')
    expect(circles.length).toBeGreaterThanOrEqual(2)
    // 第一个为 HEAD 空心圆环 (fill="none")，第二个为普通实心圆点
    expect(circles[0].getAttribute('fill')).toBe('none')
    expect(circles[0].getAttribute('stroke')).toBe('#3b82f6')
    expect(circles[1].getAttribute('fill')).toBe('#3b82f6')
    // 存在垂直连线路径
    expect(document.querySelector('svg path')).not.toBeNull()
  })

  it('历史 tab 列宽：拖拽表头分隔柄调整并持久化', async () => {
    localStorage.removeItem('capri-fe.gitLogColWidths')
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('tab', { name: '历史' }))

    // 默认作者列宽 110px（行单元格与表头联动）
    const authorCell = await screen.findByTitle('Alice')
    expect(authorCell.style.width).toBe('110px')

    // 拖拽分隔柄 +50px → 列宽 160px
    const handle = screen.getByRole('separator', { name: '调整作者列宽' })
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(authorCell.style.width).toBe('160px')

    // 键盘 ←/→ 步进 8px
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(authorCell.style.width).toBe('168px')

    // 持久化到 localStorage
    expect(JSON.parse(localStorage.getItem('capri-fe.gitLogColWidths') ?? '{}')).toMatchObject({
      author: 168,
    })
  })

  it('变更列表左侧渲染紧凑图标按钮与状态徽章', async () => {
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    // 状态徽章：字母按 changeType（M/U…），色调按 staged/unstaged
    expect(screen.getByTitle('已暂存 · 修改')).not.toBeNull()
    expect(screen.getByTitle('未暂存 · 修改')).not.toBeNull()
    expect(screen.getByTitle('未跟踪 (untracked)')).not.toBeNull()

    // 删除文件 → D 徽章（而非 M）
    transport.gitStatus.mockResolvedValue({
      branch: 'main',
      staged: [{ path: 'gone.ts', type: 'delete', additions: 0, deletions: 9 }],
      unstaged: [],
    })
    const p2 = render(<GitPanel open onClose={() => {}} />)
    expect(await p2.findByText('gone.ts')).not.toBeNull()
    expect(p2.getByTitle('已暂存 · 删除')).not.toBeNull()
    const dBadge = p2.container.querySelector('span[title="已暂存 · 删除"]')
    expect(dBadge?.textContent).toBe('D')
  })

  it('↑N 徽章点开未推送提交列表（range 查询 @{upstream}..HEAD）', async () => {
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /查看 2 个未推送的提交/ }))
    await waitFor(() =>
      expect(transport.gitLog).toHaveBeenCalledWith({
        cwd: '/work',
        range: '@{upstream}..HEAD',
        maxCount: 50,
      }),
    )
    expect((await screen.findAllByText('feat: add awesome feature')).length).toBeGreaterThanOrEqual(1)
  })

  it('merge 进行中 + 冲突 → 状态横幅展示冲突文件（最多 3 个）', async () => {
    transport.gitRepoState.mockResolvedValue({
      mergeInProgress: true,
      rebaseInProgress: false,
      cherryPickInProgress: false,
      conflicts: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      conflictCount: 4,
    })
    render(<GitPanel open onClose={() => {}} />)
    expect(await screen.findByText('merge 进行中')).not.toBeNull()
    expect(screen.getByText(/4 个冲突文件待解决/)).not.toBeNull()
    expect(screen.getByTitle('src/a.ts')).not.toBeNull()
    expect(screen.getByTitle('src/c.ts')).not.toBeNull()
    expect(screen.queryByTitle('src/d.ts')).toBeNull()
    expect(screen.getByText('… 共 4 个文件')).not.toBeNull()
  })

  it('点击顶栏分支名跳转到分支与同步 Tab', async () => {
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: '查看分支与同步' }))
    expect(await screen.findByText('远程仓库同步')).not.toBeNull()
    expect(screen.getByText('分支 · 2')).not.toBeNull()
  })

  it('变更筛选只显示对应文件，并在切换筛选时收起 diff', async () => {
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')

    fireEvent.click(screen.getByRole('button', { name: /暂存文件 1/ }))
    expect(screen.getByText('a.ts')).not.toBeNull()
    expect(screen.queryByText('b.ts')).toBeNull()
    expect(screen.queryByText('c.ts')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /待暂存文件 2/ }))
    expect(screen.queryByText('a.ts')).toBeNull()
    expect(screen.getByText('b.ts')).not.toBeNull()
    expect(screen.getByText('c.ts')).not.toBeNull()
  })

  it('分支筛选支持按名称和远程分支搜索', async () => {
    render(<GitPanel open onClose={() => {}} />)
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('tab', { name: '分支与同步' }))

    const input = await screen.findByPlaceholderText('筛选分支')
    fireEvent.change(input, { target: { value: 'origin/dev' } })
    expect(screen.getByRole('button', { name: /dev/ })).not.toBeNull()
    expect(screen.queryByRole('button', { name: /main/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '清除分支筛选' }))
    expect(screen.getByRole('button', { name: /main/ })).toBeDisabled()
  })
})
