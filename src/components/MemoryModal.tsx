import { useEffect, useState } from 'react'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'

/**
 * /memory modal — web counterpart of the TUI memory view.
 *
 * Lists the memory files cached from the `memory_files` session
 * notification (name / path / size / updatedAt). The web frontend has
 * NO file-read endpoint and no delete endpoint, so row actions are
 * limited to showing the path + a hint to manage the file in the
 * TUI / a terminal (read-only view; memory management needs host
 * support). There is also no refresh endpoint — the list is whatever
 * the last memory_files broadcast carried.
 */

type MemoryFile = { name: string; path?: string; size?: number; updatedAt?: unknown }

function fmtSize(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmtTime(u: unknown): string {
  if (u == null || u === '') return '—'
  if (typeof u === 'number' && Number.isFinite(u)) {
    // epoch seconds vs milliseconds — both plausible on the wire.
    const ms = u > 1e12 ? u : u * 1000
    return new Date(ms).toLocaleString()
  }
  if (typeof u === 'string') {
    const t = Date.parse(u)
    return Number.isNaN(t) ? u : new Date(t).toLocaleString()
  }
  return String(u)
}

export function MemoryModal() {
  const open = useChatStore((s) => s.memoryOpen)
  const closeMemory = useChatStore((s) => s.closeMemory)
  const files = useChatStore((s) => s.memoryFiles) ?? []
  // Inline detail: which file the user asked to view / delete.
  const [detail, setDetail] = useState<{ path: string; action: 'view' | 'delete' } | null>(null)

  useEffect(() => {
    if (!open) return
    setDetail(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeMemory()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, closeMemory])

  if (!open) return null

  const pathOf = (f: MemoryFile) => f.path || f.name

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="memory"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeMemory()
      }}
    >
      <div className="my-4 w-full max-w-[640px] rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl">
        <header className="flex items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5 rounded-t">
          <span className="text-gn-magenta" aria-hidden>
            {Glyphs.diamondFilled}
          </span>
          <span className="text-[13px] font-bold text-gn-fg">记忆</span>
          <span className="ml-auto text-[11px] text-gn-muted">esc 关闭</span>
        </header>

        <div className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto px-4 py-3">
          {/* Status + scope note (read-only view). */}
          <div className="rounded border border-gn-prompt-border bg-gn-bg-dark px-3 py-2 text-[11.5px] leading-relaxed text-gn-fg2">
            {files.length > 0 ? (
              <span>
                <span className="text-gn-green">记忆已启用</span>
                {' · '}
                {files.length} 个文件
              </span>
            ) : (
              <span className="text-gn-muted">暂无记忆文件（记忆可能未启用）</span>
            )}
            <span className="block text-gn-muted">
              记忆管理需 host 支持，当前为只读视图；backend 信息未暴露给 Web 端。
              列表为 memory_files 事件缓存，暂无刷新端点。
            </span>
          </div>

          {files.length === 0 ? (
            <div className="px-2 py-6 text-center text-[12px] text-gn-muted">
              会话保存或 /flush 后，host 会通过 memory_files 事件广播记忆文件列表。
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {files.map((f, i) => (
                <li key={i}>
                  <div className="flex items-center gap-2 rounded border border-gn-prompt-border px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[12px] text-gn-fg">
                        {f.name}
                      </div>
                      <div className="mt-0.5 truncate text-[10.5px] text-gn-muted">
                        {pathOf(f)}
                      </div>
                    </div>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-gn-muted">
                      {fmtSize(f.size)}
                    </span>
                    <span className="hidden shrink-0 text-[10.5px] tabular-nums text-gn-muted sm:block">
                      {fmtTime(f.updatedAt)}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setDetail({ path: pathOf(f), action: 'view' })}
                        className="rounded border border-gn-prompt-border px-2 py-0.5 text-[10.5px] text-gn-fg2 hover:bg-gn-bg-highlight"
                      >
                        查看
                      </button>
                      <button
                        type="button"
                        onClick={() => setDetail({ path: pathOf(f), action: 'delete' })}
                        className="rounded border border-gn-red/40 px-2 py-0.5 text-[10.5px] text-gn-red hover:bg-gn-diff-del-bg"
                      >
                        删除
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Inline hint panel for view / delete (no read/delete endpoint). */}
          {detail ? (
            <div className="rounded border border-gn-warning/40 bg-gn-bg-dark px-3 py-2.5 text-[11.5px] leading-relaxed">
              <div className="font-mono text-[11.5px] text-gn-path break-all">
                {detail.path}
              </div>
              <div className="mt-1 text-gn-fg2">
                {detail.action === 'view' ? (
                  <>
                    Web 端暂无文件读取端点 — 请在 <b>TUI / 终端</b> 中查看该记忆文件
                    （例如 <span className="font-mono text-gn-cyan">cat</span> 或编辑器打开）。
                  </>
                ) : (
                  <>
                    Web 端暂无删除端点 — 请在 <b>TUI / 终端</b> 中手动删除该记忆文件
                    （记忆文件由 host 管理）。
                  </>
                )}
              </div>
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-gn-prompt-border px-4 py-3">
          <button
            type="button"
            onClick={closeMemory}
            className="min-h-9 rounded border border-gn-prompt-border px-4 py-1.5 text-[12.5px] text-gn-fg2 hover:bg-gn-bg-highlight"
          >
            关闭
          </button>
        </footer>
      </div>
    </div>
  )
}
