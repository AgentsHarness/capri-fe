import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  GitBranch,
  GitFileChange,
  GitLogEntry,
  GitRepoStateData,
  GitStashItem,
  GitStatusData,
} from '../../../api/types'
import { Spinner } from '../../ui/Spinner'
import { useChatStore } from '../../../store/chat'
import { transport } from '../../../api/client'
import {
  CONFIRM_WINDOW_MS,
  PREVIEW_MAX_LINES,
  parseUnifiedDiffBlocks,
  toRows,
  type ActiveTab,
  type ChangeFilter,
  type DiffHunkBlock,
  type DiffRowKind,
  type DiffState,
  type StatusRow,
} from '../../../lib/gitPanel'
import { GitChangesTab } from './GitChangesTab'
import { GitLogTab } from './GitLogTab'
import { GitSyncTab } from './GitSyncTab'
import { GitPanelHeader } from './GitPanelHeader'
import { GitCommitFooter } from './GitCommitFooter'

export type { DiffHunkBlock } from '../../../lib/gitPanel'
import { GitNotRepoState } from './GitNotRepoState'
import { GitPanelTabs } from './GitPanelTabs'
import { GitRepoStateBanner } from './GitRepoStateBanner'

/**
 * Git panel — responsive mobile-first counterpart of the TUI git surface.
 *
 * Supports 3 tabs:
 * 1. 'changes' (default): Workspace changes (Staged / Unstaged / Untracked),
 *    diff preview with hunk staging, stage-all / unstage-all, AI commit message generator,
 *    and commit & push shortcut.
 * 2. 'log': IntelliJ IDEA-style commit log table, search filter, and commit detail inspector.
 * 3. 'sync': Remote push / pull / fetch, branch switching & creation & deletion, and stash management.
 */

export function GitPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cwd = useChatStore((s) => s.cwd)
  const gitInfo = useChatStore((s) => s.gitInfo)

  const [activeTab, setActiveTab] = useState<ActiveTab>('changes')
  const [changeFilter, setChangeFilter] = useState<ChangeFilter>('all')
  const [status, setStatus] = useState<GitStatusData>()
  const [statusError, setStatusError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [statusSeq, setStatusSeq] = useState(0)

  // Branches
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [branchesError, setBranchesError] = useState<string>()
  const [branchFilter, setBranchFilter] = useState('')
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [armedCheckout, setArmedCheckout] = useState<{ branch: string; at: number } | null>(null)
  const [newBranchName, setNewBranchName] = useState('')
  const [newBranchCheckout, setNewBranchCheckout] = useState(true)

  // Commit Log & Stashes
  const [commits, setCommits] = useState<GitLogEntry[]>([])
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string>()
  const [selectedCommitHash, setSelectedCommitHash] = useState<string>()
  const [commitFilter, setCommitFilter] = useState('')
  const [copiedHash, setCopiedHash] = useState(false)
  const [commitDiff, setCommitDiff] = useState<{
    loading: boolean
    files?: GitFileChange[]
    error?: string
  }>()
  const [stashes, setStashes] = useState<GitStashItem[]>([])
  const [stashLoading, setStashLoading] = useState(false)
  // 仓库进行中状态 / HEAD 锚点 / 未推送列表（只读信息）
  const [repoState, setRepoState] = useState<GitRepoStateData>()
  const [headCommit, setHeadCommit] = useState<GitLogEntry>()
  const [copiedHeadHash, setCopiedHeadHash] = useState(false)
  const [showUnpushed, setShowUnpushed] = useState(false)
  const [unpushed, setUnpushed] = useState<{
    loading: boolean
    commits?: GitLogEntry[]
    error?: string
  }>()
  const [openCommitFile, setOpenCommitFile] = useState<string>()

  // Selection & Diff
  const [selectedPath, setSelectedPath] = useState<string>()
  const [diff, setDiff] = useState<DiffState>()

  // Ops state
  const [busyOp, setBusyOp] = useState<string>()
  const [opError, setOpError] = useState<string>()
  const [commitMsg, setCommitMsg] = useState('')
  const [amend, setAmend] = useState(false)
  const [armedDiscard, setArmedDiscard] = useState<{ path: string; at: number } | null>(null)
  const [armedDropStash, setArmedDropStash] = useState<{ index: number; at: number } | null>(null)

  const panelRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)
  const branchReqSeq = useRef(0)

  const rows = useMemo(() => (status ? toRows(status) : []), [status])
  const stagedRows = useMemo(() => rows.filter((r) => r.status === 'staged'), [rows])
  const modifiedRows = useMemo(() => rows.filter((r) => r.status === 'modified'), [rows])
  const untrackedRows = useMemo(() => rows.filter((r) => r.status === 'untracked'), [rows])
  const unstagedRows = useMemo(() => rows.filter((r) => r.status !== 'staged'), [rows])
  const visibleStagedRows = changeFilter === 'unstaged' ? [] : stagedRows
  const visibleUnstagedRows = changeFilter === 'staged' ? [] : modifiedRows
  const visibleUntrackedRows = changeFilter === 'staged' ? [] : untrackedRows
  const visibleRowCount =
    visibleStagedRows.length + visibleUnstagedRows.length + visibleUntrackedRows.length

  useEffect(() => {
    if (!selectedPath || changeFilter === 'all') return
    const selected = rows.find((r) => r.path === selectedPath)
    if (
      (changeFilter === 'staged' && selected?.status !== 'staged') ||
      (changeFilter === 'unstaged' && selected?.status === 'staged')
    ) {
      setSelectedPath(undefined)
    }
  }, [changeFilter, rows, selectedPath])

  const refresh = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      const seq = ++reqSeq.current
      if (!opts.silent) setLoading(true)
      setStatusError(undefined)
      try {
        const data = await transport.gitStatus({ cwd, includeUntracked: true })
        if (seq !== reqSeq.current) return
        setStatus(data)
        setStatusSeq((n) => n + 1)
      } catch (e) {
        if (seq !== reqSeq.current) return
        setStatus(undefined)
        setStatusError(e instanceof Error ? e.message : String(e))
      } finally {
        if (seq === reqSeq.current) setLoading(false)
      }
    },
    [cwd],
  )

  const refreshBranches = useCallback(async () => {
    const seq = ++branchReqSeq.current
    setBranchesLoading(true)
    setBranchesError(undefined)
    try {
      const data = await transport.gitBranches({ cwd })
      if (seq !== branchReqSeq.current) return
      setBranches(data.branches ?? [])
    } catch (e) {
      if (seq !== branchReqSeq.current) return
      setBranches([])
      setBranchesError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === branchReqSeq.current) setBranchesLoading(false)
    }
  }, [cwd])

  const refreshLog = useCallback(async () => {
    setLogLoading(true)
    setLogError(undefined)
    try {
      const res = await transport.gitLog?.({ cwd, maxCount: 30 })
      if (res?.ok) {
        setCommits(res.commits ?? [])
      }
    } catch (e) {
      setLogError(e instanceof Error ? e.message : String(e))
    } finally {
      setLogLoading(false)
    }
  }, [cwd])

  const refreshStashes = useCallback(async () => {
    setStashLoading(true)
    try {
      const res = await transport.gitStashList?.({ cwd })
      if (res?.ok) {
        setStashes(res.stashes ?? [])
      }
    } catch {
      setStashes([])
    } finally {
      setStashLoading(false)
    }
  }, [cwd])

  // 进行中状态（merge/rebase/冲突）只读探测；失败视为无特殊状态。
  const refreshRepoState = useCallback(async () => {
    try {
      setRepoState(await transport.gitRepoState({ cwd }))
    } catch {
      setRepoState(undefined)
    }
  }, [cwd])

  // HEAD 锚点（短哈希 + 主题）。空仓库（无提交）返回空列表。
  const refreshHead = useCallback(async () => {
    try {
      const res = await transport.gitLog?.({ cwd, maxCount: 1 })
      setHeadCommit(res?.commits?.[0])
    } catch {
      setHeadCommit(undefined)
    }
  }, [cwd])

  // Fetch status/branches on open; tab-specific data only when that tab is shown.
  useEffect(() => {
    if (!open) return
    void refresh()
    void refreshBranches()
    void refreshRepoState()
    void refreshHead()
    // 打开时静默 fetch 一次，让 ahead/behind 反映远端真实状态；
    // 离线/无远端时失败忽略，不阻塞首屏。
    let alive = true
    void (transport.gitFetch?.({ cwd }) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        if (!alive) return
        void refresh({ silent: true })
        void refreshRepoState()
      })
    return () => {
      alive = false
    }
  }, [open, refresh, refreshBranches, refreshRepoState, refreshHead, cwd])

  useEffect(() => {
    if (!open) return
    if (activeTab === 'log') void refreshLog()
    if (activeTab === 'sync') void refreshStashes()
  }, [open, activeTab, refreshLog, refreshStashes])

  // Live refresh: host sessions_changed / git_head_changed while open.
  useEffect(() => {
    if (!open) return
    const unsub = transport.onEvent((ev) => {
      if (ev.type === 'sessions_changed' || ev.type === 'git_head_changed') {
        void refresh({ silent: true })
        void refreshBranches()
        void refreshRepoState()
        void refreshHead()
        if (activeTab === 'log') void refreshLog()
      }
    })
    return unsub
  }, [open, refresh, refreshBranches, refreshLog, refreshRepoState, refreshHead, activeTab])

  // Esc closes; focus panel for keyboard capture.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  // Reset transient state per open.
  useEffect(() => {
    if (!open) return
    setSelectedPath(undefined)
    setDiff(undefined)
    setChangeFilter('all')
    setSelectedCommitHash(undefined)
    setCommitFilter('')
    setBranchFilter('')
    setCommitDiff(undefined)
    setCopiedHash(false)
    setOpError(undefined)
    setCommitMsg('')
    setAmend(false)
    setArmedDiscard(null)
    setArmedCheckout(null)
    setArmedDropStash(null)
    setShowUnpushed(false)
    setUnpushed(undefined)
    setCopiedHeadHash(false)
    setOpenCommitFile(undefined)
  }, [open])

  // Load commit diff for selected commit in history tab
  useEffect(() => {
    if (!open || activeTab !== 'log' || !selectedCommitHash) {
      setCommitDiff(undefined)
      setOpenCommitFile(undefined)
      return
    }
    setOpenCommitFile(undefined)
    let alive = true
    setCommitDiff({ loading: true })
    const load = async () => {
      try {
        const res = await transport.gitDiffs?.({
          cwd,
          from: `${selectedCommitHash}^`,
          to: selectedCommitHash,
        })
        if (!alive) return
        setCommitDiff({ loading: false, files: res?.files ?? [] })
      } catch {
        // 根提交没有父提交（hash^ 失败）——与空树比较，展示首次提交的全部内容。
        try {
          const res = await transport.gitDiffs?.({
            cwd,
            from: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
            to: selectedCommitHash,
          })
          if (!alive) return
          setCommitDiff({ loading: false, files: res?.files ?? [] })
        } catch {
          if (alive) setCommitDiff({ loading: false, files: [] })
        }
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [open, activeTab, selectedCommitHash, cwd])

  const filteredBranches = useMemo(() => {
    const q = branchFilter.trim().toLowerCase()
    if (!q) return branches
    return branches.filter(
      (b) => b.name.toLowerCase().includes(q) || b.upstream?.toLowerCase().includes(q),
    )
  }, [branches, branchFilter])

  const filteredCommits = useMemo(() => {
    const q = commitFilter.trim().toLowerCase()
    if (!q) return commits
    return commits.filter(
      (c) =>
        c.message.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.shortHash.toLowerCase().includes(q) ||
        c.hash.toLowerCase().includes(q) ||
        (c.refs && c.refs.toLowerCase().includes(q)),
    )
  }, [commits, commitFilter])

  const selectedCommit = useMemo(() => {
    if (!selectedCommitHash) return undefined
    return commits.find((c) => c.hash === selectedCommitHash)
  }, [commits, selectedCommitHash])

  // Diff preview for selected row.
  useEffect(() => {
    if (!open) return
    if (!selectedPath) {
      setDiff(undefined)
      return
    }
    let alive = true
    setDiff({ loading: true })
    const row = rows.find((r) => r.path === selectedPath)
    void transport
      .gitDiffs({ cwd, from: 'HEAD', to: 'working', paths: [selectedPath] })
      .then((d) => {
        if (!alive) return
        const f = (d.files ?? []).find((x) => x.path === selectedPath)
        if (f?.patch) {
          const blocks = parseUnifiedDiffBlocks(f.patch)
          const flatRows = blocks.flatMap((b) => b.rows)
          setDiff({ blocks, rows: flatRows, file: f })
          return
        }
        if (row?.status === 'untracked') {
          void transport
            .gitFiles({ cwd, paths: [selectedPath], version: 'working' })
            .then((fd) => {
              if (!alive) return
              const file = (fd.files ?? []).find((x) => x.path === selectedPath)
              if (file && !file.isBinary) {
                const lines = file.content.replace(/\n$/, '').split('\n')
                const shown = lines.slice(0, PREVIEW_MAX_LINES)
                const rows2: { kind: DiffRowKind; text: string }[] = shown.map(
                  (t) => ({ kind: 'insert' as const, text: t }),
                )
                if (lines.length > PREVIEW_MAX_LINES) {
                  rows2.push({
                    kind: 'hunk' as const,
                    text: `… +${lines.length - PREVIEW_MAX_LINES} lines`,
                  })
                }
                const block: DiffHunkBlock = { header: 'New File', rows: rows2 }
                setDiff({
                  blocks: [block],
                  rows: rows2,
                  file: f,
                  note: 'untracked 文件 — 工作区内容预览（git diff 不包含 untracked）',
                })
              } else {
                setDiff({
                  blocks: [],
                  rows: [],
                  file: f,
                  note: file?.isBinary ? '二进制文件，无内容预览' : '文件内容不可读',
                })
              }
            })
            .catch((e) => {
              if (alive) {
                setDiff({ error: e instanceof Error ? e.message : String(e) })
              }
            })
          return
        }
        setDiff({
          blocks: [],
          rows: [],
          file: f,
          note:
            f == null
              ? '该文件不在 diff 范围内（untracked？）'
              : 'host 未返回 patch 内容（/api/git/diffs 不带 includePatch）— 仅统计',
        })
      })
      .catch((e) => {
        if (alive) setDiff({ error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      alive = false
    }
  }, [open, selectedPath, rows, statusSeq, cwd])

  const runOp = useCallback(
    async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
      setBusyOp(label)
      setOpError(undefined)
      try {
        await fn()
        await refresh({ silent: true })
        // commit/pull/checkout/stash 等都会改变进行中状态，跟着刷一次。
        void refreshRepoState()
        return true
      } catch (e) {
        setOpError(`${label} 失败: ${e instanceof Error ? e.message : String(e)}`)
        return false
      } finally {
        setBusyOp(undefined)
      }
    },
    [refresh, refreshRepoState],
  )

  const onDiscardClick = (e: React.MouseEvent, row: StatusRow) => {
    e.stopPropagation()
    if (armedDiscard?.path === row.path && Date.now() - armedDiscard.at < CONFIRM_WINDOW_MS) {
      setArmedDiscard(null)
      void runOp(`discard ${row.path}`, () =>
        transport.gitDiscard({
          cwd,
          paths: [row.path],
          ...(row.status === 'untracked' ? { includeUntracked: true } : {}),
        }),
      )
    } else {
      setArmedDiscard({ path: row.path, at: Date.now() })
    }
  }
  useEffect(() => {
    if (!armedDiscard) return
    const t = window.setTimeout(
      () => setArmedDiscard((cur) => (cur && cur.at === armedDiscard.at ? null : cur)),
      CONFIRM_WINDOW_MS,
    )
    return () => window.clearTimeout(t)
  }, [armedDiscard])

  const onCheckoutClick = (branch: GitBranch) => {
    if (branch.current) return
    if (
      armedCheckout?.branch === branch.name &&
      Date.now() - armedCheckout.at < CONFIRM_WINDOW_MS
    ) {
      setArmedCheckout(null)
      void runOp(`checkout ${branch.name}`, async () => {
        await transport.gitCheckout({ cwd, branch: branch.name })
        await refreshBranches()
      })
    } else {
      setArmedCheckout({ branch: branch.name, at: Date.now() })
    }
  }
  useEffect(() => {
    if (!armedCheckout) return
    const t = window.setTimeout(
      () => setArmedCheckout((cur) => (cur && cur.at === armedCheckout.at ? null : cur)),
      CONFIRM_WINDOW_MS,
    )
    return () => window.clearTimeout(t)
  }, [armedCheckout])

  useEffect(() => {
    if (!armedDropStash) return
    const t = window.setTimeout(
      () => setArmedDropStash((cur) => (cur && cur.at === armedDropStash.at ? null : cur)),
      CONFIRM_WINDOW_MS,
    )
    return () => window.clearTimeout(t)
  }, [armedDropStash])

  const onStashClick = () => {
    if (busyOp != null) return
    void runOp('stash', async () => {
      await transport.gitStash({ cwd })
      void refreshStashes()
    })
  }

  // ── 未推送提交列表（↑N 徽章点开）──────────────────────────────────
  const toggleUnpushed = () => {
    const next = !showUnpushed
    setShowUnpushed(next)
    if (!next) return
    setUnpushed({ loading: true })
    // @{upstream}..HEAD：本地领先的全部提交；无上游时 git 报错 → 友好提示。
    void Promise.resolve(transport.gitLog?.({ cwd, range: '@{upstream}..HEAD', maxCount: 50 }))
      .then((res) => setUnpushed({ loading: false, commits: res?.commits ?? [] }))
      .catch((e) =>
        setUnpushed({
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      )
  }

  // ── AI commit message recommendation ──────────────────────────────
  // ── Stage/Unstage All ──────────────────────────────────────────────
  const onStageAll = () => {
    const un = unstagedRows.map((r) => r.path)
    if (un.length === 0) return
    void runOp('stage all', () => transport.gitStage({ cwd, paths: un }))
  }

  const onUnstageAll = () => {
    const st = stagedRows.map((r) => r.path)
    if (st.length === 0) return
    void runOp('unstage all', () => transport.gitUnstage({ cwd, paths: st }))
  }

  // ── Commit & Push ──────────────────────────────────────────────────
  const onCommitAndPush = async () => {
    const msg = commitMsg.trim()
    if (!msg || busyOp != null) return
    const ok = await runOp('commit', () =>
      transport.gitCommit({
        cwd,
        message: msg,
        ...(amend ? { amend: true } : {}),
      }),
    )
    if (ok) {
      setCommitMsg('')
      await runOp('push', () => transport.gitPush?.({ cwd }) ?? Promise.resolve())
    }
  }

  // ── Hunk Staging ───────────────────────────────────────────────────
  const onStageHunk = (block: DiffHunkBlock) => {
    if (!selectedPath) return
    const content = block.rows
      .filter((r) => r.kind === 'insert' || r.kind === 'equal')
      .map((r) => r.text)
      .join('\n')
    void runOp(`stage hunk in ${selectedPath}`, async () => {
      await transport.gitStageContent?.({ cwd, path: selectedPath, content })
      await transport.gitStage({ cwd, paths: [selectedPath] })
    })
  }

  if (!open) return null

  const branch = status?.branch ?? gitInfo?.branch
  const notRepo =
    /not a git repository/i.test(statusError ?? '') ||
    /could not find repository/i.test(statusError ?? '') ||
    /notgitrepo/i.test(statusError ?? '') ||
    ((statusError === 'Internal error' || statusError?.includes('Internal error')) && !branch)
  const busy = busyOp != null
  /** 操作按钮自己的转圈：busyOp 是当前在飞操作名（含动态后缀时按前缀匹配）。 */
  const spin = (op: string, size = 11) =>
    busyOp === op || (busyOp ?? '').startsWith(`${op} `) ? <Spinner size={size} /> : null
  const canCommit = Boolean(commitMsg.trim()) && !busy && (amend || stagedRows.length > 0)
  const selectedRow = selectedPath ? rows.find((r) => r.path === selectedPath) : undefined

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center gn-modal-dim p-0 sm:items-start sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="git"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="flex h-[100dvh] w-full max-w-[1080px] flex-col overflow-hidden rounded-none border-0 border-gn-prompt-border bg-gn-bg-dark text-gn-fg shadow-2xl gn-modal-panel outline-none sm:my-auto sm:h-[min(88vh,860px)] sm:rounded-2xl sm:border pb-[env(safe-area-inset-bottom)]"
      >
        {/* Top bar: identity + branch + actions. Tabs live on their own strip. */}
        <GitPanelHeader
          onClose={onClose}
          notRepo={Boolean(notRepo)}
          branch={branch}
          status={status}
          headCommit={headCommit}
          copiedHeadHash={copiedHeadHash}
          setCopiedHeadHash={setCopiedHeadHash}
          stagedCount={stagedRows.length}
          modifiedCount={modifiedRows.length}
          untrackedCount={untrackedRows.length}
          rowCount={rows.length}
          busyOp={busyOp}
          loading={loading}
          busy={busy}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          refresh={refresh}
          refreshBranches={refreshBranches}
          refreshLog={refreshLog}
          refreshStashes={refreshStashes}
          showUnpushed={showUnpushed}
          toggleUnpushed={toggleUnpushed}
          unpushed={unpushed}
        />

        {!notRepo && (
          <GitPanelTabs activeTab={activeTab} setActiveTab={setActiveTab} rowCount={rows.length} />
        )}

        {!notRepo && (opError || (statusError && status)) && (
          <div className="shrink-0 border-b border-gn-prompt-border/50 bg-gn-diff-del-bg/40 px-3 py-1.5 font-mono text-[11px] text-gn-red">
            {opError ?? statusError}
          </div>
        )}

        {/* 进行中状态横幅（merge/rebase/cherry-pick + 冲突文件）— 只读信息，
            处理动作本身交给 agent（对话中继续/中止）。 */}
        {!notRepo && repoState && <GitRepoStateBanner repoState={repoState} />}

        {/* Content area */}
        {notRepo ? (
          <GitNotRepoState
            cwd={cwd}
            statusError={statusError}
            busy={busy}
            busyOp={busyOp}
            runOp={runOp}
            refresh={refresh}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {activeTab === 'changes' && (
              <GitChangesTab
                statusError={statusError}
                status={status}
                loading={loading}
                refresh={refresh}
                rows={rows}
                stagedRows={stagedRows}
                unstagedRows={unstagedRows}
                visibleStagedRows={visibleStagedRows}
                visibleUnstagedRows={visibleUnstagedRows}
                visibleUntrackedRows={visibleUntrackedRows}
                visibleRowCount={visibleRowCount}
                changeFilter={changeFilter}
                setChangeFilter={setChangeFilter}
                selectedPath={selectedPath}
                setSelectedPath={setSelectedPath}
                selectedRow={selectedRow}
                armedDiscard={armedDiscard}
                busy={busy}
                busyOp={busyOp}
                diff={diff}
                cwd={cwd}
                runOp={runOp}
                onStageAll={onStageAll}
                onUnstageAll={onUnstageAll}
                onDiscardClick={onDiscardClick}
                onStageHunk={onStageHunk}
              />
            )}

            {activeTab === 'log' && (
              <GitLogTab
                commits={commits}
                filteredCommits={filteredCommits}
                logLoading={logLoading}
                logError={logError}
                commitFilter={commitFilter}
                setCommitFilter={setCommitFilter}
                refreshLog={refreshLog}
                selectedCommit={selectedCommit}
                setSelectedCommitHash={setSelectedCommitHash}
                copiedHash={copiedHash}
                setCopiedHash={setCopiedHash}
                commitDiff={commitDiff}
                openCommitFile={openCommitFile}
                setOpenCommitFile={setOpenCommitFile}
              />
            )}

            {activeTab === 'sync' && (
              <GitSyncTab
                status={status}
                branches={branches}
                branchesError={branchesError}
                branchFilter={branchFilter}
                setBranchFilter={setBranchFilter}
                branchesLoading={branchesLoading}
                newBranchName={newBranchName}
                setNewBranchName={setNewBranchName}
                newBranchCheckout={newBranchCheckout}
                setNewBranchCheckout={setNewBranchCheckout}
                filteredBranches={filteredBranches}
                armedCheckout={armedCheckout}
                onCheckoutClick={onCheckoutClick}
                refreshBranches={refreshBranches}
                refreshStashes={refreshStashes}
                stashes={stashes}
                stashLoading={stashLoading}
                armedDropStash={armedDropStash}
                setArmedDropStash={setArmedDropStash}
                busy={busy}
                busyOp={busyOp}
                cwd={cwd}
                runOp={runOp}
                spin={spin}
              />
            )}
          </div>
        )}

        {!notRepo && activeTab === 'changes' && (
          <GitCommitFooter
            selectedPath={selectedPath}
            commitMsg={commitMsg}
            setCommitMsg={setCommitMsg}
            amend={amend}
            setAmend={setAmend}
            canCommit={canCommit}
            busy={busy}
            busyOp={busyOp}
            cwd={cwd}
            stagedCount={stagedRows.length}
            onCommitAndPush={onCommitAndPush}
            onStashClick={onStashClick}
            runOp={runOp}
          />
        )}
      </div>
    </div>
  )
}
