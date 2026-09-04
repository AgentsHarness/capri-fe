import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'

/**
 * x.ai/diff_review modal — web counterpart of the TUI diff-review view.
 *
 * Dual path (either one opens the modal; both empty → nothing renders):
 *  - REQUEST path (primary): the host forwards `x.ai/diff_review` as a
 *    client_request (method is in the store's SUPPORTED set), landing in
 *    xaiRequests. Approve/reject → respondXai(requestId, { approved,
 *    comments? }); Esc / backdrop → dismissXai (outcome: cancelled).
 *  - NOTIFICATION path (fallback): session_notification tag `diff_review`
 *    writes store.diffReview and opens the modal read-only — no
 *    requestId means no receipt ("通知态无法回执").
 *
 * Content parsing is defensive: each entry is `{ path?, diff?/content?,
 * status? }` (snake_case tolerated), the diff may be a unified-diff
 * string, an old/new text pair, or absent (plain content / status-only).
 * Diff rows reuse the ToolDetail diff style (ins/del bg + fg tokens,
 * gutter line numbers).
 */

type DiffRow = {
  kind: 'insert' | 'delete' | 'equal' | 'header'
  text: string
  oldNo?: number
  newNo?: number
}

type ReviewFile = {
  path: string
  status?: string
  rows: DiffRow[]
}

type Decision = 'approved' | 'rejected'

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** Extract the content array from client_request params (defensive). */
function extractContent(p?: Record<string, unknown>, depth = 0): unknown[] {
  if (!p || depth > 3) return []
  for (const k of ['content', 'files', 'diff', 'diffs']) {
    if (Array.isArray(p[k])) return p[k]
  }
  for (const k of ['request', 'result', 'params']) {
    const nested = p[k]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const inner = extractContent(nested as Record<string, unknown>, depth + 1)
      if (inner.length) return inner
    }
  }
  return []
}

/** Parse a unified diff string into styled rows (with hunk line numbers). */
function parseUnifiedDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldNo: number | undefined
  let newNo: number | undefined
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      rows.push({ kind: 'header', text: line })
      continue
    }
    // --- / +++ file headers — plain header rows, not insert/delete.
    if (line.startsWith('+++') || line.startsWith('---')) {
      rows.push({ kind: 'header', text: line })
      continue
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'insert', newNo, text: line.slice(1) })
      if (newNo != null) newNo++
      continue
    }
    if (line.startsWith('-')) {
      rows.push({ kind: 'delete', oldNo, text: line.slice(1) })
      if (oldNo != null) oldNo++
      continue
    }
    rows.push({ kind: 'equal', oldNo, newNo, text: line })
    if (oldNo != null) oldNo++
    if (newNo != null) newNo++
  }
  return rows
}

/** LCS-lite diff of an old/new text pair (small inputs; dump for big). */
function lcsDiffRows(oldText: string, newText: string): DiffRow[] {
  const a = oldText.replace(/\n$/, '').split('\n')
  const b = newText.replace(/\n$/, '').split('\n')
  const aEmpty = a.length === 0 || (a.length === 1 && a[0] === '')
  const bEmpty = b.length === 0 || (b.length === 1 && b[0] === '')
  if (aEmpty) return b.map((t) => ({ kind: 'insert' as const, text: t }))
  if (bEmpty) return a.map((t) => ({ kind: 'delete' as const, text: t }))
  if (a.length + b.length > 400) {
    return [
      ...a.map((t) => ({ kind: 'delete' as const, text: t })),
      ...b.map((t) => ({ kind: 'insert' as const, text: t })),
    ]
  }
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'equal', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: 'delete', text: a[i] })
      i++
    } else {
      rows.push({ kind: 'insert', text: b[j] })
      j++
    }
  }
  while (i < m) rows.push({ kind: 'delete', text: a[i++] })
  while (j < n) rows.push({ kind: 'insert', text: b[j++] })
  return rows
}

function extractRows(o: Record<string, unknown>): DiffRow[] {
  // 1) unified diff string
  const diffText =
    asStr(o.diff) ?? asStr(o.diff_text) ?? asStr(o.diffText) ?? asStr(o.patch)
  if (diffText) return parseUnifiedDiff(diffText)
  // 2) old/new text pair (nested diff object or sibling fields)
  const d = o.diff
  if (d && typeof d === 'object') {
    const obj = d as Record<string, unknown>
    const oldT = asStr(obj.old_text) ?? asStr(obj.oldText) ?? asStr(obj.before)
    const newT = asStr(obj.new_text) ?? asStr(obj.newText) ?? asStr(obj.after)
    if (oldT != null || newT != null) return lcsDiffRows(oldT ?? '', newT ?? '')
  }
  const oldT = asStr(o.old_text) ?? asStr(o.oldText)
  const newT = asStr(o.new_text) ?? asStr(o.newText)
  if (oldT != null || newT != null) return lcsDiffRows(oldT ?? '', newT ?? '')
  // 3) plain content — render as context rows
  const content =
    asStr(o.content) ?? asStr(o.text) ?? asStr(o.file_content) ?? asStr(o.fileContent)
  if (content) {
    return content
      .replace(/\n$/, '')
      .split('\n')
      .map((t) => ({ kind: 'equal' as const, text: t }))
  }
  return []
}

function parseFile(raw: unknown): ReviewFile | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const path =
    asStr(o.path) ??
    asStr(o.file) ??
    asStr(o.name) ??
    asStr(o.file_path) ??
    asStr(o.filePath) ??
    '未知文件'
  const status = asStr(o.status) ?? asStr(o.change_type) ?? asStr(o.changeType)
  return { path, status, rows: extractRows(o) }
}

function fmtCount(n: number) {
  return n.toLocaleString()
}

export function DiffReviewModal() {
  const xaiRequests = useChatStore((s) => s.xaiRequests)
  const respondXai = useChatStore((s) => s.respondXai)
  const dismissXai = useChatStore((s) => s.dismissXai)
  const diffReview = useChatStore((s) => s.diffReview)
  const diffReviewOpen = useChatStore((s) => s.diffReviewOpen)
  const closeDiffReview = useChatStore((s) => s.closeDiffReview)

  // Request path wins over the notification payload when both exist.
  const req = xaiRequests.find((r) => r.method === 'x.ai/diff_review')
  const notifOpen = diffReviewOpen && Array.isArray(diffReview) && diffReview.length > 0
  const visible = !!req || notifOpen

  const files = useMemo<ReviewFile[]>(() => {
    const raw: unknown[] = req
      ? extractContent(req.params)
      : Array.isArray(diffReview)
        ? diffReview
        : []
    return raw.map(parseFile).filter((f): f is ReviewFile => f !== null)
  }, [req, diffReview])

  const [selectedIdx, setSelectedIdx] = useState(0)
  const [decisions, setDecisions] = useState<Record<number, Decision>>({})
  const [comment, setComment] = useState('')

  // Reset local review state when a new request arrives.
  useEffect(() => {
    setSelectedIdx(0)
    setDecisions({})
    setComment('')
  }, [req?.requestId])

  // Esc: request path cancels (outcome:cancelled); notification path closes.
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (req) void dismissXai(req.requestId)
        else closeDiffReview()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, req, dismissXai, closeDiffReview])

  // 弹窗打开 = 要把这些改动摊开看：滚动区里被 lite 裁掉正文的 edit 工具行
  // 在这里一次补回（同区间只拉一次；非 lite 场景 no-op、不发请求）。
  useEffect(() => {
    if (!visible) return
    void useChatStore.getState().fillLiteToolBodies({ editOnly: true })
  }, [visible])

  if (!visible) return null

  const close = () => {
    if (req) void dismissXai(req.requestId)
    else closeDiffReview()
  }

  const active = files[Math.min(selectedIdx, Math.max(files.length - 1, 0))]
  const ins = active?.rows.filter((r) => r.kind === 'insert').length ?? 0
  const del = active?.rows.filter((r) => r.kind === 'delete').length ?? 0

  const setDecision = (i: number, d: Decision) =>
    setDecisions((prev) => ({ ...prev, [i]: d }))
  const allDecided =
    files.length === 0 || files.every((_, i) => decisions[i] !== undefined)
  const anyRejected = files.some((_, i) => decisions[i] === 'rejected')

  const submit = () => {
    if (!req) return
    const comments = comment.trim()
    void respondXai(req.requestId, {
      approved: !anyRejected,
      ...(comments ? { comments } : {}),
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto gn-modal-dim p-4"
      role="dialog"
      aria-modal="true"
      aria-label="diff review"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="my-4 w-full max-w-[860px] gn-modal-panel">
        <header className="gn-modal-header">
          <span className="text-gn-magenta" aria-hidden>
            {Glyphs.diamondFilled}
          </span>
          <span className="text-[13px] font-bold text-gn-fg">Diff 审查</span>
          {req ? (
            <span className="text-[11px] text-gn-muted">待 Agent 回执</span>
          ) : (
            <span className="rounded border border-gn-warning/40 px-1.5 py-px text-[10.5px] text-gn-warning">
              通知态 · 无法回执
            </span>
          )}
          <button
            type="button"
            onClick={close}
            className="ml-auto rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            aria-label="关闭弹窗"
            title="关闭 (Esc)"
          >
            <X size={14} aria-hidden />
          </button>
        </header>

        {files.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12.5px] text-gn-muted">
            未解析到 diff 内容（请求为空或字段不识别）
          </div>
        ) : (
          <div className="flex min-h-0 flex-col md:flex-row">
            {/* file list — left column on desktop, top tabs on narrow */}
            <div className="flex max-h-[45vh] shrink-0 flex-row overflow-x-auto border-b border-gn-prompt-border md:max-h-[62vh] md:w-56 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r">
              {files.map((f, i) => {
                const d = decisions[i]
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setSelectedIdx(i)}
                    className={`flex min-w-0 flex-1 items-center gap-1.5 border-b border-gn-prompt-border px-2.5 py-1.5 text-left last:border-b-0 md:flex-none md:border-b md:border-gn-prompt-border md:last:border-b ${ i === selectedIdx ? 'bg-gn-bg-highlight text-gn-fg' : 'text-gn-fg2 hover:bg-gn-bg-highlight/60' }`}
                  >
                    <span
                      className={`shrink-0 text-[10.5px] ${
 d === 'approved'
                          ? 'text-gn-diff-ins-fg'
                          : d === 'rejected'
                            ? 'text-gn-red'
                            : 'text-gn-gutter'
                      }`}
                      aria-hidden
                    >
                      <IconGlyph
                        glyph={
                          d === 'approved'
                            ? Glyphs.checkMark
                            : d === 'rejected'
                              ? Glyphs.ballotX
                              : Glyphs.diamondHollow
                        }
                      />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                      {f.path}
                    </span>
                    {f.status ? (
                      <span className="shrink-0 rounded border border-gn-prompt-border px-1 text-[9.5px] text-gn-muted">
                        {f.status}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>

            {/* diff view */}
            <div className="min-w-0 flex-1">
              {active ? (
                <div className="flex flex-wrap items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-dark px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-gn-path">
                    {active.path}
                  </span>
                  {active.status ? (
                    <span className="rounded border border-gn-prompt-border px-1.5 py-px text-[10.5px] text-gn-muted">
                      {active.status}
                    </span>
                  ) : null}
                  {ins > 0 || del > 0 ? (
                    <span className="text-[11px] tabular-nums">
                      <span style={{ color: 'var(--color-gn-diff-ins-fg)' }}>
                        +{fmtCount(ins)}
                      </span>{' '}
                      <span style={{ color: 'var(--color-gn-diff-del-fg)' }}>
                        −{fmtCount(del)}
                      </span>
                    </span>
                  ) : null}
                  {req ? (
                    <span className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setDecision(selectedIdx, 'approved')}
                        className={`rounded px-1.5 py-px text-[10.5px] ${
 decisions[selectedIdx] === 'approved'
                            ? 'bg-gn-bg-highlight text-gn-diff-ins-fg'
                            : 'text-gn-fg2 hover:bg-gn-bg-highlight'
                        }`}
                      >
                        批准
                      </button>
                      <button
                        type="button"
                        onClick={() => setDecision(selectedIdx, 'rejected')}
                        className={`rounded px-1.5 py-px text-[10.5px] ${
 decisions[selectedIdx] === 'rejected'
                            ? 'bg-gn-bg-highlight text-gn-red'
                            : 'text-gn-fg2 hover:bg-gn-bg-highlight'
                        }`}
                      >
                        拒绝
                      </button>
                    </span>
                  ) : null}
                </div>
              ) : null}

              <div className="max-h-[45vh] overflow-y-auto px-1 py-1 md:max-h-[50vh]">
                {active && active.rows.length > 0 ? (
                  <DiffRows rows={active.rows} />
                ) : (
                  <div className="px-3 py-6 text-center text-[11.5px] text-gn-muted">
                    该文件无 diff 内容
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {req ? (
          <footer className="gn-modal-footer flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const next: Record<number, Decision> = {}
                files.forEach((_, i) => (next[i] = 'approved'))
                setDecisions(next)
              }}
              className="min-h-9 rounded bg-gn-bg-highlight px-3 py-1.5 text-[12px] text-gn-diff-ins-fg hover:bg-gn-bg-hover"
            >
              全部批准
            </button>
            <button
              type="button"
              onClick={() => {
                const next: Record<number, Decision> = {}
                files.forEach((_, i) => (next[i] = 'rejected'))
                setDecisions(next)
              }}
              className="min-h-9 rounded bg-gn-bg-highlight px-3 py-1.5 text-[12px] text-gn-red hover:bg-gn-bg-hover"
            >
              全部拒绝
            </button>
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="审查意见（拒绝时填写）…"
              className="min-w-40 flex-1 rounded border border-gn-prompt-border bg-gn-bg-dark px-3 py-1.5 text-[12px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-magenta/50"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!allDecided}
              className="min-h-9 rounded bg-gn-bg-highlight px-4 py-1.5 text-[12.5px] font-semibold text-gn-fg hover:bg-gn-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              提交审查
            </button>
            <button
              type="button"
              onClick={close}
              className="min-h-9 rounded px-3 py-1.5 text-[12.5px] text-gn-red hover:bg-gn-diff-del-bg"
            >
              取消
            </button>
          </footer>
        ) : (
          <footer className="gn-modal-footer flex items-center justify-between gap-2">
            <span className="text-[11.5px] text-gn-muted">
              通知态请求无法回执 — 如需批准/拒绝，请让 Agent 通过 x.ai/diff_review 请求发起
            </span>
            <button
              type="button"
              onClick={close}
              className="min-h-9 rounded px-4 py-1.5 text-[12.5px] text-gn-fg2 hover:bg-gn-bg-highlight"
            >
              关闭
            </button>
          </footer>
        )}
      </div>
    </div>
  )
}

/** Diff rows in the ToolDetail style (ins/del bg+fg, gutter line numbers). */
function DiffRows({ rows }: { rows: DiffRow[] }) {
  const gutterW = Math.max(
    2,
    ...rows.map((l) => String(l.newNo ?? l.oldNo ?? 0).length),
  )
  return (
    <div className="space-y-0">
      {rows.map((l, i) => {
        if (l.kind === 'header') {
          return (
            <div key={i} className="px-2 font-mono text-[11px] text-gn-cyan">
              {l.text}
            </div>
          )
        }
        const bg =
          l.kind === 'insert'
            ? 'var(--color-gn-diff-ins-bg)'
            : l.kind === 'delete'
              ? 'var(--color-gn-diff-del-bg)'
              : undefined
        const fg =
          l.kind === 'insert'
            ? 'var(--color-gn-diff-ins-fg)'
            : l.kind === 'delete'
              ? 'var(--color-gn-diff-del-fg)'
              : 'var(--color-gn-fg2)'
        const sign = l.kind === 'insert' ? '+' : l.kind === 'delete' ? '−' : ' '
        const no = l.newNo ?? l.oldNo
        return (
          <div
            key={i}
            className="flex font-mono text-[12px] leading-[1.4]"
            style={{ background: bg }}
          >
            <span
              className="shrink-0 select-none pr-1 text-right text-gn-gray-dim tabular-nums"
              style={{ width: `${gutterW + 1}ch` }}
            >
              {no ?? ''}
            </span>
            <span className="shrink-0 select-none px-0.5" style={{ color: fg }}>
              {sign}
            </span>
            <span
              className="min-w-0 flex-1 whitespace-pre-wrap break-all"
              style={{ color: fg }}
            >
              {l.text || ' '}
            </span>
          </div>
        )
      })}
    </div>
  )
}
