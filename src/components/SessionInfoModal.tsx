import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import { transport } from '../api/client'
import type { SessionInfoDetail, SessionUsageData } from '../api/types'
import { fmtTok, shortCwd } from '../format'
import { contextUrgencyColor } from '../theme/contextColor'

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
  // ── x.ai/session/usage + x.ai/share_session（footer 操作）──────────
  const [usage, setUsage] = useState<SessionUsageData>()
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageError, setUsageError] = useState<string>()
  const [sharing, setSharing] = useState(false)
  const [shareError, setShareError] = useState<string>()
  const [shareCopied, setShareCopied] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)

  const fetchInfo = useCallback(async () => {
    const seq = ++reqSeq.current
    setLoading(true)
    setError(undefined)
    try {
      // 锁定打开弹窗时的会话（缺省 = host active，多 tab 下可能漂移）。
      const info = await transport.sessionInfo(useChatStore.getState().sessionId)
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

  /** x.ai/session/usage — token 用量（字段防御性解析，缺啥不显示啥）。 */
  const refreshUsage = useCallback(async () => {
    setUsageLoading(true)
    setUsageError(undefined)
    try {
      const r = await transport.sessionUsage()
      setUsage({
        totalTokens: num(r.totalTokens) ?? num(r.total_tokens),
        inputTokens: num(r.inputTokens) ?? num(r.input_tokens),
        outputTokens: num(r.outputTokens) ?? num(r.output_tokens),
        contextSize: num(r.contextSize) ?? num(r.context_size),
      })
    } catch (e) {
      setUsageError(e instanceof Error ? e.message : String(e))
    } finally {
      setUsageLoading(false)
    }
  }, [])

  /** x.ai/share_session — 从 result 里防御性找分享 URL，找不到提示失败。 */
  const shareSession = async () => {
    setSharing(true)
    setShareError(undefined)
    try {
      const result = await transport.sessionShare()
      const url = findShareUrl(result)
      if (!url) {
        setShareError('分享失败: 响应中没有分享链接（share_url/url/link 字段）')
        return
      }
      await navigator.clipboard.writeText(url)
      setShareCopied(true)
      setTimeout(() => setShareCopied(false), 1500)
      useChatStore.setState({ statusText: `分享链接已复制: ${url}` })
    } catch (e) {
      setShareError(`分享失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSharing(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setCopied(false)
    setShareCopied(false)
    setShareError(undefined)
    setUsage(undefined)
    setUsageError(undefined)
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
  // totalContextTokens — same precedence as the TUI context bar. pct is
  // clamped to 100 like the TUI (used can transiently exceed the window);
  // the color follows the same urgency gradient as the context chip.
  const ctxSize = data?.contextSize || data?.model?.contextWindow || 0
  const ctxUsed = data?.contextUsed ?? 0
  const pct =
    ctxSize > 0 ? Math.min(100, Math.round((ctxUsed / ctxSize) * 100)) : undefined

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
              <span style={pct != null ? { color: contextUrgencyColor(pct) } : undefined}>
                {fmtTok(ctxUsed)} / {fmtTok(ctxSize)}
                {pct != null ? ` (${pct}%)` : ''}
              </span>
            ),
            mono: true,
          },
        ]
      : []),
    // x.ai/session/usage（footer 刷新按钮拉取）— 与宿主 context 行互补。
    ...(usage &&
    (usage.totalTokens != null ||
      usage.inputTokens != null ||
      usage.outputTokens != null)
      ? [
          {
            label: 'usage',
            value: (
              <span className="font-mono">
                {usage.totalTokens != null
                  ? fmtTok(usage.totalTokens)
                  : `${fmtTok(usage.inputTokens ?? 0)} in · ${fmtTok(usage.outputTokens ?? 0)} out`}
                {usage.contextSize != null ? ` / ${fmtTok(usage.contextSize)}` : ''}
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

        <footer className="rounded-b border-t border-gn-prompt-border px-4 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshUsage()}
              disabled={usageLoading}
              className="rounded border border-gn-prompt-border px-2 py-0.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
              title="x.ai/session/usage — 拉取本次会话的 token 用量"
            >
              {usageLoading ? '刷新中…' : '刷新 usage'}
            </button>
            <button
              type="button"
              onClick={() => void shareSession()}
              disabled={sharing}
              className="rounded border border-gn-prompt-border px-2 py-0.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
              title="x.ai/share_session — 生成分享链接并复制到剪贴板"
            >
              {sharing ? '分享中…' : shareCopied ? '✓ 已复制' : '复制分享'}
            </button>
            <span className="ml-auto text-[11px] text-gn-gutter">
              x.ai/session-info · 与 TUI /session-info 一致
            </span>
          </div>
          {(usageError || shareError) && (
            <div className="mt-1.5 font-mono text-[10.5px] text-gn-red">
              {usageError ?? shareError}
            </div>
          )}
        </footer>
      </div>
    </div>
  )
}

/** Finite non-negative number helper (usage fields are optional). */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/**
 * 从 x.ai/share_session 的 result 里防御性找分享 URL：浅层 + 一层
 * result/result.result 嵌套，字段名兼容 camelCase / snake_case。
 */
function findShareUrl(result: unknown): string | undefined {
  const keys = ['url', 'share_url', 'shareUrl', 'link', 'permalink', 'share_link']
  const candidates: unknown[] = [result]
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const inner = (result as Record<string, unknown>).result
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      candidates.push(inner)
    }
  }
  for (const c of candidates) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue
    const o = c as Record<string, unknown>
    for (const k of keys) {
      const v = o[k]
      if (typeof v === 'string' && /^https?:\/\//.test(v)) return v
    }
  }
  return undefined
}
