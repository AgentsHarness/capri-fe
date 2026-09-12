import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleOff,
  MoreVertical,
  Pencil,
  Pin,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { useChatStore } from '../store/chat'
import type { SessionInfo, WorkspaceSummary } from '../api/types'
import {
  frozenSortRank,
  repoNameFromCwd,
  sanitizeTitle,
  sessionContextPct,
  sessionGroupKey,
} from '../store/historyGroups'
import { SPINNER_FRAMES } from '../theme/glyphs'
import { SessionStateIcon } from './SessionStateIcon'
import { stateLabel, useSessionSpinner } from '../hooks/sessionState'
import {
  sortSessionsWithPins,
  sortWorkspacesWithPins,
  usePins,
} from '../store/historyPins'
import { useHistoryView } from '../store/historyView'
import {
  activityMs,
  rowOrderMs,
  sortGroupsByOrderMs,
  useHistoryOrder,
  type OrderSeed,
} from '../store/historyOrder'
import { scrollAncestor, useScrollAnchor } from '../hooks/useScrollAnchor'

/** 根据 data-gkey 属性在根容器下查找指定工作区分组元素。 */
function findGroupEl(root: HTMLElement | null, key: string): HTMLElement | null {
  if (!root) return null
  const all = root.querySelectorAll<HTMLElement>('[data-gkey]')
  for (let i = 0; i < all.length; i++) {
    if (all[i].getAttribute('data-gkey') === key) return all[i]
  }
  return null
}

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
 * - marked：按类型分组（思考中 / 置顶 / 待办），key = 类型
 */
type ListSection = {
  key: string
  label: string
  sessions: MergedRow[]
  /** 仅 workspace 形态：工作目录全路径（组菜单「新建会话」/ 置顶目录）。 */
  cwd?: string
  kind: 'workspace' | 'running' | 'pinned' | 'todo'
}

/**
 * 组内比较器：比「排序锚」而不是本次响应的 updatedAt。
 * 无锚的首次出现退回活动时间（新会话照旧排最前），之后钉住不动；
 * 时间缺失（0）垫底，同分按 id，保证顺序可复现。
 */
function byAnchoredDesc(anchors: Record<string, number>) {
  return (a: WorkspaceSummary, b: WorkspaceSummary): number => {
    const d = rowOrderMs(anchors, b) - rowOrderMs(anchors, a)
    if (d !== 0) return d
    return a.sessionId.localeCompare(b.sessionId)
  }
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
 * 2. marked：分类视图（思考中 / 置顶 / 待办）
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
  // 展示形态：工作区分组 vs 分类视图（见 historyView.ts）。
  const listMode = useHistoryView((s) => s.mode)
  const anchors = useHistoryOrder((s) => s.anchors)
  const collapsePrefs = useHistoryOrder((s) => s.collapse)
  const seedOrder = useHistoryOrder((s) => s.seed)
  const setCollapsePref = useHistoryOrder((s) => s.setCollapse)
  // 锚点只在同一台 host 内有意义：换 host 即整表重锚（见 historyOrder）。
  const selectedHostId = useChatStore((s) => s.selectedHostId)
  const hostScope = selectedHostId ?? 'local'
  /** 列表根节点（其可滚动祖先是侧栏 / 移动端下拉的滚动容器）。 */
  const listRootRef = useRef<HTMLDivElement>(null)
  /** 组「默认是否收起」的钉住表：本次挂载内算一次就不再随时间翻转。 */
  const collapseDefaultRef = useRef(new Map<string, boolean>())

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

  /** 组内最终比较器：比排序锚而不是每次响应的 updatedAt。 */
  const byOrderKey = useMemo(
    () => byAnchoredDesc(anchors),
    [anchors],
  )

  /**
   * 工作区形态：按 sessionId 把 live 状态覆盖到 workspace 摘要行上；
   * 当前会话的 cwd 不在列表里时用 sessions补一组；最后按
   * sortGroupsByOrderMs 排序（置顶工作区最前，其余按排序锚）。
   */
  const workspaceGroups = useMemo((): MergedGroup[] => {
    const merged: MergedGroup[] = workspaces.map((g) => ({
      ...g,
      // 组内排序：置顶的会话永远最前，随后是待办（未完成），其余按
      // 状态优先级（待处理排最前），时间换成钉住的排序锚。
      sessions: sortSessionsWithPins(
        g.sessions.map(toRow),
        pinnedSessions,
        completedNotices,
        byOrderKey,
        todos,
        frozenSortRank,
      ),
    }))
    // 兜底：当前会话的 cwd 不在 workspace-list 里时，用 live sessions
    // 中该 cwd 的会话补一个组。
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
            byOrderKey,
            todos,
            frozenSortRank,
          ),
        })
      }
    }
    // 置顶的工作目录永远在最前；其余按钉住的排序锚降序。
    const ordered = sortGroupsByOrderMs(merged, anchors)
    return sortWorkspacesWithPins(ordered, pinnedWorkspaces)
  }, [
    workspaces,
    sessions,
    cwd,
    pinnedWorkspaces,
    pinnedSessions,
    completedNotices,
    todos,
    toRow,
    byOrderKey,
    anchors,
  ])

  /**
   * 标记形态：扁平索引全部已知会话（workspace 摘要 ∪ live roster）。
   * 三个分类：
   * - 思考中 — 所有非空闲会话（待处理 / 处理中 / 后台任务运行中），
   *   与置顶/待办独立：即使未标记也显示，方便一眼盯住进行中的会话；
   *   与置顶/待办重叠的会话两边都出现（行内仍带各自的标记徽标）。
   * - 置顶 / 待办 — 只含被标记的会话，同一会话只出现一次，优先级
   *   置顶 > 待办（置顶行仍可显示待办徽标）；已完成的待办不进列表
   *   （右键仍可改回待办 / 取消）。
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
    const running: MergedRow[] = []
    for (const row of byId.values()) {
      if (sessionGroupKey(row, sessionId) !== 'idle') running.push(row)
    }

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
      sortSessionsWithPins(
        rows,
        pinnedSessions,
        completedNotices,
        byOrderKey,
        todos,
        frozenSortRank,
      )

    const sections: ListSection[] = []
    if (running.length > 0) {
      sections.push({
        key: 'marked:running',
        label: '思考中',
        kind: 'running',
        sessions: sortMarked(running),
      })
    }
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
  }, [
    workspaces,
    sessions,
    pinnedSessions,
    todos,
    completedNotices,
    toRow,
    sessionId,
    byOrderKey,
  ])

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
   *
   * 每个组只在**首次见到**时算一次并钉住：否则页面开着跨过 6 小时线，
   * 组会在用户眼皮底下自己收起/展开，把下面的内容整体挪位。
   */
  const defaultCollapsed = useMemo(() => {
    const map = new Map<string, boolean>()
    const frozenDefaults = collapseDefaultRef.current
    const now = Date.now()
    for (const s of sections) {
      const held = frozenDefaults.get(s.key)
      if (held != null) {
        map.set(s.key, held)
        continue
      }
      let value = false
      if (listMode !== 'marked') {
        let latest = 0
        for (const row of s.sessions) {
          const t = activityMs(row)
          if (t > latest) latest = t
        }
        // 无时间戳视为不活跃 → 默认收起。
        value = now - latest > WORKSPACE_ACTIVE_WINDOW_MS
      }
      frozenDefaults.set(s.key, value)
      map.set(s.key, value)
    }
    return map
  }, [sections, listMode])

  /** 用户手动折叠/展开、加载更多时跳过 useScrollAnchor 的 delta 补偿。 */
  const skipAnchorRef = useRef(false)
  /** 记录本次正在展开的组 key，供 layoutEffect 检查是否需要滚入视口。 */
  const expandingGroupRef = useRef<string | null>(null)
  /** 记录本次正在折叠的组 sticky 回滚目标 scrollTop。 */
  const collapseStickyTargetRef = useRef<number | null>(null)

  /**
   * 折叠偏好：用户明确点过的组写进 localStorage（跨会话、跨桌面/移动
   * 两端共享），没点过的回退到上面钉住的 defaultCollapsed。
   */
  const isGroupCollapsed = (key: string) =>
    collapsePrefs[key] ?? defaultCollapsed.get(key) ?? false

  const toggleGroup = (key: string) => {
    const collapsed = isGroupCollapsed(key)
    skipAnchorRef.current = true

    if (collapsed) {
      // 展开操作：记录正在展开的组，在 layoutEffect 中确保展开条目可见
      expandingGroupRef.current = key
      collapseStickyTargetRef.current = null
    } else {
      // 折叠操作：检查组头是否处于 sticky 吸顶状态
      expandingGroupRef.current = null
      const root = listRootRef.current
      const scroller = scrollAncestor(root)
      const groupEl = findGroupEl(root, key)
      if (scroller && groupEl) {
        const scrollerRect = scroller.getBoundingClientRect()
        const groupRect = groupEl.getBoundingClientRect()
        // 组顶在视口上方：组头已吸顶。折叠后行消失，scrollTop 必须拉回组顶，保证组头仍然可见
        if (groupRect.top < scrollerRect.top) {
          collapseStickyTargetRef.current = scroller.scrollTop + (groupRect.top - scrollerRect.top)
        } else {
          collapseStickyTargetRef.current = null
        }
      }
    }

    setCollapsePref(key, !collapsed)
  }

  /**
   * 钉住顺序：列表落地时把没见过的会话钉一个排序锚（只补新锚，
   * 已锚定的不动）。数据本身（sessions / workspaces）每次刷新都是新数组，
   * 顺序却不因此改变——显式刷新与换 host 才会整表重锚。
   */
  useEffect(() => {
    const rows: OrderSeed[] = []
    for (const section of sections) {
      for (const row of section.sessions) {
        rows.push({ sessionId: row.sessionId, ms: activityMs(row) })
      }
    }
    seedOrder(rows, hostScope)
  }, [sections, hostScope, seedOrder])

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
    skipAnchorRef.current = true
    expandingGroupRef.current = key
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
    skipAnchorRef.current = true
    const base = sectionByKey(key)
      ? defaultShownCount(sectionByKey(key)!)
      : WORKSPACE_ROWS_LIMIT
    setVisibleCount((prev) => {
      const next = new Map(prev)
      next.set(key, base)
      return next
    })
  }

  /**
   * 渲染形态指纹：组顺序 / 各组行数 / 折叠态 / 展开名额。只有它变了才
   * 做一次滚动补偿（见 useScrollAnchor）——状态图标每帧翻动不该触发测量。
   */
  const layoutFingerprint = useMemo(() => {
    const parts: string[] = [listMode]
    for (const g of sections) {
      parts.push(
        `${g.key}#${g.sessions.length}#${isGroupCollapsed(g.key) ? 'c' : 'e'}#${Math.min(
          visibleCount.get(g.key) ?? defaultShownCount(g),
          g.sessions.length,
        )}`,
      )
    }
    return parts.join('|')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, listMode, visibleCount, collapsePrefs, pinnedSessions, todos])
  const { reanchor } = useScrollAnchor(listRootRef, layoutFingerprint, skipAnchorRef)

  useLayoutEffect(() => {
    const root = listRootRef.current
    const scroller = scrollAncestor(root)
    if (!scroller) return

    // 1. 折叠吸顶组：把 scrollTop 拉回到组头顶部，保证组头仍然停在视口最上方
    if (collapseStickyTargetRef.current != null) {
      const target = collapseStickyTargetRef.current
      collapseStickyTargetRef.current = null
      scroller.scrollTop = Math.max(0, target)
      reanchor()
      return
    }

    // 2. 展开组：确保刚展开的组及其条目在视口中可见（尤其是在视口底部点击展开时）
    if (expandingGroupRef.current != null) {
      const key = expandingGroupRef.current
      expandingGroupRef.current = null
      const groupEl = findGroupEl(root, key)
      if (groupEl) {
        const scrollerRect = scroller.getBoundingClientRect()
        const groupRect = groupEl.getBoundingClientRect()
        const headerTop = groupRect.top - scrollerRect.top
        const groupBottom = groupRect.bottom - scrollerRect.top
        const viewportH = scroller.clientHeight

        if (headerTop < 0) {
          // 组头位于视口上方：拉回视口顶
          scroller.scrollTop += headerTop
          reanchor()
        } else if (groupBottom > viewportH) {
          // 展开内容溢出到底部视口外：视组整体高度向上滚动，确保展开内容展现
          if (groupRect.height <= viewportH) {
            // 整组高度小于视口：滚到整组底部贴齐视口底部（组头仍在视口内）
            scroller.scrollTop += (groupBottom - viewportH)
          } else {
            // 组内容比整个视口还高：将组头置顶，最大化展示下方展开条目
            scroller.scrollTop += headerTop
          }
          reanchor()
        }
      }
    }
  })

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

  // 空列表且正在拉取：中央显示与 scrollback 一致的加载态（唯一加载
  // 指示；旧数据仍在时列表直接保留，刷新无提示）。标记形态下 sections
  // 空是正常的空态（置顶/待办本就少），不显示"加载会话…"。
  const centeredLoading =
    listMode === 'workspace' && sections.length === 0 && workspaceLoading
  // braille 帧只喂这两处加载提示；行内「处理中」已换成 CSS 自转的图标。
  const spinnerFrame = useSessionSpinner(
    centeredLoading || workspaceRecentLoadingMore,
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
          没有标记或运行中的会话
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
        // 钉住形态下在跑的会话不会自己浮上来，组头带一个在跑数量：既保住
        // 「哪个目录在干活」一眼可见，也不因状态翻转挪动任何一行。
        const busyCount = isWorkspace
          ? g.sessions.filter((s) => sessionGroupKey(s, sessionId) !== 'idle').length
          : 0
        const sectionAccent =
          g.kind === 'running'
            ? 'text-gn-cyan'
            : g.kind === 'pinned' || g.kind === 'todo'
              ? 'text-gn-yellow'
              : 'text-gn-fg'
        return (
          <div key={g.key} data-gkey={g.key} className="relative">
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
                {/* flex + items-center：图标与文字同轴。 */}
                <span className="flex shrink-0 items-center text-gn-gutter" aria-hidden>
                  {isCollapsed ? (
                    <ChevronRight size={12} strokeWidth={2.5} />
                  ) : (
                    <ChevronDown size={12} strokeWidth={2.5} />
                  )}
                </span>
                <span
                  className={`flex min-w-0 items-center gap-1 text-[10.5px] font-medium tracking-wide ${sectionAccent}`}
                >
                  {isWorkspace && g.cwd && pinnedWorkspaces.has(g.cwd) && (
                    <span
                      className="shrink-0 text-gn-yellow"
                      title="已置顶此工作目录"
                      aria-label="已置顶"
                    >
                      <Pin size={12} strokeWidth={2.5} />
                    </span>
                  )}
                  {/* 标记视角的三个分组不再带图标——组名（思考中 / 置顶 /
                      待办）本身就是分类，行内也各有状态与标记图标。 */}
                  <span className="min-w-0 truncate">{g.label}</span>
                </span>
                {busyCount > 0 && (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-gn-cyan"
                    title={`${busyCount} 个会话有进行中的回合 / 后台任务`}
                    aria-label={`${busyCount} 个会话在运行`}
                  >
                    <SessionStateIcon state="active" pending={false} />
                    {busyCount}
                  </span>
                )}
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
                  className="mr-3 flex shrink-0 items-center justify-center rounded px-1.5 py-1 text-gn-muted hover:text-gn-fg lg:hidden"
                  title="更多操作"
                  aria-label="更多操作"
                >
                  <MoreVertical size={13} strokeWidth={2.5} />
                </button>
              )}
            </div>
            {!isCollapsed && (
              <>
                {rows.map((s) => {
                  const active = s.sessionId === sessionId
                  // Row icon follows live state: 处理中 spinner / 待处理
                  // blue diamond / 后台任务 bg 徽标；空闲与仅 bg 的行留空位。
                  const key = sessionGroupKey(s, sessionId)
                  const state = key === 'active' ? 'active' : 'idle'
                  const pending = key === 'awaiting'
                  const completed = completedNotices[s.sessionId] != null
                  // 置顶/待办徽标默认占掉行首的状态列（原来空心菱形的位置）；
                  // 状态本身要占那一格时（spinner / 待处理菱形 / 完成 ✓）徽标
                  // 退回标题前，两者不同时挤一格。
                  const markIcons = (
                    <>
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
                    </>
                  )
                  const stateInLeading = completed || state === 'active' || pending
                  const renaming = renamingId === s.sessionId
                  const contextPct = sessionContextPct(s)
                  return (
                    <div
                      key={s.sessionId}
                      data-hkey={s.sessionId}
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
                      {stateInLeading ? (
                        completed ? (
                          // 完成提醒替换状态图标：Check 取代菱形/spinner
                          // （该会话跑完待查看，状态本身已无新意）。
                          <span
                            className="inline-flex w-[1.25em] shrink-0 items-center justify-center text-gn-green"
                            title="该会话已完成，等待查看"
                            aria-label="已完成待查看"
                          >
                            <Check size={12} strokeWidth={2.5} />
                          </span>
                        ) : (
                          <SessionStateIcon
                            state={state}
                            pending={pending}
                          />
                        )
                      ) : (
                        <span className="inline-flex min-w-[1.25em] shrink-0 items-center justify-center gap-0.5">
                          {markIcons}
                        </span>
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
                              // 输入法组字中的 Enter 是上屏候选词：中文
                              // 标题按回车选词会把半截标题存进去。
                              if (e.nativeEvent.isComposing) return
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
                            {stateInLeading ? markIcons : null}
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
                        <span className="shrink-0 text-[11px] text-gn-cyan">当前</span>
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
                      {/* Row action trigger — mobile/touch: MoreVertical opens the same
                          menu desktop right-click shows (lg+ rows rely on
                          onContextMenu, so the trigger hides there). */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          const r = e.currentTarget.getBoundingClientRect()
                          openMenu({ kind: 'row', row: s }, r.right - ROW_MENU_W, r.bottom + 4)
                        }}
                        className="flex shrink-0 items-center justify-center rounded px-1 text-gn-muted hover:text-gn-fg lg:hidden"
                        title="更多操作"
                        aria-label="更多操作"
                      >
                        <MoreVertical size={13} strokeWidth={2.5} />
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
          （当前模式高亮）。顺序默认且固定为钉住顺序，不再在底部提供选择。
          切换偏好持久化到 localStorage。仅 workspace 形态且有数据时显示。 */}
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
              className={`flex flex-1 cursor-pointer items-center justify-center px-1 py-0.5 text-[10.5px] disabled:cursor-default disabled:opacity-60 ${ workspaceListMode === 'full' ? 'bg-gn-bg-highlight text-gn-cyan' : 'text-gn-muted hover:text-gn-fg' }`}
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
              className={`flex flex-1 cursor-pointer items-center justify-center px-1 py-0.5 text-[10.5px] disabled:cursor-default disabled:opacity-60 ${ workspaceListMode === 'recent' ? 'bg-gn-bg-highlight text-gn-cyan' : 'text-gn-muted hover:text-gn-fg' }`}
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
              className="absolute w-[176px] overflow-hidden gn-menu"
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
                  <div className="border-t border-gn-prompt-border/60" />
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
                  <div className="border-t border-gn-prompt-border/60" />
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
            className="fixed inset-0 z-[60] flex items-center justify-center gn-modal-dim p-4"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setDeleteTarget(null)
            }}
          >
            <div
              className="w-full max-w-[360px] gn-modal-panel"
              role="dialog"
              aria-modal="true"
              aria-label="删除会话"
            >
              <header className="gn-modal-header">
                <X size={12} className="shrink-0 text-gn-red" aria-hidden />
                <span className="text-[13px] font-bold text-gn-fg">删除会话</span>
              </header>
              <div className="px-4 py-3 text-[12.5px] leading-relaxed text-gn-fg2">
                确定删除会话
                <span className="mx-1 font-semibold text-gn-fg">
                  「{deleteTarget.title || deleteTarget.sessionId.slice(0, 12)}」
                </span>
                ？删除后不可恢复。
              </div>
              <footer className="gn-modal-footer flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteTarget(null)}
                  className="min-h-8 rounded bg-gn-bg-base px-3 py-1 text-[12px] text-gn-fg2 hover:bg-gn-bg-highlight"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={confirmDelete}
                  className="min-h-8 rounded bg-gn-diff-del-bg px-3 py-1 text-[12px] font-semibold text-gn-red hover:bg-gn-red/15"
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
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${ disabled ? 'cursor-not-allowed text-gn-gutter opacity-50' : danger ? 'text-gn-red hover:bg-gn-diff-del-bg' : 'text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg' }`}
    >
      {children}
    </button>
  )
}

