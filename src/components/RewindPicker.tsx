import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { loadBool, saveBool } from '../lib/storage'
import { useChatStore } from '../store/chat'
import { pushToast } from '../store/toast'
import type { RewindConflict, RewindExecuteResult, RewindMode, RewindPoint } from '../api/types'
import { KEY } from '../lib/keys'

/**
 * /rewind picker modal (TUI /rewind — views/rewind.rs state machine,
 * dispatch/rewind.rs flow).
 *
 * Phases:
 *   cancel-offer — the host is busy when the picker opens: ask whether to
 *     cancel the running turn before rewinding or let it finish.
 *   loading → picker (j/k or arrow move, Enter selects) → confirm →
 *     executing → modal closes on success; failures render the error
 *     phase with retry.
 *   warning — rewind succeeded but files conflicted with external edits
 *     (mode=all): they were overwritten from snapshots; the list is shown
 *     before the modal closes.
 */
const CONFIRM_KEY = KEY.confirmBeforeRewind

function confirmBeforeRewind(): boolean {
  return loadBool(CONFIRM_KEY, true)
}

function disableConfirmBeforeRewind(): void {
  saveBool(CONFIRM_KEY, false)
}

type Phase = 'cancel-offer' | 'loading' | 'picker' | 'confirm' | 'executing' | 'error' | 'warning'

export function RewindPicker() {
  const open = useChatStore((s) => s.rewindOpen)
  const closeRewind = useChatStore((s) => s.closeRewind)
  const sessionId = useChatStore((s) => s.sessionId)
  const rewindPoints = useChatStore((s) => s.rewindPoints)
  const rewindExecute = useChatStore((s) => s.rewindExecute)
  const cancelTurn = useChatStore((s) => s.cancelTurn)
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string>()
  const [points, setPoints] = useState<RewindPoint[]>([])
  // Picker cursor / radio cursors (TUI RewindPhase cursors).
  const [cursor, setCursor] = useState(0)
  const [offerCursor, setOfferCursor] = useState(0)
  const [confirmCursor, setConfirmCursor] = useState(0)
  // Point awaiting confirmation / execution + the confirm mode for retry.
  const [pending, setPending] = useState<{
    point: RewindPoint
    mode: 'yes' | 'always'
  }>()
  // Rewind scope: conversation-only (default) or all (files too).
  const [rewindMode, setRewindMode] = useState<RewindMode>('conversation_only')
  const [executing, setExecuting] = useState(false)
  // Last successful rewind outcome (warning phase / toast payload).
  const [outcome, setOutcome] = useState<RewindExecuteResult>()
  const panelRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])
  const reqSeq = useRef(0)
  // One-shot open flow (busy check + initial fetch) per open.
  const wasOpen = useRef(false)
  // Re-entrancy guard for execute (double-Enter / double-click).
  const executingRef = useRef(false)

  const fetchPoints = useCallback(async () => {
    if (!sessionId) return
    const seq = ++reqSeq.current
    setError(undefined)
    try {
      const list = await rewindPoints()
      if (seq === reqSeq.current) {
        setPoints(Array.isArray(list) ? list : [])
        setCursor(0)
        setPhase('picker')
      }
    } catch (e) {
      if (seq === reqSeq.current) {
        setPoints([])
        setPhase('loading')
        setError(e instanceof Error ? e.message : String(e))
      }
    }
  }, [sessionId, rewindPoints])

  /** Open flow: busy at open → cancel-offer layer; otherwise fetch. */
  useEffect(() => {
    if (!open) {
      wasOpen.current = false
      return
    }
    if (wasOpen.current) return
    wasOpen.current = true
    setPoints([])
    setError(undefined)
    setPending(undefined)
    setOutcome(undefined)
    setRewindMode('conversation_only')
    setExecuting(false)
    executingRef.current = false
    if (!sessionId) {
      setPhase('loading')
      return
    }
    if (useChatStore.getState().conn === 'busy') {
      setPhase('cancel-offer')
      setOfferCursor(0)
    } else {
      setPhase('loading')
      void fetchPoints()
    }
    panelRef.current?.focus()
  }, [open, sessionId, fetchPoints])

  /** Execute the rewind (shared by confirm Yes / Always / direct). */
  const execute = useCallback(
    async (point: RewindPoint, mode: 'yes' | 'always') => {
      if (executingRef.current) return
      executingRef.current = true
      if (mode === 'always') disableConfirmBeforeRewind()
      setExecuting(true)
      setError(undefined)
      setPending({ point, mode })
      setPhase('executing')
      try {
        const res = await rewindExecute(point.index, rewindMode)
        if (res?.conflicts && res.conflicts.length > 0) {
          setOutcome(res)
          setPhase('warning')
          return
        }
        const reverted = res?.revertedFiles?.length ?? 0
        if (rewindMode === 'all' && reverted > 0) {
          pushToast(
            `已回退到 #${point.index}：还原 ${reverted} 个文件${
              res?.cleanFiles?.length ? `（${res.cleanFiles.length} 个未改动）` : ''
            }`,
          )
        }
        closeRewind()
      } catch (e) {
        executingRef.current = false
        setExecuting(false)
        setPhase('error')
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [rewindExecute, closeRewind, rewindMode],
  )

  /** Row click / Enter in the picker: confirm layer or direct execute. */
  const selectPoint = useCallback(
    (p: RewindPoint) => {
      if (executingRef.current) return
      setRewindMode('conversation_only')
      if (confirmBeforeRewind()) {
        setPending({ point: p, mode: 'yes' })
        setConfirmCursor(0)
        setPhase('confirm')
      } else {
        void execute(p, 'yes')
      }
    },
    [execute],
  )

  /** Cancel-offer: cancel the running turn, then proceed to rewind. */
  const cancelTurnThenProceed = useCallback(async () => {
    setPhase('loading')
    await cancelTurn({ cancelSubagents: true })
    void fetchPoints()
  }, [cancelTurn, fetchPoints])

  // Newest first (倒序) — highest index on top.
  const list = useMemo(
    () => (Array.isArray(points) ? [...points].sort((a, b) => b.index - a.index) : []),
    [points],
  )

  // 键盘移动光标时自动滚入视野
  useEffect(() => {
    if (phase === 'picker' && typeof rowRefs.current[cursor]?.scrollIntoView === 'function') {
      rowRefs.current[cursor]?.scrollIntoView({ block: 'nearest' })
    }
  }, [cursor, phase])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const prevent = () => {
        e.preventDefault()
        e.stopPropagation()
      }
      if (e.key === 'Escape') {
        if (phase === 'executing') return
        prevent()
        closeRewind()
        return
      }
      switch (phase) {
        case 'cancel-offer': {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            prevent()
            setOfferCursor((c) => (c + 1) % 2)
          } else if (e.key === 'Enter') {
            prevent()
            if (offerCursor === 0) {
              void cancelTurnThenProceed()
            } else {
              closeRewind()
            }
          }
          break
        }
        case 'confirm': {
          if (e.key === 'Enter') {
            prevent()
            if (pending) void execute(pending.point, 'yes')
          }
          break
        }
        case 'picker': {
          const max = list.length - 1
          if (e.key === 'ArrowDown') {
            prevent()
            setCursor((c) => Math.min(max, c + 1))
          } else if (e.key === 'ArrowUp') {
            prevent()
            setCursor((c) => Math.max(0, c - 1))
          } else if (e.key === 'Enter') {
            const p = list[cursor]
            if (p) {
              prevent()
              selectPoint(p)
            }
          }
          break
        }
        case 'error': {
          if (e.key === 'Enter') {
            prevent()
            if (pending) void execute(pending.point, pending.mode)
          }
          break
        }
        case 'warning': {
          if (e.key === 'Enter' || e.key === 'Escape') {
            prevent()
            closeRewind()
          }
          break
        }
        case 'loading':
        case 'executing':
          break
      }
    }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [
    open,
    phase,
    cursor,
    offerCursor,
    confirmCursor,
    pending,
    list,
    closeRewind,
    selectPoint,
    execute,
    cancelTurnThenProceed,
    fetchPoints,
  ])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center gn-modal-dim p-4"
      role="dialog"
      aria-modal="true"
      aria-label="rewind"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && phase !== 'executing') closeRewind()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="mt-8 flex w-full max-w-[480px] flex-col max-h-[82vh] overflow-hidden gn-modal-panel outline-none"
      >
        <header className="gn-modal-header">
          <span className="font-mono text-[13px] font-bold text-gn-fg">/rewind</span>
          <button
            type="button"
            onClick={closeRewind}
            className="ml-auto rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {!sessionId ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              暂无活动会话
            </div>
          ) : phase === 'cancel-offer' ? (
            <div className="p-4 space-y-3">
              <div className="rounded border border-gn-warning/30 bg-gn-warning/10 p-3 text-[12px]">
                <div className="font-semibold text-gn-warning">当前有回合正在运行</div>
                <div className="mt-1 text-[11.5px] leading-snug text-gn-fg2">
                  执行回退将截断正在运行的回合。你可以选择取消当前回合立即回退，或等待它完成。
                </div>
              </div>

              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => void cancelTurnThenProceed()}
                  className={`flex w-full items-center justify-between rounded border px-3 py-2 text-left text-[12px] transition-colors ${
                    offerCursor === 0
                      ? 'bg-gn-bg-highlight border-gn-cyan/50 text-gn-fg'
                      : 'border-gn-prompt-border/50 text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg'
                  }`}
                >
                  <div>
                    <div className="font-medium">取消当前回合并回退</div>
                    <div className="text-[11px] text-gn-muted mt-0.5">立即终止当前回合，载入历史回退点</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={closeRewind}
                  className={`flex w-full items-center justify-between rounded border px-3 py-2 text-left text-[12px] transition-colors ${
                    offerCursor === 1
                      ? 'bg-gn-bg-highlight border-gn-cyan/50 text-gn-fg'
                      : 'border-gn-prompt-border/50 text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg'
                  }`}
                >
                  <div>
                    <div className="font-medium">等它完成</div>
                    <div className="text-[11px] text-gn-muted mt-0.5">关闭弹窗，等待任务执行完毕后再回退</div>
                  </div>
                </button>
              </div>
            </div>
          ) : phase === 'loading' ? (
            error ? (
              <div className="px-4 py-5 text-center">
                <div className="text-[12px] text-gn-red">{error}</div>
                <button
                  type="button"
                  onClick={() => void fetchPoints()}
                  className="mt-2 rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                >
                  重试
                </button>
              </div>
            ) : (
              <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
                加载回退点…
              </div>
            )
          ) : phase === 'confirm' && pending ? (
            <div className="p-4 space-y-3.5">
              {/* 目标检查点摘要卡片 */}
              <div className="rounded border border-gn-prompt-border/70 bg-gn-bg-dark/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded border border-gn-cyan/40 bg-gn-cyan/10 px-1.5 py-0.5 font-mono text-[11px] font-bold text-gn-cyan">
                    #{pending.point.index}
                  </span>
                  <span className="font-mono text-[10.5px] text-gn-muted">
                    {formatPointTime(pending.point.timestamp)}
                  </span>
                </div>
                <div className="mt-1.5 text-[12px] leading-snug text-gn-fg break-words">
                  {pending.point.summary || `第 #${pending.point.index} 轮历史检查点`}
                </div>
              </div>

              {/* 回退范围 */}
              <div>
                <div className="text-[11px] font-semibold text-gn-muted mb-1.5">
                  回退范围
                </div>
                <div className="space-y-1">
                  <RadioRow
                    label="仅对话"
                    description="仅回退聊天记录，保留工作区中的文件修改"
                    active={confirmCursor === 0}
                    checked={rewindMode === 'conversation_only'}
                    onClick={() => setRewindMode('conversation_only')}
                  />
                  <RadioRow
                    label="对话 + 文件"
                    description="同时将工作区文件还原至该检查点的快照状态"
                    disabled={pending.point.hasFileChanges === false}
                    active={confirmCursor === 1}
                    checked={rewindMode === 'all'}
                    onClick={() => setRewindMode('all')}
                  />
                  {pending.point.hasFileChanges === false && (
                    <div className="pl-2 pt-0.5 text-[10.5px] text-gn-gutter">
                      该回退点无文件快照，仅支持对话回退
                    </div>
                  )}
                </div>
              </div>

              {/* 操作按钮栏 */}
              <div className="pt-2 border-t border-gn-prompt-border/40 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPending(undefined)
                    setPhase('picker')
                  }}
                  className={`rounded border border-gn-prompt-border/60 px-3 py-1.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg transition-colors ${
                    confirmCursor === 4 ? 'bg-gn-bg-highlight text-gn-fg ring-1 ring-gn-prompt-border' : ''
                  }`}
                >
                  返回列表
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void execute(pending.point, 'always')}
                    className={`rounded px-2.5 py-1.5 text-[11.5px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg transition-colors ${
                      confirmCursor === 3 ? 'bg-gn-bg-highlight text-gn-fg ring-1 ring-gn-prompt-border' : ''
                    }`}
                    title="确认并以后不再弹出确认提示"
                  >
                    不再询问并回退
                  </button>
                  <button
                    type="button"
                    onClick={() => void execute(pending.point, 'yes')}
                    className={`rounded bg-gn-cyan/15 border border-gn-cyan/50 px-4 py-1.5 text-[12px] font-semibold text-gn-cyan hover:bg-gn-cyan/25 transition-colors ${
                      confirmCursor === 2 ? 'ring-2 ring-gn-cyan/50' : ''
                    }`}
                  >
                    确认回退
                  </button>
                </div>
              </div>
            </div>
          ) : phase === 'executing' ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              回退中{rewindMode === 'all' ? '（含文件）' : ''}…
            </div>
          ) : phase === 'warning' && outcome ? (
            <div className="px-4 py-5">
              <div className="text-[12px] leading-snug text-gn-fg">
                回退成功，但{' '}
                <span className="font-mono text-gn-yellow">
                  {outcome.conflicts?.length ?? 0}
                </span>{' '}
                个文件与外部修改冲突，已按快照覆盖：
              </div>
              <div className="mt-2 max-h-40 overflow-y-auto rounded border border-gn-prompt-border/50">
                {(outcome.conflicts ?? []).map((c) => (
                  <div
                    key={c.path}
                    className="flex items-start gap-2 border-b border-gn-prompt-border/40 px-2.5 py-1.5 last:border-b-0"
                  >
                    <span className="shrink-0 rounded bg-gn-bg-highlight px-1 font-mono text-[10px] leading-[16px] text-gn-yellow">
                      {conflictLabel(c)}
                    </span>
                    <span className="min-w-0 break-all font-mono text-[11px] leading-snug text-gn-fg">
                      {c.path}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-2 text-[11px] leading-snug text-gn-muted">
                这些文件在你回退前被外部修改过（编辑器/终端等），快照已还原为 agent
                当时的状态。
                {outcome.revertedFiles?.length
                  ? ` 另有 ${outcome.revertedFiles.length} 个文件正常还原。`
                  : ''}
              </div>
              <button
                type="button"
                onClick={closeRewind}
                className="mt-3 w-full rounded px-3 py-1.5 text-[12px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg"
              >
                知道了
              </button>
            </div>
          ) : phase === 'error' ? (
            <div className="px-4 py-5 text-center">
              <div className="text-[12px] text-gn-red">回退失败 · {error}</div>
              {pending && (
                <div className="mt-2 flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => void execute(pending.point, pending.mode)}
                    className="rounded px-3 py-1 text-[11px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg"
                  >
                    重试
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPending(undefined)
                      setPhase('picker')
                    }}
                    className="rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  >
                    返回列表
                  </button>
                </div>
              )}
            </div>
          ) : list.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              没有可用的回退点
            </div>
          ) : (
            <div className="divide-y divide-gn-prompt-border/40">
              {list.map((p, i) => (
                <button
                  key={p.index}
                  ref={(el) => {
                    rowRefs.current[i] = el
                  }}
                  type="button"
                  disabled={executing}
                  onClick={() => selectPoint(p)}
                  className={`flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors ${
                    i === cursor
                      ? 'bg-gn-bg-highlight text-gn-fg'
                      : 'hover:bg-gn-bg-highlight/60 text-gn-fg2'
                  } disabled:opacity-50`}
                  title={`回退到索引 #${p.index} — 删除该点之后的对话内容`}
                >
                  <span
                    className={`shrink-0 rounded border px-1 font-mono text-[10.5px] leading-[16px] ${
                      i === cursor
                        ? 'border-gn-cyan/60 bg-gn-cyan/15 text-gn-cyan'
                        : 'border-gn-prompt-border text-gn-cyan'
                    }`}
                  >
                    #{p.index}
                  </span>
                  <span className="min-w-0 flex-1">
                    {p.summary ? (
                      <span className="block break-words text-[12px] leading-snug text-gn-fg">
                        {p.summary}
                      </span>
                    ) : (
                      <span className="block text-[12px] leading-snug text-gn-fg2">
                        第 #{p.index} 轮历史检查点
                      </span>
                    )}
                    <span className="block pt-0.5 font-mono text-[10px] text-gn-muted">
                      {formatPointTime(p.timestamp)}
                      {p.hasFileChanges === false
                        ? ' · 仅对话'
                        : p.hasFileChanges === true
                          ? ' · 对话+文件'
                          : ''}
                      {pending?.point.index === p.index && executing ? ' · 回退中…' : ''}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 单选行组件（纯粹的图形化选项，不展示键盘符号） */
function RadioRow({
  label,
  description,
  active,
  checked,
  disabled,
  onClick,
}: {
  label: string
  description?: string
  active: boolean
  checked?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  const isChecked = checked ?? active
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`group relative flex w-full items-start gap-2.5 rounded px-3 py-1.5 text-left text-[12px] transition-colors border ${
        active
          ? 'bg-gn-bg-highlight border-gn-prompt-border-active text-gn-fg'
          : isChecked
            ? 'bg-gn-bg-highlight/40 border-gn-prompt-border/60 text-gn-fg'
            : 'border-transparent text-gn-fg2 hover:bg-gn-bg-highlight/30 hover:text-gn-fg'
      } ${disabled ? 'cursor-not-allowed opacity-40 hover:bg-transparent hover:border-transparent hover:text-gn-fg2' : ''}`}
    >
      <span className={`mt-0.5 shrink-0 ${isChecked ? 'text-gn-cyan' : 'text-gn-muted'}`} aria-hidden>
        {isChecked ? '●' : '○'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="leading-snug">{label}</div>
        {description && (
          <div className="text-[10.5px] text-gn-muted leading-tight mt-0.5">
            {description}
          </div>
        )}
      </div>
    </button>
  )
}

/** Rewind conflict type → short Chinese label (agent RewindConflictInfo). */
function conflictLabel(c: RewindConflict): string {
  switch (c.conflictType) {
    case 'modified_externally':
      return '外部修改'
    case 'deleted_externally':
      return '外部删除'
    case 'created_externally':
      return '外部新建'
    default:
      return c.conflictType || '冲突'
  }
}

/** Rewind point timestamp → "YYYY/MM/DD HH:MM" (epoch s / ms / ISO all accepted). */
function formatPointTime(ts: number | string | undefined): string {
  if (ts == null || ts === '') return ''
  const n = Number(ts)
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n < 1e12 ? n * 1000 : n)
    if (!Number.isNaN(d.getTime())) return fmtStamp(d)
  }
  const d = new Date(String(ts))
  if (!Number.isNaN(d.getTime())) return fmtStamp(d)
  return String(ts)
}

function fmtStamp(d: Date): string {
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}
