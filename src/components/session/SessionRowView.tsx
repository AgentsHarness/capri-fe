import type { RefObject } from 'react'
import { Check, Circle, CircleCheck, MoreVertical, Pin } from 'lucide-react'
import { useChatStore } from '../../store/chat'
import { sessionGroupKey, sessionContextPct, sanitizeTitle } from '../../store/historyGroups'
import { usePins } from '../../store/historyPins'
import type { SessionRow } from '../../store/chat/sessionRows'
import { SessionStateIcon } from './SessionStateIcon'
import { stateLabel } from '../../hooks/sessionState'
import { MENU_W } from './sessionListShared'

type MenuAnchor = { x: number; y: number; flipY: number }

type SessionRowViewProps = {
  s: SessionRow
  renamingId: string | null
  renameText: string
  setRenameText: (text: string) => void
  renameInputRef: RefObject<HTMLInputElement | null>
  commitRename: (s: SessionRow) => void
  cancelRename: () => void
  onOpenMenu: (
    target: { kind: 'row'; row: SessionRow } | { kind: 'group'; cwd: string },
    anchor: MenuAnchor,
  ) => void
}

/** 单个会话行：状态列 / 置顶待办徽标 / 行内重命名 / 上下文占用。 */
export function SessionRowView({
  s,
  renamingId,
  renameText,
  setRenameText,
  renameInputRef,
  commitRename,
  cancelRename,
  onOpenMenu,
}: SessionRowViewProps) {
  const sessionId = useChatStore((st) => st.sessionId)
  const historyLoading = useChatStore((st) => st.historyLoading)
  const continueSession = useChatStore((st) => st.continueSession)
  const completedNotices = useChatStore((st) => st.completedNotices)
  const pinnedSessions = usePins((st) => st.pinnedSessions)
  const todos = usePins((st) => st.todos)
                  const active = s.sessionId === sessionId
                  // Row icon follows live state: 处理中 spinner / 待处理
                  // blue diamond / 后台任务 bg 徽标；空闲与仅 bg 的行留空位。
                  const key = sessionGroupKey(s, sessionId)
                  const state = key === 'active' ? 'active' : 'idle'
                  const pending = key === 'awaiting'
                  // ✓ 只留给「别的会话跑完待查看」：当前正在看的会话完成
                  // 时不写 completedNotices（用户就在现场），这里再按
                  // active 兜底，保证当前行永远不画对勾。
                  const completed = completedNotices[s.sessionId] != null && !active
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
                        onOpenMenu(
                          { kind: 'row', row: s },
                          { x: e.clientX, y: e.clientY, flipY: e.clientY },
                        )
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
                          onOpenMenu(
                            { kind: 'row', row: s },
                            { x: r.right - MENU_W, y: r.bottom + 4, flipY: r.top - 4 },
                          )
                        }}
                        className="flex shrink-0 items-center justify-center rounded px-1 text-gn-muted hover:text-gn-fg lg:hidden"
                        title="更多操作"
                        aria-label="更多操作"
                      >
                        <MoreVertical size={13} strokeWidth={2.5} />
                      </button>
                    </div>
                  )
}
