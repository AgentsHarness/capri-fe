import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  Circle,
  CircleCheck,
  CircleOff,
  ChevronRight,
  Pencil,
  Pin,
  Plus,
  Share2,
  Trash2,
  X,
} from 'lucide-react'
import { useChatStore } from '../../store/chat'
import { sessionGroupKey } from '../../store/historyGroups'
import { usePins } from '../../store/historyPins'
import { openShareGuest } from '../../lib/shareGuestTarget'
import { Spinner } from '../ui/Spinner'
import { MENU_W } from './sessionListShared'
import type { MenuState } from './useSessionListMenu'
import type { SessionRow } from '../../store/chat/sessionRows'

type SessionListMenuProps = {
  menu: MenuState | null
  menuPos: { x: number; y: number } | null
  menuRef: RefObject<HTMLDivElement | null>
  closeMenu: () => void
  startRename: (s: { sessionId: string; title?: string }) => void
  applyMark: (mutate: () => void) => void
  canShare: boolean
  shareHint: string
  deleteTarget: SessionRow | null
  setDeleteTarget: (row: SessionRow | null) => void
  deleting: boolean
  confirmDelete: () => Promise<void>
}

/** 行 / 分组操作菜单（portal）与删除确认弹窗。 */
export function SessionListMenu({
  menu,
  menuPos,
  menuRef,
  closeMenu,
  startRename,
  applyMark,
  canShare,
  shareHint,
  deleteTarget,
  setDeleteTarget,
  deleting,
  confirmDelete,
}: SessionListMenuProps) {
  const sessionId = useChatStore((s) => s.sessionId)
  const selectedHostId = useChatStore((s) => s.selectedHostId)
  const hostName = useChatStore((s) => s.hostName)
  const continueSession = useChatStore((s) => s.continueSession)
  const newSession = useChatStore((s) => s.newSession)
  const pinnedSessions = usePins((s) => s.pinnedSessions)
  const pinnedWorkspaces = usePins((s) => s.pinnedWorkspaces)
  const todos = usePins((s) => s.todos)
  const toggleSessionPin = usePins((s) => s.toggleSessionPin)
  const toggleWorkspacePin = usePins((s) => s.toggleWorkspacePin)
  const setTodoStatus = usePins((s) => s.setTodoStatus)

  return (
    <>
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
              ref={menuRef}
              className="absolute overflow-hidden gn-menu"
              style={{ left: menuPos?.x ?? menu.x, top: menuPos?.y ?? menu.y, width: MENU_W }}
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
                    disabled={!canShare}
                    disabledTitle={shareHint}
                    onClick={() => {
                      const host = useChatStore
                        .getState()
                        .hosts.find((h) => h.hostId === selectedHostId)
                      openShareGuest({
                        hostId: selectedHostId ?? '',
                        hostName: host?.hostName || hostName || 'Host',
                        sessionId: menu.row.sessionId,
                        cwd: menu.row.cwd || '',
                        ...(menu.row.title ? { title: menu.row.title } : {}),
                      })
                      closeMenu()
                    }}
                  >
                    <span aria-hidden className="inline-block w-4 shrink-0 text-center">
                      <Share2 size={14} strokeWidth={2.5} />
                    </span>{' '}
                    分享只读链接
                  </MenuItem>
                  <MenuItem
                    onClick={() => applyMark(() => toggleSessionPin(menu.row.sessionId))}
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
                              applyMark(() => setTodoStatus(menu.row.sessionId, 'completed'))
                            }}
                          >
                            <span aria-hidden className="inline-block w-4 shrink-0 text-center text-gn-green">
                              <CircleCheck size={14} strokeWidth={2.5} />
                            </span>{' '}
                            标记已完成
                          </MenuItem>
                          <MenuItem
                            onClick={() => {
                              applyMark(() => setTodoStatus(menu.row.sessionId, null))
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
                              applyMark(() => setTodoStatus(menu.row.sessionId, 'todo'))
                            }}
                          >
                            <span aria-hidden className="inline-block w-4 shrink-0 text-center text-gn-yellow">
                              <Circle size={14} strokeWidth={2.5} />
                            </span>{' '}
                            标记为待办
                          </MenuItem>
                          <MenuItem
                            onClick={() => {
                              applyMark(() => setTodoStatus(menu.row.sessionId, null))
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
                            applyMark(() => setTodoStatus(menu.row.sessionId, 'todo'))
                          }}
                        >
                          <span aria-hidden className="inline-block w-4 shrink-0 text-center text-gn-yellow">
                            <Circle size={14} strokeWidth={2.5} />
                          </span>{' '}
                          设为待办
                        </MenuItem>
                        <MenuItem
                          onClick={() => {
                            applyMark(() => setTodoStatus(menu.row.sessionId, 'completed'))
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
                    onClick={() => applyMark(() => toggleWorkspacePin(menu.cwd))}
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
                  disabled={deleting}
                  onClick={() => setDeleteTarget(null)}
                  className="min-h-8 rounded bg-gn-bg-base px-3 py-1 text-[12px] text-gn-fg2 hover:bg-gn-bg-highlight disabled:cursor-not-allowed disabled:opacity-40"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => void confirmDelete()}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded bg-gn-diff-del-bg px-3 py-1 text-[12px] font-semibold text-gn-red hover:bg-gn-red/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {deleting ? <Spinner size={11} /> : null}
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
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${ disabled ? 'cursor-not-allowed text-gn-gutter opacity-50' : danger ? 'text-gn-red hover:bg-gn-diff-del-bg' : 'text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg' }`}
    >
      {children}
    </button>
  )
}
