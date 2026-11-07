import type { RefObject } from 'react'
import { ChevronDown, ChevronRight, MoreVertical, Pin } from 'lucide-react'
import { useChatStore } from '../../store/chat'
import { sessionGroupKey } from '../../store/historyGroups'
import { usePins } from '../../store/historyPins'
import type { SessionRow } from '../../store/chat/sessionRows'
import { SessionStateIcon } from './SessionStateIcon'
import { SessionRowView } from './SessionRowView'
import { LOAD_MORE_STEP, MENU_W, type ListSection } from './sessionListShared'

type MenuAnchor = { x: number; y: number; flipY: number }

type SessionSectionProps = {
  g: ListSection
  isCollapsed: boolean
  defaultShown: number
  shown: number
  renamingId: string | null
  renameText: string
  setRenameText: (text: string) => void
  renameInputRef: RefObject<HTMLInputElement | null>
  commitRename: (s: SessionRow) => void
  cancelRename: () => void
  onToggleGroup: (key: string) => void
  onExpandMore: (key: string) => void
  onCollapseMore: (key: string) => void
  onOpenMenu: (
    target: { kind: 'row'; row: SessionRow } | { kind: 'group'; cwd: string },
    anchor: MenuAnchor,
  ) => void
}

/** 一个列表分区：sticky 组头 + 可见行 + 「收起 / 显示更多」。 */
export function SessionSection({
  g,
  isCollapsed,
  defaultShown,
  shown,
  renamingId,
  renameText,
  setRenameText,
  renameInputRef,
  commitRename,
  cancelRename,
  onToggleGroup,
  onExpandMore,
  onCollapseMore,
  onOpenMenu,
}: SessionSectionProps) {
  const sessionId = useChatStore((st) => st.sessionId)
  const pinnedWorkspaces = usePins((st) => st.pinnedWorkspaces)
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
                onClick={() => onToggleGroup(g.key)}
                onContextMenu={(e) => {
                  // Right-click a workspace group → "新建会话在此目录".
                  // Marked sections have no group-level actions.
                  if (!isWorkspace || !g.cwd) return
                  e.preventDefault()
                  e.stopPropagation()
                  onOpenMenu(
                    { kind: 'group', cwd: g.cwd },
                    { x: e.clientX, y: e.clientY, flipY: e.clientY },
                  )
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
                    onOpenMenu(
                      { kind: 'group', cwd: g.cwd! },
                      { x: r.right - MENU_W, y: r.bottom + 4, flipY: r.top - 4 },
                    )
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
                {rows.map((s) => (
                  <SessionRowView
                    key={s.sessionId}
                    s={s}
                    renamingId={renamingId}
                    renameText={renameText}
                    setRenameText={setRenameText}
                    renameInputRef={renameInputRef}
                    commitRename={commitRename}
                    cancelRename={cancelRename}
                    onOpenMenu={onOpenMenu}
                  />
                ))}
                {g.sessions.length > defaultShown && (
                  <div className="flex">
                    {shown > defaultShown && (
                      <button
                        type="button"
                        onClick={() => onCollapseMore(g.key)}
                        className="flex flex-1 cursor-pointer items-center justify-center gap-2 px-3 py-1 text-center text-[10.5px] text-gn-muted hover:bg-gn-bg-highlight"
                        title={`收起为最近 ${defaultShown} 个会话`}
                      >
                        收起
                      </button>
                    )}
                    {g.sessions.length > shown && (
                      <button
                        type="button"
                        onClick={() => onExpandMore(g.key)}
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
}
