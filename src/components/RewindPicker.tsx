import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import type { RewindPoint } from '../api/types'

/**
 * /rewind picker modal (TUI /rewind) — lists candidate rewind points from
 * POST /api/rewind-points (newest first) and executes the chosen one via
 * POST /api/rewind-execute. On success the store reloads the current
 * session's history and the modal closes; failures render inline (an
 * agent without rewind support shows the error + retry) with the same
 * audit row in the scrollback.
 */
export function RewindPicker() {
  const open = useChatStore((s) => s.rewindOpen)
  const closeRewind = useChatStore((s) => s.closeRewind)
  const sessionId = useChatStore((s) => s.sessionId)
  const rewindPoints = useChatStore((s) => s.rewindPoints)
  const rewindExecute = useChatStore((s) => s.rewindExecute)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [points, setPoints] = useState<RewindPoint[]>([])
  const [executing, setExecuting] = useState<number | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)

  const fetchPoints = useCallback(async () => {
    if (!sessionId) return
    const seq = ++reqSeq.current
    setLoading(true)
    setError(undefined)
    setExecuting(null)
    try {
      const list = await rewindPoints()
      // A newer open superseded this one (or the modal closed mid-flight).
      if (seq === reqSeq.current) setPoints(list)
    } catch (e) {
      if (seq === reqSeq.current) {
        setPoints([])
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [sessionId, rewindPoints])

  useEffect(() => {
    if (!open) return
    void fetchPoints()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeRewind()
      }
    }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, fetchPoints, closeRewind])

  if (!open) return null

  // Newest first (倒序) — highest index on top.
  const sorted = [...points].sort((a, b) => b.index - a.index)

  const pick = async (p: RewindPoint) => {
    if (executing != null) return
    setExecuting(p.index)
    setError(undefined)
    try {
      await rewindExecute(p.index)
      // The store reloads the session history; close to reveal it.
      closeRewind()
    } catch (e) {
      setExecuting(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="rewind"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeRewind()
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
          ) : loading ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              加载回退点…
            </div>
          ) : error ? (
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
          ) : sorted.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              没有可用的回退点
            </div>
          ) : (
            sorted.map((p) => (
              <button
                key={p.index}
                type="button"
                disabled={executing != null}
                onClick={() => void pick(p)}
                className="flex w-full items-start gap-3 border-b border-gn-prompt-border/50 px-4 py-2 text-left hover:bg-gn-bg-highlight disabled:opacity-50"
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
                    {executing === p.index ? ' · 回退中…' : ''}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>

        <footer className="rounded-b border-t border-gn-prompt-border px-4 py-2 text-[11px] text-gn-gutter">
          回退将删除目标点之后的对话内容 · 与 TUI /rewind 一致
        </footer>
      </div>
    </div>
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
