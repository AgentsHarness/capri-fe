import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, Circle, CircleCheck, CircleOff, Pencil, Pin, Plus, Trash2 } from 'lucide-react'
import { useChatStore } from '../store/chat'
import type { SessionInfo, WorkspaceSummary } from '../api/types'
import {
  groupWorkspaces,
  repoNameFromCwd,
  sanitizeTitle,
  sessionContextPct,
  sessionGroupKey,
} from '../store/historyGroups'
import { Glyphs, SPINNER_FRAMES } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { SessionStateIcon } from './SessionStateIcon'
import { stateLabel, useSessionSpinner } from '../hooks/sessionState'
import {
  sortSessionsWithPins,
  sortWorkspacesWithPins,
  usePins,
} from '../store/historyPins'
import { useHistoryView } from '../store/historyView'

/** 组内默认显示的普通会话行数（置顶/待办不占名额，超出折叠为"加载更多"）。 */
const WORKSPACE_ROWS_LIMIT = 4

/** 行操作菜单（右键 / ⋮）的估算尺寸，用于视口边界 clamp。 */
const ROW_MENU_W = 176
const ROW_MENU_H = 240

/** 点击"加载更多"每次追加的行数，循环直到组内会话全部显示；
 *  展开超过默认基准（WORKSPACE_ROWS_LIMIT + 置顶/待办数）后出现
 *  "收起"，点击回到默认基准。 */
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

/**
 * 列表分区（两种展示形态共用渲染）：
 * - workspace：按 cwd 分组，key = cwd
 * - marked：按标记类型分组（置顶 / 待办），key = 类型
 */
type ListSection = {
  key: string
  label: string
  sessions: MergedRow[]
  /** 仅 workspace 形态：工作目录全路径（组菜单「新建会话」/ 置顶目录）。 */
  cwd?: string
  kind: 'workspace' | 'pinned' | 'todo'
}

/** 组内排序最终 tiebreak：updatedAt 降序，无 updatedAt 排最后。 */
function byUpdatedDesc(a: WorkspaceSummary, b: WorkspaceSummary): number {
  if (!a.updatedAt && !b.updatedAt) return a.sessionId.localeCompare(b.sessionId)
  if (!a.updatedAt) return 1
  if (!b.updatedAt) return -1
  return b.updatedAt.localeCompare(a.updatedAt)
}

/** live SessionInfo → 摘要行（workspace-list 缺该会话时的兜底）。 */
function liveToRow(s: SessionInfo, fallbackCwd = ''): MergedRow {
  const ctx = s as SessionInfo & { contextUsed?: number; contextSize?: number }
  return {
    sessionId: s.sessionId,
    cwd: s.cwd ?? fallbackCwd,
    title: s.title,
    updatedAt: s.updatedAt,
    status: s.status,
    bgRunning: s.bgRunning,
    bgCount: s.bgCount,
    hasTasks: s.hasTasks,
    contextUsed: ctx.contextUsed,
    contextSize: ctx.contextSize,
  }
}

/**
 * 历史会话列表 — 两种展示形态共用：
 * 1. workspace：按工作区（cwd）分组（桌面侧边栏 / 移动端 history 下拉）
 * 2. marked：只显示用户标记的会话（置顶 / 待办）
 *
 * 交互：分组折叠 / "加载更多"+"收起" / 行内重命名 / 行操作菜单
 * （桌面右键、移动端 ⋮）/ 上下文进度条。数据由宿主 sessions_changed
 * + 挂载 refresh 保持新鲜（本组件不负责拉取）。
 */
export function SessionHistoryList() {
  const sessions = useChatStore((s) => s.sessions)
  const workspaces = useChatStore((s) => s.workspaces)
  const workspaceLoading = useChatStore((s) => s.workspaceLoading)
  const workspaceRecentLoadingMore = useChatStore((s) => s.workspaceRecentLoadingMore)
  const workspaceRecentHasMore = useChatStore((s) => s.workspaceRecentHasMore)
  const workspaceListMode = useChatStore((s) => s.workspaceListMode)
  const workspaceLoadMore = useChatStore((s) => s.workspaceLoadMore)
  const switchWorkspaceListMode = useChatStore((s) => s.switchWorkspaceListMode)
  const sessionId = useChatStore((s) => s.sessionId)
  const cwd = useChatStore((s) => s.cwd)
  const historyLoading = useChatStore((s) => s.historyLoading)
  const continueSession = useChatStore((s) => s.continueSession)
  const renameSession = useChatStore((s) => s.renameSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const newSession = useChatStore((s) => s.newSession)
  const completedNotices = useChatStore((s) => s.completedNotices)
  // 浏览器本地置顶偏好（工作目录 / 会话），见 historyPins.ts。
  const pinnedWorkspaces = usePins((s) => s.pinnedWorkspaces)
  const pinnedSessions = usePins((s) => s.pinnedSessions)
  const todos = usePins((s) => s.todos)
  const toggleWorkspacePin = usePins((s) => s.toggleWorkspacePin)
  const toggleSessionPin = usePins((s) => s.toggleSessionPin)
  const setTodoStatus = usePins((s) => s.setTodoStatus)
  // 展示形态：工作区分组 vs 仅标记任务（见 historyView.ts）。
  const listMode = useHistoryView((s) => s.mode)

  /**
   * 把 live 状态 merge 到摘要行上（workspace-list + sessions 双源）。
   */
  const toRow = useMemo(() => {
    const liveById = new Map<string, SessionInfo>()
    for (const s of sessions) liveById.set(s.sessionId, s)
    return (row: WorkspaceSummary): MergedRow => {
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
  }, [sessions])

  /**
   * 工作区形态：按 sessionId 把 live 状态覆盖到 workspace 摘要行上；
   * 当前会话的 cwd 不在列表里时用 sessions 补一组；最后按
   * groupWorkspaces 排序（置顶工作区最前）。
   */
  const workspaceGroups = useMemo((): MergedGroup[] => {
    const merged: MergedGroup[] = workspaces.map((g) => ({
      ...g,
      // 组内排序：置顶的会话永远最前，随后是待办（未完成），其余按
      // 状态优先级（待处理 → 对勾 → 运行中+后台 → 运行中 → 后台运行 →
      // 空闲），同状态再按 updatedAt 降序。
      sessions: sortSessionsWithPins(
        g.sessions.map(toRow),
        pinnedSessions,
        completedNotices,
        byUpdatedDesc,
        todos,
      ),
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
        merged.push({
          cwd,
          label: repoNameFromCwd(cwd),
          sessions: sortSessionsWithPins(
            rows,
            pinnedSessions,
            completedNotices,
            byUpdatedDesc,
            todos,
          ),
        })
      }
    }
    // 置顶的工作目录永远在最前（内部仍按 groupWorkspaces 活跃度排序）。
    return sortWorkspacesWithPins(groupWorkspaces(merged), pinnedWorkspaces)
  }, [workspaces, sessions, cwd, pinnedWorkspaces, pinnedSessions, completedNotices, todos, toRow])

  /**
   * 标记形态：扁平索引全部已知会话（workspace 摘要 ∪ live roster），
   * 只保留置顶 / 待办（不含已完成）；同一会话只出现一次，优先级
   * 置顶 > 待办（置顶行仍可显示待办徽标）。
   */
  const markedSections = useMemo((): ListSection[] => {
    const byId = new Map<string, MergedRow>()
    for (const g of workspaces) {
      for (const row of g.sessions) {
        byId.set(row.sessionId, toRow(row))
      }
    }
    for (const s of sessions) {
      if (!byId.has(s.sessionId)) byId.set(s.sessionId, liveToRow(s))
    }

    const pinned: MergedRow[] = []
    const todo: MergedRow[] = []

    // 以标记集合为驱动：即使摘要列表尚未返回该会话，只要 live 有也能显示。
    // 已完成的待办不进标记列表（右键仍可改回待办 / 取消）。
    const candidateIds = new Set<string>([
      ...pinnedSessions,
      ...Object.keys(todos).filter((id) => todos[id] === 'todo'),
    ])
    for (const id of candidateIds) {
      const row = byId.get(id)
      if (!row) continue
      if (pinnedSessions.has(id)) {
        pinned.push(row)
        continue
      }
      if (todos[id] === 'todo') todo.push(row)
    }

    const sortMarked = (rows: MergedRow[]) =>
      sortSessionsWithPins(rows, pinnedSessions, completedNotices, byUpdatedDesc, todos)

    const sections: ListSection[] = []
    if (pinned.length > 0) {
      sections.push({
        key: 'marked:pinned',
        label: '置顶',
        kind: 'pinned',
        sessions: sortMarked(pinned),
      })
    }
    if (todo.length > 0) {
      sections.push({
        key: 'marked:todo',
        label: '待办',
        kind: 'todo',
        sessions: sortMarked(todo),
      })
    }
    return sections
  }, [workspaces, sessions, pinnedSessions, todos, completedNotices, toRow])

  /** 当前形态下的分区列表（统一渲染入口）。 */
  const sections = useMemo((): ListSection[] => {
    if (listMode === 'marked') return markedSections
    return workspaceGroups.map((g) => ({
      key: g.cwd,
      label: repoNameFromCwd(g.cwd),
      cwd: g.cwd,
      kind: 'workspace' as const,
      sessions: g.sessions,
    }))
  }, [listMode, markedSections, workspaceGroups])

  /**
   * 默认收起判定：
   * - workspace：组内 max updatedAt 超过 6 小时 → 收起
   * - marked：各分区默认展开（标记本就少，一屏能看完）
   */
  const defaultCollapsed = useMemo(() => {
    const map = new Map<string, boolean>()
    if (listMode === 'marked') {
      for (const s of sections) map.set(s.key, false)
      return map
    }
    const now = Date.now()
    for (const g of sections) {
      let latest = 0
      for (const s of g.sessions) {
        if (!s.updatedAt) continue
        const t = Date.parse(s.updatedAt)
        if (Number.isFinite(t) && t > latest) latest = t
      }
      // 无时间戳视为不活跃 → 默认收起。
      map.set(g.key, now - latest > WORKSPACE_ACTIVE_WINDOW_MS)
    }
    return map
  }, [sections, listMode])

  /**
   * 手动折叠状态：Map<sectionKey, 是否收起>，只记录用户明确操作过的组；
   * 未操作过的组始终回退到 defaultCollapsed。
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
   * 组内默认展开的行数：置顶 / 待办（未完成）会话不占普通名额——
   * 被标记的会话始终全部可见，普通会话仍默认展示 WORKSPACE_ROWS_LIMIT
   * 个。标记形态（marked）的分组本身就只含被标记的会话，直接全展示。
   */
  const defaultShownCount = (g: ListSection): number => {
    if (g.kind !== 'workspace') return g.sessions.length
    const pinnedOrTodo = g.sessions.filter(
      (s) => pinnedSessions.has(s.sessionId) || todos[s.sessionId] === 'todo',
    ).length
    return WORKSPACE_ROWS_LIMIT + pinnedOrTodo
  }
  const sectionByKey = (key: string): ListSection | undefined =>
    sections.find((s) => s.key === key)

  /**
   * 组内已展开的行数（key = sectionKey）；初始显示最近
   * WORKSPACE_ROWS_LIMIT 个普通会话（置顶/待办额外全显），点击
   * "加载更多"每次追加 LOAD_MORE_STEP（10）个，循环直到全部显示；
   * 一旦超过默认基准，"收起"即出现（与"加载更多"并排），
   * 点击回到 defaultShownCount，无需等全部加载完。
   */
  const [visibleCount, setVisibleCount] = useState<ReadonlyMap<string, number>>(new Map())
  const expandMore = (key: string) => {
    const base = sectionByKey(key)
      ? defaultShownCount(sectionByKey(key)!)
      : WORKSPACE_ROWS_LIMIT
    setVisibleCount((prev) => {
      const next = new Map(prev)
      next.set(key, (prev.get(key) ?? base) + LOAD_MORE_STEP)
      return next
    })
  }
  const collapseMore = (key: string) => {
    const base = sectionByKey(key)
      ? defaultShownCount(sectionByKey(key)!)
      : WORKSPACE_ROWS_LIMIT
    setVisibleCount((prev) => {
      const next = new Map(prev)
      next.set(key, base)
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
  // row would strand it on the wrong row, so the list scrolling dismisses
  // it too. Scoped to the LIST only: the main scrollback auto-scrolls
  // during streaming output (scrollTop writes as content grows), and that
  // must not close the menu — the scroll container is an ancestor of the
  // list root, inner scrollables are descendants; anything else is ignored.
  const listRootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu()
    }
    const onScroll = (e: Event) => {
      const list = listRootRef.current
      if (list && e.target instanceof Node) {
        const t = e.target
        const related = t === list || list.contains(t) || t.contains(list)
        if (!related) return
      }
      closeMenu()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
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
      sections.some((g) =>
        g.sessions.some((s) => sessionGroupKey(s, sessionId) === 'active'),
      ),
    [sections, sessionId],
  )
  // 空列表且正在拉取：中央显示与 scrollback 一致的加载态（唯一加载
  // 指示；旧数据仍在时列表直接保留，刷新无提示）。标记形态下 sections
  // 空是正常的空态（置顶/待办本就少），不显示"加载会话…"。
  const centeredLoading =
    listMode === 'workspace' && sections.length === 0 && workspaceLoading
  const spinnerFrame = useSessionSpinner(
    anyActive || centeredLoading || workspaceRecentLoadingMore,
  )

  // 标记形态空态：未加载中且没有可显示的标记会话。
  const markedEmpty =
    listMode === 'marked' && sections.length === 0 && !workspaceLoading
  // 工作区形态空态。
  const workspaceEmpty =
    listMode === 'workspace' && sections.length === 0 && !workspaceLoading

  return (
    <div ref={listRootRef} className="relative min-h-full">
      {workspaceEmpty && (
        <div className="px-3 py-2 text-[11px] text-gn-muted">没有历史会话</div>
      )}
      {markedEmpty && (
        <div className="px-3 py-2 text-[11px] leading-relaxed text-gn-muted">
          没有标记的会话
          <span className="mt-0.5 block text-[10px] text-gn-gutter">
            右键会话可置顶或设为待办
          </span>
        </div>
      )}
      {sections.map((g) => {
        const isCollapsed = isGroupCollapsed(g.key)
        const defaultShown = defaultShownCount(g)
        const shown = visibleCount.get(g.key) ?? defaultShown
        const rows = g.sessions.slice(0, shown)
        const isWorkspace = g.kind === 'workspace'
        const sectionAccent =
          g.kind === 'pinned' || g.kind === 'todo' ? 'text-gn-yellow' : 'text-gn-fg'
        return (
          <div key={g.key} className="relative">
            {/* Group header — sticky opaque bar so list rows scroll under
                it cleanly (no bleed-through). Wrapper owns sticky + solid
                fill; button only handles interaction. */}
            <div
              className="sticky top-0 z-20 flex items-center border-b border-gn-prompt-border bg-gn-bg-base"
              style={{ backgroundColor: 'var(--color-gn-bg-base)' }}
            >
              <button
                type="button"
                onClick={() => toggleGroup(g.key)}
                onContextMenu={(e) => {
                  // Right-click a workspace group → "新建会话在此目录".
                  // Marked sections have no group-level actions.
                  if (!isWorkspace || !g.cwd) return
                  e.preventDefault()
                  e.stopPropagation()
                  openMenu({ kind: 'group', cwd: g.cwd }, e.clientX, e.clientY)
                }}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-1 text-left hover:bg-gn-bg-highlight"
                title={isWorkspace ? g.cwd : g.label}
              >
                <span className="shrink-0 text-gn-gutter" aria-hidden>
                  <IconGlyph glyph={isCollapsed ? Glyphs.chevron : Glyphs.chevronDown} />
                </span>
                <span
                  className={`min-w-0 truncate text-[10.5px] font-medium tracking-wide ${sectionAccent}`}
                >
                  {isWorkspace && g.cwd && pinnedWorkspaces.has(g.cwd) && (
                    <span
                      className="mr-1 inline-block align-[-0.1em] text-gn-yellow"
                      title="已置顶此工作目录"
                      aria-label="已置顶"
                    >
                      <Pin size={12} strokeWidth={2.5} />
                    </span>
                  )}
                  {g.kind === 'pinned' && (
                    <span className="mr-1 inline-block align-[-0.1em]" aria-hidden>
                      <Pin size={11} strokeWidth={2.5} />
                    </span>
                  )}
                  {g.kind === 'todo' && (
                    <span className="mr-1 inline-block align-[-0.1em]" aria-hidden>
                      <Circle size={11} strokeWidth={2.5} />
                    </span>
                  )}
                  {g.label}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-gn-gutter">
                  {g.sessions.length}
                </span>
              </button>
              {/* Mobile/touch group actions — only for workspace groups. */}
              {isWorkspace && g.cwd && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    const r = e.currentTarget.getBoundingClientRect()
                    openMenu({ kind: 'group', cwd: g.cwd! }, r.right - ROW_MENU_W, r.bottom + 4)
                  }}
                  className="mr-3 shrink-0 px-1.5 py-1 text-[13px] leading-none text-gn-muted hover:text-gn-fg lg:hidden"
                  title="更多操作"
                  aria-label="更多操作"
                >
                  ⋮
                </button>
              )}
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
                      className={`group flex w-full cursor-pointer select-none items-center gap-2 px-3 py-2 text-left hover:bg-gn-bg-highlight ${active ? 'bg-gn-bg-highlight' : ''}`}
                      title={`${s.title || 'New Chat'} · ${stateLabel(key)}${s.cwd ? ` · ${s.cwd}` : ''}`}
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
                            {pinnedSessions.has(s.sessionId) && (
                              <span
                                className="shrink-0 text-gn-yellow"
                                title="已置顶此会话"
                                aria-label="已置顶"
                              >
                                <Pin size={12} strokeWidth={2.5} />
                              </span>
                            )}
                            {todos[s.sessionId] === 'todo' && (
                              <span
                                className="shrink-0 text-gn-yellow"
                                title="待办：还有事没做完"
                                aria-label="待办"
                              >
                                <Circle size={12} strokeWidth={2.5} />
                              </span>
                            )}
                            {todos[s.sessionId] === 'completed' && (
                              <span
                                className="shrink-0 text-gn-green"
                                title="待办已完成"
                                aria-label="已完成"
                              >
                                <CircleCheck size={12} strokeWidth={2.5} />
                              </span>
                            )}
                            <span
                              className={`block min-w-0 flex-1 truncate text-[12px] ${s.title ? (active ? 'text-gn-cyan' : 'text-gn-fg') : 'text-gn-muted'}`}
                            >
                              {s.title || 'New Chat'}
                            </span>
                          </span>
                        )}
                        {/* 副行：最后一轮动作摘要（workspace-list 的
                            last_turn_summary，agent 生成）——比标题具体，
                            一眼看出上次干了什么；缺失时不显示。 */}
                        {s.lastTurnSummary && (
                          <span
                            className="block truncate font-mono text-[10px] text-gn-muted"
                            title={s.lastTurnSummary}
                          >
                            {s.lastTurnSummary}
                          </span>
                        )}
                      </span>
                      {((s.bgRunning ?? 0) > 0) && (
                        <span
                          className="shrink-0 rounded border border-gn-gutter/70 px-1 font-mono text-[9px] leading-[13px] text-gn-muted"
                          title={`该会话有 ${s.bgRunning} 个仍在运行的后台任务（历史共 ${s.bgCount ?? 0} 个）`}
                        >
                          bg
                        </span>
                      )}
                      {!s.title && (
                        <span
                          className="shrink-0 font-mono text-[10px] leading-none text-gn-muted"
                          title={`会话 ID 前缀：${s.sessionId}`}
                        >
                          {s.sessionId.slice(0, 12)}
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
                {g.sessions.length > defaultShown && (
                  <div className="flex">
                    {shown > defaultShown && (
                      <button
                        type="button"
                        onClick={() => collapseMore(g.key)}
                        className="flex flex-1 cursor-pointer items-center justify-center gap-2 px-3 py-1 text-center text-[10.5px] text-gn-muted hover:bg-gn-bg-highlight"
                        title={`收起为最近 ${defaultShown} 个会话`}
                      >
                        收起
                      </button>
                    )}
                    {g.sessions.length > shown && (
                      <button
                        type="button"
                        onClick={() => expandMore(g.key)}
                        className="flex flex-1 cursor-pointer items-center justify-center gap-2 px-3 py-1 text-center text-[10.5px] text-gn-cyan hover:bg-gn-bg-highlight"
                        title={`显示更多 ${Math.min(LOAD_MORE_STEP, g.sessions.length - shown)} 个会话`}
                      >
                        显示更多 {Math.min(LOAD_MORE_STEP, g.sessions.length - shown)} 个
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )
      })}
      {/* 底部展示模式条（两行）：第一行「已加载最近/全部 N 条会话」
          （真实条数）；第二行「加载更多」+「切换全量 / 切换最近」tab
          （当前模式高亮）。切换偏好持久化到 localStorage。仅 workspace
          形态且有数据时显示。 */}
      {listMode === 'workspace' && sections.length > 0 && (
        <div className="py-1.5">
          <div className="flex items-center justify-center">
            <span className="text-[10.5px] tabular-nums text-gn-gutter">
              {workspaceListMode === 'recent'
                ? `已加载最近 ${sections.reduce((n, g) => n + g.sessions.length, 0)} 条会话`
                : `已加载全部 ${sections.reduce((n, g) => n + g.sessions.length, 0)} 条会话`}
            </span>
          </div>
          <div className="mt-1 flex gap-1">
            <button
              type="button"
              onClick={() => void switchWorkspaceListMode('full')}
              disabled={workspaceLoading}
              className={`flex flex-1 cursor-pointer items-center justify-center px-1 py-0.5 text-[10.5px] disabled:cursor-default disabled:opacity-60 ${
                workspaceListMode === 'full'
                  ? 'bg-gn-bg-highlight text-gn-cyan'
                  : 'text-gn-muted hover:text-gn-fg'
              }`}
              title="显示全部历史会话（更早的也会出现）"
            >
              切换全量
            </button>
            {workspaceListMode === 'recent' && workspaceRecentHasMore && (
              <button
                type="button"
                onClick={() => void workspaceLoadMore()}
                disabled={workspaceRecentLoadingMore || workspaceLoading}
                className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 px-1 py-0.5 text-[10.5px] text-gn-cyan hover:bg-gn-bg-highlight disabled:cursor-default disabled:opacity-60"
                title="再加载 50 条更早的会话"
              >
                {workspaceRecentLoadingMore && (
                  <span className="text-[11px] leading-none text-gn-muted">
                    {SPINNER_FRAMES[spinnerFrame]}
                  </span>
                )}
                加载更多
              </button>
            )}
            <button
              type="button"
              onClick={() => void switchWorkspaceListMode('recent')}
              disabled={workspaceLoading}
              className={`flex flex-1 cursor-pointer items-center justify-center px-1 py-0.5 text-[10.5px] disabled:cursor-default disabled:opacity-60 ${
                workspaceListMode === 'recent'
                  ? 'bg-gn-bg-highlight text-gn-cyan'
                  : 'text-gn-muted hover:text-gn-fg'
              }`}
              title="只显示最近加载的会话，可逐页加载更多"
            >
              切换最近
            </button>
          </div>
        </div>
      )}
      {/* 空列表 + 拉取中（workspace 形态）：中央显示与 scrollback
          加载态一致的提示（braille 字符动画 + "加载会话…"），这是
          会话列表唯一的加载指示。旧数据非空时列表保留、不覆盖。 */}
      {centeredLoading && (
        <div className="pointer-events-none absolute inset-0 z-10 flex min-h-[220px] items-center justify-center gap-2 select-none">
          <span className="text-[15px] leading-none text-gn-muted">
            {SPINNER_FRAMES[spinnerFrame]}
          </span>
          <span className="text-[12.5px] text-gn-muted">加载会话…</span>
        </div>
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
                    <span aria-hidden className="inline-block w-4 shrink-0 text-center">
                      <ChevronRight size={14} strokeWidth={2.5} />
                    </span>{' '}
                    打开会话
                  </MenuItem>
                  <MenuItem
                    disabled={menu.row.sessionId !== sessionId}
                    disabledTitle="重命名仅支持当前会话"
                    onClick={() => {
                      startRename(menu.row)
                      closeMenu()
                    }}
                  >
                    <span aria-hidden className="inline-block w-4 shrink-0 text-center">
                      <Pencil size={14} strokeWidth={2.5} />
                    </span>{' '}
                    重命名
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      toggleSessionPin(menu.row.sessionId)
                      closeMenu()
                    }}
                  >
                    <span aria-hidden className="inline-block w-4 shrink-0 text-center text-gn-yellow">
                      <Pin size={14} strokeWidth={2.5} />
                    </span>{' '}
                    {pinnedSessions.has(menu.row.sessionId) ? '取消置顶' : '置顶此会话'}
                  </MenuItem>
                  <div className="my-0.5 border-t border-gn-prompt-border/60" />
                  {/* 待办操作：待办是独立于置顶的追踪状态——设为待办后
                      该会话升到列表前部，做完可标记已完成（✓ 徽标）。 */}
                  {(() => {
                    const st = todos[menu.row.sessionId]
                    if (st === 'todo') {
                      return (
                        <>
                          <MenuItem
                            onClick={() => {
                              setTodoStatus(menu.row.sessionId, 'completed')
                              closeMenu()
                            }}
                          >
                            <span aria-hidden className="inline-block w-4 shrink-0 text-center text-gn-green">
                              <CircleCheck size={14} strokeWidth={2.5} />
                            </span>{' '}
                            标记已完成
                          </MenuItem>
                          <MenuItem
                            onClick={() => {
                              setTodoStatus(menu.row.sessionId, null)
                              closeMenu()
                            }}
                          >
                            <span aria-hidden className="inline-block w-4 shrink-0 text-center">
                              <CircleOff size={14} strokeWidth={2.5} />
                            </span>{' '}
                            取消待办
                          </MenuItem>
                        </>
                      )
                    }
                    if (st === 'completed') {
                      return (
                        <>
                          <MenuItem
                            onClick={() => {
                              setTodoStatus(menu.row.sessionId, 'todo')
                              closeMenu()
                            }}
                          >
                            <span aria-hidden className="inline-block w-4 shrink-0 text-center text-gn-yellow">
                              <Circle size={14} strokeWidth={2.5} />
                            </span>{' '}
                            标记为待办
                          </MenuItem>
                          <MenuItem
                            onClick={() => {
                              setTodoStatus(menu.row.sessionId, null)
                              closeMenu()
                            }}
                          >
                            <span aria-hidden className="inline-block w-4 shrink-0 text-center">
                              <CircleOff size={14} strokeWidth={2.5} />
                            </span>{' '}
                            取消待办
                          </MenuItem>
                        </>
                      )
                    }
                    return (
                      <>
                        <MenuItem
                          onClick={() => {
                            setTodoStatus(menu.row.sessionId, 'todo')
                            closeMenu()
                          }}
                        >
                          <span aria-hidden className="inline-block w-4 shrink-0 text-center text-gn-yellow">
                            <Circle size={14} strokeWidth={2.5} />
                          </span>{' '}
                          设为待办
                        </MenuItem>
                        <MenuItem
                          onClick={() => {
                            setTodoStatus(menu.row.sessionId, 'completed')
                            closeMenu()
                          }}
                        >
                          <span aria-hidden className="inline-block w-4 shrink-0 text-center text-gn-green">
                            <CircleCheck size={14} strokeWidth={2.5} />
                          </span>{' '}
                          标记已完成
                        </MenuItem>
                      </>
                    )
                  })()}
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
                    <span aria-hidden className="inline-block w-4 shrink-0 text-center">
                      <Trash2 size={14} strokeWidth={2.5} />
                    </span>{' '}
                    删除
                  </MenuItem>
                </>
              ) : (
                <>
                  <MenuItem
                    onClick={() => {
                      toggleWorkspacePin(menu.cwd)
                      closeMenu()
                    }}
                  >
                    <span aria-hidden className="inline-block w-4 shrink-0 text-center text-gn-yellow">
                      <Pin size={14} strokeWidth={2.5} />
                    </span>{' '}
                    {pinnedWorkspaces.has(menu.cwd) ? '取消置顶' : '置顶此目录'}
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      void newSession(menu.cwd)
                      closeMenu()
                    }}
                  >
                    <span aria-hidden className="inline-block w-4 shrink-0 text-center">
                      <Plus size={14} strokeWidth={2.5} />
                    </span>{' '}
                    在此目录新建会话
                  </MenuItem>
                </>
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
    </div>
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

