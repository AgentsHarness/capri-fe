import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  Clock,
  GitBranch as GitBranchIcon,
  GitCommit,
  GitPullRequest,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import { useChatStore } from '../store/chat'
import { transport } from '../api/client'
import type { GitBranch, GitFileChange, GitLogEntry, GitStashItem, GitStatusData } from '../api/types'

/**
 * Git panel — responsive mobile-first counterpart of the TUI git surface.
 *
 * Supports 3 tabs:
 * 1. 'changes' (default): Workspace changes (Staged / Unstaged / Untracked),
 *    diff preview with hunk staging, stage-all / unstage-all, AI commit message generator,
 *    and commit & push shortcut.
 * 2. 'log': Commit history timeline with hashes, messages, authors, and dates.
 * 3. 'sync': Remote push / pull / fetch, branch switching & creation & deletion, and stash management.
 */

const CONFIRM_WINDOW_MS = 2000
const PREVIEW_MAX_LINES = 1000

type ActiveTab = 'changes' | 'log' | 'sync'
type RowStatus = 'staged' | 'modified' | 'untracked'

type StatusRow = {
  path: string
  status: RowStatus
  changeType: GitFileChange['type']
  additions: number
  deletions: number
}

const ROW_STATUS_CLASS: Record<RowStatus, string> = {
  staged: 'text-gn-green',
  modified: 'text-gn-yellow',
  untracked: 'text-gn-red',
}
const ROW_STATUS_LABEL: Record<RowStatus, string> = {
  staged: 'staged',
  modified: 'modified',
  untracked: 'untracked',
}

function toRows(data: GitStatusData): StatusRow[] {
  const rows: StatusRow[] = []
  for (const f of data.staged ?? []) {
    rows.push({
      path: f.path,
      status: 'staged',
      changeType: f.type,
      additions: f.additions,
      deletions: f.deletions,
    })
  }
  for (const f of data.unstaged ?? []) {
    rows.push({
      path: f.path,
      status: f.type === 'untracked' ? 'untracked' : 'modified',
      changeType: f.type,
      additions: f.additions,
      deletions: f.deletions,
    })
  }
  const order = { staged: 0, modified: 1, untracked: 2 } as const
  rows.sort(
    (a, b) =>
      order[a.status] - order[b.status] || a.path.localeCompare(b.path),
  )
  return rows
}

// ── read-only unified-diff rendering with hunk detection ──────────────

type DiffRowKind = 'header' | 'hunk' | 'equal' | 'insert' | 'delete'

export type DiffHunkBlock = {
  header: string
  rows: { kind: DiffRowKind; text: string }[]
}

function parseUnifiedDiffBlocks(patch: string): DiffHunkBlock[] {
  const blocks: DiffHunkBlock[] = []
  const raw = patch.replace(/\n$/, '').split('\n')
  let currentHunk: DiffHunkBlock | null = null

  for (const line of raw) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('similarity') ||
      line.startsWith('rename ') ||
      line.startsWith('Binary files')
    ) {
      if (!currentHunk) {
        currentHunk = { header: 'File Header', rows: [] }
        blocks.push(currentHunk)
      }
      currentHunk.rows.push({ kind: 'header', text: line })
    } else if (line.startsWith('@@')) {
      currentHunk = { header: line, rows: [{ kind: 'hunk', text: line }] }
      blocks.push(currentHunk)
    } else if (line.startsWith('+')) {
      if (!currentHunk) {
        currentHunk = { header: 'Changes', rows: [] }
        blocks.push(currentHunk)
      }
      currentHunk.rows.push({ kind: 'insert', text: line.slice(1) })
    } else if (line.startsWith('-')) {
      if (!currentHunk) {
        currentHunk = { header: 'Changes', rows: [] }
        blocks.push(currentHunk)
      }
      currentHunk.rows.push({ kind: 'delete', text: line.slice(1) })
    } else {
      if (!currentHunk) {
        currentHunk = { header: 'Changes', rows: [] }
        blocks.push(currentHunk)
      }
      currentHunk.rows.push({ kind: 'equal', text: line })
    }
  }
  return blocks
}

function DiffRowView({ kind, text }: { kind: DiffRowKind; text: string }) {
  if (kind === 'header') {
    return <div className="px-2 font-mono text-[11px] text-gn-cyan">{text}</div>
  }
  if (kind === 'hunk') {
    return <div className="px-2 font-mono text-[11px] text-gn-muted">{text}</div>
  }
  const bg =
    kind === 'insert'
      ? 'var(--color-gn-diff-ins-bg)'
      : kind === 'delete'
        ? 'var(--color-gn-diff-del-bg)'
        : undefined
  const fg =
    kind === 'insert'
      ? 'var(--color-gn-diff-ins-fg)'
      : kind === 'delete'
        ? 'var(--color-gn-diff-del-fg)'
        : 'var(--color-gn-fg2)'
  const sign = kind === 'insert' ? '+' : kind === 'delete' ? '−' : ' '
  return (
    <div className="flex font-mono text-[12px] leading-[1.4]" style={{ background: bg }}>
      <span className="shrink-0 select-none px-0.5" style={{ color: fg }}>
        {sign}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all" style={{ color: fg }}>
        {text || ' '}
      </span>
    </div>
  )
}

// ── panel ────────────────────────────────────────────────────────────

type DiffState =
  | { loading: boolean; blocks?: undefined; rows?: undefined; error?: undefined; file?: undefined; note?: undefined }
  | {
      loading?: undefined
      blocks: DiffHunkBlock[]
      rows: { kind: DiffRowKind; text: string }[]
      error?: undefined
      file?: GitFileChange
      note?: string
    }
  | { loading?: undefined; blocks?: undefined; rows?: undefined; error: string; file?: undefined; note?: undefined }

export function GitPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cwd = useChatStore((s) => s.cwd)
  const gitInfo = useChatStore((s) => s.gitInfo)

  const [activeTab, setActiveTab] = useState<ActiveTab>('changes')
  const [status, setStatus] = useState<GitStatusData>()
  const [statusError, setStatusError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [statusSeq, setStatusSeq] = useState(0)

  // Branches
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [branchesError, setBranchesError] = useState<string>()
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [armedCheckout, setArmedCheckout] = useState<{ branch: string; at: number } | null>(null)
  const [newBranchName, setNewBranchName] = useState('')
  const [newBranchCheckout, setNewBranchCheckout] = useState(true)

  // Commit Log & Stashes
  const [commits, setCommits] = useState<GitLogEntry[]>([])
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string>()
  const [stashes, setStashes] = useState<GitStashItem[]>([])
  const [stashLoading, setStashLoading] = useState(false)

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
  const unstagedRows = useMemo(() => rows.filter((r) => r.status !== 'staged'), [rows])

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

  // Fetch on open + keep in sync with session/cwd changes.
  useEffect(() => {
    if (!open) return
    void refresh()
    void refreshBranches()
    if (activeTab === 'log') void refreshLog()
    if (activeTab === 'sync') void refreshStashes()
  }, [open, refresh, refreshBranches, refreshLog, refreshStashes, activeTab])

  // Live refresh: host sessions_changed / git_head_changed while open.
  useEffect(() => {
    if (!open) return
    const unsub = transport.onEvent((ev) => {
      if (ev.type === 'sessions_changed' || ev.type === 'git_head_changed') {
        void refresh({ silent: true })
        void refreshBranches()
        if (activeTab === 'log') void refreshLog()
      }
    })
    return unsub
  }, [open, refresh, refreshBranches, refreshLog, activeTab])

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
    setOpError(undefined)
    setCommitMsg('')
    setAmend(false)
    setArmedDiscard(null)
    setArmedCheckout(null)
    setArmedDropStash(null)
  }, [open])

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
        return true
      } catch (e) {
        setOpError(`${label} 失败: ${e instanceof Error ? e.message : String(e)}`)
        return false
      } finally {
        setBusyOp(undefined)
      }
    },
    [refresh],
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

  const onStashClick = () => {
    if (busyOp != null) return
    void runOp('stash', async () => {
      await transport.gitStash({ cwd })
      void refreshStashes()
    })
  }

  // ── AI commit message recommendation ──────────────────────────────
  const onGenerateCommitMsg = () => {
    const targets = stagedRows.length > 0 ? stagedRows : rows
    if (targets.length === 0) return
    const paths = targets.map((t) => t.path)
    let prefix = 'feat'
    if (paths.some((p) => /fix|bug|issue|patch|err/i.test(p))) {
      prefix = 'fix'
    } else if (paths.some((p) => /test|spec/i.test(p))) {
      prefix = 'test'
    } else if (paths.every((p) => /docs?|readme|\.md/i.test(p))) {
      prefix = 'docs'
    } else if (paths.every((p) => /style|css|less|scss/i.test(p))) {
      prefix = 'style'
    }
    const sample = paths.slice(0, 2).map((p) => p.split('/').pop()).join(', ')
    const countExtra = paths.length > 2 ? ` and ${paths.length - 2} more` : ''
    setCommitMsg(`${prefix}: update ${sample}${countExtra}`)
  }

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
  const notRepo = /not a git repository/i.test(statusError ?? '')
  const busy = busyOp != null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center gn-modal-dim p-0 sm:p-4"
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
        className="flex h-full w-full flex-col bg-gn-bg-dark text-gn-fg shadow-2xl sm:mt-8 sm:h-auto sm:max-h-[85vh] sm:max-w-[940px] sm:rounded-lg sm:border sm:border-gn-prompt-border"
      >
        {/* Top bar header */}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-base px-3 sm:px-4">
          <span className="text-[14px] font-bold text-gn-fg">git</span>
          {branch ? (
            <span
              className="flex min-w-0 items-center gap-1 truncate font-mono text-[12px] text-gn-cyan"
              title={branch}
            >
              <span className="shrink-0" aria-hidden>
                ⎇
              </span>
              <span className="truncate">{branch === '(detached)' ? 'detached' : branch}</span>
              {status?.ahead != null && status.ahead > 0 && (
                <span className="shrink-0 font-bold text-gn-yellow" title="领先上游的未推送提交">
                  ↑{status.ahead}
                </span>
              )}
              {status?.behind != null && status.behind > 0 && (
                <span className="shrink-0 font-bold text-gn-muted" title="落后上游的提交">
                  ↓{status.behind}
                </span>
              )}
            </span>
          ) : null}

          {rows.length > 0 && (
            <span className="hidden font-mono text-[11px] text-gn-muted md:inline">
              {rows.filter((r) => r.status === 'staged').length} staged ·{' '}
              {rows.filter((r) => r.status === 'modified').length} modified ·{' '}
              {rows.filter((r) => r.status === 'untracked').length} untracked
            </span>
          )}

          {/* Tab Navigation */}
          <div className="ml-auto flex items-center gap-1 rounded bg-gn-bg-dark/80 p-0.5 text-[11.5px]">
            <button
              type="button"
              onClick={() => setActiveTab('changes')}
              className={`rounded px-2.5 py-1 transition-colors ${
                activeTab === 'changes'
                  ? 'bg-gn-bg-highlight font-medium text-gn-fg'
                  : 'text-gn-muted hover:text-gn-fg'
              }`}
            >
              变更{rows.length > 0 ? ` · ${rows.length}` : ''}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('log')}
              className={`rounded px-2.5 py-1 transition-colors ${
                activeTab === 'log'
                  ? 'bg-gn-bg-highlight font-medium text-gn-fg'
                  : 'text-gn-muted hover:text-gn-fg'
              }`}
            >
              历史
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('sync')}
              className={`rounded px-2.5 py-1 transition-colors ${
                activeTab === 'sync'
                  ? 'bg-gn-bg-highlight font-medium text-gn-fg'
                  : 'text-gn-muted hover:text-gn-fg'
              }`}
            >
              分支与同步
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              void refresh()
              void refreshBranches()
              if (activeTab === 'log') void refreshLog()
              if (activeTab === 'sync') void refreshStashes()
            }}
            disabled={loading}
            className="rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40"
            title="重新拉取 git 状态"
          >
            <span className="hidden sm:inline text-[11px] px-1">刷新</span>
            <RefreshCw size={13} className={`inline ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            <X size={15} aria-hidden />
          </button>
        </header>

        {/* Content area */}
        {statusError && !status ? (
          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
            <div className="text-[13px] text-gn-red">{statusError}</div>
            <div className="mt-1 text-[11.5px] text-gn-muted">
              {notRepo ? '当前目录不是 git 仓库' : 'host 调用失败'}
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              className="mt-3 rounded border border-gn-prompt-border bg-gn-bg-base px-4 py-1.5 text-[12px] text-gn-fg hover:bg-gn-bg-highlight"
            >
              重试
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            {activeTab === 'changes' && (
              <>
                {/* File list sidebar */}
                <div
                  className={`gn-no-scrollbar shrink-0 overflow-y-auto border-r border-gn-prompt-border bg-gn-bg-base/40 ${
                    selectedPath ? 'hidden sm:block sm:w-72' : 'w-full sm:w-72'
                  }`}
                >
                  {/* 分支折叠栏（保持测试用例兼容性） */}
                  <div className="border-b border-gn-prompt-border/50 px-3 pb-1.5 pt-2">
                    <div className="text-[10px] uppercase tracking-wider text-gn-gutter">
                      分支{branches.length > 0 ? ` · ${branches.length}` : ''}
                    </div>
                    {branchesError && (
                      <div className="mt-1 text-[10.5px] leading-snug text-gn-red">
                        {branchesError}
                      </div>
                    )}
                    <div className="gn-no-scrollbar mt-1 max-h-24 overflow-y-auto">
                      {branchesLoading && branches.length === 0 && (
                        <div className="text-[11px] text-gn-muted">加载中…</div>
                      )}
                      {!branchesLoading && branches.length === 0 && !branchesError && (
                        <div className="text-[11px] text-gn-muted">无分支信息</div>
                      )}
                      {branches.map((b) => {
                        const armed = armedCheckout?.branch === b.name
                        return (
                          <button
                            key={b.name}
                            type="button"
                            disabled={busy || b.current === true}
                            onClick={() => onCheckoutClick(b)}
                            className={`flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left font-mono text-[11px] disabled:cursor-default ${
                              b.current
                                ? 'text-gn-green font-medium'
                                : 'text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-60'
                            }`}
                            title={
                              b.current
                                ? '当前分支'
                                : armed
                                  ? '再点一次确认切换（2 秒内）'
                                  : `切换到 ${b.name}${b.upstream ? ` · upstream ${b.upstream}` : ''}`
                            }
                          >
                            <span className="w-4 shrink-0 text-[10px]">
                              {b.current ? '✓' : armed ? '?' : '⎇'}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{b.name}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Header bar with Stage/Unstage All */}
                  <div className="flex items-center justify-between border-b border-gn-prompt-border/50 px-3 py-2">
                    <span className="text-[10px] uppercase tracking-wider text-gn-gutter">
                      工作区状态 · {rows.length}
                    </span>
                    <div className="flex items-center gap-1">
                      {unstagedRows.length > 0 && (
                        <button
                          type="button"
                          onClick={onStageAll}
                          disabled={busy}
                          className="rounded bg-gn-bg-highlight px-1.5 py-0.5 text-[10px] text-gn-green hover:bg-gn-green/20"
                          title="一键暂存所有修改"
                        >
                          全部暂存
                        </button>
                      )}
                      {stagedRows.length > 0 && (
                        <button
                          type="button"
                          onClick={onUnstageAll}
                          disabled={busy}
                          className="rounded bg-gn-bg-highlight px-1.5 py-0.5 text-[10px] text-gn-muted hover:bg-gn-bg-base"
                          title="一键取消暂存全部文件"
                        >
                          全部取消
                        </button>
                      )}
                    </div>
                  </div>

                  {loading && rows.length === 0 && (
                    <div className="px-3 py-3 text-[11px] text-gn-muted">加载中…</div>
                  )}
                  {!loading && rows.length === 0 && (
                    <div className="px-3 py-4 text-[11.5px] text-gn-muted text-center">
                      工作区没有改动 ✓
                    </div>
                  )}

                  {/* File row items */}
                  {rows.map((row) => {
                    const sel = row.path === selectedPath
                    const armed = armedDiscard?.path === row.path
                    return (
                      <div
                        key={row.path}
                        className={`group flex items-center gap-1 px-2.5 py-1.5 border-b border-gn-prompt-border/20 transition-colors ${
                          sel ? 'bg-gn-bg-highlight font-medium' : 'hover:bg-gn-bg-highlight/60'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedPath(sel ? undefined : row.path)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          title={row.path}
                        >
                          <span
                            className={`shrink-0 rounded px-1 font-mono text-[9.5px] leading-[14px] ${
                              ROW_STATUS_CLASS[row.status]
                            }`}
                          >
                            {ROW_STATUS_LABEL[row.status]}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-gn-fg">
                            {row.path}
                          </span>
                          {(row.additions > 0 || row.deletions > 0) && (
                            <span className="shrink-0 font-mono text-[10px] tabular-nums text-gn-gutter">
                              +{row.additions}−{row.deletions}
                            </span>
                          )}
                        </button>

                        <div className="flex shrink-0 items-center gap-1">
                          {row.status === 'staged' ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={(e) => {
                                e.stopPropagation()
                                void runOp(`unstage ${row.path}`, () =>
                                  transport.gitUnstage({ cwd, paths: [row.path] }),
                                )
                              }}
                              className="rounded px-1.5 py-0.5 text-[10.5px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40"
                              title="git unstage — 移出暂存区"
                            >
                              unstage
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={(e) => {
                                e.stopPropagation()
                                void runOp(`stage ${row.path}`, () =>
                                  transport.gitStage({ cwd, paths: [row.path] }),
                                )
                              }}
                              className="rounded px-1.5 py-0.5 text-[10.5px] text-gn-green hover:bg-gn-green/10 disabled:opacity-40"
                              title="git stage — 加入暂存区"
                            >
                              stage
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={(e) => onDiscardClick(e, row)}
                            className={`rounded px-1.5 py-0.5 text-[10.5px] transition-colors disabled:opacity-40 ${
                              armed
                                ? 'bg-gn-diff-del-bg text-gn-red font-medium'
                                : 'text-gn-red opacity-60 hover:bg-gn-diff-del-bg hover:opacity-100'
                            }`}
                            title={
                              armed
                                ? '再点一次确认丢弃更改（2 秒内）'
                                : '丢弃该文件的更改（需确认）'
                            }
                          >
                            {armed ? '确认？' : 'discard'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Diff Viewer panel */}
                <div
                  className={`gn-no-scrollbar min-w-0 flex-1 overflow-y-auto bg-gn-bg-dark ${
                    selectedPath ? 'block' : 'hidden sm:block'
                  }`}
                >
                  {/* Mobile Back Button */}
                  {selectedPath && (
                    <div className="flex sm:hidden items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-base px-3 py-2">
                      <button
                        type="button"
                        onClick={() => setSelectedPath(undefined)}
                        className="flex items-center gap-1 text-[12px] text-gn-cyan"
                      >
                        <ChevronLeft size={16} /> 返回文件列表
                      </button>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-gn-fg2">
                        {selectedPath}
                      </span>
                    </div>
                  )}

                  {diff?.loading ? (
                    <div className="px-4 py-4 font-mono text-[12px] text-gn-muted">
                      加载 diff…
                    </div>
                  ) : diff?.error ? (
                    <div className="px-4 py-4 font-mono text-[12px] text-gn-red">
                      {diff.error}
                    </div>
                  ) : diff?.rows != null ? (
                    <div className="py-2">
                      {diff.file && (
                        <div className="flex items-center justify-between px-3 pb-2 font-mono text-[11.5px] text-gn-cyan border-b border-gn-prompt-border/30">
                          <span className="truncate">diff · {diff.file.path}</span>
                          {diff.file.additions > 0 || diff.file.deletions > 0 ? (
                            <span className="shrink-0 text-gn-gutter">
                              +{diff.file.additions} −{diff.file.deletions}
                            </span>
                          ) : null}
                        </div>
                      )}
                      {diff.note && (
                        <div className="px-3 py-1 font-mono text-[10.5px] text-gn-gutter bg-gn-bg-base/20">
                          {diff.note}
                        </div>
                      )}
                      {diff.rows.length === 0 ? (
                        <div className="px-4 py-4 font-mono text-[12px] text-gn-muted">
                          （无 diff 内容）
                        </div>
                      ) : (
                        diff.blocks?.map((block, bi) => (
                          <div key={bi} className="my-1 border-y border-gn-prompt-border/20">
                            {block.header !== 'File Header' && (
                              <div className="flex items-center justify-between bg-gn-bg-base/60 px-2 py-1">
                                <span className="font-mono text-[11px] text-gn-muted truncate">
                                  {block.header}
                                </span>
                                {selectedPath && (
                                  <button
                                    type="button"
                                    onClick={() => onStageHunk(block)}
                                    disabled={busy}
                                    className="rounded bg-gn-bg-highlight px-2 py-0.5 text-[10px] text-gn-green hover:bg-gn-green/20"
                                    title="将当前这块改动加入暂存区"
                                  >
                                    暂存此块
                                  </button>
                                )}
                              </div>
                            )}
                            {block.rows.map((r, ri) => (
                              <DiffRowView key={ri} kind={r.kind} text={r.text} />
                            ))}
                          </div>
                        )) ??
                        diff.rows.map((r, i) => (
                          <DiffRowView key={i} kind={r.kind} text={r.text} />
                        ))
                      )}
                    </div>
                  ) : (
                    <div className="flex h-48 items-center justify-center font-mono text-[12px] text-gn-muted">
                      选择左侧文件查看 diff
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Tab: History Log */}
            {activeTab === 'log' && (
              <div className="gn-no-scrollbar flex-1 overflow-y-auto p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-[12px] font-medium text-gn-fg">
                    提交历史 (Commit Log)
                  </span>
                  <button
                    type="button"
                    onClick={() => void refreshLog()}
                    className="flex items-center gap-1 rounded bg-gn-bg-base px-2 py-1 text-[11px] text-gn-muted hover:text-gn-fg"
                  >
                    <RefreshCw size={11} className={logLoading ? 'animate-spin' : ''} /> 刷新
                  </button>
                </div>
                {logLoading && commits.length === 0 ? (
                  <div className="py-8 text-center text-[12px] text-gn-muted">加载提交历史中…</div>
                ) : logError ? (
                  <div className="py-8 text-center text-[12px] text-gn-red">{logError}</div>
                ) : commits.length === 0 ? (
                  <div className="py-8 text-center text-[12px] text-gn-muted">暂无提交记录</div>
                ) : (
                  <div className="space-y-2">
                    {commits.map((c) => (
                      <div
                        key={c.hash}
                        className="rounded border border-gn-prompt-border/60 bg-gn-bg-base/40 p-3 transition-colors hover:bg-gn-bg-highlight/30"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-mono text-[12.5px] font-medium text-gn-fg">
                            {c.message}
                          </span>
                          <span className="shrink-0 rounded bg-gn-bg-dark px-1.5 py-0.5 font-mono text-[10.5px] text-gn-cyan">
                            {c.shortHash}
                          </span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-gn-muted">
                          <span>{c.author}</span>
                          <span className="flex items-center gap-1">
                            <Clock size={11} /> {c.date}
                          </span>
                          {c.refs && (
                            <span className="rounded bg-gn-cyan/10 px-1.5 py-0.2 font-mono text-[10px] text-gn-cyan">
                              {c.refs}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Tab: Sync & Branches */}
            {activeTab === 'sync' && (
              <div className="gn-no-scrollbar flex-1 overflow-y-auto p-4 space-y-6">
                {/* Remote Sync Card */}
                <div className="rounded-lg border border-gn-prompt-border bg-gn-bg-base/60 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-medium text-gn-fg flex items-center gap-1.5">
                      <UploadCloud size={16} className="text-gn-cyan" /> 远程仓库同步
                    </span>
                    <span className="font-mono text-[11px] text-gn-muted">
                      {status?.ahead ? `领先 ↑${status.ahead}` : '已是最新'}
                      {status?.behind ? ` · 落后 ↓${status.behind}` : ''}
                    </span>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        runOp('fetch', async () => {
                          await transport.gitFetch?.({ cwd })
                        })
                      }
                      className="flex items-center gap-1 rounded bg-gn-bg-base border border-gn-prompt-border px-3 py-1.5 text-[12px] text-gn-fg hover:bg-gn-bg-highlight disabled:opacity-40"
                    >
                      <RefreshCw size={12} /> Fetch (拉取状态)
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        runOp('pull', async () => {
                          await transport.gitPull?.({ cwd })
                        })
                      }
                      className="flex items-center gap-1 rounded bg-gn-bg-base border border-gn-prompt-border px-3 py-1.5 text-[12px] text-gn-fg hover:bg-gn-bg-highlight disabled:opacity-40"
                    >
                      <ArrowDown size={12} /> Pull (拉取并合并)
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        runOp('push', async () => {
                          await transport.gitPush?.({ cwd })
                        })
                      }
                      className="flex items-center gap-1 rounded bg-gn-green/20 border border-gn-green/40 px-3.5 py-1.5 text-[12px] font-medium text-gn-green hover:bg-gn-green/30 disabled:opacity-40"
                    >
                      <ArrowUp size={12} /> Push (推送到远程)
                    </button>
                  </div>
                </div>

                {/* Branch Management Card */}
                <div className="rounded-lg border border-gn-prompt-border bg-gn-bg-base/60 p-4">
                  <span className="text-[13px] font-medium text-gn-fg flex items-center gap-1.5">
                    <GitBranchIcon size={16} className="text-gn-yellow" /> 分支管理
                  </span>
                  {/* Create branch input */}
                  <div className="mt-3 flex items-center gap-2">
                    <input
                      type="text"
                      value={newBranchName}
                      onChange={(e) => setNewBranchName(e.target.value)}
                      placeholder="新分支名称"
                      className="min-h-8 min-w-0 flex-1 rounded border border-gn-prompt-border bg-gn-bg-dark px-2.5 text-[12px] text-gn-fg outline-none focus:border-gn-green/60"
                    />
                    <label className="flex items-center gap-1 text-[11px] text-gn-muted select-none">
                      <input
                        type="checkbox"
                        checked={newBranchCheckout}
                        onChange={(e) => setNewBranchCheckout(e.target.checked)}
                        className="accent-gn-green"
                      />
                      切换
                    </label>
                    <button
                      type="button"
                      disabled={!newBranchName.trim() || busy}
                      onClick={() => {
                        const name = newBranchName.trim()
                        void runOp(`创建分支 ${name}`, async () => {
                          await transport.gitBranchCreate?.({
                            cwd,
                            branch: name,
                            checkout: newBranchCheckout,
                          })
                          setNewBranchName('')
                          await refreshBranches()
                        })
                      }}
                      className="flex items-center gap-1 rounded bg-gn-bg-highlight px-3 py-1.5 text-[12px] text-gn-fg hover:bg-gn-prompt-border disabled:opacity-40"
                    >
                      <Plus size={13} /> 新建
                    </button>
                  </div>

                  {/* Branches list */}
                  <div className="mt-3 space-y-1 max-h-40 overflow-y-auto gn-no-scrollbar">
                    {branches.map((b) => {
                      const armed = armedCheckout?.branch === b.name
                      return (
                        <div
                          key={b.name}
                          className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-gn-bg-highlight/40"
                        >
                          <button
                            type="button"
                            disabled={busy || b.current === true}
                            onClick={() => onCheckoutClick(b)}
                            className={`flex min-w-0 flex-1 items-center gap-2 text-left font-mono text-[12px] ${
                              b.current ? 'text-gn-green font-medium' : 'text-gn-fg2 hover:text-gn-fg'
                            }`}
                          >
                            <span>{b.current ? '✓' : armed ? '?' : '⎇'}</span>
                            <span className="truncate">{b.name}</span>
                            {b.upstream && (
                              <span className="text-[10.5px] text-gn-muted truncate">
                                ({b.upstream})
                              </span>
                            )}
                          </button>
                          {!b.current && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                void runOp(`删除分支 ${b.name}`, async () => {
                                  await transport.gitBranchDelete?.({ cwd, branch: b.name, force: true })
                                  await refreshBranches()
                                })
                              }}
                              className="p-1 text-gn-muted hover:text-gn-red"
                              title="删除此分支"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Stash Management Card */}
                <div className="rounded-lg border border-gn-prompt-border bg-gn-bg-base/60 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-medium text-gn-fg flex items-center gap-1.5">
                      <GitPullRequest size={16} className="text-gn-muted" /> Stash 暂存箱
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={onStashClick}
                      className="rounded bg-gn-bg-base border border-gn-prompt-border px-2.5 py-1 text-[11px] text-gn-fg hover:bg-gn-bg-highlight disabled:opacity-40"
                    >
                      暂存当前改动 (Stash)
                    </button>
                  </div>
                  <div className="mt-3 space-y-1.5">
                    {stashLoading ? (
                      <div className="py-3 text-center text-[11px] text-gn-muted">加载中…</div>
                    ) : stashes.length === 0 ? (
                      <div className="py-3 text-center text-[11px] text-gn-muted">暂存箱为空</div>
                    ) : (
                      stashes.map((s) => {
                        const armedDrop = armedDropStash?.index === s.index
                        return (
                          <div
                            key={s.ref}
                            className="flex items-center justify-between rounded border border-gn-prompt-border/30 bg-gn-bg-dark/40 px-2.5 py-1.5 text-[11.5px]"
                          >
                            <div className="min-w-0 flex-1 truncate font-mono">
                              <span className="text-gn-cyan mr-2">{s.ref}</span>
                              <span className="text-gn-fg">{s.message}</span>
                              <span className="text-gn-muted ml-2 text-[10.5px]">({s.date})</span>
                            </div>
                            <div className="flex items-center gap-1 shrink-0 ml-2">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  runOp(`应用 ${s.ref}`, async () => {
                                    await transport.gitStashPop?.({ cwd, index: s.ref })
                                    await refreshStashes()
                                  })
                                }
                                className="rounded px-2 py-0.5 text-[10.5px] text-gn-green bg-gn-green/10 hover:bg-gn-green/20"
                              >
                                Pop
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  if (armedDropStash?.index === s.index && Date.now() - armedDropStash.at < CONFIRM_WINDOW_MS) {
                                    setArmedDropStash(null)
                                    void runOp(`删除 ${s.ref}`, async () => {
                                      await transport.gitStashDrop?.({ cwd, index: s.ref })
                                      await refreshStashes()
                                    })
                                  } else {
                                    setArmedDropStash({ index: s.index, at: Date.now() })
                                  }
                                }}
                                className={`rounded px-1.5 py-0.5 text-[10.5px] ${
                                  armedDrop ? 'bg-gn-diff-del-bg text-gn-red' : 'text-gn-muted hover:text-gn-red'
                                }`}
                              >
                                {armedDrop ? '确认？' : 'Drop'}
                              </button>
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer Commit Bar (only in Changes tab) */}
        {activeTab === 'changes' && (
          <footer className="gn-modal-footer flex flex-col gap-2 bg-gn-bg-base px-3 py-2.5 sm:px-4">
            {statusError && (
              <div className="rounded bg-gn-diff-del-bg px-2.5 py-1 text-[11px] text-gn-red font-mono truncate">
                {statusError}
              </div>
            )}
            {opError && (
              <div className="rounded bg-gn-diff-del-bg px-2.5 py-1 text-[11px] text-gn-red font-mono truncate">
                {opError}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter' && commitMsg.trim() && !busy) {
                    const msg = commitMsg.trim()
                    void runOp('commit', () =>
                      transport.gitCommit({
                        cwd,
                        message: msg,
                        ...(amend ? { amend: true } : {}),
                      }),
                    ).then((ok) => {
                      if (ok) setCommitMsg('')
                    })
                  }
                }}
                placeholder="提交信息（Enter 提交）"
                className="min-h-8 min-w-0 flex-1 rounded border border-gn-prompt-border bg-gn-bg-dark px-2.5 text-[12px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-green/60"
              />

              {/* AI Commit message button */}
              <button
                type="button"
                onClick={onGenerateCommitMsg}
                disabled={rows.length === 0 || busy}
                className="flex items-center gap-1 rounded border border-gn-prompt-border bg-gn-bg-highlight/60 px-2.5 py-1 text-[11.5px] text-gn-cyan hover:bg-gn-bg-highlight disabled:opacity-40"
                title="根据当前改动自动生成规范的提交信息"
              >
                <Sparkles size={12} />
                <span className="hidden sm:inline">AI 描述</span>
              </button>

              <label
                className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-gn-muted select-none"
                title="git commit --amend"
              >
                <input
                  type="checkbox"
                  checked={amend}
                  onChange={(e) => setAmend(e.target.checked)}
                  className="accent-gn-green"
                />
                amend
              </label>

              <button
                type="button"
                disabled={!commitMsg.trim() || busy}
                onClick={() => {
                  const msg = commitMsg.trim()
                  void runOp('commit', () =>
                    transport.gitCommit({
                      cwd,
                      message: msg,
                      ...(amend ? { amend: true } : {}),
                    }),
                  ).then((ok) => {
                    if (ok) setCommitMsg('')
                  })
                }}
                className="shrink-0 rounded bg-gn-green/20 border border-gn-green/40 px-3 py-1 text-[12px] font-medium text-gn-green hover:bg-gn-green/30 disabled:cursor-not-allowed disabled:opacity-40"
                title="提交暂存区的更改（x.ai/git/commit）"
              >
                commit
              </button>

              <button
                type="button"
                disabled={!commitMsg.trim() || busy}
                onClick={onCommitAndPush}
                className="hidden sm:flex shrink-0 items-center gap-1 rounded bg-gn-bg-base border border-gn-prompt-border px-2.5 py-1 text-[12px] text-gn-fg hover:bg-gn-bg-highlight disabled:cursor-not-allowed disabled:opacity-40"
                title="提交并推送到远端"
              >
                <GitCommit size={12} /> commit & push
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={onStashClick}
                className="shrink-0 rounded bg-gn-bg-base border border-gn-prompt-border px-2.5 py-1 text-[12px] text-gn-fg hover:bg-gn-bg-highlight disabled:cursor-not-allowed disabled:opacity-40"
                title="git stash — 暂存全部未提交更改"
              >
                stash
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  )
}
