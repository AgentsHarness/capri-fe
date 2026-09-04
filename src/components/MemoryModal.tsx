import { useEffect, useMemo, useState } from 'react'
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

type MemoryFile = { name: string; path?: string; size?: number; updatedAt?: unknown; source?: string }

/** Stable empty fallback — a fresh `[]` per render would defeat useMemo. */
const NO_MEMORY_FILES: MemoryFile[] = []

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

/** updatedAt as epoch ms (0 when unknown) — drives session-log ordering. */
function updatedMs(f: MemoryFile): number {
  const u = f.updatedAt
  if (typeof u === 'number' && Number.isFinite(u)) return u > 1e12 ? u : u * 1000
  if (typeof u === 'string') {
    const t = Date.parse(u)
    return Number.isNaN(t) ? 0 : t
  }
  return 0
}

function cmpStrCi(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b)
}

type MemoryGroup = { label: string; items: MemoryFile[] }

/**
 * Group memory files like the TUI memory modal (memory_modal.rs
 * build_entries): Global / Workspace / Sessions, session logs newest
 * first. `source` ("global" / "workspace" / "session") wins when the
 * wire carries it; otherwise the path is sniffed defensively. When
 * nothing classifies, returns null — the modal falls back to a flat
 * A-Z list.
 */
function groupMemoryFiles(files: MemoryFile[]): MemoryGroup[] | null {
  const global: MemoryFile[] = []
  const workspace: MemoryFile[] = []
  const session: MemoryFile[] = []
  let classified = 0
  for (const f of files) {
    const source = f.source
    const path = f.path ?? ''
    if (source === 'global' || source === 'workspace' || source === 'session') {
      classified++
      if (source === 'global') global.push(f)
      else if (source === 'workspace') workspace.push(f)
      else session.push(f)
    } else if (/(^|[\\/])sessions?[\\/]/.test(path) || path.includes('.grok/memory/sessions')) {
      classified++
      session.push(f)
    } else if (path.includes('.grok/memory') || /(^|[\\/])MEMORY\.md$/i.test(path)) {
      classified++
      global.push(f)
    } else if (/(^|[\\/])workspace[\\/]?/.test(path)) {
      classified++
      workspace.push(f)
    }
  }
  if (classified === 0) return null // 分不了 — 保持扁平 + A-Z
  // Unclassifiable leftovers ride with the session bucket (TUI `_ => session`).
  session.push(...files.filter((f) => !global.includes(f) && !workspace.includes(f) && !session.includes(f)))

  const byName = (a: MemoryFile, b: MemoryFile) => cmpStrCi(a.name, b.name)
  global.sort(byName)
  workspace.sort(byName)
  // 会话日志倒序：newest first, unknown timestamps last.
  session.sort((a, b) => updatedMs(b) - updatedMs(a) || byName(a, b))

  const groups: MemoryGroup[] = []
  if (global.length > 0) groups.push({ label: 'Global', items: global })
  if (workspace.length > 0) groups.push({ label: 'Workspace', items: workspace })
  if (session.length > 0) groups.push({ label: 'Sessions', items: session })
  return groups
}

export function MemoryModal() {
  const open = useChatStore((s) => s.memoryOpen)
  const closeMemory = useChatStore((s) => s.closeMemory)
  const files = useChatStore((s) => s.memoryFiles) ?? NO_MEMORY_FILES
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

  // Grouped view (TUI build_entries); unclassifiable data stays flat A-Z.
  const groups = useMemo(() => groupMemoryFiles(files), [files])
  const flat = useMemo(() => [...files].sort((a, b) => cmpStrCi(a.name, b.name)), [files])

  if (!open) return null

  const pathOf = (f: MemoryFile) => f.path || f.name

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto gn-modal-dim p-4"
      role="dialog"
      aria-modal="true"
      aria-label="memory"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeMemory()
      }}
    >
      <div className="my-4 w-full max-w-[640px] gn-modal-panel">
        <header className="gn-modal-header">
          <span className="text-gn-magenta" aria-hidden>
            {Glyphs.diamondFilled}
          </span>
          <span className="text-[13px] font-bold text-gn-fg">记忆</span>
          <span className="ml-auto hidden items-center gap-1 text-[11px] text-gn-muted sm:inline-flex"><span className="gn-kbd">Esc</span> 关闭</span>
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
          ) : groups ? (
            groups.map((g) => (
              <div key={g.label}>
                <div className="flex items-center gap-1.5 px-1 pb-1 pt-2 text-[10px] uppercase tracking-wider text-gn-gutter">
                  <span className="font-medium">{g.label}</span>
                  <span className="tabular-nums">{g.items.length}</span>
                </div>
                <ul className="flex flex-col gap-1.5">
                  {g.items.map((f, i) => (
                    <li key={`${g.label}-${i}`}>
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
                            className="rounded px-2 py-0.5 text-[10.5px] text-gn-fg2 hover:bg-gn-bg-highlight"
                          >
                            查看
                          </button>
                          <button
                            type="button"
                            onClick={() => setDetail({ path: pathOf(f), action: 'delete' })}
                            className="rounded px-2 py-0.5 text-[10.5px] text-gn-red hover:bg-gn-diff-del-bg"
                          >
                            删除
                          </button>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <ul className="flex flex-col gap-1.5">
              {flat.map((f, i) => (
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
                        className="rounded px-2 py-0.5 text-[10.5px] text-gn-fg2 hover:bg-gn-bg-highlight"
                      >
                        查看
                      </button>
                      <button
                        type="button"
                        onClick={() => setDetail({ path: pathOf(f), action: 'delete' })}
                        className="rounded px-2 py-0.5 text-[10.5px] text-gn-red hover:bg-gn-diff-del-bg"
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

        <footer className="gn-modal-footer flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={closeMemory}
            className="min-h-9 rounded px-4 py-1.5 text-[12.5px] text-gn-fg2 hover:bg-gn-bg-highlight"
          >
            关闭
          </button>
        </footer>
      </div>
    </div>
  )
}
