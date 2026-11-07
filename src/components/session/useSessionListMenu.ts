import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useChatStore } from '../../store/chat'
import { sanitizeTitle } from '../../store/historyGroups'
import type { SessionRow } from '../../store/chat/sessionRows'

/** 菜单锚点（视口坐标）：`y` 是向下开时菜单的上沿，`flipY` 是向上翻时
 *  菜单的下沿——右键两者同取光标，⋮ 取按钮的下沿 / 上沿（含 4px 间距）。 */
export type MenuAnchor = { x: number; y: number; flipY: number }
export type MenuState =
  | ({ kind: 'row'; row: SessionRow } & MenuAnchor)
  | ({ kind: 'group'; cwd: string } & MenuAnchor)

type SessionListMenuState = {
  renamingId: string | null
  renameText: string
  setRenameText: (text: string) => void
  renameInputRef: React.RefObject<HTMLInputElement | null>
  startRename: (s: { sessionId: string; title?: string }) => void
  commitRename: (s: SessionRow) => Promise<void>
  cancelRename: () => void
  menu: MenuState | null
  menuPos: { x: number; y: number } | null
  menuRef: React.RefObject<HTMLDivElement | null>
  openMenu: (
    m: { kind: 'row'; row: SessionRow } | { kind: 'group'; cwd: string },
    anchor: MenuAnchor,
  ) => void
  closeMenu: () => void
  applyMark: (mutate: () => void) => void
  deleteTarget: SessionRow | null
  setDeleteTarget: (row: SessionRow | null) => void
  deleting: boolean
  confirmDelete: () => Promise<void>
}

/**
 * 行 / 分组操作菜单与行内重命名的状态机：落位按实测尺寸、Esc/滚动关闭、
 * 删除二次确认。渲染归 SessionListMenu。
 */
export function useSessionListMenu(
  skipAnchorRef: React.RefObject<boolean>,
  listRootRef: React.RefObject<HTMLDivElement | null>,
): SessionListMenuState {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const startRename = (s: { sessionId: string; title?: string }) => {
    setRenamingId(s.sessionId)
    setRenameText(s.title ?? '')
    requestAnimationFrame(() => renameInputRef.current?.select())
  }
  const commitRename = async (s: SessionRow) => {
    const title = sanitizeTitle(renameText).trim()
    setRenamingId(null)
    if (title && title !== (s.title ?? '')) {
      await renameSession(title)
      // Keep the list in sync even if the host sends no sessions_changed.
      void useChatStore.getState().refreshSessionLists()
    }
  }
  const cancelRename = () => setRenamingId(null)

  // ── row / group action menu (desktop right-click / mobile ⋮) ───────
  // One shared floating menu with two targets:
  //  - row   : 打开会话 / 重命名(仅当前) / 删除(非运行中，含当前会话 —
  //            删当前会话落到空状态)；删除走确认弹窗。
  //  - group : 右键工作区分组头 → "在此目录新建会话"。
  const renameSession = useChatStore((s) => s.renameSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const [menu, setMenu] = useState<MenuState | null>(null)
  // 实测尺寸后的落位；null = 还没量到（先前按锚点渲染，布局副作用在绘制前
  // 纠正，不会闪）。
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [deleteTarget, setDeleteTarget] = useState<SessionRow | null>(null)
  /** 删除请求在飞：确认按钮转圈并锁住重复点击。 */
  const [deleting, setDeleting] = useState(false)
  const closeMenu = useCallback(() => {
    setMenu(null)
    setMenuPos(null)
  }, [])
  /**
   * 「标记」类操作统一入口（待办三态 / 置顶会话 / 置顶目录）：这些都是
   * 排序主键，改完该行或该组在列表里换位，整张列表重排，组的默认展示
   * 名额也跟着变（见 defaultShownCount）。这类操作由用户主动发起，视口
   * 应原地不动：置 skip 让 useScrollAnchor 只重选锚点、不做 delta 补偿
   * （滚动容器已关原生锚定，见 HistorySidebar / TopBar）。
   */
  const applyMark = (mutate: () => void) => {
    skipAnchorRef.current = true
    mutate()
    closeMenu()
  }
  const openMenu = (
    m: { kind: 'row'; row: SessionRow } | { kind: 'group'; cwd: string },
    anchor: MenuAnchor,
  ) => {
    setMenuPos(null)
    setMenu(
      m.kind === 'row'
        ? { kind: 'row', row: m.row, ...anchor }
        : { kind: 'group', cwd: m.cwd, ...anchor },
    )
  }
  // 落位按实测尺寸算：菜单高度随条目数在 ~64px（分组两项）到 ~190px（行菜单
  // 六项 + 两条分隔线）之间变，"按行菜单起草"的固定估值夹取会把分组菜单顶到
  // 离光标一百多像素的地方（右键视口底部的分组头时最明显）。
  useLayoutEffect(() => {
    if (!menu) return
    const place = () => {
      const el = menuRef.current
      if (!el) return
      const pad = 8
      const r = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const x = Math.max(pad, Math.min(menu.x, vw - r.width - pad))
      const yDown = menu.y
      const yUp = menu.flipY - r.height
      const y =
        yDown + r.height <= vh - pad ? yDown : yUp >= pad ? yUp : Math.max(pad, vh - r.height - pad)
      setMenuPos({ x, y })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [menu])
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
  }, [menu, closeMenu, listRootRef])
  // Esc also closes the delete-confirm dialog.
  useEffect(() => {
    if (!deleteTarget) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDeleteTarget(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteTarget])
  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return
    const { sessionId, cwd } = deleteTarget
    setDeleting(true)
    try {
      await deleteSession(sessionId, cwd || '')
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  // 空列表且正在拉取：中央显示与 scrollback 一致的加载态（唯一加载
  // 指示；旧数据仍在时列表直接保留，刷新无提示）。标记形态下 sections
  return {
    renamingId,
    renameText,
    setRenameText,
    renameInputRef,
    startRename,
    commitRename,
    cancelRename,
    menu,
    menuPos,
    menuRef,
    openMenu,
    closeMenu,
    applyMark,
    deleteTarget,
    setDeleteTarget,
    deleting,
    confirmDelete,
  }
}
