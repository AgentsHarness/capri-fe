import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../../store/chat'
import { buildSessionRowIndex, type SessionRow } from '../../store/chat/sessionRows'
import {
  activityMs,
  sortGroupsByOrderMs,
  useHistoryOrder,
  type OrderSeed,
} from '../../store/historyOrder'
import {
  frozenSortRank,
  sessionGroupKey,
  workspaceGroupLabel,
} from '../../store/historyGroups'
import { sortSessionsWithPins, sortWorkspacesWithPins, useFePrefs, usePins } from '../../store/historyPins'
import { useHistoryView } from '../../store/historyView'
import { transport } from '../../api/client'
import { byAnchoredDesc, findGroupEl } from '../../lib/sessionList'
import { scrollAncestor, useScrollAnchor } from '../../hooks/useScrollAnchor'
import { useSessionSpinner } from '../../hooks/sessionState'
import { SPINNER_FRAMES } from '../../theme/glyphs'
import {
  LOAD_MORE_STEP,
  WORKSPACE_ACTIVE_WINDOW_MS,
  WORKSPACE_ROWS_LIMIT,
  type ListSection,
  type MergedGroup,
} from './sessionListShared'
import { SessionSection } from './SessionSection'
import { SessionListMenu } from './SessionListMenu'
import { useSessionListMenu } from './useSessionListMenu'

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
  const completedNotices = useChatStore((s) => s.completedNotices)
  // 浏览器本地置顶偏好（工作目录 / 会话），见 historyPins.ts。
  const pinnedWorkspaces = usePins((s) => s.pinnedWorkspaces)
  const pinnedSessions = usePins((s) => s.pinnedSessions)
  const todos = usePins((s) => s.todos)
  /** 目录分组名显示方式：短名 / 完整路径（FE 偏好，跨浏览器同步）。 */
  const workspaceFullPath = useFePrefs((s) => s.fePrefs.workspaceFullPath)
  // 展示形态：工作区分组 vs 分类视图（见 historyView.ts）。
  const listMode = useHistoryView((s) => s.mode)
  const anchors = useHistoryOrder((s) => s.anchors)
  const collapsePrefs = useHistoryOrder((s) => s.collapse)
  const seedOrder = useHistoryOrder((s) => s.seed)
  const setCollapsePref = useHistoryOrder((s) => s.setCollapse)
  // 锚点只在同一台 host 内有意义：换 host 即整表重锚（见 historyOrder）。
  const selectedHostId = useChatStore((s) => s.selectedHostId)
  const hostScope = selectedHostId ?? 'local'
  /**
   * 「分享只读链接」的可用条件：hub 模式 + 已登录（有门禁令牌）+ 选中了
   * 一台 host。local 模式没有 hub 承载白名单，直接禁用并给出提示。
   * 模式取自 store（由启动链写入），列表渲染不依赖 transport 的方法面。
   */
  const connMode = useChatStore((s) => s.mode)
  const hasToken = !!transport.getAccessToken()
  const canShare = connMode === 'hub' && hasToken && !!selectedHostId
  const shareHint =
    connMode !== 'hub'
      ? '仅 Hub 模式支持分享'
      : !hasToken
        ? '需要先登录 Hub'
        : '需要先选中一台 Host'
  /** 列表根节点（其可滚动祖先是侧栏 / 移动端下拉的滚动容器）。 */
  const listRootRef = useRef<HTMLDivElement>(null)
  /** 组「默认是否收起」的钉住表：本次挂载内算一次就不再随时间翻转。 */
  const collapseDefaultRef = useRef(new Map<string, boolean>())

  /**
   * 单一行投影：`sessions` 是 live 事实源，`workspaces` 只补分组所需的
   * 成员表和缺失字段（标题 / 副行摘要 / 活动时间 / 持久化档位）。
   * 组件只读这份索引，不再逐处合并两份数据。
   */
  const rowById = useMemo(
    () => buildSessionRowIndex(sessions, workspaces),
    [sessions, workspaces],
  )

  /** 组内最终比较器：比排序锚而不是每次响应的 updatedAt。 */
  const byOrderKey = useMemo(() => byAnchoredDesc<SessionRow>(anchors), [anchors])

  /**
   * 工作区形态：沿用 workspace 的分组与组内成员，每行取 rowById 的投影；
   * 当前会话的 cwd 不在列表里时用 rowById 补一组；最后按
   * sortGroupsByOrderMs 排序（置顶工作区最前，其余按排序锚）。
   */
  const workspaceGroups = useMemo((): MergedGroup[] => {
    const merged: MergedGroup[] = workspaces.map((g) => ({
      cwd: g.cwd,
      label: workspaceGroupLabel(g.cwd, workspaceFullPath),
      // 组内排序：置顶的会话永远最前，随后是待办（未完成），其余按
      // 状态优先级（待处理排最前），时间换成钉住的排序锚。
      sessions: sortSessionsWithPins(
        g.sessions.flatMap((summary) => rowById.get(summary.sessionId) ?? []),
        pinnedSessions,
        completedNotices,
        byOrderKey,
        todos,
        frozenSortRank,
      ),
    }))
    // 兜底：当前会话的 cwd 不在 workspace-list 里时，用投影中该 cwd 的
    // 行补一个组。
    if (cwd && !merged.some((g) => g.cwd === cwd)) {
      const rows = [...rowById.values()].filter((row) => row.cwd === cwd)
      if (rows.length > 0) {
        merged.push({
          cwd,
          label: workspaceGroupLabel(cwd, workspaceFullPath),
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
    rowById,
    cwd,
    pinnedWorkspaces,
    pinnedSessions,
    completedNotices,
    todos,
    byOrderKey,
    anchors,
    workspaceFullPath,
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
    const pinned: SessionRow[] = []
    const todo: SessionRow[] = []
    const running: SessionRow[] = []
    for (const row of rowById.values()) {
      if (sessionGroupKey(row, sessionId) !== 'idle') running.push(row)
    }

    // 以标记集合为驱动：即使摘要列表尚未返回该会话，只要 live 有也能显示。
    // 已完成的待办不进标记列表（右键仍可改回待办 / 取消）。
    const candidateIds = new Set<string>([
      ...pinnedSessions,
      ...Object.keys(todos).filter((id) => todos[id] === 'todo'),
    ])
    for (const id of candidateIds) {
      const row = rowById.get(id)
      if (!row) continue
      if (pinnedSessions.has(id)) {
        pinned.push(row)
        continue
      }
      if (todos[id] === 'todo') todo.push(row)
    }

    const sortMarked = (rows: SessionRow[]) =>
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
  }, [rowById, pinnedSessions, todos, completedNotices, sessionId, byOrderKey])

  /** 当前形态下的分区列表（统一渲染入口）。 */
  const sections = useMemo((): ListSection[] => {
    if (listMode === 'marked') return markedSections
    return workspaceGroups.map((g) => ({
      key: g.cwd,
      label: g.label,
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
  // ── row / group action menu (desktop right-click / mobile ⋮) ───────
  const menuState = useSessionListMenu(skipAnchorRef, listRootRef)

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
        const defaultShown = defaultShownCount(g)
        return (
          <SessionSection
            key={g.key}
            g={g}
            isCollapsed={isGroupCollapsed(g.key)}
            defaultShown={defaultShown}
            shown={visibleCount.get(g.key) ?? defaultShown}
            renamingId={menuState.renamingId}
            renameText={menuState.renameText}
            setRenameText={menuState.setRenameText}
            renameInputRef={menuState.renameInputRef}
            commitRename={menuState.commitRename}
            cancelRename={menuState.cancelRename}
            onToggleGroup={toggleGroup}
            onExpandMore={expandMore}
            onCollapseMore={collapseMore}
            onOpenMenu={menuState.openMenu}
          />
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
      <SessionListMenu
        menu={menuState.menu}
        menuPos={menuState.menuPos}
        menuRef={menuState.menuRef}
        closeMenu={menuState.closeMenu}
        startRename={menuState.startRename}
        applyMark={menuState.applyMark}
        canShare={canShare}
        shareHint={shareHint}
        deleteTarget={menuState.deleteTarget}
        setDeleteTarget={menuState.setDeleteTarget}
        deleting={menuState.deleting}
        confirmDelete={menuState.confirmDelete}
      />
    </div>
  )
}
