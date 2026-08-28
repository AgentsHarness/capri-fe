import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { transport } from '../api/client'
import { pushToast } from '../store/toast'

/**
 * /search — workspace content search modal (TUI /search panel's content
 * arm; agent `x.ai/search/content` ripgrep via the host's
 * `POST /api/search/content` flat-passthrough route).
 *
 * - Debounced live search (case-insensitive, gitignore-respecting,
 *   capped match budget) rooted at the active session workspace.
 * - Results grouped by file: click (or ↑/↓ + Enter) copies `path:line`
 *   so the hit can be pasted into the composer / editor.
 * - Esc closes; the backdrop click closes too.
 *
 * The streaming `x.ai/search/content/status` batches are ignored — the
 * one-shot RPC response already carries the final aggregate.
 */

type ContentMatch = {
  line: number
  content: string
  matchStart?: number
  matchEnd?: number
}

type ContentMatchFile = {
  name: string
  path: string
  matches: ContentMatch[]
}

type ContentSearchResult = {
  files: ContentMatchFile[]
  totalMatches: number
  totalFiles: number
  truncated: boolean
}

const MIN_QUERY_LEN = 2
const DEBOUNCE_MS = 300
/** Match budget — keeps the modal render bounded on big workspaces. */
const MAX_MATCHES = 200

/** Defensive parse: the ext result may be flat or nested a level deep. */
function parseResult(raw: unknown): ContentSearchResult {
  const o = (raw ?? {}) as Record<string, unknown>
  const filesRaw = Array.isArray(o.files)
    ? o.files
    : Array.isArray((o.result as Record<string, unknown> | undefined)?.files)
      ? ((o.result as Record<string, unknown>).files as unknown[])
      : []
  const files: ContentMatchFile[] = []
  for (const f of filesRaw) {
    if (f == null || typeof f !== 'object') continue
    const fo = f as Record<string, unknown>
    if (typeof fo.path !== 'string' || !fo.path) continue
    const matches: ContentMatch[] = []
    if (Array.isArray(fo.matches)) {
      for (const m of fo.matches) {
        if (m == null || typeof m !== 'object') continue
        const mo = m as Record<string, unknown>
        if (typeof mo.content !== 'string') continue
        matches.push({
          line: typeof mo.line === 'number' ? mo.line : 0,
          content: mo.content,
          ...(typeof mo.matchStart === 'number'
            ? { matchStart: mo.matchStart }
            : {}),
          ...(typeof mo.matchEnd === 'number' ? { matchEnd: mo.matchEnd } : {}),
        })
      }
    }
    files.push({
      name:
        typeof fo.name === 'string' && fo.name
          ? fo.name
          : fo.path.split('/').pop() || fo.path,
      path: fo.path,
      matches,
    })
  }
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0
  return {
    files,
    totalMatches: num(o.totalMatches),
    totalFiles: num(o.totalFiles),
    truncated: o.truncated === true,
  }
}

export function ContentSearchModal() {
  const open = useChatStore((s) => s.contentSearchOpen)
  const prefill = useChatStore((s) => s.contentSearchPrefill)
  const closeContentSearch = useChatStore((s) => s.closeContentSearch)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string>()
  const [result, setResult] = useState<ContentSearchResult>()
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)
  const wasOpen = useRef(false)

  // Flat selectable rows (file headers are not selectable).
  const rows = useMemo(() => {
    const out: { file: ContentMatchFile; match: ContentMatch }[] = []
    for (const f of result?.files ?? []) {
      for (const m of f.matches) out.push({ file: f, match: m })
    }
    return out
  }, [result])

  // One-shot open flow: prefill (from `/search foo`) + autofocus.
  useEffect(() => {
    if (!open) {
      wasOpen.current = false
      return
    }
    if (wasOpen.current) return
    wasOpen.current = true
    setQuery(prefill)
    setError(undefined)
    setResult(undefined)
    setSel(0)
    inputRef.current?.focus()
  }, [open, prefill])

  const runSearch = useCallback(async (q: string) => {
    const seq = ++reqSeq.current
    const st = useChatStore.getState()
    const target = st.cwd || (st.sessionId ? { sessionId: st.sessionId } : {})
    setSearching(true)
    setError(undefined)
    try {
      const raw = await transport.searchContent({
        pattern: q,
        ...(typeof target === 'string'
          ? { cwd: target }
          : { sessionId: target.sessionId }),
        caseInsensitive: true,
        maxMatches: MAX_MATCHES,
      })
      if (seq !== reqSeq.current) return // superseded
      setResult(parseResult(raw))
      setSel(0)
    } catch (e) {
      if (seq !== reqSeq.current) return
      setResult(undefined)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === reqSeq.current) setSearching(false)
    }
  }, [])

  // Debounced live search on query change (TUI /search searches as you type).
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < MIN_QUERY_LEN) {
      reqSeq.current++ // invalidate in-flight searches
      setSearching(false)
      setResult(undefined)
      setError(undefined)
      return
    }
    const t = window.setTimeout(() => void runSearch(q), DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [open, query, runSearch])

  /** Copy `path:line` — row click / Enter (TUI yank path). */
  const copyHit = useCallback((idx: number) => {
    const row = rows[idx]
    if (!row) return
    const text = `${row.file.path}:${row.match.line}`
    void navigator.clipboard
      .writeText(text)
      .then(() => pushToast(`已复制 ${text}`))
      .catch(() => pushToast('复制失败：剪贴板不可用'))
  }, [rows])

  // Keep the selected row visible while ↑/↓ walks the list.
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-sel="1"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel, rows.length])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const prevent = () => {
        e.preventDefault()
        e.stopPropagation()
      }
      if (e.key === 'Escape') {
        prevent()
        closeContentSearch()
        return
      }
      // In the input: only Escape/arrows/Enter are intercepted — typing
      // (including j/k) must reach the field.
      const inInput = e.target === inputRef.current
      if (!inInput && (e.key === 'j' || e.key === 'k')) {
        prevent()
        setSel((s) =>
          e.key === 'j'
            ? Math.min(rows.length - 1, s + 1)
            : Math.max(0, s - 1),
        )
        return
      }
      if (e.key === 'ArrowDown') {
        prevent()
        setSel((s) => Math.min(rows.length - 1, s + 1))
        return
      }
      if (e.key === 'ArrowUp') {
        prevent()
        setSel((s) => Math.max(0, s - 1))
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        prevent()
        copyHit(sel)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, rows.length, sel, copyHit, closeContentSearch])

  if (!open) return null

  const noRoot = !useChatStore.getState().cwd && !useChatStore.getState().sessionId

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="search"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeContentSearch()
      }}
    >
      <div className="mt-8 flex w-full max-w-[680px] flex-col overflow-hidden rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl">
        <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
          <span className="font-mono text-[13px] font-bold text-gn-fg">/search</span>
          <span className="text-[11px] text-gn-muted">搜索工作区文件内容</span>
          <button
            type="button"
            onClick={closeContentSearch}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            esc
          </button>
        </header>

        <div className="flex items-center gap-2 border-b border-gn-prompt-border px-4 py-2">
          <Search size={13} className="shrink-0 text-gn-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入内容片段（≥2 字符，忽略大小写）"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-gn-fg outline-none placeholder:text-gn-gutter"
          />
          {searching && (
            <span className="shrink-0 text-[10px] text-gn-muted">搜索中…</span>
          )}
        </div>

        <div ref={listRef} className="gn-no-scrollbar max-h-[52vh] min-h-[120px] overflow-y-auto">
          {noRoot ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              暂无活动会话工作目录 — 先打开一个会话再搜索
            </div>
          ) : error ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-red">{error}</div>
          ) : query.trim().length < MIN_QUERY_LEN ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              输入要搜索的内容片段 · 结果按文件分组，点击复制 路径:行号
            </div>
          ) : result ? (
            result.files.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
                没有匹配（尊重 .gitignore）
              </div>
            ) : (
              result.files.map((f) => (
                <div key={f.path}>
                  <div className="flex items-center gap-2 border-b border-gn-prompt-border/60 bg-gn-bg-dark/60 px-3 py-1">
                    <span className="truncate font-mono text-[11px] font-bold text-gn-fg2" title={f.path}>
                      {f.path}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-gn-muted">
                      {f.matches.length} 处
                    </span>
                  </div>
                  {f.matches.map((m) => {
                    const idx = rows.findIndex(
                      (r) => r.file.path === f.path && r.match === m,
                    )
                    return (
                      <button
                        key={`${f.path}:${m.line}:${idx}`}
                        type="button"
                        data-sel={idx === sel ? '1' : '0'}
                        onMouseEnter={() => setSel(idx)}
                        onClick={() => copyHit(idx)}
                        className={`flex w-full items-baseline gap-2 border-b border-gn-prompt-border/30 px-3 py-1 text-left ${
                          idx === sel ? 'bg-gn-bg-highlight' : ''
                        }`}
                      >
                        <span className="w-10 shrink-0 text-right font-mono text-[10px] leading-[18px] text-gn-gutter">
                          {m.line > 0 ? m.line : ''}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-[18px] text-gn-fg2">
                          <MatchText match={m} />
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))
            )
          ) : (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              输入内容开始搜索…
            </div>
          )}
        </div>

        <footer className="flex items-center gap-3 border-t border-gn-prompt-border bg-gn-bg-dark px-4 py-1.5 text-[10px] text-gn-muted">
          {result && (
            <span>
              {result.truncated ? '结果已截断 · ' : ''}
              {result.totalMatches} 处匹配 / {result.totalFiles} 个文件
            </span>
          )}
          <span className="ml-auto">↑/↓ 选择 · Enter 复制 路径:行号 · Esc 关闭</span>
        </footer>
      </div>
    </div>
  )
}

/** Line text with the matched span highlighted (matchStart/matchEnd). */
function MatchText({ match }: { match: ContentMatch }) {
  const { content, matchStart, matchEnd } = match
  if (
    matchStart == null ||
    matchEnd == null ||
    matchStart < 0 ||
    matchEnd <= matchStart ||
    matchEnd > content.length
  ) {
    return <>{content}</>
  }
  return (
    <>
      {content.slice(0, matchStart)}
      <span className="rounded bg-gn-cyan/20 font-bold text-gn-cyan">
        {content.slice(matchStart, matchEnd)}
      </span>
      {content.slice(matchEnd)}
    </>
  )
}
