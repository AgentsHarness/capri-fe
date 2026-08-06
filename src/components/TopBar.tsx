import { useState } from 'react'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { ThemePicker } from './ThemePicker'

/**
 * Minimal top chrome — closer to TUI status (gray on bg_base) than a fat web header.
 * Host switcher pre-wired for multi-host; git branch + session actions
 * (fork / rename / recap) live off the x.ai extension surface.
 */
export function TopBar({ onOpenMcp }: { onOpenMcp?: () => void }) {
  const conn = useChatStore((s) => s.conn)
  const statusText = useChatStore((s) => s.statusText)
  const hostName = useChatStore((s) => s.hostName)
  const hostId = useChatStore((s) => s.hostId)
  const hosts = useChatStore((s) => s.hosts)
  const sessionId = useChatStore((s) => s.sessionId)
  const cancel = useChatStore((s) => s.cancel)
  const newSession = useChatStore((s) => s.newSession)
  const sessions = useChatStore((s) => s.sessions)
  const historyOpen = useChatStore((s) => s.historyOpen)
  const historyLoading = useChatStore((s) => s.historyLoading)
  const openHistory = useChatStore((s) => s.openHistory)
  const closeHistory = useChatStore((s) => s.closeHistory)
  const continueSession = useChatStore((s) => s.continueSession)
  const gitInfo = useChatStore((s) => s.gitInfo)
  const forkSession = useChatStore((s) => s.forkSession)
  const renameSession = useChatStore((s) => s.renameSession)
  const requestRecap = useChatStore((s) => s.requestRecap)
  const [openHosts, setOpenHosts] = useState(false)

  const dot =
    conn === 'ready'
      ? 'bg-gn-green shadow-[0_0_6px_rgba(158,206,106,.5)]'
      : conn === 'busy'
        ? 'bg-gn-yellow shadow-[0_0_6px_rgba(224,175,104,.5)] animate-pulse'
        : conn === 'error'
          ? 'bg-gn-red'
          : 'bg-gn-muted animate-pulse'

  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-dark px-3 py-[6px] sm:px-4 text-[12px] text-gn-muted select-none">
      <span className="font-semibold tracking-wide text-gn-magenta">
        grok <b className="font-semibold text-gn-fg">build</b>
      </span>
      <span className="text-gn-gray-dim">|</span>

      <div className="relative min-w-0">
        <button
          type="button"
          onClick={() => setOpenHosts((v) => !v)}
          className="flex max-w-[46vw] sm:max-w-xs items-center gap-1 truncate rounded px-1.5 py-0.5 hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
        >
          <span className="truncate">{hostName || 'Local Host'}</span>
          <span className="text-gn-gutter">▾</span>
        </button>
        {openHosts && (
          <>
            <button
              type="button"
              className="fixed inset-0 z-30 cursor-default"
              aria-label="close"
              onClick={() => setOpenHosts(false)}
            />
            <div className="absolute left-0 top-full z-40 mt-1 w-64 max-w-[90vw] rounded border border-gn-prompt-border bg-gn-bg-base shadow-xl py-1">
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gn-gutter">
                hosts
              </div>
              {(hosts.length
                ? hosts
                : [{ hostId: hostId || 'local', hostName: hostName || 'Local Host', online: true }]
              ).map((h) => (
                <div
                  key={h.hostId}
                  className="flex items-center gap-2 px-3 py-2 text-[12px] hover:bg-gn-bg-highlight"
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${h.online ? 'bg-gn-green' : 'bg-gn-muted'}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-gn-fg">{h.hostName}</div>
                    <div className="truncate font-mono text-[10px] text-gn-muted">{h.hostId}</div>
                  </div>
                </div>
              ))}
              <div className="border-t border-gn-prompt-border px-3 py-2 text-[11px] text-gn-muted leading-snug">
                Multi-host via Hub · currently local only
              </div>
            </div>
          </>
        )}
      </div>

      {/* Git head (x.ai/git_head_changed) — TUI status-bar branch. */}
      {gitInfo?.branch ? (
        <span
          className="hidden max-w-[24vw] items-center gap-1 truncate rounded px-1.5 py-0.5 font-mono text-[11px] text-gn-cyan sm:flex"
          title={
            gitInfo.isWorktree
              ? `${gitInfo.branch} · worktree${gitInfo.mainRepo ? ` of ${gitInfo.mainRepo}` : ''}`
              : gitInfo.branch
          }
        >
          <span className="text-gn-cyan" aria-hidden>
            ⎇
          </span>
          <span className="truncate">{gitInfo.branch}</span>
          {gitInfo.isWorktree && <span className="text-gn-gutter">wt</span>}
        </span>
      ) : null}

      <div className="flex-1" />

      <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${dot}`} title={statusText} />
      <span className="hidden max-w-[14rem] truncate md:inline">{statusText}</span>
      {sessionId && (
        <span className="hidden font-mono text-[10px] text-gn-gutter lg:inline">
          {sessionId.slice(0, 8)}
        </span>
      )}

      {conn === 'busy' && (
        <button
          type="button"
          onClick={() => void cancel()}
          className="rounded border border-transparent px-2 py-0.5 text-gn-red hover:border-gn-red hover:bg-gn-bg-highlight min-h-8"
        >
          <span className="mr-1 inline-flex items-center">
            <IconGlyph glyph={Glyphs.ballotX} color="currentColor" />
          </span>
          cancel
        </button>
      )}
      <ThemePicker />
      {onOpenMcp && (
        <button
          type="button"
          onClick={onOpenMcp}
          className="rounded border border-transparent px-2 py-0.5 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
          title="MCP 服务器状态"
        >
          mcp
        </button>
      )}
      <button
        type="button"
        onClick={() => void newSession()}
        className="rounded border border-transparent px-2 py-0.5 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
      >
        new
      </button>
      <div className="relative">
        <button
          type="button"
          onClick={() => (historyOpen ? closeHistory() : void openHistory())}
          className="rounded border border-transparent px-2 py-0.5 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
          title="加载历史会话"
        >
          history
        </button>
        {historyOpen && (
          <>
            <button
              type="button"
              className="fixed inset-0 z-30 cursor-default"
              aria-label="close"
              onClick={closeHistory}
            />
            <div className="absolute right-0 top-full z-40 mt-1 max-h-[70vh] w-80 max-w-[92vw] overflow-y-auto rounded border border-gn-prompt-border bg-gn-bg-base shadow-xl py-1">
              {/* Session actions (x.ai ext methods). */}
              <div className="flex items-center gap-1 border-b border-gn-prompt-border px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => {
                    closeHistory()
                    void requestRecap()
                  }}
                  className="rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="x.ai/recap — 生成「我在哪」摘要"
                >
                  recap
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeHistory()
                    void forkSession()
                  }}
                  className="rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="x.ai/session/fork — 从当前会话派生新会话"
                >
                  fork
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeHistory()
                    const title = window.prompt('新会话标题：')
                    if (title && title.trim()) void renameSession(title.trim())
                  }}
                  className="rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="x.ai/session/rename"
                >
                  rename
                </button>
              </div>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gn-gutter">
                history · 点击继续对话
              </div>
              {sessions.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-gn-muted">没有历史会话</div>
              )}
              {sessions.map((s) => (
                <button
                  key={s.sessionId}
                  type="button"
                  disabled={historyLoading}
                  onClick={() => void continueSession(s.sessionId, s.cwd || '')}
                  className="block w-full px-3 py-2 text-left hover:bg-gn-bg-highlight disabled:opacity-50"
                  title="切换到此会话并继续对话"
                >
                  <div className="truncate text-[12px] text-gn-fg">
                    {s.title || s.sessionId.slice(0, 12)}
                  </div>
                  <div className="truncate font-mono text-[10px] text-gn-muted">
                    {s.updatedAt ? fmtTime(s.updatedAt) : ''}
                    {s.cwd ? ` · ${s.cwd}` : ''}
                  </div>
                </button>
              ))}
              {historyLoading && (
                <div className="px-3 py-2 text-[11px] text-gn-muted">加载中…</div>
              )}
            </div>
          </>
        )}
      </div>
    </header>
  )
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}
