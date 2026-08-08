import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import { transport } from '../api/localTransport'
import type { GitBranch, GitFileChange, GitStatusData } from '../api/types'

/**
 * Git panel — modal counterpart of the TUI git surface (web-only; the
 * codegen TUI has no git panel, so the layout follows the app's modal
 * conventions: fixed overlay + panel + Esc/backdrop close, like
 * SettingsModal).
 *
 * Data: POST /api/git/status {cwd, includeUntracked: true} → the agent's
 * structured GitStatusData (branch / staged: index-vs-HEAD / unstaged:
 * worktree-vs-index incl. untracked). Refreshed on open, on
 * sessions_changed / git_head_changed, on session/cwd switch, and via
 * the manual 刷新 button.
 *
 * Diff preview: POST /api/git/diffs {cwd, from:"HEAD", to:"working",
 * paths:[file]} — the host does not forward includePatch, so patches are
 * usually absent: modified/deleted files degrade to +/− stats, untracked
 * files preview content via /api/git/files {version:"working"} rendered
 * as added lines. When a patch IS present it renders in the read-only
 * diff-row style (ToolDetail's EditBody/DiffRow colors).
 *
 * Actions: stage / unstage / discard (two-stage confirm, sidebar
 * CONFIRM_WINDOW pattern) / commit (message + amend). Every host call
 * failure renders an inline error line.
 */

/** Two-stage confirm window (matches the history sidebar CONFIRM_WINDOW). */
const CONFIRM_WINDOW_MS = 2000
/** Untracked-file content preview cap (rows). */
const PREVIEW_MAX_LINES = 1000

type RowStatus = 'staged' | 'modified' | 'untracked'

type StatusRow = {
  path: string
  status: RowStatus
  changeType: GitFileChange['type']
  additions: number
  deletions: number
}

/** TUI/常用 git 配色: staged 绿、modified 黄、untracked 红。 */
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

// ── read-only unified-diff rendering (ToolDetail DiffRow style) ──────

type DiffRowKind = 'header' | 'hunk' | 'equal' | 'insert' | 'delete'

function parseUnifiedDiff(patch: string): { kind: DiffRowKind; text: string }[] {
  const out: { kind: DiffRowKind; text: string }[] = []
  const raw = patch.replace(/\n$/, '').split('\n')
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
      out.push({ kind: 'header', text: line })
    } else if (line.startsWith('@@')) {
      out.push({ kind: 'hunk', text: line })
    } else if (line.startsWith('+')) {
      out.push({ kind: 'insert', text: line.slice(1) })
    } else if (line.startsWith('-')) {
      out.push({ kind: 'delete', text: line.slice(1) })
    } else {
      out.push({ kind: 'equal', text: line })
    }
  }
  return out
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
  | { loading: boolean; rows?: undefined; error?: undefined; file?: undefined; note?: undefined }
  | {
      loading?: undefined
      rows: { kind: DiffRowKind; text: string }[]
      error?: undefined
      file?: GitFileChange
      note?: string
    }
  | { loading?: undefined; rows?: undefined; error: string; file?: undefined; note?: undefined }

export function GitPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cwd = useChatStore((s) => s.cwd)
  const gitInfo = useChatStore((s) => s.gitInfo)
  const [status, setStatus] = useState<GitStatusData>()
  const [statusError, setStatusError] = useState<string>()
  const [loading, setLoading] = useState(false)
  /** Bumped after every successful status fetch — diff effect re-runs. */
  const [statusSeq, setStatusSeq] = useState(0)
  /** Branch list (x.ai/git/branches) — separate seq so status refreshes
   *  never cancel an in-flight branch fetch (shared reqSeq would). */
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [branchesError, setBranchesError] = useState<string>()
  const [branchesLoading, setBranchesLoading] = useState(false)
  /** Two-stage checkout confirm (same CONFIRM_WINDOW as discard). */
  const [armedCheckout, setArmedCheckout] = useState<{ branch: string; at: number } | null>(null)
  const [selectedPath, setSelectedPath] = useState<string>()
  const [diff, setDiff] = useState<DiffState>()
  /** In-flight op label ("stage"/"unstage"/"discard"/"commit"/"stash"/…) or undefined. */
  const [busyOp, setBusyOp] = useState<string>()
  const [opError, setOpError] = useState<string>()
  const [commitMsg, setCommitMsg] = useState('')
  const [amend, setAmend] = useState(false)
  const [armedDiscard, setArmedDiscard] = useState<{ path: string; at: number } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)
  const branchReqSeq = useRef(0)

  const rows = useMemo(() => (status ? toRows(status) : []), [status])

  const refresh = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      const seq = ++reqSeq.current
      if (!opts.silent) setLoading(true)
      setStatusError(undefined)
      try {
        const data = await transport.gitStatus({ cwd, includeUntracked: true })
        if (seq !== reqSeq.current) return // superseded
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

  /** x.ai/git/branches — refresh on open and after checkout. */
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

  // Fetch on open + keep in sync with session/cwd changes.
  useEffect(() => {
    if (!open) return
    void refresh()
    void refreshBranches()
  }, [open, refresh, refreshBranches])

  // Live refresh: host sessions_changed / git_head_changed while open.
  useEffect(() => {
    if (!open) return
    const unsub = transport.onEvent((ev) => {
      if (ev.type === 'sessions_changed' || ev.type === 'git_head_changed') {
        void refresh({ silent: true })
      }
    })
    return unsub
  }, [open, refresh])

  // Esc closes; focus the panel for keyboard capture.
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
  }, [open])

  // Diff preview for the selected row.
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
          setDiff({ rows: parseUnifiedDiff(f.patch), file: f })
          return
        }
        // Untracked files never appear in a git diff — preview the
        // working-tree content via /api/git/files instead.
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
                setDiff({ rows: rows2, file: f, note: 'untracked 文件 — 工作区内容预览（git diff 不包含 untracked）' })
              } else {
                setDiff({
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
          // Untracked files need includeUntracked to be removed at all.
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

  /** Branch row click — two-stage confirm, then x.ai/git/checkout. */
  const onCheckoutClick = (branch: GitBranch) => {
    if (branch.current) return
    if (
      armedCheckout?.branch === branch.name &&
      Date.now() - armedCheckout.at < CONFIRM_WINDOW_MS
    ) {
      setArmedCheckout(null)
      void runOp(`checkout ${branch.name}`, async () => {
        await transport.gitCheckout({ cwd, branch: branch.name })
        // Branch list + status refresh (runOp already refreshes status).
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

  /** git stash — 成功后 status 由 runOp 刷新（分支不变，无需刷新列表）。 */
  const onStashClick = () => {
    if (busy) return
    void runOp('stash', () => transport.gitStash({ cwd }))
  }

  if (!open) return null

  const branch = status?.branch ?? gitInfo?.branch
  const notRepo = /not a git repository/i.test(statusError ?? '')
  const busy = busyOp != null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-[1px] p-4"
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
        className="mt-8 flex max-h-[80vh] w-full max-w-[840px] flex-col rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl outline-none"
      >
        <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
          <span className="text-[13px] font-bold text-gn-fg">git</span>
          {branch ? (
            <span className="flex min-w-0 items-center gap-1 truncate font-mono text-[12px] text-gn-cyan" title={branch}>
              <span className="shrink-0" aria-hidden>
                ⎇
              </span>
              <span className="truncate">{branch === '(detached)' ? 'detached' : branch}</span>
              {status?.ahead != null && status.ahead > 0 && (
                <span className="shrink-0 text-gn-yellow" title="领先上游的未推送提交">
                  ↑{status.ahead}
                </span>
              )}
              {status?.behind != null && status.behind > 0 && (
                <span className="shrink-0 text-gn-muted" title="落后上游的提交">
                  ↓{status.behind}
                </span>
              )}
            </span>
          ) : null}
          {rows.length > 0 && (
            <span className="font-mono text-[11px] text-gn-muted">
              {rows.filter((r) => r.status === 'staged').length} staged ·{' '}
              {rows.filter((r) => r.status === 'modified').length} modified ·{' '}
              {rows.filter((r) => r.status === 'untracked').length} untracked
            </span>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="ml-auto rounded px-2 py-0.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40"
            title="重新拉取 git 状态（sessions_changed / git_head_changed 时也会自动刷新）"
          >
            刷新
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            esc
          </button>
        </header>

        {statusError && !status ? (
          <div className="px-4 py-5 text-center">
            <div className="text-[12px] text-gn-red">{statusError}</div>
            <div className="mt-1 text-[11px] text-gn-muted">
              {notRepo ? '当前目录不是 git 仓库' : 'host 调用失败'}
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              className="mt-2 rounded border border-gn-prompt-border px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
            >
              重试
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* File list — 工作区状态。 */}
            <div className="gn-no-scrollbar w-64 shrink-0 overflow-y-auto border-r border-gn-prompt-border">
              {/* 分支列表 — x.ai/git/branches；点击切换（两段确认）。 */}
              <div className="border-b border-gn-prompt-border/50 px-3 pb-1.5 pt-2">
                <div className="text-[10px] uppercase tracking-wider text-gn-gutter">
                  分支{branches.length > 0 ? ` · ${branches.length}` : ''}
                </div>
                {branchesError && (
                  <div className="mt-1 text-[10.5px] leading-snug text-gn-red">
                    {branchesError}
                  </div>
                )}
                <div className="gn-no-scrollbar mt-1 max-h-28 overflow-y-auto">
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
                            ? 'text-gn-green'
                            : 'text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-60'
                        }`}
                        title={
                          b.current
                            ? '当前分支'
                            : armed
                              ? '再点一次确认切换（2 秒内）'
                              : `切换到 ${b.name}（x.ai/git/checkout）${b.upstream ? ` · upstream ${b.upstream}` : ''}`
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
              <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-gn-gutter">
                工作区状态 · {rows.length}
              </div>
              {loading && rows.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-gn-muted">加载中…</div>
              )}
              {!loading && rows.length === 0 && (
                <div className="px-3 py-3 text-[11.5px] text-gn-muted">
                  工作区没有改动 ✓
                </div>
              )}
              {rows.map((row) => {
                const sel = row.path === selectedPath
                const armed = armedDiscard?.path === row.path
                return (
                  <div
                    key={row.path}
                    className={`group flex items-center gap-1 px-2 py-1 ${sel ? 'bg-gn-bg-highlight' : 'hover:bg-gn-bg-highlight'}`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedPath(sel ? undefined : row.path)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      title={row.path}
                    >
                      <span
                        className={`shrink-0 rounded px-1 font-mono text-[9.5px] leading-[14px] ${ROW_STATUS_CLASS[row.status]}`}
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
                    <div className="flex shrink-0 items-center gap-0.5">
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
                          className="rounded px-1 py-0.5 text-[10px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40"
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
                          className="rounded px-1 py-0.5 text-[10px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40"
                          title="git stage — 加入暂存区"
                        >
                          stage
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={(e) => onDiscardClick(e, row)}
                        className={`rounded px-1 py-0.5 text-[10px] disabled:opacity-40 ${
                          armed
                            ? 'bg-gn-diff-del-bg text-gn-red'
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

            {/* Diff preview — 只读 diff 行样式。 */}
            <div className="gn-no-scrollbar min-w-0 flex-1 overflow-y-auto bg-gn-bg-dark">
              {diff?.loading ? (
                <div className="px-3 py-3 font-mono text-[11px] text-gn-muted">
                  加载 diff…
                </div>
              ) : diff?.error ? (
                <div className="px-3 py-3 font-mono text-[11px] text-gn-red">
                  {diff.error}
                </div>
              ) : diff?.rows != null ? (
                <div className="py-1">
                  {diff.file && (
                    <div className="px-2 pb-1 font-mono text-[11px] text-gn-cyan">
                      diff · {diff.file.path}
                      {diff.file.additions > 0 || diff.file.deletions > 0
                        ? ` · +${diff.file.additions} −${diff.file.deletions}`
                        : ''}
                    </div>
                  )}
                  {diff.note && (
                    <div className="px-2 pb-1 font-mono text-[10.5px] text-gn-gutter">
                      {diff.note}
                    </div>
                  )}
                  {diff.rows.length === 0 ? (
                    <div className="px-3 py-3 font-mono text-[11px] text-gn-muted">
                      （无 diff 内容）
                    </div>
                  ) : (
                    diff.rows.map((r, i) => <DiffRowView key={i} kind={r.kind} text={r.text} />)
                  )}
                </div>
              ) : (
                <div className="px-3 py-3 font-mono text-[11px] text-gn-muted">
                  选择左侧文件查看 diff
                </div>
              )}
            </div>
          </div>
        )}

        <footer className="rounded-b border-t border-gn-prompt-border px-4 py-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => {
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
              className="min-h-8 min-w-0 flex-1 rounded border border-gn-prompt-border bg-gn-bg-base px-2.5 text-[12px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-green/60"
            />
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-gn-muted select-none" title="git commit --amend">
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
              className="shrink-0 rounded border border-gn-green/50 bg-gn-bg-base px-3 py-1 text-[12px] text-gn-fg hover:bg-gn-bg-highlight disabled:cursor-not-allowed disabled:opacity-40"
              title="提交暂存区的更改（x.ai/git/commit）"
            >
              commit
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onStashClick}
              className="shrink-0 rounded border border-gn-yellow/40 bg-gn-bg-base px-3 py-1 text-[12px] text-gn-fg hover:bg-gn-bg-highlight disabled:cursor-not-allowed disabled:opacity-40"
              title="git stash — 暂存全部未提交更改（x.ai/git/stash）"
            >
              stash
            </button>
          </div>
          {(opError || statusError || busy) && (
            <div className="mt-1.5 font-mono text-[10.5px]">
              {busy && <span className="text-gn-muted">{busyOp}…</span>}
              {opError && <span className="text-gn-red">{opError}</span>}
              {statusError && <span className="text-gn-red">{statusError}</span>}
            </div>
          )}
        </footer>
      </div>
    </div>
  )
}
