import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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

/** 组内默认显示的会话行数（超出折叠为"加载更多"）。 */
const WORKSPACE_ROWS_LIMIT = 4

/** 行操作菜单（右键 / ⋮）的估算尺寸，用于视口边界 clamp。 */
const ROW_MENU_W = 176
const ROW_MENU_H = 128

/** 点击"加载更多"每次追加的行数，循环直到组内会话全部显示。 */
const LOAD_MORE_STEP = 10

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
 * 历史会话列表 — 按工作区（cwd）分组的共享实现，桌面端持久侧边栏
 * （HistorySidebar）与移动端顶栏 history 下拉共用同一份数据与交互：
 * 分组折叠 / "加载更多"（每次 10 个） / 行内重命名 / 行操作菜单
 * （桌面右键、移动端 ⋮；打开 / 重命名 / 删除，删除走确认弹窗） /
 * 上下文进度条，保证两端永远一致。
 *
 * 数据由宿主 sessions_changed 通知 + 挂载时的 refresh 保持新鲜；本组件
 * 不负责拉取（HistorySidebar 挂载即全局拉一次）。
 */
export function SessionHistoryList() {  const sessions = useChatStore((s) => s.sessions)
  const workspaces = useChatStore((s) => s.workspaces)
  const workspaceLoading = useChatStore((s) => s.workspaceLoading)
  const sessionId = useChatStore((s) => s.sessionId)
  const cwd = useChatStore((s) => s.cwd)
  const historyLoading = useChatStore((s) => s.historyLoading)
  const continueSession = useChatStore((s) => s.continueSession)
  const renameSession = useChatStore((s) => s.renameSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const newSession = useChatStore((s) => s.newSession)
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

  /**
   * 组内已展开的行数（key = cwd）；初始显示最近 4 个，点击
   * "加载更多"每次追加 LOAD_MORE_STEP（10）个，循环直到全部显示。
   */
  const [visibleCount, setVisibleCount] = useState<ReadonlyMap<string, number>>(new Map())
  const expandMore = (key: string) => {
    setVisibleCount((prev) => {
      const next = new Map(prev)
      next.set(key, (prev.get(key) ?? WORKSPACE_ROWS_LIMIT) + LOAD_MORE_STEP)
      return next
    })
  }

  // ── inline rename (TUI Ctrl+R RenameDraft) ─────────────────────────
  // The wire rename API (POST /api/session-rename) only targets the
  // CURRENT session, so the row editor is offered on the active row.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const startRename = (s: { sessionId: string; title?: string }) => {
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
      const refreshSessions = useChatStore.getState().refreshSessions
      const refreshWorkspaces = useChatStore.getState().refreshWorkspaces
      void refreshSessions()
      void refreshWorkspaces()
    }
  }
  const cancelRename = () => setRenamingId(null)

  // ── row / group action menu (desktop right-click / mobile ⋮) ───────
  // One shared floating menu with two targets:
  //  - row   : 打开会话 / 重命名(仅当前) / 删除(非运行中，含当前会话 —
  //            删当前会话落到空状态)；删除走确认弹窗。
  //  - group : 右键工作区分组头 → "在此目录新建会话"。
  type MenuState =
    | { kind: 'row'; row: MergedRow; x: number; y: number }
    | { kind: 'group'; cwd: string; x: number; y: number }
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<MergedRow | null>(null)
  const closeMenu = () => setMenu(null)
  const openMenu = (
    m: { kind: 'row'; row: MergedRow } | { kind: 'group'; cwd: string },
    x: number,
    y: number,
  ) => {
    const pos = {
      x: Math.max(8, Math.min(x, window.innerWidth - ROW_MENU_W - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - ROW_MENU_H - 8)),
    }
    setMenu(
      m.kind === 'row'
        ? { kind: 'row', row: m.row, ...pos }
        : { kind: 'group', cwd: m.cwd, ...pos },
    )
  }
  // Esc closes the menu; scrolling the list while the menu floats over a
  // row would strand it on the wrong row, so any scroll dismisses it too.
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', closeMenu, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', closeMenu, true)
    }
  }, [menu])
  // Esc also closes the delete-confirm dialog.
  useEffect(() => {
    if (!deleteTarget) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDeleteTarget(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteTarget])
  const confirmDelete = () => {
    if (!deleteTarget) return
    const { sessionId, cwd } = deleteTarget
    setDeleteTarget(null)
    void deleteSession(sessionId, cwd || '')
  }

  // Shared braille spinner for any "active" rows (same cadence as busy).
  const anyActive = useMemo(
    () =>
      groups.some((g) =>
        g.sessions.some((s) => sessionGroupKey(s, sessionId) === 'active'),
      ),
    [groups, sessionId],
  )
  const spinnerFrame = useSessionSpinner(anyActive)

  return (
    <>
      {groups.length === 0 && !workspaceLoading && (
        <div className="px-3 py-2 text-[11px] text-gn-muted">没有历史会话</div>
      )}
      {groups.map((g) => {
        const isCollapsed = isGroupCollapsed(g.cwd)
        const shown = visibleCount.get(g.cwd) ?? WORKSPACE_ROWS_LIMIT
        const rows = g.sessions.slice(0, shown)
        return (
          <div key={g.cwd} className="relative">
            {/* Workspace group header — sticky opaque bar so list rows
                scroll under it cleanly (no bleed-through). Wrapper owns
                sticky + solid fill; button only handles interaction. */}
            <div
              className="sticky top-0 z-20 flex items-center border-b border-gn-prompt-border bg-gn-bg-base"
              style={{ backgroundColor: 'var(--color-gn-bg-base)' }}
            >
              <button
                type="button"
                onClick={() => toggleGroup(g.cwd)}
                onContextMenu={(e) => {
                  // Right-click a workspace group → "新建会话在此目录".
                  e.preventDefault()
                  e.stopPropagation()
                  openMenu({ kind: 'group', cwd: g.cwd }, e.clientX, e.clientY)
                }}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-1 text-left hover:bg-gn-bg-highlight"
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
              {/* Mobile/touch group actions — ⋮ opens the same menu desktop
                  right-click shows (lg+ relies on onContextMenu; no long-press). */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  const r = e.currentTarget.getBoundingClientRect()
                  openMenu({ kind: 'group', cwd: g.cwd }, r.right - ROW_MENU_W, r.bottom + 4)
                }}
                className="mr-3 shrink-0 px-1.5 py-1 text-[13px] leading-none text-gn-muted hover:text-gn-fg lg:hidden"
                title="更多操作"
                aria-label="更多操作"
              >
                ⋮
              </button>
            </div>
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
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        openMenu({ kind: 'row', row: s }, e.clientX, e.clientY)
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
                      {/* Row action trigger — mobile/touch: ⋮ opens the same
                          menu desktop right-click shows (lg+ rows rely on
                          onContextMenu, so the trigger hides there). */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          const r = e.currentTarget.getBoundingClientRect()
                          openMenu({ kind: 'row', row: s }, r.right - ROW_MENU_W, r.bottom + 4)
                        }}
                        className="shrink-0 rounded px-1 text-[13px] leading-none text-gn-muted hover:text-gn-fg lg:hidden"
                        title="更多操作"
                        aria-label="更多操作"
                      >
                        ⋮
                      </button>
                    </div>
                  )
                })}
                {g.sessions.length > shown && (
                  <button
                    type="button"
                    onClick={() => expandMore(g.cwd)}
                    className="flex w-full cursor-pointer items-center justify-center gap-2 px-3 py-1 text-center text-[10.5px] text-gn-cyan hover:bg-gn-bg-highlight"
                    title={`再加载 ${Math.min(LOAD_MORE_STEP, g.sessions.length - shown)} 个会话`}
                  >
                    加载更多 {Math.min(LOAD_MORE_STEP, g.sessions.length - shown)} 个
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

      {/* ── row action menu (portaled; desktop right-click / mobile ⋮) ── */}
      {/* ── row / group action menu (portaled; right-click / mobile ⋮) ── */}
      {menu &&
        createPortal(
          <div
            className="fixed inset-0 z-50"
            onMouseDown={(e) => {
              e.stopPropagation()
              closeMenu()
            }}
          >
            <div
              className="absolute w-[176px] overflow-hidden rounded border border-gn-prompt-border bg-gn-bg-dark py-0.5 shadow-xl"
              style={{ left: menu.x, top: menu.y }}
              onMouseDown={(e) => e.stopPropagation()}
              role="menu"
              aria-label="会话操作"
            >
              {menu.kind === 'row' ? (
                <>
                  <MenuItem
                    disabled={menu.row.sessionId === sessionId}
                    disabledTitle="当前会话"
                    onClick={() => {
                      void continueSession(menu.row.sessionId, menu.row.cwd || '')
                      closeMenu()
                    }}
                  >
                    <span aria-hidden className="inline-block w-4 shrink-0 text-center">›</span> 打开会话
                  </MenuItem>
                  <MenuItem
                    disabled={menu.row.sessionId !== sessionId}
                    disabledTitle="重命名仅支持当前会话"
                    onClick={() => {
                      startRename(menu.row)
                      closeMenu()
                    }}
                  >
                    <span aria-hidden className="inline-block w-4 shrink-0 text-center">✎</span> 重命名
                  </MenuItem>
                  <div className="my-0.5 border-t border-gn-prompt-border/60" />
                  <MenuItem
                    danger
                    disabled={
                      sessionGroupKey(menu.row, sessionId) === 'active' ||
                      (menu.row.bgRunning ?? 0) > 0
                    }
                    disabledTitle="运行中会话不可删除"
                    onClick={() => {
                      setDeleteTarget(menu.row)
                      closeMenu()
                    }}
                  >
                    <span aria-hidden className="inline-block w-4 shrink-0 text-center">✕</span> 删除
                  </MenuItem>
                </>
              ) : (
                <MenuItem
                  onClick={() => {
                    void newSession(menu.cwd)
                    closeMenu()
                  }}
                >
                  <span aria-hidden className="inline-block w-4 shrink-0 text-center">＋</span> 在此目录新建会话
                </MenuItem>
              )}
            </div>
          </div>,
          document.body,
        )}

      {/* ── delete confirmation dialog ─────────────────────────────── */}
      {deleteTarget &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setDeleteTarget(null)
            }}
          >
            <div
              className="w-full max-w-[360px] rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl"
              role="dialog"
              aria-modal="true"
              aria-label="删除会话"
            >
              <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
                <span className="text-gn-red" aria-hidden>
                  ✕
                </span>
                <span className="text-[13px] font-bold text-gn-fg">删除会话</span>
                <span className="ml-auto text-[11px] text-gn-muted">esc 关闭</span>
              </header>
              <div className="px-4 py-3 text-[12.5px] leading-relaxed text-gn-fg2">
                确定删除会话
                <span className="mx-1 font-semibold text-gn-fg">
                  「{deleteTarget.title || deleteTarget.sessionId.slice(0, 12)}」
                </span>
                ？删除后不可恢复。
              </div>
              <footer className="flex justify-end gap-2 rounded-b border-t border-gn-prompt-border px-4 py-2.5">
                <button
                  type="button"
                  onClick={() => setDeleteTarget(null)}
                  className="min-h-8 rounded border border-gn-prompt-border bg-gn-bg-base px-3 py-1 text-[12px] text-gn-fg2 hover:bg-gn-bg-highlight"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={confirmDelete}
                  className="min-h-8 rounded border border-gn-red/50 bg-gn-diff-del-bg px-3 py-1 text-[12px] font-semibold text-gn-red hover:bg-gn-red/15"
                >
                  删除
                </button>
              </footer>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

/** 行操作菜单的单个菜单项（禁用态灰色 + tooltip，danger 红色）。 */
function MenuItem({
  onClick,
  disabled,
  disabledTitle,
  danger,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  disabledTitle?: string
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={disabled ? disabledTitle : undefined}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${
        disabled
          ? 'cursor-not-allowed text-gn-gutter opacity-50'
          : danger
            ? 'text-gn-red hover:bg-gn-diff-del-bg'
            : 'text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg'
      }`}
    >
      {children}
    </button>
  )
}

