import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import type { RewindMode, RewindPoint } from '../api/types'

/**
 * /rewind picker modal (TUI /rewind — views/rewind.rs state machine,
 * dispatch/rewind.rs flow).
 *
 * Phases:
 *   cancel-offer — the host is busy when the picker opens: ask whether to
 *     cancel the running turn before rewinding (y) or let it finish (n —
 *     closes the panel). Confirming cancels the turn (cancelTurn) and then
 *     loads the rewind points, like the TUI's CancelTurnThenProceed.
 *   loading → picker (j/k move, Enter selects) → confirm (y/a/n) →
 *     executing → modal closes on success; failures render the error
 *     phase with retry (existing inline-error behavior preserved).
 *
 * confirm-before-rewind is a persistent setting: the confirm layer's
 * "Yes, and don't ask again" flips `acpfe.confirmBeforeRewind` to false
 * in localStorage (TUI confirm_before_rewind); later rewinds execute
 * immediately without the confirm layer.
 *
 * Draft custody: while the picker is open the composer's draft is parked
 * in the store (`stashedDraft`) and restored on close — see Composer.
 */
const CONFIRM_KEY = 'acpfe.confirmBeforeRewind'

function confirmBeforeRewind(): boolean {
  try {
    return localStorage.getItem(CONFIRM_KEY) !== 'false'
  } catch {
    return true
  }
}

function disableConfirmBeforeRewind(): void {
  try {
    localStorage.setItem(CONFIRM_KEY, 'false')
  } catch {
    /* private mode / quota — session-only */
  }
}

type Phase = 'cancel-offer' | 'loading' | 'picker' | 'confirm' | 'executing' | 'error'

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
  // Rewind scope: conversation-only (TUI default) or all (files too).
  // Reset per selection so a fresh pick always starts conversation-only.
  const [rewindMode, setRewindMode] = useState<RewindMode>('conversation_only')
  const [executing, setExecuting] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
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
      // A newer open superseded this one (or the modal closed mid-flight).
      if (seq === reqSeq.current) {
        setPoints(list)
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
    setRewindMode('conversation_only')
    setExecuting(false)
    executingRef.current = false
    if (!sessionId) {
      // No active session — the picker renders the no-session notice.
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
        await rewindExecute(point.index, rewindMode)
        // The store reloads the session history; close to reveal it.
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
      // Fresh pick always starts conversation-only (TUI default); the
      // confirm layer offers "对话+文件" for points with snapshots.
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

  /** Cancel-offer "y": cancel the running turn, then proceed to rewind. */
  const cancelTurnThenProceed = useCallback(async () => {
    setPhase('loading')
    await cancelTurn()
    void fetchPoints()
  }, [cancelTurn, fetchPoints])

  // Newest first (倒序) — highest index on top. Cursor/rows/keyboard all
  // index this same sorted list.
  const list = useMemo(
    () => [...points].sort((a, b) => b.index - a.index),
    [points],
  )

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const prevent = () => {
        e.preventDefault()
        e.stopPropagation()
      }
      if (e.key === 'Escape') {
        if (phase === 'executing') return // in-flight rewind is uninterruptible
        prevent()
        closeRewind()
        return
      }
      switch (phase) {
        case 'cancel-offer': {
          if (e.key === 'j' || e.key === 'k' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            prevent()
            setOfferCursor((c) => (c + 1) % 2)
          } else if (e.key === 'y' || (e.key === 'Enter' && offerCursor === 0)) {
            prevent()
            void cancelTurnThenProceed()
          } else if (e.key === 'n' || (e.key === 'Enter' && offerCursor === 1)) {
            prevent()
            closeRewind()
          }
          break
        }
        case 'confirm': {
          // Cursor rows: 0 仅对话 · 1 对话+文件 · 2 y · 3 a · 4 n.
          const filesAllowed = !pending || pending.point.hasFileChanges !== false
          if (e.key === 'j' || e.key === 'ArrowDown') {
            prevent()
            setConfirmCursor((c) => Math.min(4, c + 1))
          } else if (e.key === 'k' || e.key === 'ArrowUp') {
            prevent()
            setConfirmCursor((c) => Math.max(0, c - 1))
          } else if (e.key === 'c') {
            prevent()
            setRewindMode('conversation_only')
          } else if (e.key === 'f' && filesAllowed) {
            prevent()
            setRewindMode('all')
          } else if (e.key === 'y') {
            prevent()
            if (pending) void execute(pending.point, 'yes')
          } else if (e.key === 'a') {
            prevent()
            if (pending) void execute(pending.point, 'always')
          } else if (e.key === 'n') {
            prevent()
            setPending(undefined)
            setPhase('picker')
          } else if (e.key === 'Enter') {
            prevent()
            if (!pending) return
            if (confirmCursor === 0) setRewindMode('conversation_only')
            else if (confirmCursor === 1) {
              if (filesAllowed) setRewindMode('all')
            } else if (confirmCursor === 2) void execute(pending.point, 'yes')
            else if (confirmCursor === 3) void execute(pending.point, 'always')
            else {
              setPending(undefined)
              setPhase('picker')
            }
          }
          break
        }
        case 'picker': {
          const max = list.length - 1
          if (e.key === 'j' || e.key === 'ArrowDown') {
            prevent()
            setCursor((c) => Math.min(max, c + 1))
          } else if (e.key === 'k' || e.key === 'ArrowUp') {
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
          if (e.key === 'Enter' || e.key === 'r') {
            prevent()
            if (pending) void execute(pending.point, pending.mode)
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-[1px] p-4"
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
        className="mt-8 w-full max-w-[460px] rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl outline-none"
      >
        <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
          <span className="font-mono text-[13px] font-bold text-gn-fg">/rewind</span>
          <span className="text-[11px] text-gn-muted">回退到历史检查点</span>
          <button
            type="button"
            onClick={closeRewind}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            esc
          </button>
        </header>

        <div className="py-1">
          {!sessionId ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              暂无活动会话
            </div>
          ) : phase === 'cancel-offer' ? (
            <div className="px-4 py-5">
              <div className="text-[13px] font-bold text-gn-fg">
                当前有回合正在运行
              </div>
              <div className="mt-1 text-[12px] leading-snug text-gn-muted">
                取消当前回合并回卷？还是等它完成？
              </div>
              <div className="mt-3 space-y-1">
                <RadioRow
                  k="y"
                  label="取消回合并回卷"
                  active={offerCursor === 0}
                  onClick={() => void cancelTurnThenProceed()}
                />
                <RadioRow
                  k="n"
                  label="等它完成"
                  active={offerCursor === 1}
                  onClick={closeRewind}
                />
              </div>
            </div>
          ) : phase === 'loading' ? (
            error ? (
              <div className="px-4 py-5 text-center">
                <div className="text-[12px] text-gn-red">{error}</div>
                <button
                  type="button"
                  onClick={() => void fetchPoints()}
                  className="mt-2 rounded border border-gn-prompt-border px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
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
            <div className="px-4 py-5">
              <div className="text-[12px] leading-snug text-gn-fg">
                回退到{' '}
                <span className="font-mono text-gn-cyan">#{pending.point.index}</span>
                {pending.point.summary ? ` — ${pending.point.summary}` : ''}？
              </div>
              <div className="mt-1 font-mono text-[10px] text-gn-muted">
                {formatPointTime(pending.point.timestamp)}
              </div>
              <div className="mt-3 space-y-1">
                <RadioRow
                  k="c"
                  label="仅对话"
                  active={confirmCursor === 0}
                  checked={rewindMode === 'conversation_only'}
                  onClick={() => setRewindMode('conversation_only')}
                />
                <RadioRow
                  k="f"
                  label="对话+文件"
                  disabled={pending.point.hasFileChanges === false}
                  active={confirmCursor === 1}
                  checked={rewindMode === 'all'}
                  onClick={() => setRewindMode('all')}
                />
                {pending.point.hasFileChanges === false ? (
                  <div className="pl-3 text-[10px] text-gn-gutter">
                    该回退点无文件快照，仅支持对话回退
                  </div>
                ) : null}
              </div>
              <div className="mt-3 space-y-1">
                <RadioRow
                  k="y"
                  label="是"
                  active={confirmCursor === 2}
                  onClick={() => void execute(pending.point, 'yes')}
                />
                <RadioRow
                  k="a"
                  label="是，且不再询问（下次直接回卷）"
                  active={confirmCursor === 3}
                  onClick={() => void execute(pending.point, 'always')}
                />
                <RadioRow
                  k="n"
                  label="否"
                  active={confirmCursor === 4}
                  onClick={() => {
                    setPending(undefined)
                    setPhase('picker')
                  }}
                />
              </div>
            </div>
          ) : phase === 'executing' ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              回退中{rewindMode === 'all' ? '（含文件）' : ''}…
            </div>
          ) : phase === 'error' ? (
            <div className="px-4 py-5 text-center">
              <div className="text-[12px] text-gn-red">回退失败 · {error}</div>
              {pending && (
                <div className="mt-2 flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => void execute(pending.point, pending.mode)}
                    className="rounded border border-gn-prompt-border px-3 py-1 text-[11px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg"
                  >
                    重试
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPending(undefined)
                      setPhase('picker')
                    }}
                    className="rounded border border-gn-prompt-border px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
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
            list.map((p, i) => (
              <button
                key={p.index}
                type="button"
                disabled={executing}
                onClick={() => selectPoint(p)}
                className={`flex w-full items-start gap-3 border-b border-gn-prompt-border/50 px-4 py-2 text-left hover:bg-gn-bg-highlight disabled:opacity-50 ${
                  i === cursor ? 'bg-gn-bg-highlight' : ''
                }`}
                title={`回退到索引 ${p.index} — 删除该点之后的对话内容`}
              >
                <span className="shrink-0 rounded border border-gn-prompt-border px-1 font-mono text-[10px] leading-[16px] text-gn-cyan">
                  #{p.index}
                </span>
                <span className="min-w-0 flex-1">
                  {p.summary ? (
                    <span className="block break-words text-[12px] leading-snug text-gn-fg">
                      {p.summary}
                    </span>
                  ) : null}
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
            ))
          )}
        </div>

        <footer className="rounded-b border-t border-gn-prompt-border px-4 py-2 text-[11px] text-gn-gutter">
          {phase === 'cancel-offer'
            ? 'y 取消回合并回卷 · n 等它完成 · j/k 移动'
            : phase === 'confirm'
              ? 'c/f 选择模式（对话 / 对话+文件） · y 是 · a 是且不再询问 · n 否 · j/k 移动 · esc 关闭'
              : phase === 'error'
                ? 'enter/r 重试 · esc 关闭'
                : phase === 'picker'
                  ? 'j/k 选择 · enter 确认 · esc 关闭'
                  : '回退将删除目标点之后的对话内容 · 该点的提示词将放回输入框'}
        </footer>
      </div>
    </div>
  )
}

/** TUI render_radio_row port: key · (●/○) label, cursor-highlighted. */
function RadioRow({
  k,
  label,
  active,
  checked,
  disabled,
  onClick,
}: {
  k: string
  label: string
  active: boolean
  /** Radio dot state (defaults to `active` — used by the rewind mode rows). */
  checked?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  const dot = checked ?? active
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded border px-3 py-1.5 text-left text-[12px] ${
        active
          ? 'border-gn-prompt-border-active bg-gn-bg-highlight text-gn-fg'
          : 'border-gn-prompt-border text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg'
      } ${disabled ? 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-gn-fg2' : ''}`}
    >
      <span className={`font-mono text-[11px] ${active ? 'text-gn-cyan' : 'text-gn-muted'}`}>
        {k}
      </span>
      <span className="text-gn-muted" aria-hidden>
        {dot ? '●' : '○'}
      </span>
      <span className="min-w-0 flex-1">{label}</span>
    </button>
  )
}

/** Rewind point timestamp → "MM/DD HH:MM" (epoch s / ms / ISO all accepted). */
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
