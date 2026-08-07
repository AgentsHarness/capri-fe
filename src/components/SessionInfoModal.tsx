import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import { transport } from '../api/localTransport'
import type { SessionInfoDetail } from '../api/types'
import { fmtTok, shortCwd } from './StatusChips'

/**
 * Session info modal — web counterpart of the TUI `/session-info` command.
 * Every open issues a fresh POST /api/session-info to the host; nothing is
 * read from the chat store, so the numbers are authoritative at open time
 * (loading / error / retry states included).
 */
export function SessionInfoModal() {
  const open = useChatStore((s) => s.sessionInfoOpen)
  const close = useChatStore((s) => s.closeSessionInfo)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [data, setData] = useState<SessionInfoDetail>()
  const [copied, setCopied] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)

  const fetchInfo = useCallback(async () => {
    const seq = ++reqSeq.current
    setLoading(true)
    setError(undefined)
    try {
      const info = await transport.sessionInfo()
      // A newer open superseded this one (or the modal closed mid-flight).
      if (seq === reqSeq.current) setData(info)
    } catch (e) {
      if (seq === reqSeq.current) {
        setData(undefined)
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setCopied(false)
    void fetchInfo()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, fetchInfo, close])

  if (!open) return null

  const copyId = async () => {
    if (!data?.sessionId) return
    try {
      await navigator.clipboard.writeText(data.sessionId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable */
    }
  }

  // Context window: host-tracked usage size if reported, else the model's
  // totalContextTokens — same precedence as the TUI context bar.
  const ctxSize = data?.contextSize || data?.model?.contextWindow || 0
  const ctxUsed = data?.contextUsed ?? 0
  const pct = ctxSize > 0 ? Math.round((ctxUsed / ctxSize) * 100) : undefined
  const ctxColor =
    pct == null ? 'text-gn-muted' : pct >= 90 ? 'text-gn-red' : pct >= 70 ? 'text-gn-yellow' : 'text-gn-fg'

  const rows: Array<{ label: string; value: React.ReactNode; mono?: boolean }> = [
    ...(data?.title ? [{ label: 'title', value: data.title }] : []),
    ...(data?.sessionId
      ? [
          {
            label: 'session id',
            value: (
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{data.sessionId}</span>
                <button
                  type="button"
                  onClick={() => void copyId()}
                  className="shrink-0 rounded border border-gn-prompt-border px-1.5 py-px text-[10px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="复制 session id"
                >
                  {copied ? '✓' : 'copy'}
                </button>
              </span>
            ),
            mono: true,
          },
        ]
      : []),
    ...(data?.cwd
      ? [
          {
            label: 'workspace',
            value: (
              <span className="truncate" title={data.cwd}>
                {shortCwd(data.cwd, data.homeDir)}
              </span>
            ),
            mono: true,
          },
        ]
      : []),
    ...(data?.model
      ? [
          {
            label: 'model',
            value: data.model.reasoningEffort
              ? `${data.model.name || data.model.modelId} · ${data.model.reasoningEffort}`
              : data.model.name || data.model.modelId,
          },
        ]
      : []),
    ...(ctxSize > 0
      ? [
          {
            label: 'context',
            value: (
              <span className={ctxColor}>
                {fmtTok(ctxUsed)} / {fmtTok(ctxSize)}
                {pct != null ? ` (${pct}%)` : ''}
              </span>
            ),
            mono: true,
          },
        ]
      : []),
    ...(data?.hostName || data?.hostId
      ? [{ label: 'host', value: [data.hostName, data.hostId].filter(Boolean).join(' · ') }]
      : []),
    ...(data?.gitBranch
      ? [
          {
            label: 'git branch',
            value: data.gitIsWorktree ? `${data.gitBranch} (worktree)` : data.gitBranch,
            mono: true,
          },
        ]
      : []),
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="session info"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="mt-8 w-full max-w-[460px] rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl outline-none"
      >
        <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
          <span className="font-mono text-[13px] font-bold text-gn-fg">/session-info</span>
          <span className="text-[11px] text-gn-muted">当前会话详情</span>
          <button
            type="button"
            onClick={close}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            esc
          </button>
        </header>

        <div className="py-1">
          {loading ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              加载中…
            </div>
          ) : error ? (
            <div className="px-4 py-5 text-center">
              <div className="text-[12px] text-gn-red">{error}</div>
              <button
                type="button"
                onClick={() => void fetchInfo()}
                className="mt-2 rounded border border-gn-prompt-border px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
              >
                重试
              </button>
            </div>
          ) : !data ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              暂无活动会话
            </div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              暂无活动会话
            </div>
          ) : (
            rows.map((r) => (
              <div
                key={r.label}
                className="flex items-start gap-3 border-b border-gn-prompt-border/50 px-4 py-2"
              >
                <span className="w-20 shrink-0 pt-px text-[10px] uppercase tracking-wider text-gn-gutter">
                  {r.label}
                </span>
                <span
                  className={`min-w-0 flex-1 break-words text-[12px] leading-snug ${r.mono ? 'font-mono text-gn-fg' : 'text-gn-fg2'}`}
                >
                  {r.value}
                </span>
              </div>
            ))
          )}
        </div>

        <footer className="rounded-b border-t border-gn-prompt-border px-4 py-2 text-[11px] text-gn-gutter">
          x.ai/session-info · 与 TUI /session-info 一致
        </footer>
      </div>
    </div>
  )
}
