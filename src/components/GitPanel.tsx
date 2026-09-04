import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  GitBranch as GitBranchIcon,
  GitCommit,
  GitPullRequest,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
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
 * 2. 'log': IntelliJ IDEA-style commit log table, search filter, and commit detail inspector.
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

const STATUS_BADGE: Record<
  RowStatus,
  { label: string; title: string; className: string }
> = {
  staged: {
    label: 'S',
    title: 'Staged (已暂存)',
    className: 'bg-gn-green/20 text-gn-green border-gn-green/40',
  },
  modified: {
    label: 'M',
    title: 'Modified (已修改)',
    className: 'bg-gn-yellow/20 text-gn-yellow border-gn-yellow/40',
  },
  untracked: {
    label: 'U',
    title: 'Untracked (未跟踪)',
    className: 'bg-gn-red/20 text-gn-red border-gn-red/40',
  },
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
      // Hunk header is displayed once in the block header bar; do not repeat it as a diff row
      currentHunk = { header: line, rows: [] }
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
    return <div className="px-2.5 py-0.5 font-mono text-[11px] text-gn-cyan/80 bg-gn-bg-dark/40">{text}</div>
  }
  if (kind === 'hunk') {
    return <div className="px-2.5 py-0.5 font-mono text-[11px] text-gn-muted bg-gn-bg-base/40">{text}</div>
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
    <div className="flex font-mono text-[12px] leading-[1.4] hover:bg-gn-bg-highlight/30" style={{ background: bg }}>
      <span className="shrink-0 select-none px-1.5 font-semibold opacity-70" style={{ color: fg }}>
        {sign}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all" style={{ color: fg }}>
        {text || ' '}
      </span>
    </div>
  )
}

function renderRefBadges(refs?: string) {
  if (!refs) return null
  const parts = refs.split(',').map((r) => r.trim()).filter(Boolean)
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      {parts.map((ref, idx) => {
        const isHead = ref.includes('HEAD') || ref.includes('main') || ref.includes('master')
        const isTag = ref.startsWith('tag:')
        const isRemote = ref.startsWith('origin/') || ref.startsWith('upstream/')
        const colorClass = isHead
          ? 'bg-gn-green/20 text-gn-green border-gn-green/40'
          : isTag
            ? 'bg-gn-yellow/20 text-gn-yellow border-gn-yellow/40'
            : isRemote
              ? 'bg-gn-cyan/20 text-gn-cyan border-gn-cyan/40'
              : 'bg-gn-bg-highlight text-gn-muted border-gn-prompt-border'
        return (
          <span
            key={idx}
            className={`rounded border px-1.5 py-[1px] font-mono text-[9.5px] font-medium leading-none ${colorClass}`}
          >
            {ref}
          </span>
        )
      })}
    </span>
  )
}

function splitPath(path: string): { fileName: string; dirPath: string } {
  const lastSlash = path.lastIndexOf('/')
  if (lastSlash < 0) return { fileName: path, dirPath: '' }
  return { fileName: path.slice(lastSlash + 1), dirPath: path.slice(0, lastSlash + 1) }
}

const TABS: { id: ActiveTab; label: string; shortLabel: string }[] = [
  { id: 'changes', label: '变更', shortLabel: '变更' },
  { id: 'log', label: '历史', shortLabel: '历史' },
  { id: 'sync', label: '分支与同步', shortLabel: '同步' },
]

function ChangeGroup({
  title,
  count,
  tone,
  action,
  children,
}: {
  title: string
  count: number
  tone: 'green' | 'yellow' | 'red'
  action?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  if (count === 0) return null
  const toneClass =
    tone === 'green' ? 'text-gn-green' : tone === 'yellow' ? 'text-gn-yellow' : 'text-gn-red'
  return (
    <section>
      <div className="sticky top-0 z-[1] flex items-center gap-1 border-b border-gn-prompt-border/40 bg-gn-bg-base/95 px-2 py-0.5 backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? '折叠' : '展开'}${title}`}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1.5 text-left hover:bg-gn-bg-highlight/60 sm:py-1"
        >
          {open ? (
            <ChevronDown size={12} className="shrink-0 text-gn-muted" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-gn-muted" />
          )}
          <span className={`text-[10.5px] font-semibold uppercase tracking-wider ${toneClass}`}>
            {title}
          </span>
          <span className="font-mono text-[10px] text-gn-muted">{count}</span>
        </button>
        {action}
      </div>
      {open ? children : null}
    </section>
  )
}

function FileRow({
  row,
  selected,
  armed,
  busy,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
}: {
  row: StatusRow
  selected: boolean
  armed: boolean
  busy: boolean
  onSelect: () => void
  onStage?: () => void
  onUnstage?: () => void
  onDiscard: (e: React.MouseEvent) => void
}) {
  const { fileName, dirPath } = splitPath(row.path)
  const statusConfig = STATUS_BADGE[row.status]
  return (
    <div
      className={`group flex items-center gap-1.5 border-b border-gn-prompt-border/20 px-2.5 py-2 min-h-11 sm:min-h-0 sm:py-1.5 transition-colors ${
        selected
          ? 'bg-gn-bg-highlight font-medium border-l-2 border-l-gn-cyan'
          : 'border-l-2 border-l-transparent hover:bg-gn-bg-highlight/60'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        title={row.path}
      >
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border font-mono text-[9px] font-bold ${statusConfig.className}`}
          title={statusConfig.title}
        >
          {statusConfig.label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] sm:text-[11.5px]">
          <span className="font-medium text-gn-fg">{fileName}</span>
          {dirPath ? <span className="ml-1 text-[10px] text-gn-muted/70">{dirPath}</span> : null}
        </span>
        {(row.additions > 0 || row.deletions > 0) && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-gn-gutter">
            +{row.additions}−{row.deletions}
          </span>
        )}
      </button>

      <div className="flex shrink-0 items-center gap-0.5">
        {row.status === 'staged' ? (
          <button
            type="button"
            disabled={busy}
            aria-label="unstage"
            onClick={(e) => {
              e.stopPropagation()
              onUnstage?.()
            }}
            className="flex h-8 w-8 items-center justify-center rounded text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40 sm:h-6 sm:w-6"
            title="取消暂存 (unstage)"
          >
            <Minus size={13} />
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            aria-label="stage"
            onClick={(e) => {
              e.stopPropagation()
              onStage?.()
            }}
            className="flex h-8 w-8 items-center justify-center rounded text-gn-green transition-colors hover:bg-gn-green/20 disabled:opacity-40 sm:h-6 sm:w-6"
            title="加入暂存 (stage)"
          >
            <Plus size={13} />
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          aria-label={armed ? '确认？' : 'discard'}
          onClick={onDiscard}
          className={`flex items-center justify-center rounded transition-colors disabled:opacity-40 ${
            armed
              ? 'h-8 px-1.5 text-[10px] font-medium bg-gn-diff-del-bg text-gn-red border border-gn-red/40 sm:h-6'
              : 'h-8 w-8 text-gn-muted hover:bg-gn-diff-del-bg hover:text-gn-red sm:h-6 sm:w-6'
          }`}
          title={armed ? '再点一次确认丢弃更改（2 秒内）' : '丢弃该文件的更改 (discard)'}
        >
          {armed ? '确认？' : <RotateCcw size={13} />}
        </button>
      </div>
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

  // Fetch status/branches on open; tab-specific data only when that tab is shown.
  useEffect(() => {
    if (!open) return
    void refresh()
    void refreshBranches()
  }, [open, refresh, refreshBranches])

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
    setSelectedCommitHash(undefined)
    setCommitFilter('')
    setCommitDiff(undefined)
    setCopiedHash(false)
    setOpError(undefined)
    setCommitMsg('')
    setAmend(false)
    setArmedDiscard(null)
    setArmedCheckout(null)
    setArmedDropStash(null)
  }, [open])

  // Load commit diff for selected commit in history tab
  useEffect(() => {
    if (!open || activeTab !== 'log' || !selectedCommitHash) {
      setCommitDiff(undefined)
      return
    }
    let alive = true
    setCommitDiff({ loading: true })
    void transport
      .gitDiffs?.({ cwd, from: `${selectedCommitHash}^`, to: selectedCommitHash })
      ?.then((res) => {
        if (!alive) return
        setCommitDiff({ loading: false, files: res?.files ?? [] })
      })
      ?.catch(() => {
        if (!alive) return
        setCommitDiff({ loading: false, files: [] })
      })
    return () => {
      alive = false
    }
  }, [open, activeTab, selectedCommitHash, cwd])

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
  const notRepo =
    /not a git repository/i.test(statusError ?? '') ||
    /could not find repository/i.test(statusError ?? '') ||
    /notgitrepo/i.test(statusError ?? '') ||
    ((statusError === 'Internal error' || statusError?.includes('Internal error')) && !branch)
  const busy = busyOp != null
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
        <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-base px-3 py-1.5 sm:px-4">
          <span className="text-[14px] font-bold text-gn-fg">git</span>

          {!notRepo && branch ? (
            <button
              type="button"
              onClick={() => setActiveTab('sync')}
              aria-label="查看分支与同步"
              title={branch}
              className="flex min-w-0 max-w-[46vw] items-center gap-1 truncate rounded px-1 py-0.5 font-mono text-[12px] text-gn-cyan hover:bg-gn-bg-highlight sm:max-w-[240px]"
            >
              <span className="shrink-0" aria-hidden>
                ⎇
              </span>
              <span className="truncate">{branch === '(detached)' ? 'detached' : branch}</span>
              {status?.ahead != null && status.ahead > 0 && (
                <span className="shrink-0 rounded bg-gn-yellow/15 px-1 font-bold text-gn-yellow" title="领先上游的未推送提交">
                  ↑{status.ahead}
                </span>
              )}
              {status?.behind != null && status.behind > 0 && (
                <span className="shrink-0 rounded bg-gn-bg-highlight px-1 font-bold text-gn-muted" title="落后上游的提交">
                  ↓{status.behind}
                </span>
              )}
            </button>
          ) : null}

          {!notRepo && rows.length > 0 && (
            <span className="hidden font-mono text-[11px] text-gn-muted md:inline">
              {stagedRows.length} staged · {modifiedRows.length} modified · {untrackedRows.length} untracked
            </span>
          )}

          {busyOp ? (
            <span className="hidden min-w-0 truncate font-mono text-[11px] text-gn-yellow sm:inline">
              {busyOp}…
            </span>
          ) : null}

          <div className="ml-auto flex items-center gap-0.5">
            {!notRepo && (
              <button
                type="button"
                onClick={() => {
                  void refresh()
                  void refreshBranches()
                  if (activeTab === 'log') void refreshLog()
                  if (activeTab === 'sync') void refreshStashes()
                }}
                disabled={loading}
                className="rounded p-1.5 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40"
                title="重新拉取 git 状态"
              >
                <span className="hidden sm:inline text-[11px] px-1">刷新</span>
                <RefreshCw size={13} className={`inline ${loading || busy ? 'animate-spin' : ''}`} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1.5 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
              aria-label="关闭"
              title="关闭 (Esc)"
            >
              <X size={15} aria-hidden />
            </button>
          </div>
        </header>

        {!notRepo && (
          <nav
            role="tablist"
            aria-label="Git 面板分类"
            className="shrink-0 border-b border-gn-prompt-border bg-gn-bg-dark/30 p-1.5"
          >
            <div className="flex w-full gap-1">
              {TABS.map((tab) => {
                const on = activeTab === tab.id
                const count = tab.id === 'changes' && rows.length > 0 ? rows.length : undefined
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-label={tab.label}
                    aria-selected={on}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded px-2 py-2 text-[12.5px] transition-colors sm:flex-none sm:px-3 sm:py-1.5 sm:text-[12px] ${
                      on
                        ? 'bg-gn-bg-highlight font-medium text-gn-fg'
                        : 'text-gn-muted hover:bg-gn-bg-highlight/60 hover:text-gn-fg'
                    }`}
                  >
                    <span className="sm:hidden">{tab.shortLabel}</span>
                    <span className="hidden sm:inline">{tab.label}</span>
                    {count != null && (
                      <span className="rounded bg-gn-bg-dark/80 px-1 font-mono text-[10px] text-gn-muted">
                        {count}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </nav>
        )}

        {!notRepo && (opError || (statusError && status)) && (
          <div className="shrink-0 border-b border-gn-prompt-border/50 bg-gn-diff-del-bg/40 px-3 py-1.5 font-mono text-[11px] text-gn-red">
            {opError ?? statusError}
          </div>
        )}

        {/* Content area */}
        {notRepo ? (
          <div className="flex flex-1 flex-col items-center justify-center p-6 sm:p-8 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gn-bg-highlight text-gn-cyan border border-gn-prompt-border/60 shadow-sm">
              <GitBranchIcon size={26} />
            </div>
            <div className="mt-4 text-[16px] font-semibold text-gn-fg">
              当前目录不是 git 仓库
            </div>
            <p className="mt-2 max-w-md text-[12.5px] leading-relaxed text-gn-muted">
              当前工作区路径 <span className="font-mono text-gn-cyan">{cwd || '当前路径'}</span> 尚未初始化 Git 版本控制 (not a git repository)。
              一键初始化后即可直接使用暂存、提交、分支管理等功能。
            </p>
            <div className="mt-2 font-mono text-[11px] text-gn-gutter">
              ({statusError})
            </div>
            <div className="mt-6 flex w-full max-w-sm flex-col items-stretch gap-2 sm:max-w-none sm:flex-row sm:items-center sm:justify-center sm:gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  runOp('init', async () => {
                    await transport.gitInit?.({ cwd })
                    await refresh()
                  })
                }
                className="flex items-center justify-center gap-1.5 rounded-lg bg-gn-green/20 border border-gn-green/40 px-4 py-2.5 text-[12.5px] font-medium text-gn-green hover:bg-gn-green/30 disabled:opacity-40 shadow-sm sm:py-2"
              >
                <Plus size={15} /> 初始化 Git 仓库 (git init)
              </button>
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-lg border border-gn-prompt-border bg-gn-bg-base px-3.5 py-2.5 text-[12px] text-gn-fg hover:bg-gn-bg-highlight sm:py-2"
              >
                重试
              </button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {activeTab === 'changes' && (
              statusError && !status ? (
                <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
                  <div className="text-[13px] text-gn-red">{statusError}</div>
                  <div className="mt-1 text-[11.5px] text-gn-muted">host 调用失败</div>
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
                  {/* File list sidebar — hidden on mobile while a diff is open */}
                  <div
                    className={`flex min-h-0 shrink-0 flex-col border-gn-prompt-border bg-gn-bg-base/40 sm:border-r ${
                      selectedPath ? 'hidden sm:flex sm:w-[320px] lg:w-[360px]' : 'flex w-full sm:w-[320px] lg:w-[360px]'
                    }`}
                  >
                    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gn-prompt-border/50 px-3 py-2">
                      <span className="text-[10px] uppercase tracking-wider text-gn-gutter">
                        工作区状态 · {rows.length}
                      </span>
                      <div className="flex items-center gap-1">
                        {unstagedRows.length > 0 && (
                          <button
                            type="button"
                            onClick={onStageAll}
                            disabled={busy}
                            className="rounded bg-gn-bg-highlight px-2 py-1 text-[10.5px] text-gn-green hover:bg-gn-green/20 sm:px-1.5 sm:py-0.5 sm:text-[10px]"
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
                            className="rounded bg-gn-bg-highlight px-2 py-1 text-[10.5px] text-gn-muted hover:bg-gn-bg-base sm:px-1.5 sm:py-0.5 sm:text-[10px]"
                            title="一键取消暂存全部文件"
                          >
                            全部取消
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="gn-no-scrollbar min-h-0 flex-1 overflow-y-auto">
                      {loading && rows.length === 0 && (
                        <div className="px-3 py-3 text-[11px] text-gn-muted">加载中…</div>
                      )}
                      {!loading && rows.length === 0 && (
                        <div className="px-3 py-8 text-center text-[12px] text-gn-muted">
                          工作区没有改动 ✓
                        </div>
                      )}

                      <ChangeGroup title="已暂存" count={stagedRows.length} tone="green">
                        {stagedRows.map((row) => (
                          <FileRow
                            key={row.path}
                            row={row}
                            selected={row.path === selectedPath}
                            armed={armedDiscard?.path === row.path}
                            busy={busy}
                            onSelect={() => setSelectedPath(row.path === selectedPath ? undefined : row.path)}
                            onUnstage={() =>
                              void runOp(`unstage ${row.path}`, () =>
                                transport.gitUnstage({ cwd, paths: [row.path] }),
                              )
                            }
                            onDiscard={(e) => onDiscardClick(e, row)}
                          />
                        ))}
                      </ChangeGroup>
                      <ChangeGroup title="已修改" count={modifiedRows.length} tone="yellow">
                        {modifiedRows.map((row) => (
                          <FileRow
                            key={row.path}
                            row={row}
                            selected={row.path === selectedPath}
                            armed={armedDiscard?.path === row.path}
                            busy={busy}
                            onSelect={() => setSelectedPath(row.path === selectedPath ? undefined : row.path)}
                            onStage={() =>
                              void runOp(`stage ${row.path}`, () =>
                                transport.gitStage({ cwd, paths: [row.path] }),
                              )
                            }
                            onDiscard={(e) => onDiscardClick(e, row)}
                          />
                        ))}
                      </ChangeGroup>
                      <ChangeGroup title="未跟踪" count={untrackedRows.length} tone="red">
                        {untrackedRows.map((row) => (
                          <FileRow
                            key={row.path}
                            row={row}
                            selected={row.path === selectedPath}
                            armed={armedDiscard?.path === row.path}
                            busy={busy}
                            onSelect={() => setSelectedPath(row.path === selectedPath ? undefined : row.path)}
                            onStage={() =>
                              void runOp(`stage ${row.path}`, () =>
                                transport.gitStage({ cwd, paths: [row.path] }),
                              )
                            }
                            onDiscard={(e) => onDiscardClick(e, row)}
                          />
                        ))}
                      </ChangeGroup>
                    </div>
                  </div>

                  {/* Diff Viewer — full-screen on mobile when a file is selected */}
                  <div
                    className={`flex min-h-0 min-w-0 flex-1 flex-col bg-gn-bg-dark ${
                      selectedPath ? 'flex' : 'hidden sm:flex'
                    }`}
                  >
                    {selectedPath && (
                      <div className="flex shrink-0 items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-base px-3 py-2 sm:hidden">
                        <button
                          type="button"
                          onClick={() => setSelectedPath(undefined)}
                          className="flex min-h-9 items-center gap-1 text-[12.5px] text-gn-cyan"
                        >
                          <ChevronLeft size={16} /> 返回文件列表
                        </button>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-gn-fg2">
                          {selectedPath}
                        </span>
                      </div>
                    )}

                    <div className="gn-no-scrollbar min-h-0 flex-1 overflow-y-auto">
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
                            <div className="flex items-center justify-between gap-2 border-b border-gn-prompt-border/30 px-3 pb-2 font-mono text-[11.5px] text-gn-cyan">
                              <span className="truncate">diff · {diff.file.path}</span>
                              {diff.file.additions > 0 || diff.file.deletions > 0 ? (
                                <span className="shrink-0 text-gn-gutter">
                                  +{diff.file.additions} −{diff.file.deletions}
                                </span>
                              ) : null}
                            </div>
                          )}
                          {diff.note && (
                            <div className="bg-gn-bg-base/20 px-3 py-1 font-mono text-[10.5px] text-gn-gutter">
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
                                  <div className="flex items-center justify-between gap-2 border-b border-gn-prompt-border/40 bg-gn-bg-base/80 px-2.5 py-1">
                                    <span className="truncate font-mono text-[11px] text-gn-cyan/90 select-all">
                                      {block.header}
                                    </span>
                                    {selectedPath &&
                                      selectedRow?.status !== 'staged' &&
                                      block.header !== 'New File' && (
                                        <button
                                          type="button"
                                          onClick={() => onStageHunk(block)}
                                          disabled={busy}
                                          className="ml-2 shrink-0 rounded border border-gn-green/30 bg-gn-bg-highlight px-2 py-1 text-[10px] text-gn-green transition-colors hover:bg-gn-green/20 sm:py-0.5"
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
                        <div className="flex h-full min-h-48 flex-col items-center justify-center gap-1 px-6 text-center font-mono text-[12px] text-gn-muted">
                          <span>选择左侧文件查看 diff</span>
                          <span className="text-[10.5px] text-gn-gutter">
                            点击文件名预览改动，使用 + / − 暂存或取消暂存
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            )}

            {/* Tab: History Log (IntelliJ IDEA Style) */}
            {activeTab === 'log' && (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div
                  className={`shrink-0 items-center justify-between gap-2 border-b border-gn-prompt-border bg-gn-bg-base/60 px-3 py-2 ${
                    selectedCommit ? 'hidden sm:flex' : 'flex'
                  }`}
                >
                  <div className="relative min-w-0 flex-1 max-w-sm">
                    <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gn-muted" />
                    <input
                      type="text"
                      value={commitFilter}
                      onChange={(e) => setCommitFilter(e.target.value)}
                      placeholder="搜索提交信息、作者、哈希..."
                      className="h-8 w-full rounded border border-gn-prompt-border bg-gn-bg-dark pl-7 pr-7 text-[11.5px] text-gn-fg outline-none focus:border-gn-cyan/60 sm:h-7"
                    />
                    {commitFilter && (
                      <button
                        type="button"
                        onClick={() => setCommitFilter('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gn-muted hover:text-gn-fg"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-gn-muted">
                    <span className="hidden font-mono sm:inline">
                      {filteredCommits.length !== commits.length
                        ? `${filteredCommits.length} / ${commits.length} 次提交`
                        : `共 ${commits.length} 次提交`}
                    </span>
                    <button
                      type="button"
                      onClick={() => void refreshLog()}
                      className="flex items-center gap-1 rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-gn-muted hover:text-gn-fg"
                      title="刷新提交历史"
                    >
                      <RefreshCw size={11} className={logLoading ? 'animate-spin' : ''} /> 刷新
                    </button>
                  </div>
                </div>

                <div className="flex min-h-0 flex-1 flex-col overflow-hidden sm:flex-row">
                  <div
                    className={`min-w-0 flex-col border-gn-prompt-border/60 sm:border-r ${
                      selectedCommit ? 'hidden sm:flex sm:flex-1' : 'flex flex-1'
                    }`}
                  >
                    <div className="flex shrink-0 items-center border-b border-gn-prompt-border/40 bg-gn-bg-base/80 px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-wider text-gn-gutter select-none">
                      <span className="min-w-0 flex-1">提交信息</span>
                      <span className="hidden w-24 shrink-0 text-left md:inline">作者</span>
                      <span className="hidden w-24 shrink-0 text-left sm:inline">日期</span>
                      <span className="w-16 shrink-0 text-right">哈希</span>
                    </div>

                    <div className="gn-no-scrollbar flex-1 divide-y divide-gn-prompt-border/20 overflow-y-auto">
                      {logLoading && commits.length === 0 ? (
                        <div className="py-8 text-center text-[12px] text-gn-muted">加载提交历史中…</div>
                      ) : logError ? (
                        <div className="py-8 text-center text-[12px] text-gn-red">{logError}</div>
                      ) : filteredCommits.length === 0 ? (
                        <div className="py-8 text-center text-[12px] text-gn-muted">
                          {commitFilter ? '未找到匹配的提交' : '暂无提交记录'}
                        </div>
                      ) : (
                        filteredCommits.map((c) => {
                          const isSelected = selectedCommit?.hash === c.hash
                          return (
                            <div
                              key={c.hash}
                              onClick={() => setSelectedCommitHash(c.hash)}
                              className={`flex cursor-pointer items-center gap-2 px-3 py-2.5 text-[12px] transition-colors sm:py-1.5 ${
                                isSelected
                                  ? 'border-l-2 border-gn-cyan bg-gn-bg-highlight font-medium text-gn-fg'
                                  : 'border-l-2 border-transparent text-gn-fg2 hover:bg-gn-bg-highlight/40 hover:text-gn-fg'
                              }`}
                            >
                              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <div className="flex min-w-0 items-center gap-1.5 truncate">
                                  {renderRefBadges(c.refs)}
                                  <span className="truncate font-mono" title={c.message}>
                                    {c.message}
                                  </span>
                                </div>
                                <div className="truncate text-[10.5px] text-gn-muted sm:hidden">
                                  {c.author} · {c.date}
                                </div>
                              </div>
                              <span className="hidden w-24 shrink-0 truncate font-mono text-[11px] text-gn-muted md:inline" title={c.author}>
                                {c.author}
                              </span>
                              <span className="hidden w-24 shrink-0 truncate text-[11px] text-gn-muted sm:inline" title={c.date}>
                                {c.date}
                              </span>
                              <span className="w-16 shrink-0 text-right font-mono text-[10.5px] text-gn-cyan">
                                {c.shortHash}
                              </span>
                            </div>
                          )
                        })
                      )}
                    </div>
                  </div>

                  {selectedCommit ? (
                    <div className="flex min-h-0 w-full shrink-0 flex-col overflow-hidden bg-gn-bg-dark/60 sm:w-[320px] md:w-[360px]">
                      <div className="flex shrink-0 items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-base px-3 py-2 sm:hidden">
                        <button
                          type="button"
                          onClick={() => setSelectedCommitHash(undefined)}
                          className="flex min-h-9 items-center gap-1 text-[12.5px] text-gn-cyan"
                        >
                          <ChevronLeft size={16} /> 返回提交列表
                        </button>
                      </div>
                      <div className="shrink-0 space-y-2 border-b border-gn-prompt-border/40 bg-gn-bg-base/30 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-mono text-[13px] font-semibold leading-snug break-words text-gn-fg">
                            <span className="font-normal text-gn-gutter">提交：</span>
                            {selectedCommit.message}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              void navigator.clipboard?.writeText(selectedCommit.hash)
                              setCopiedHash(true)
                              setTimeout(() => setCopiedHash(false), 1500)
                            }}
                            className="flex shrink-0 items-center gap-1 rounded border border-gn-prompt-border bg-gn-bg-dark px-1.5 py-0.5 font-mono text-[10px] text-gn-cyan hover:bg-gn-bg-highlight"
                            title="复制完整 SHA"
                          >
                            {copiedHash ? <Check size={11} className="text-gn-green" /> : <Copy size={11} />}
                            <span>{selectedCommit.hash.slice(0, 7)}</span>
                          </button>
                        </div>

                        <div className="flex flex-col gap-1 text-[11px] text-gn-muted">
                          <div>
                            <span className="text-gn-gutter">作者：</span>
                            {selectedCommit.author}
                            {selectedCommit.email ? ` <${selectedCommit.email}>` : ''}
                          </div>
                          <div className="flex items-center gap-1 text-[10.5px]">
                            <Clock size={11} className="shrink-0" />
                            <span>{selectedCommit.date}</span>
                          </div>
                          {selectedCommit.refs && (
                            <div className="pt-0.5">{renderRefBadges(selectedCommit.refs)}</div>
                          )}
                        </div>
                      </div>

                      <div className="flex min-h-0 flex-1 flex-col">
                        <div className="flex shrink-0 items-center justify-between border-b border-gn-prompt-border/30 bg-gn-bg-base/50 px-3 py-1.5 text-[10.5px] uppercase tracking-wider text-gn-gutter select-none">
                          <span>改动文件 {commitDiff?.files ? `· ${commitDiff.files.length}` : ''}</span>
                        </div>
                        <div className="gn-no-scrollbar flex-1 space-y-1 overflow-y-auto p-2">
                          {commitDiff?.loading ? (
                            <div className="py-4 text-center text-[11px] text-gn-muted">分析改动中…</div>
                          ) : commitDiff?.error ? (
                            <div className="px-3 py-2 text-[11px] text-gn-muted">无附加文件差异</div>
                          ) : commitDiff?.files && commitDiff.files.length > 0 ? (
                            commitDiff.files.map((f) => (
                              <div
                                key={f.path}
                                className="flex items-center justify-between rounded px-2 py-2 font-mono text-[11px] hover:bg-gn-bg-highlight/40 sm:py-1"
                                title={f.path}
                              >
                                <span className="min-w-0 flex-1 truncate text-gn-fg">{f.path}</span>
                                <span className="ml-2 shrink-0 text-[10px] tabular-nums text-gn-gutter">
                                  +{f.additions}−{f.deletions}
                                </span>
                              </div>
                            ))
                          ) : (
                            <div className="py-3 text-center text-[11px] text-gn-muted">
                              {commitDiff ? '无修改文件记录' : '点击提交查看改动详情'}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="hidden flex-1 items-center justify-center text-[12px] text-gn-muted sm:flex">
                      选择左侧提交查看详细信息
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Tab: Sync & Branches */}
            {activeTab === 'sync' && (
              <div className="gn-no-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:p-4">
                <div className="flex shrink-0 flex-col gap-2.5 rounded-lg border border-gn-prompt-border bg-gn-bg-base/60 px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-3.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <UploadCloud size={16} className="shrink-0 text-gn-cyan" />
                    <span className="text-[13px] font-medium text-gn-fg">远程仓库同步</span>
                    <span className="ml-1 font-mono text-[11px] text-gn-muted">
                      {status?.ahead ? `领先 ↑${status.ahead}` : '已是最新'}
                      {status?.behind ? ` · 落后 ↓${status.behind}` : ''}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 sm:flex sm:items-center">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        runOp('fetch', async () => {
                          await transport.gitFetch?.({ cwd })
                        })
                      }
                      className="flex min-h-9 items-center justify-center gap-1 rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1.5 text-[11.5px] text-gn-fg hover:bg-gn-bg-highlight disabled:opacity-40 sm:min-h-0 sm:px-2.5 sm:py-1"
                    >
                      <RefreshCw size={11} />
                      Fetch
                      <span className="hidden sm:inline"> (拉取状态)</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        runOp('pull', async () => {
                          await transport.gitPull?.({ cwd })
                        })
                      }
                      className="flex min-h-9 items-center justify-center gap-1 rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1.5 text-[11.5px] text-gn-fg hover:bg-gn-bg-highlight disabled:opacity-40 sm:min-h-0 sm:px-2.5 sm:py-1"
                    >
                      <ArrowDown size={11} />
                      Pull
                      <span className="hidden sm:inline"> (拉取并合并)</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        runOp('push', async () => {
                          await transport.gitPush?.({ cwd })
                        })
                      }
                      className="flex min-h-9 items-center justify-center gap-1 rounded border border-gn-green/40 bg-gn-green/20 px-2 py-1.5 text-[11.5px] font-medium text-gn-green hover:bg-gn-green/30 disabled:opacity-40 sm:min-h-0 sm:px-3 sm:py-1"
                    >
                      <ArrowUp size={11} />
                      Push
                      <span className="hidden sm:inline"> (推送到远程)</span>
                    </button>
                  </div>
                </div>

                <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex min-h-0 flex-col rounded-lg border border-gn-prompt-border bg-gn-bg-base/60 p-3">
                    <div className="flex shrink-0 items-center justify-between border-b border-gn-prompt-border/40 pb-2">
                      <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-gn-fg">
                        <GitBranchIcon size={15} className="text-gn-yellow" /> 分支 · {branches.length}
                      </span>
                    </div>
                    {branchesError && (
                      <div className="mt-1.5 text-[10.5px] leading-snug text-gn-red">{branchesError}</div>
                    )}

                    <div className="mt-2.5 flex shrink-0 flex-col gap-1.5 sm:flex-row sm:items-center">
                      <input
                        type="text"
                        value={newBranchName}
                        onChange={(e) => setNewBranchName(e.target.value)}
                        placeholder="新分支名称"
                        className="h-9 min-w-0 flex-1 rounded border border-gn-prompt-border bg-gn-bg-dark px-2 text-[11.5px] text-gn-fg outline-none focus:border-gn-green/60 sm:h-7"
                      />
                      <div className="flex items-center gap-1.5">
                        <label className="flex shrink-0 cursor-pointer select-none items-center gap-1 text-[11px] text-gn-muted">
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
                          className="flex h-9 shrink-0 items-center gap-1 rounded bg-gn-bg-highlight px-2.5 text-[11.5px] text-gn-fg hover:bg-gn-prompt-border disabled:opacity-40 sm:h-7"
                        >
                          <Plus size={12} /> 新建
                        </button>
                      </div>
                    </div>

                    <div className="gn-no-scrollbar mt-2.5 min-h-[140px] max-h-[360px] flex-1 space-y-0.5 overflow-y-auto">
                      {branchesLoading && branches.length === 0 && (
                        <div className="py-4 text-center text-[11px] text-gn-muted">加载中…</div>
                      )}
                      {!branchesLoading && branches.length === 0 && !branchesError && (
                        <div className="py-4 text-center text-[11px] text-gn-muted">无分支信息</div>
                      )}
                      {branches.map((b) => {
                        const armed = armedCheckout?.branch === b.name
                        return (
                          <div
                            key={b.name}
                            className="group flex items-center justify-between rounded px-2 py-1.5 transition-colors hover:bg-gn-bg-highlight/50 sm:py-1"
                          >
                            <button
                              type="button"
                              disabled={busy || b.current === true}
                              onClick={() => onCheckoutClick(b)}
                              className={`flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-[12px] sm:text-[11.5px] ${
                                b.current ? 'font-medium text-gn-green' : 'text-gn-fg2 hover:text-gn-fg'
                              }`}
                            >
                              <span className="w-3.5 shrink-0 text-[10.5px]">
                                {b.current ? '✓' : armed ? '?' : '⎇'}
                              </span>
                              <span className="truncate">{b.name}</span>
                              {b.upstream && (
                                <span className="ml-1 truncate text-[10px] text-gn-muted">({b.upstream})</span>
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
                                className="p-1.5 text-gn-muted transition-colors hover:text-gn-red sm:p-1"
                                title="删除此分支"
                              >
                                <Trash2 size={12} />
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  <div className="flex min-h-0 flex-col rounded-lg border border-gn-prompt-border bg-gn-bg-base/60 p-3">
                    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gn-prompt-border/40 pb-2">
                      <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-gn-fg">
                        <GitPullRequest size={15} className="text-gn-muted" /> Stash 暂存箱
                        <span className="font-mono text-[10.5px] font-normal text-gn-muted">({stashes.length})</span>
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={onStashClick}
                        className="rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-[10.5px] text-gn-fg hover:bg-gn-bg-highlight disabled:opacity-40"
                      >
                        暂存当前改动 (Stash)
                      </button>
                    </div>

                    <div className="gn-no-scrollbar mt-2.5 min-h-[140px] max-h-[360px] flex-1 space-y-1 overflow-y-auto">
                      {stashLoading ? (
                        <div className="py-4 text-center text-[11px] text-gn-muted">加载中…</div>
                      ) : stashes.length === 0 ? (
                        <div className="py-4 text-center text-[11px] text-gn-muted">暂存箱为空</div>
                      ) : (
                        stashes.map((s) => {
                          const armedDrop = armedDropStash?.index === s.index
                          return (
                            <div
                              key={s.ref}
                              className="flex flex-col gap-1.5 rounded border border-gn-prompt-border/30 bg-gn-bg-dark/40 px-2 py-1.5 text-[11px] sm:flex-row sm:items-center sm:justify-between sm:gap-0 sm:py-1"
                            >
                              <div className="min-w-0 flex-1 truncate font-mono">
                                <span className="mr-1.5 text-gn-cyan">{s.ref}</span>
                                <span className="text-gn-fg">{s.message}</span>
                                <span className="ml-1.5 text-[10px] text-gn-muted">({s.date})</span>
                              </div>
                              <div className="ml-0 flex shrink-0 items-center gap-1 sm:ml-1.5">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() =>
                                    runOp(`应用 ${s.ref}`, async () => {
                                      await transport.gitStashPop?.({ cwd, index: s.ref })
                                      await refreshStashes()
                                    })
                                  }
                                  className="rounded bg-gn-green/10 px-2 py-1 text-[10px] text-gn-green hover:bg-gn-green/20 sm:px-1.5 sm:py-0.5"
                                >
                                  Pop
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    if (
                                      armedDropStash?.index === s.index &&
                                      Date.now() - armedDropStash.at < CONFIRM_WINDOW_MS
                                    ) {
                                      setArmedDropStash(null)
                                      void runOp(`删除 ${s.ref}`, async () => {
                                        await transport.gitStashDrop?.({ cwd, index: s.ref })
                                        await refreshStashes()
                                      })
                                    } else {
                                      setArmedDropStash({ index: s.index, at: Date.now() })
                                    }
                                  }}
                                  className={`rounded px-2 py-1 text-[10px] sm:px-1.5 sm:py-0.5 ${
                                    armedDrop
                                      ? 'bg-gn-diff-del-bg font-medium text-gn-red'
                                      : 'text-gn-muted hover:text-gn-red'
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
              </div>
            )}
          </div>
        )}

        {!notRepo && activeTab === 'changes' && (
          <footer
            className={`gn-modal-footer flex-col gap-2 bg-gn-bg-base px-3 py-2.5 sm:px-4 ${
              selectedPath ? 'hidden sm:flex' : 'flex'
            }`}
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  type="text"
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return
                    if (e.key === 'Enter' && canCommit) {
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
                  className="min-h-9 min-w-0 flex-1 rounded border border-gn-prompt-border bg-gn-bg-dark px-2.5 text-[12px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-green/60 sm:min-h-8"
                />
                <button
                  type="button"
                  onClick={onGenerateCommitMsg}
                  disabled={rows.length === 0 || busy}
                  className="flex h-9 shrink-0 items-center gap-1 rounded border border-gn-prompt-border bg-gn-bg-highlight/60 px-2.5 text-[11.5px] text-gn-cyan hover:bg-gn-bg-highlight disabled:opacity-40 sm:h-auto sm:py-1"
                  title="根据当前改动自动生成规范的提交信息"
                  aria-label="AI 描述"
                >
                  <Sparkles size={12} />
                  <span>AI 描述</span>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label
                  className="flex shrink-0 cursor-pointer select-none items-center gap-1 text-[11px] text-gn-muted"
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
                  disabled={!canCommit}
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
                  className="min-h-9 shrink-0 rounded border border-gn-green/40 bg-gn-green/20 px-3 py-1 text-[12px] font-medium text-gn-green hover:bg-gn-green/30 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
                  title={
                    stagedRows.length === 0 && !amend
                      ? '请先暂存文件，或勾选 amend'
                      : '提交暂存区的更改（x.ai/git/commit）'
                  }
                >
                  commit
                </button>

                <button
                  type="button"
                  disabled={!canCommit}
                  onClick={onCommitAndPush}
                  className="flex min-h-9 shrink-0 items-center gap-1 rounded border border-gn-prompt-border bg-gn-bg-base px-2.5 py-1 text-[12px] text-gn-fg hover:bg-gn-bg-highlight disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
                  title="提交并推送到远端"
                >
                  <GitCommit size={12} />
                  <span className="sm:hidden">推送</span>
                  <span className="hidden sm:inline">commit & push</span>
                </button>

                <button
                  type="button"
                  disabled={busy}
                  onClick={onStashClick}
                  className="min-h-9 shrink-0 rounded border border-gn-prompt-border bg-gn-bg-base px-2.5 py-1 text-[12px] text-gn-fg hover:bg-gn-bg-highlight disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
                  title="git stash — 暂存全部未提交更改"
                >
                  stash
                </button>
              </div>
            </div>
          </footer>
        )}
      </div>
    </div>
  )
}
