import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import type { SessionInfo } from '../api/types'
import {
  absTime,
  fmtTime,
  groupAccentClass,
  groupByState,
  sanitizeTitle,
  sessionContextPct,
  sessionGroupKey,
} from './historyGroups'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { SessionStateIcon, stateLabel, useSessionSpinner } from './SessionStateIcon'

/** Two-stage delete window — TUI CONFIRM_WINDOW (2s). */
const CONFIRM_WINDOW_MS = 2000

/**
 * Desktop (lg+) history sidebar — persistent, grouped by live status
 * (处理中 / 待处理 / 空闲). Each status group is collapsible. The mobile
 * counterpart remains the top-bar dropdown. The list is fetched on mount
 * and kept fresh by the host's sessions_changed notifications.
 */
export function HistorySidebar() {
  const sessions = useChatStore((s) => s.sessions)
  const sessionId = useChatStore((s) => s.sessionId)
  const historyLoading = useChatStore((s) => s.historyLoading)
  const lastViewedAt = useChatStore((s) => s.lastViewedAt)
  const openedAt = useChatStore((s) => s.openedAt)
  const continueSession = useChatStore((s) => s.continueSession)
  const refreshSessions = useChatStore((s) => s.refreshSessions)
  const requestRecap = useChatStore((s) => s.requestRecap)
  const openSessionInfo = useChatStore((s) => s.openSessionInfo)
  const forkSession = useChatStore((s) => s.forkSession)
  const renameSession = useChatStore((s) => s.renameSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const compactSession = useChatStore((s) => s.compactSession)
  const openRewind = useChatStore((s) => s.openRewind)
  const groups = useMemo(
    () => groupByState(sessions, { currentSessionId: sessionId, lastViewedAt, openedAt }),
    [sessions, sessionId, lastViewedAt, openedAt],
  )

  /** Collapsed status groups — click header to toggle. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // ── inline rename (TUI Ctrl+R RenameDraft) ─────────────────────────
  // The wire rename API (POST /api/session-rename) only targets the
  // CURRENT session, so the row editor is offered on the active row.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const startRename = (s: SessionInfo) => {
    setRenamingId(s.sessionId)
    setRenameText(s.title ?? '')
    requestAnimationFrame(() => renameInputRef.current?.select())
  }
  const commitRename = async (s: SessionInfo) => {
    const title = sanitizeTitle(renameText).trim()
    setRenamingId(null)
    if (title && title !== (s.title ?? '')) {
      await renameSession(title)
      // Keep the list in sync even if the host sends no sessions_changed.
      void refreshSessions()
    }
  }
  const cancelRename = () => setRenamingId(null)

  // ── two-stage delete (TUI [✗] + CONFIRM_WINDOW) ────────────────────
  const [armedDelete, setArmedDelete] = useState<{ id: string; at: number } | null>(null)
  useEffect(() => {
    if (!armedDelete) return
    const t = window.setTimeout(
      () => setArmedDelete((cur) => (cur && cur.at === armedDelete.at ? null : cur)),
      CONFIRM_WINDOW_MS,
    )
    return () => window.clearTimeout(t)
  }, [armedDelete])
  const onDeleteClick = (e: React.MouseEvent, s: SessionInfo) => {
    e.stopPropagation()
    if (armedDelete?.id === s.sessionId && Date.now() - armedDelete.at < CONFIRM_WINDOW_MS) {
      setArmedDelete(null)
      void deleteSession(s.sessionId, s.cwd || '')
    } else {
      setArmedDelete({ id: s.sessionId, at: Date.now() })
    }
  }
  const deleteArmed = (id: string) =>
    armedDelete?.id === id && Date.now() - armedDelete.at < CONFIRM_WINDOW_MS

  // Shared braille spinner for any "active" rows (same cadence as busy).
  const anyActive = useMemo(
    () =>
      sessions.some((s) =>
        sessionGroupKey(s, { currentSessionId: sessionId, lastViewedAt, openedAt }) === 'active',
      ),
    [sessions, sessionId, lastViewedAt, openedAt],
  )
  const spinnerFrame = useSessionSpinner(anyActive)

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  return (
    <aside className="hidden w-72 shrink-0 flex-col bg-gn-bg-base lg:flex">
      {/* Session actions (x.ai ext methods). */}
      <div className="flex items-center gap-1 border-b border-gn-prompt-border px-2 py-1.5">
        <button
          type="button"
          onClick={() => void requestRecap()}
          className="rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          title="x.ai/recap — 生成「我在哪」摘要"
        >
          recap
        </button>
        <button
          type="button"
          onClick={() => void openSessionInfo()}
          className="rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          title="x.ai/session-info — 查看当前会话信息"
        >
          session-info
        </button>
        <button
          type="button"
          onClick={() => void forkSession()}
          className="rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          title="x.ai/session/fork — 从当前会话派生新会话"
        >
          fork
        </button>
        <button
          type="button"
          onClick={() => {
            const cur = sessions.find((s) => s.sessionId === sessionId)
            if (cur) startRename(cur)
          }}
          className="rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          title="x.ai/session/rename — 行内重命名当前会话（双击标题也可）"
        >
          rename
        </button>
        <button
          type="button"
          onClick={() => {
            const note = window.prompt('压缩说明（可留空）：')
            if (note !== null) void compactSession(note.trim() || undefined)
          }}
          className="rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          title="x.ai/session/compact — 压缩当前会话上下文"
        >
          compact
        </button>
        <button
          type="button"
          onClick={() => void openRewind()}
          className="rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          title="x.ai/session/rewind — 回退到历史检查点"
        >
          rewind
        </button>
      </div>

      <div className="gn-no-scrollbar flex-1 overflow-y-auto">
        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-gn-gutter">
          history · 点击继续对话
        </div>
        {groups.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-gn-muted">没有历史会话</div>
        )}
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key)
          return (
            <div key={g.key}>
              {/* Status group header — sticky, click to collapse/expand. */}
              <button
                type="button"
                onClick={() => toggleGroup(g.key)}
                className="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-base px-3 py-1 text-left hover:bg-gn-bg-highlight"
                title={isCollapsed ? `展开${g.label}会话` : `收起${g.label}会话`}
              >
                <span className="shrink-0 text-gn-gutter" aria-hidden>
                  <IconGlyph glyph={isCollapsed ? Glyphs.chevron : Glyphs.chevronDown} />
                </span>
                <span
                  className={`min-w-0 truncate text-[10.5px] font-medium tracking-wide ${groupAccentClass(g.key)}`}
                >
                  {g.label}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-gn-gutter">
                  {g.items.length}
                </span>
              </button>
              {!isCollapsed &&
                g.items.map((s) => {
                  const active = s.sessionId === sessionId
                  // Row icon follows its bucket: 处理中 spinner / 后台任务
                  // ◇ + bg badge / 待处理 blue diamond / 空闲 hollow ◇.
                  const key = sessionGroupKey(s, { currentSessionId: sessionId, lastViewedAt, openedAt })
                  const state = key === 'active' ? 'active' : 'idle'
                  const pending = key === 'awaiting'
                  const renaming = renamingId === s.sessionId
                  // TUI RowState::allows_delete — only settled rows may be
                  // deleted; Working / NeedsInput (处理中 bucket) and
                  // still-running bg tasks are locked.
                  const canDelete = key !== 'active' && (s.bgRunning ?? 0) <= 0
                  const contextPct = sessionContextPct(s)
                  return (
                    <div
                      key={s.sessionId}
                      role="button"
                      tabIndex={0}
                      aria-disabled={historyLoading}
                      onClick={() => {
                        if (!historyLoading) void continueSession(s.sessionId, s.cwd || '')
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          if (!historyLoading) void continueSession(s.sessionId, s.cwd || '')
                        }
                      }}
                      className={`group flex w-full cursor-pointer select-none items-center gap-2 px-3 py-2 text-left hover:bg-gn-bg-highlight ${historyLoading ? 'opacity-50' : ''} ${active ? 'bg-gn-bg-highlight' : ''}`}
                      title={`${s.title || s.sessionId.slice(0, 12)} · ${stateLabel(key)}${s.cwd ? ` · ${s.cwd}` : ''}`}
                    >
                      <SessionStateIcon
                        state={state}
                        pending={pending}
                        spinnerFrame={spinnerFrame}
                      />
                      <span className="min-w-0 flex-1">
                        {renaming ? (
                          <input
                            ref={renameInputRef}
                            value={renameText}
                            onChange={(e) => setRenameText(sanitizeTitle(e.target.value))}
                            onClick={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              e.stopPropagation()
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                void commitRename(s)
                              } else if (e.key === 'Escape') {
                                e.preventDefault()
                                cancelRename()
                              }
                            }}
                            onBlur={() => cancelRename()}
                            maxLength={100}
                            className="w-full rounded border border-gn-cyan/60 bg-gn-bg-dark px-1 py-0 text-[12px] text-gn-fg outline-none"
                            aria-label="重命名会话"
                          />
                        ) : (
                          <span className="flex min-w-0 items-center gap-1">
                            <span
                              className={`block min-w-0 flex-1 truncate text-[12px] ${active ? 'text-gn-cyan' : 'text-gn-fg'}`}
                              onDoubleClick={(e) => {
                                e.stopPropagation()
                                // Wire rename targets only the current session.
                                if (active && !historyLoading) startRename(s)
                              }}
                              title={active ? '双击重命名（Enter 保存，Esc 取消）' : undefined}
                            >
                              {s.title || s.sessionId.slice(0, 12)}
                            </span>
                            {active && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  startRename(s)
                                }}
                                className="shrink-0 rounded px-0.5 text-[10px] leading-none text-gn-gutter opacity-0 hover:text-gn-cyan group-hover:opacity-100"
                                title="重命名当前会话（Enter 保存，Esc 取消）"
                                aria-label="重命名当前会话"
                              >
                                ✎
                              </button>
                            )}
                          </span>
                        )}
                        <span
                          className="block truncate font-mono text-[10px] text-gn-muted"
                          title={s.updatedAt ? absTime(s.updatedAt) : undefined}
                        >
                          {s.updatedAt ? fmtTime(s.updatedAt) : ''}
                        </span>
                      </span>
                      {((s.bgRunning ?? 0) > 0) && (
                        <span
                          className="shrink-0 rounded border border-gn-gutter/70 px-1 font-mono text-[9px] leading-[13px] text-gn-muted"
                          title={`该会话有 ${s.bgRunning} 个仍在运行的后台任务（历史共 ${s.bgCount ?? 0} 个）`}
                        >
                          bg
                        </span>
                      )}
                      {active && (
                        <span className="shrink-0 text-[9px] text-gn-cyan">当前</span>
                      )}
                      {/* Context-window mini gauge (TUI context_pct), when the
                          session list carries contextUsed/contextSize. */}
                      {contextPct != null && (
                        <span
                          className="block h-[3px] w-10 shrink-0 overflow-hidden rounded-sm bg-gn-bg-highlight"
                          title={`上下文占用 ${contextPct}%`}
                          aria-label={`上下文占用 ${contextPct}%`}
                        >
                          <span
                            className={`block h-full ${contextPct > 90 ? 'bg-gn-red' : contextPct >= 70 ? 'bg-gn-yellow' : 'bg-gn-cyan'}`}
                            style={{ width: `${contextPct}%` }}
                          />
                        </span>
                      )}
                      {/* Row-hover delete (x.ai/session/delete — TUI /delete):
                          two-stage confirm inside CONFIRM_WINDOW (2s). */}
                      {canDelete ? (
                        <button
                          type="button"
                          onClick={(e) => onDeleteClick(e, s)}
                          className={`shrink-0 rounded px-1 text-[11px] leading-none ${
                            deleteArmed(s.sessionId)
                              ? 'bg-gn-diff-del-bg text-gn-red opacity-100'
                              : 'text-gn-red opacity-40 hover:bg-gn-diff-del-bg hover:opacity-100'
                          }`}
                          title={
                            deleteArmed(s.sessionId)
                              ? '再点一次确认删除（2 秒内）'
                              : '删除会话（/delete）'
                          }
                          aria-label={deleteArmed(s.sessionId) ? '确认删除会话' : '删除会话'}
                        >
                          {deleteArmed(s.sessionId) ? '确认？' : '✕'}
                        </button>
                      ) : (
                        <span
                          className="shrink-0 rounded px-1 text-[11px] leading-none text-gn-gutter opacity-30"
                          title="运行中会话不可删除"
                        >
                          ✕
                        </span>
                      )}
                    </div>
                  )
                })}
            </div>
          )
        })}
        {historyLoading && (
          <div className="px-3 py-2 text-[11px] text-gn-muted">加载中…</div>
        )}
      </div>
    </aside>
  )
}
