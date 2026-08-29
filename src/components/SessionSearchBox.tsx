import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { transport } from '../api/client'

/**
 * Session full-text search box for the history sidebars (TUI /history /
 * session-picker search; agent `x.ai/session/search` via the host's
 * `POST /api/session/search`).
 *
 * Empty input → inactive (the normal grouped list renders below; wire the
 * `onActive` callback to a flag that hides it). A non-empty query
 * debounces into a server full-text search across past sessions
 * (title / summary / content snippets) and renders a flat hit list
 * instead; clicking a hit (or Enter) opens the session via
 * `continueSession` and resets the search. Paging clamps live in the
 * transport (limit ≤ 100 / offset ≤ 1000 — the agent hard-validates the
 * window and answers invalid_params otherwise).
 */

type SessionSearchHit = {
  sessionId: string
  cwd: string
  summary: string
  updatedAt: string
  score?: number
  matchedFields?: string[]
  snippet?: string
}

const DEBOUNCE_MS = 350
/** Hits per page (transport clamps to the agent's ≤100 window anyway). */
const PAGE_LIMIT = 20

export function SessionSearchBox({
  onActive,
  onRequestClose,
}: {
  onActive: (active: boolean) => void
  /** 打开某条命中后收起整个搜索框（按钮化后的展开容器由父级卸载）。 */
  onRequestClose?: () => void
}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SessionSearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [bootstrapping, setBootstrapping] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const reqSeq = useRef(0)
  const trimmed = query.trim()
  const active = trimmed.length > 0

  // 按钮化展开：挂载即聚焦，点开直接可打字。
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    onActive(active)
  }, [active, onActive])

  // Debounced server search per query change (seq guard: a newer query
  // supersedes in-flight responses, including after reset).
  useEffect(() => {
    if (!active) {
      reqSeq.current++
      setHits([])
      setLoading(false)
      setError(undefined)
      setBootstrapping(false)
      return
    }
    const seq = ++reqSeq.current
    setLoading(true)
    setError(undefined)
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const raw = await transport.sessionSearch({ query: trimmed, limit: PAGE_LIMIT })
          if (seq !== reqSeq.current) return
          const o = (raw ?? {}) as Record<string, unknown>
          const list = Array.isArray(o.results) ? o.results : []
          const parsed: SessionSearchHit[] = []
          for (const h of list) {
            if (h == null || typeof h !== 'object') continue
            const ho = h as Record<string, unknown>
            if (typeof ho.sessionId !== 'string' || !ho.sessionId) continue
            parsed.push({
              sessionId: ho.sessionId,
              cwd: typeof ho.cwd === 'string' ? ho.cwd : '',
              summary: typeof ho.summary === 'string' ? ho.summary : '',
              updatedAt: typeof ho.updatedAt === 'string' ? ho.updatedAt : '',
              score: typeof ho.score === 'number' ? ho.score : undefined,
              matchedFields: Array.isArray(ho.matchedFields)
                ? (ho.matchedFields as unknown[]).filter(
                    (x): x is string => typeof x === 'string',
                  )
                : undefined,
              snippet: typeof ho.snippet === 'string' ? ho.snippet : undefined,
            })
          }
          setHits(parsed)
          setBootstrapping(o.bootstrapping === true)
          setLoading(false)
        } catch (e) {
          if (seq !== reqSeq.current) return
          setHits([])
          setLoading(false)
          setError(e instanceof Error ? e.message : String(e))
        }
      })()
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [active, trimmed])

  /** Open a hit — reset the search so the grouped list takes back over. */
  const openHit = (h: SessionSearchHit) => {
    setQuery('')
    setHits([])
    onRequestClose?.()
    void useChatStore.getState().continueSession(h.sessionId, h.cwd || '')
  }

  return (
    <div className="border-b border-gn-prompt-border/60 px-2 py-1.5">
      <div className="flex items-center gap-1.5 rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1">
        <Search size={12} className="shrink-0 text-gn-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Esc clears (and never leaks to the busy-cancel flow below).
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setQuery('')
              inputRef.current?.blur()
            }
          }}
          placeholder="全文搜索历史会话…"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-gn-fg outline-none placeholder:text-gn-gutter"
        />
        {active && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="shrink-0 rounded p-0.5 text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
            title="清空搜索"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {active && (
        <div className="pt-1">
          {loading && hits.length === 0 ? (
            <div className="py-3 text-center text-[12px] text-gn-muted">
              搜索「{trimmed}」…
            </div>
          ) : error ? (
            <div className="py-3 text-center text-[12px] text-gn-red">
              搜索失败 · {error}
            </div>
          ) : hits.length === 0 ? (
            <div className="py-3 text-center text-[12px] text-gn-muted">
              {bootstrapping ? '搜索索引正在建立，暂无结果 — 稍后重试' : '没有匹配的会话'}
            </div>
          ) : (
            <div className="gn-no-scrollbar max-h-[60vh] overflow-y-auto">
              {hits.map((h) => (
                <button
                  key={h.sessionId}
                  type="button"
                  onClick={() => openHit(h)}
                  className="block w-full border-b border-gn-prompt-border/40 px-2.5 py-1.5 text-left hover:bg-gn-bg-highlight"
                  title={h.cwd ? `打开会话（${h.cwd}）` : '打开会话'}
                >
                  <span className="block truncate text-[12px] leading-snug text-gn-fg">
                    {h.summary || h.sessionId.slice(0, 8)}
                  </span>
                  {h.snippet && (
                    <span className="mt-0.5 block break-all text-[11px] leading-snug text-gn-muted">
                      {h.snippet}
                    </span>
                  )}
                  <span className="mt-0.5 block truncate font-mono text-[10px] text-gn-gutter">
                    {formatStamp(h.updatedAt)}
                    {h.cwd ? ` · ${tailPath(h.cwd)}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** updatedAt (epoch s/ms or ISO) → "MM-DD HH:mm"; unparseable → verbatim. */
function formatStamp(ts: string): string {
  if (!ts) return ''
  const n = Number(ts)
  const d =
    Number.isFinite(n) && n > 0 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Last two path segments (workspace tail) for the row meta line. */
function tailPath(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || cwd
}
