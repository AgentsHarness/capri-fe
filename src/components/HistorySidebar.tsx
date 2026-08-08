import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import type { SessionInfo, WorkspaceSummary } from '../api/types'
import {
  absTime,
  fmtTime,
  groupWorkspaces,
  repoNameFromCwd,
  sanitizeTitle,
  sessionContextPct,
  sessionGroupKey,
  sessionSubtitle,
} from './historyGroups'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { SessionStateIcon } from './SessionStateIcon'
import { stateLabel, useSessionSpinner } from './sessionState'

/** Two-stage delete window — TUI CONFIRM_WINDOW (2s). */
const CONFIRM_WINDOW_MS = 2000

/** 组内默认显示的会话行数（超出折叠为"加载更多 N 个"）。 */
const WORKSPACE_ROWS_LIMIT = 4

/** 工作区活跃窗口：最新活动在 6 小时内的默认展开，超过默认收起。 */
const WORKSPACE_ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000

/**
 * Workspace summary 行 merge 上 /api/sessions 的 live 状态（status /
 * bgRunning / bgCount / hasTasks / contextUsed / contextSize）——字段
 * 与 SessionInfo 兼容，可复用 sessionGroupKey / sessionContextPct。
 */
type MergedRow = WorkspaceSummary & {
  status?: SessionInfo['status']
  bgRunning?: number
  bgCount?: number
  hasTasks?: boolean
  contextUsed?: number
  contextSize?: number
}

/** 工作区组：行已 merge 上 live 状态（MergedRow 兼容 SessionInfo）。 */
type MergedGroup = {
  cwd: string
  label: string
  sessions: MergedRow[]
}

/** 组内排序：updatedAt 降序，无 updatedAt 排最后。 */
function byUpdatedDesc(a: WorkspaceSummary, b: WorkspaceSummary): number {
  if (!a.updatedAt && !b.updatedAt) return a.sessionId.localeCompare(b.sessionId)
  if (!a.updatedAt) return 1
  if (!b.updatedAt) return -1
  return b.updatedAt.localeCompare(a.updatedAt)
}

/**
 * Desktop (lg+) history sidebar — persistent, grouped by workspace
 * (cwd). Each workspace group is collapsible, shows the newest 4
 * sessions by default and expands via "加载更多 N 个". Live per-session
 * state (处理中 / 后台任务 / 待处理 / 空闲) is merged onto each row from
 * the /api/sessions list. The mobile counterpart remains the top-bar
 * dropdown. The list is fetched on mount and kept fresh by the host's
 * sessions_changed notifications.
 */
export function HistorySidebar() {
  const sessions = useChatStore((s) => s.sessions)
  const workspaces = useChatStore((s) => s.workspaces)
  const workspaceLoading = useChatStore((s) => s.workspaceLoading)
  const sessionId = useChatStore((s) => s.sessionId)
  const cwd = useChatStore((s) => s.cwd)
  const historyLoading = useChatStore((s) => s.historyLoading)
  const continueSession = useChatStore((s) => s.continueSession)
  const refreshSessions = useChatStore((s) => s.refreshSessions)
  const refreshWorkspaces = useChatStore((s) => s.refreshWorkspaces)
  const renameSession = useChatStore((s) => s.renameSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const completedNotices = useChatStore((s) => s.completedNotices)

  /**
   * 按 sessionId 把 live 状态覆盖到 workspace 摘要行上；当前会话的
   * cwd 不在列表里时用 sessions 中该 cwd 的会话补一组；最后按
   * groupWorkspaces 排序（当前工作区 pin 最前）。
   */
  const groups = useMemo((): MergedGroup[] => {
    const liveById = new Map<string, SessionInfo>()
    for (const s of sessions) liveById.set(s.sessionId, s)
    const toRow = (row: WorkspaceSummary): MergedRow => {
      const live = liveById.get(row.sessionId)
      if (!live) return row
      const ctx = live as SessionInfo & { contextUsed?: number; contextSize?: number }
      return {
        ...row,
        status: live.status,
        bgRunning: live.bgRunning,
        bgCount: live.bgCount,
        hasTasks: live.hasTasks,
        contextUsed: ctx.contextUsed,
        contextSize: ctx.contextSize,
      }
    }
    const merged: MergedGroup[] = workspaces.map((g) => ({
      ...g,
      sessions: g.sessions.map(toRow).sort(byUpdatedDesc),
    }))
    // 兜底：当前会话的 cwd 不在 workspace-list 里时，用 live sessions
    // 中该 cwd 的会话补一个组（groupWorkspaces 会把它 pin 到最前）。
    if (cwd && !merged.some((g) => g.cwd === cwd)) {
      const rows = sessions
        .filter((s) => s.cwd === cwd)
        .map((s) =>
          toRow({
            sessionId: s.sessionId,
            cwd: s.cwd ?? cwd,
            title: s.title,
            updatedAt: s.updatedAt,
          }),
        )
      if (rows.length > 0) {
        merged.push({ cwd, label: repoNameFromCwd(cwd), sessions: rows })
      }
    }
    return groupWorkspaces(merged)
  }, [workspaces, sessions, cwd])

  /**
   * 默认收起判定：工作区最新活动（组内 max updatedAt）超过 6 小时 → 收起。
   * collapsed 为 null 表示用户尚未手动操作过，此时用 defaultCollapsed；
   * 一旦用户点击过任意组头，collapsed 变成完整快照，之后完全由用户控制
   * （刷新不重置手动状态）。
   */
  const defaultCollapsed = useMemo(() => {
    const map = new Map<string, boolean>()
    const now = Date.now()
    for (const g of groups) {
      let latest = 0
      for (const s of g.sessions) {
        if (!s.updatedAt) continue
        const t = Date.parse(s.updatedAt)
        if (Number.isFinite(t) && t > latest) latest = t
      }
      // 无时间戳视为不活跃 → 默认收起。
      map.set(g.cwd, now - latest > WORKSPACE_ACTIVE_WINDOW_MS)
    }
    return map
  }, [groups])

  /**
   * 手动折叠状态：Map<cwd, 是否收起>，只记录用户明确操作过的组；
   * 未操作过的组始终回退到 defaultCollapsed（6 小时活跃窗口）。
   * 不能用"Set 快照 + 取反"（一旦点击任意组，空快照会让所有默认
   * 收起的组同时展开），必须逐组记录最终状态。
   */
  const [collapsed, setCollapsed] = useState<ReadonlyMap<string, boolean> | null>(null)
  const isGroupCollapsed = (key: string) =>
    collapsed?.get(key) ?? defaultCollapsed.get(key) ?? false
  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const cur = prev?.get(key) ?? defaultCollapsed.get(key) ?? false
      const next = new Map(prev ?? [])
      next.set(key, !cur)
      return next
    })
  }

  /** 展开全部会话行的工作区（key = cwd）；默认每组只显示最近 4 个。 */
  const [expandedCwd, setExpandedCwd] = useState<ReadonlySet<string>>(new Set())
  const toggleExpand = (key: string) => {
    setExpandedCwd((prev) => {
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
  const startRename = (s: MergedRow) => {
    setRenamingId(s.sessionId)
    setRenameText(s.title ?? '')
    requestAnimationFrame(() => renameInputRef.current?.select())
  }
  const commitRename = async (s: MergedRow) => {
    const title = sanitizeTitle(renameText).trim()
    setRenamingId(null)
    if (title && title !== (s.title ?? '')) {
      await renameSession(title)
      // Keep the list in sync even if the host sends no sessions_changed.
      void refreshSessions()
      void refreshWorkspaces()
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
  const onDeleteClick = (e: React.MouseEvent, s: MergedRow) => {
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
      groups.some((g) =>
        g.sessions.some((s) => sessionGroupKey(s, sessionId) === 'active'),
      ),
    [groups, sessionId],
  )
  const spinnerFrame = useSessionSpinner(anyActive)

  useEffect(() => {
    void refreshSessions()
    void refreshWorkspaces()
  }, [refreshSessions, refreshWorkspaces])

  return (
    <aside className="hidden w-72 shrink-0 flex-col bg-gn-bg-base lg:flex">
      <div className="gn-no-scrollbar flex-1 overflow-y-auto">
        {groups.length === 0 && !workspaceLoading && (
          <div className="px-3 py-2 text-[11px] text-gn-muted">没有历史会话</div>
        )}
        {groups.map((g) => {
          const isCollapsed = isGroupCollapsed(g.cwd)
          const expanded = expandedCwd.has(g.cwd)
          const rows = expanded ? g.sessions : g.sessions.slice(0, WORKSPACE_ROWS_LIMIT)
          return (
            <div key={g.cwd}>
              {/* Workspace group header — sticky, click to collapse/expand. */}
              <button
                type="button"
                onClick={() => toggleGroup(g.cwd)}
                className="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-base px-3 py-1 text-left hover:bg-gn-bg-highlight"
                title={g.cwd}
              >
                <span className="shrink-0 text-gn-gutter" aria-hidden>
                  <IconGlyph glyph={isCollapsed ? Glyphs.chevron : Glyphs.chevronDown} />
                </span>
                <span className="min-w-0 truncate text-[10.5px] font-medium tracking-wide text-gn-fg">
                  {repoNameFromCwd(g.cwd)}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-gn-gutter">
                  {g.sessions.length}
                </span>
              </button>
              {!isCollapsed && (
                <>
                  {rows.map((s) => {
                    const active = s.sessionId === sessionId
                    // Row icon follows live state: 处理中 spinner / 后台任务
                    // ◇ + bg badge / 待处理 blue diamond / 空闲 hollow ◇.
                    const key = sessionGroupKey(s, sessionId)
                    const state = key === 'active' ? 'active' : 'idle'
                    const pending = key === 'awaiting'
                    const subtitle = sessionSubtitle(s)
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
                        {completedNotices[s.sessionId] != null ? (
                          // 完成提醒替换状态图标：✓ 取代菱形/spinner
                          // （该会话跑完待查看，状态本身已无新意）。
                          <span
                            className="inline-flex w-[1.25em] shrink-0 items-center justify-center font-mono text-[12px] leading-none text-gn-green"
                            title="该会话已完成，等待查看"
                            aria-label="已完成待查看"
                          >
                            ✓
                          </span>
                        ) : (
                          <SessionStateIcon
                            state={state}
                            pending={pending}
                            spinnerFrame={spinnerFrame}
                          />
                        )}
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
                            {subtitle ? `${subtitle} · ` : ''}
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
                  {g.sessions.length > WORKSPACE_ROWS_LIMIT && (
                    <button
                      type="button"
                      onClick={() => toggleExpand(g.cwd)}
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left text-[10.5px] text-gn-cyan hover:bg-gn-bg-highlight"
                      title={
                        expanded
                          ? '收起全部会话'
                          : `展开该工作区的其余 ${g.sessions.length - WORKSPACE_ROWS_LIMIT} 个会话`
                      }
                    >
                      {expanded
                        ? '收起'
                        : `加载更多 ${g.sessions.length - WORKSPACE_ROWS_LIMIT} 个`}
                    </button>
                  )}
                </>
              )}
            </div>
          )
        })}
        {workspaceLoading && (
          <div className="px-3 py-2 text-[11px] text-gn-muted">加载中…</div>
        )}
      </div>
    </aside>
  )
}
