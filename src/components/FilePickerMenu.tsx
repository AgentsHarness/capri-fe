import { useEffect, useRef } from 'react'
import { FileSearch } from 'lucide-react'
import type { FileSearchMatch } from '../store/chat'

/**
 * TUI @ file picker popover — floats above the composer while an `@`
 * token is being typed (fuzzy file search, agent `x.ai/search/fuzzy/*`).
 * Matches stream in via the store's `fileSearch` state (fed by the
 * `search_fuzzy_status` SSE event); ↑/↓ (or hover) pick, Enter/Tab insert
 * the path after the `@`. Empty query shows the type-to-filter hint (the
 * wire's change call requires a non-empty query).
 */
export function FilePickerMenu({
  query,
  matches,
  done,
  total,
  selected,
  onHover,
  onPick,
}: {
  query: string
  matches: FileSearchMatch[]
  done: boolean
  total?: number
  selected: number
  onHover: (i: number) => void
  onPick: (path: string) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the highlighted row visible while ↑/↓ walks the list.
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-sel="1"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected, matches.length])

  const showList = query.length > 0

  return (
    <div className="absolute bottom-full left-0 right-0 z-40 mb-1 overflow-hidden rounded border border-gn-prompt-border-active bg-gn-bg-dark shadow-2xl">
      <div className="flex items-center justify-between border-b border-gn-prompt-border px-3 py-1.5">
        <span className="text-[11px] font-bold text-gn-fg2">文件</span>
        <span className="text-[10px] text-gn-muted">
          {showList && done
            ? `${matches.length}${total != null && total > matches.length ? ` / ${total}` : ''} 个匹配`
            : '@ 前缀触发'}
        </span>
      </div>
      <div ref={listRef} className="gn-no-scrollbar max-h-56 overflow-y-auto py-0.5">
        {!showList ? (
          <div className="px-3 py-3 text-[11px] text-gn-muted">
            输入以过滤文件（相对工作目录路径）
          </div>
        ) : matches.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-gn-muted">
            {done ? (
              <>没有匹配的文件</>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <FileSearch size={11} className="animate-pulse text-gn-muted" />
                搜索中…
              </span>
            )}
          </div>
        ) : (
          matches.map((m, i) => (
            <button
              key={`${m.path}:${i}`}
              type="button"
              data-sel={i === selected ? '1' : '0'}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(m.path)}
              className={`block w-full px-3 py-[5px] text-left transition-colors ${
                i === selected ? 'bg-gn-bg-highlight' : ''
              }`}
            >
              <span className="block truncate font-mono text-[12px] text-gn-fg">
                <MatchPath path={m.path} matched={m.matchedIndices} />
              </span>
            </button>
          ))
        )}
      </div>
      <div className="border-t border-gn-prompt-border px-3 py-[3px] text-[10px] text-gn-muted">
        ↑/↓ 选择 · Enter/Tab 填入 · Esc 关闭
      </div>
    </div>
  )
}

/**
 * Path text with the fuzzy-matched characters highlighted (TUI renders
 * matched char runs emphasized). Indices beyond the path length (should
 * not happen) are skipped defensively.
 */
function MatchPath({
  path,
  matched,
}: {
  path: string
  matched?: number[]
}) {
  if (!matched || matched.length === 0) return <>{path}</>
  const set = new Set(matched)
  const out: React.ReactNode[] = []
  let run: string[] = []
  let inMatch = false
  const flush = (key: number) => {
    if (run.length === 0) return
    const text = run.join('')
    out.push(
      inMatch ? (
        <span key={key} className="font-bold text-gn-cyan">
          {text}
        </span>
      ) : (
        <span key={key}>{text}</span>
      ),
    )
    run = []
  }
  for (let i = 0; i < path.length; i++) {
    const m = set.has(i)
    if (m !== inMatch) {
      flush(i)
      inMatch = m
    }
    run.push(path[i])
  }
  flush(path.length)
  return <>{out}</>
}
