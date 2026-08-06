import { useEffect, useRef } from 'react'
import { useChatStore } from '../store/chat'

/**
 * MCP server status panel (x.ai/mcp/server_status) — web counterpart of the
 * TUI MCP modal. Rows are patched in place as server_status notifications
 * arrive; tools_changed / servers_updated bump mcpVersion (displayed as a
 * "已更新" hint on the next notification).
 */
export function McpPanel({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const mcpServers = useChatStore((s) => s.mcpServers)
  const mcpVersion = useChatStore((s) => s.mcpVersion)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="MCP servers"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="mt-8 w-full max-w-[560px] rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl outline-none"
      >
        <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
          <span className="text-[13px] font-bold text-gn-fg">MCP servers</span>
          <span className="text-[11px] text-gn-muted">
            {mcpServers.length} 个服务器
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            esc
          </button>
        </header>

        <div className="max-h-[55vh] overflow-y-auto py-1">
          {mcpServers.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              尚未收到服务器状态通知
            </div>
          ) : (
            mcpServers.map((s) => (
              <div
                key={s.name}
                className="flex items-start gap-2.5 border-b border-gn-prompt-border/50 px-4 py-2.5"
              >
                <span
                  className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${statusDot(s.status)}`}
                  title={s.status ?? 'unknown'}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate font-mono text-[12.5px] text-gn-fg">
                      {s.name}
                    </span>
                    <span className="shrink-0 text-[11px] text-gn-muted">
                      {s.status ?? 'unknown'}
                      {s.source ? ` · ${s.source}` : ''}
                    </span>
                  </div>
                  {s.reason ? (
                    <div className="truncate text-[11px] text-gn-gutter">
                      {s.reason}
                    </div>
                  ) : null}
                  {s.detail ? (
                    <div className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-gn-muted">
                      {s.detail}
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>

        {mcpVersion > 0 ? (
          <footer className="rounded-b border-t border-gn-prompt-border px-4 py-2 text-[11px] text-gn-gutter">
            工具列表已更新 {mcpVersion} 次（x.ai/mcp/tools_changed）
          </footer>
        ) : null}
      </div>
    </div>
  )
}

function statusDot(status?: string): string {
  switch (status) {
    case 'ready':
      return 'bg-gn-green shadow-[0_0_6px_rgba(158,206,106,.5)]'
    case 'initializing':
      return 'bg-gn-yellow animate-pulse'
    case 'needs_auth':
      return 'bg-gn-orange'
    default:
      return 'bg-gn-red'
  }
}
