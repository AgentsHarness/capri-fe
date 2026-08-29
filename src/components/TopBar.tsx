import { useEffect, useRef, useState, type Ref } from 'react'
import {
  Activity,
  Boxes,
  GitBranch,
  History,
  Plus,
  Puzzle,
  Settings,
} from 'lucide-react'
import { useChatStore } from '../store/chat'
import { ThemeOptions, ThemePicker } from './ThemePicker'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../theme/layout'
import { SessionHistoryList } from './SessionHistoryList'
import { SessionListHeader } from './SessionListHeader'
import { SessionSearchBox } from './SessionSearchBox'
import {
  ContextChip,
  GoalChip,
  McpChip,
  QueueBadge,
  RunningChip,
  RunningTasksBar,
  TodoChip,
} from './StatusChips'
import { filterRunningEntries, shortCwd } from '../format'
import type { HostInfo } from '../api/types'
import {
  AddHostModal,
  DeleteHostModal,
  HostActionsMenu,
  RenameHostModal,
  RestartAgentModal,
} from './HostActions'

/** 菜单打开位置边缘夹取：菜单宽 ~184px、高 ~80px，贴着视口边缘。 */
function clampMenuPos(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(4, Math.min(x, window.innerWidth - 188)),
    y: Math.max(4, Math.min(y, window.innerHeight - 136)),
  }
}

/**
 * Workspace + git + status chips — the whole TUI status-bar row (branch +
 * `~`-shortened cwd on the left, ⠋N / goal / ⠋ MCP / context / queue /
 * todo / credits on the right — TUI status.push order). Click ⠋N toggles
 * the sticky {@link RunningTasksBar} under the bar.
 */
export function WorkspaceBar({
  onOpenMcp,
  topRef,
  fadeHidden,
}: {
  onOpenMcp?: () => void
  /** Scrollback measures this sticky bar's rendered height to offset the
   *  pinned user-prompt header below it (grows with the tasks bar). */
  topRef?: Ref<HTMLDivElement>
  /** 会话切换加载中（historyLoading）栏内内容淡出：git branch / cwd /
   *  状态芯片等旧会话数据不属于新会话，加载完毕再淡入。栏本身（背景
   *  条）保持常驻可见、高度不变。隐藏期间不可交互、不可聚焦、不进
   *  无障碍树。 */
  fadeHidden?: boolean
}) {
  const gitInfo = useChatStore((s) => s.gitInfo)
  const cwd = useChatStore((s) => s.cwd)
  const homeDir = useChatStore((s) => s.homeDir)
  const usage = useChatStore((s) => s.usage)
  const goalState = useChatStore((s) => s.goalState)
  const todos = useChatStore((s) => s.todos)
  const entries = useChatStore((s) => s.entries)
  const topTasks = useChatStore((s) => s.topTasks)
  const scheduledTasks = useChatStore((s) => s.scheduledTasks)
  const models = useChatStore((s) => s.models)
  const modelName = useChatStore((s) => s.modelName)

  // ⠋N toggles sticky task list (also opened by the composer's idle
  // still-running cue — shared store flag). Auto-open when the first task
  // appears (TUI opened_by_auto) or the first scheduled task lands; user
  // hide stays until they click again or everything finishes and a new
  // one starts. Restored top-strip tasks count.
  const tasksOpen = useChatStore((s) => s.tasksBarOpen)
  const setTasksBarOpen = useChatStore((s) => s.setTasksBarOpen)
  const prevCount = useRef(0)
  const prevScheduled = useRef(0)
  const runningCount = filterRunningEntries(entries).length + topTasks.length
  useEffect(() => {
    if (runningCount > 0 && prevCount.current === 0) {
      setTasksBarOpen(true)
    }
    if (scheduledTasks.length > 0 && prevScheduled.current === 0) {
      setTasksBarOpen(true)
    }
    if (runningCount === 0 && scheduledTasks.length === 0) {
      setTasksBarOpen(false)
    }
    prevCount.current = runningCount
    prevScheduled.current = scheduledTasks.length
  }, [runningCount, scheduledTasks.length, setTasksBarOpen])

  // z-30 above scrollback sticky user prompt (z-10) so todo/goal
  // dropdowns aren't covered when the sticky header is pinned.
  return (
    <div ref={topRef} className="sticky top-0 z-30 shrink-0 bg-gn-bg-base">
      {/* Content column matches scrollback/composer (mx-auto max-w-[960px]).
          Mobile: the row wraps — left (branch/cwd) stays on the first line,
          the chip cluster is one unit that wraps to a right-aligned second
          line instead of overflowing/clipping past the viewport edge.
          会话切换加载中（historyLoading）只有栏内内容淡出：栏本身保持
          常驻可见，高度不变（min-h 仍在布局里），wsBarH 连续测量，
          钉住的用户提示头始终与栏底齐平。 */}
      <div
        className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} flex min-h-[37px] min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-2 text-[14px] select-none transition-opacity duration-300 ${
          fadeHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
        }`}
        aria-hidden={fadeHidden || undefined}
        inert={fadeHidden || undefined}
      >
        {/* Git head (x.ai/git_head_changed) — TUI status-bar branch.
            Detached HEAD renders as "⎇ detached" (TUI render.rs: empty
            branch → "{icon} detached"); worktrees get the `wt` badge. */}
        {gitInfo?.branch ? (
          <span
            className="flex min-w-0 max-w-[18vw] items-center gap-1 truncate font-mono text-[13px] text-gn-cyan sm:max-w-[24vw]"
            title={
              gitInfo.isWorktree
                ? `${gitInfo.branch} · worktree${gitInfo.mainRepo ? ` of ${gitInfo.mainRepo}` : ''}`
                : gitInfo.branch
            }
          >
            <span className="shrink-0 text-gn-cyan" aria-hidden>
              ⎇
            </span>
            <span className="truncate">
              {gitInfo.branch === '(detached)' ? 'detached' : gitInfo.branch}
            </span>
            {gitInfo.isWorktree && <span className="shrink-0 text-gn-gutter">wt</span>}
          </span>
        ) : null}

        {/* Active session workspace — TUI status-bar path, `~`-shortened.
            Linked worktrees append "(worktree of <main>)" after the path
            (TUI render.rs cwd_line suffix), using the host-reported main
            repo when present. */}
        {cwd ? (
          <span
            className="flex min-w-0 max-w-[30vw] items-center truncate font-mono text-[13px] text-gn-gray-dim sm:max-w-[52vw]"
            title={cwd}
          >
            {shortCwd(cwd, homeDir)}
            {gitInfo?.isWorktree && gitInfo.mainRepo ? (
              <span
                className="min-w-0 max-w-[10vw] truncate sm:max-w-[16vw]"
                title={gitInfo.mainRepo}
              >
                {' '}
                (worktree of {shortCwd(gitInfo.mainRepo, homeDir)})
              </span>
            ) : null}
          </span>
        ) : null}

        {/* Chip cluster — right-aligned; wraps as a unit onto a second
            line on narrow screens (never clips past the viewport edge).
            max-w-full caps the cluster at the row width so its chips wrap
            internally instead of stretching the page (flex min-content). */}
        <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
          {/* ⠋N toggles sticky task list · goal · ⠋ MCP · context · queue · todo · credits
              (TUI status.push order: bg_tasks → goal → mcp → context → queue → badge → credits) */}
          <RunningChip
            entries={entries}
            topTasks={topTasks}
            open={tasksOpen}
            onToggle={() => setTasksBarOpen(!tasksOpen)}
          />
          <GoalChip goalState={goalState} contextUsed={usage?.used} />
          {onOpenMcp && <McpChip onOpen={onOpenMcp} />}
          <ContextChip
            used={usage?.used}
            size={
              usage?.size ??
              (models.find((m) => m.name === modelName)?.contextWindow ??
                models[0]?.contextWindow)
            }
          />
          <QueueBadge />
          <TodoChip todos={todos} goalState={goalState} />
        </div>
      </div>
      {/* Sticky task rows under the bar (not a floating popup).
          会话切换加载中随栏内内容一起淡出（旧会话任务不属于新会话）。 */}
      <div
        className={`transition-opacity duration-300 ${
          fadeHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
        }`}
        aria-hidden={fadeHidden || undefined}
        inert={fadeHidden || undefined}
      >
        <RunningTasksBar entries={entries} topTasks={topTasks} open={tasksOpen} />
      </div>
    </div>
  )
}

/**
 * Minimal top chrome — closer to TUI status (gray on bg_base) than a fat web header.
 * Host switcher pre-wired for multi-host; git branch + session actions
 * (fork / rename / recap) live off the x.ai extension surface.
 */
export function TopBar({
  onOpenMcp,
  onOpenGit,
}: {
  onOpenMcp?: () => void
  onOpenGit?: () => void
}) {
  const hostName = useChatStore((s) => s.hostName)
  const hostId = useChatStore((s) => s.hostId)
  const hosts = useChatStore((s) => s.hosts)
  const mode = useChatStore((s) => s.mode)
  const selectedHostId = useChatStore((s) => s.selectedHostId)
  const switchHost = useChatStore((s) => s.switchHost)
  const conn = useChatStore((s) => s.conn)
  const layerErrors = useChatStore((s) => s.layerErrors)
  const resetToEmpty = useChatStore((s) => s.resetToEmpty)
  const historyOpen = useChatStore((s) => s.historyOpen)
  const openHistory = useChatStore((s) => s.openHistory)
  const closeHistory = useChatStore((s) => s.closeHistory)
  const openExtensions = useChatStore((s) => s.openExtensions)
  const openSettings = useChatStore((s) => s.openSettings)
  const openUsage = useChatStore((s) => s.openUsage)
  const sidebarCollapsed = useChatStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useChatStore((s) => s.toggleSidebar)

  const [openHosts, setOpenHosts] = useState(false)
  // Mobile (lg:hidden) "更多" menu — the secondary action buttons fold
  // into one ⋮ trigger; clicking expands them vertically.
  const [moreOpen, setMoreOpen] = useState(false)
  // history 下拉的会话搜索（与桌面侧边栏同一套 SessionSearchBox：按钮
  // 展开 → 命中接管列表；打开命中或收起下拉后归位）。
  const [historySearchOpen, setHistorySearchOpen] = useState(false)
  const [historySearchActive, setHistorySearchActive] = useState(false)
  // 收起下拉同时归位搜索：下次打开回到紧凑列表态。
  const closeMobileHistory = () => {
    closeHistory()
    setHistorySearchOpen(false)
    setHistorySearchActive(false)
  }
  // The theme row expands inline (accordion) inside the 更多 menu.
  const [themeExpanded, setThemeExpanded] = useState(false)
  // 单个 host 的操作菜单（右键 / 行内 ⋮ 打开，fixed 坐标）。
  const [menuHost, setMenuHost] = useState<{ host: HostInfo; pos: { x: number; y: number } } | null>(null)
  // 添加 Host（配对码）模态框。
  const [addHostOpen, setAddHostOpen] = useState(false)
  // 修改名称 / 删除 / 重启确认的目标 host。
  const [renameTarget, setRenameTarget] = useState<HostInfo | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<HostInfo | null>(null)
  const [restartTarget, setRestartTarget] = useState<HostInfo | null>(null)
  // 当前选中的 host（右键左上角开关直接对当前 host 弹菜单）。
  const currentHost =
    hosts.find((h) => h.hostId === selectedHostId) ??
    (hosts.length ? hosts[0] : null)

  // Host label reflects connection health: abnormal → "connecting" / "error".
  // 分层横幅（hub/host 层错误）存在时，label 只显示简短 ⚠ 状态——完整
  // 消息在顶部横幅（ErrorBanner），避免长文本截断与多入口重复。
  const layerErr = layerErrors.host ?? layerErrors.hub
  const hostLabel = layerErr
    ? `⚠ ${layerErr.level === 'error' ? '异常' : '警告'}`
    : conn === 'connecting'
      ? 'connecting'
      : conn === 'error' || conn === 'offline'
        ? 'error'
        : hostName || 'Local Host'
  const hostLabelColor = layerErr
    ? layerErr.level === 'error'
      ? 'text-gn-red'
      : 'text-gn-warning'
    : conn === 'connecting'
      ? 'text-gn-muted'
      : conn === 'error' || conn === 'offline'
        ? 'text-gn-red'
        : ''

  // relative z-40 so host/history/more dropdowns stack above WorkspaceBar
  // (sticky z-30) and scrollback sticky prompts (z-10). Without a stacking
  // context on this chrome, absolute z-40 children still lose to later
  // siblings and chat text "shows through" the history panel.
  return (
    <header className="relative z-40 select-none border-b border-gn-prompt-border bg-gn-bg-base">
      {/* Main row: host switcher + actions. */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-[6px] sm:px-4 text-[12px] text-gn-muted">
        {/* Desktop-only sidebar collapse toggle — sits left of the host switcher. */}
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? '展开会话侧边栏' : '折叠会话侧边栏'}
          title={sidebarCollapsed ? '展开会话侧边栏' : '折叠会话侧边栏'}
          className="hidden min-h-8 items-center rounded px-1.5 hover:bg-gn-bg-highlight hover:text-gn-fg lg:inline-flex"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            className="shrink-0"
            aria-hidden
          >
            <rect x="1.2" y="2.2" width="11.6" height="9.6" rx="1" />
            <line x1="5" y1="2.2" x2="5" y2="11.8" />
            <path d="M2.4 5h1.4M2.4 8h1.4" />
          </svg>
        </button>
        <div className="relative min-w-0">
          {mode === 'local' ? (
            // 本地模式：锁定本机 —— 静态 Localhost 标签，不可点击、无下拉。
            <div
              className="flex min-h-8 max-w-[40vw] items-center gap-1 truncate rounded px-1.5 py-0.5 sm:max-w-xs"
              title="本地模式（仅本机 capri-host，无 host 切换）"
            >
              <span className="truncate text-gn-fg">Localhost</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setOpenHosts((v) => !v)}
              onContextMenu={(e) => {
                // 网页端：右键当前 host 直接弹操作菜单（修改 / 删除）。
                e.preventDefault()
                if (currentHost) {
                  setMenuHost({ host: currentHost, pos: clampMenuPos(e.clientX, e.clientY) })
                } else {
                  setOpenHosts(true)
                }
              }}
              className={`flex max-w-[40vw] sm:max-w-xs items-center gap-1 truncate rounded px-1.5 py-0.5 hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8 ${hostLabelColor}`}
              title={
                layerErr
                  ? `${layerErr.message}${hostName ? ` · ${hostName}` : ''}`
                  : conn === 'connecting' || conn === 'error' || conn === 'offline'
                    ? `连接状态: ${conn}${hostName ? ` · ${hostName}` : ''}`
                    : `${hostName || 'Local Host'}（右键可管理 Host）`
              }
            >
              <span className="truncate">{hostLabel}</span>
              <span className="text-gn-gutter">▾</span>
            </button>
          )}
          {openHosts && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-30 cursor-default"
                aria-label="close"
                onClick={() => {
                  setOpenHosts(false)
                  setMenuHost(null)
                }}
              />
              <div className="absolute left-0 top-full z-40 mt-1 w-64 max-w-[90vw] rounded border border-gn-prompt-border bg-gn-bg-base shadow-xl py-1">
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gn-gutter">
                  hosts
                </div>
                {(hosts.length
                  ? hosts
                  : [{ hostId: hostId || 'local', hostName: hostName || 'Local Host', online: true }]
                ).map((h) => {
                  const current = h.hostId === selectedHostId
                  return (
                    <div
                      key={h.hostId}
                      className="group/host relative"
                      onContextMenu={(e) => {
                        // 网页端：右键任意 host 行弹操作菜单。
                        e.preventDefault()
                        setMenuHost({ host: h, pos: clampMenuPos(e.clientX, e.clientY) })
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setMenuHost(null)
                          setOpenHosts(false)
                          void switchHost(h.hostId)
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-2 pr-9 text-left text-[12px] hover:bg-gn-bg-highlight ${current ? 'bg-gn-bg-highlight' : ''}`}
                        title={
                          h.online
                            ? `切换到 ${h.hostName}（右键可管理）`
                            : `${h.hostName}（离线）`
                        }
                      >
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${h.online ? 'bg-gn-green' : 'bg-gn-muted'}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-gn-fg">
                            {h.hostName}
                            {current && <span className="ml-1.5 text-[10px] text-gn-cyan">当前</span>}
                          </div>
                          <div className="truncate font-mono text-[10px] text-gn-muted">{h.hostId}</div>
                        </div>
                      </button>
                      {/* 行内 ⋮ 菜单图标：移动端（无右键）的主要入口，桌面端悬停可见。 */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          const r = e.currentTarget.getBoundingClientRect()
                          setMenuHost(
                            menuHost?.host.hostId === h.hostId
                              ? null
                              : { host: h, pos: clampMenuPos(r.right - 176, r.bottom + 2) },
                          )
                        }}
                        aria-label={`${h.hostName} 操作`}
                        title="修改 / 删除"
                        className={`absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-gn-gutter hover:bg-gn-bg-highlight hover:text-gn-fg lg:opacity-0 lg:group-hover/host:opacity-100 ${menuHost?.host.hostId === h.hostId ? 'lg:opacity-100' : ''}`}
                      >
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          aria-hidden
                        >
                          <circle cx="3.2" cy="8" r="1.4" />
                          <circle cx="8" cy="8" r="1.4" />
                          <circle cx="12.8" cy="8" r="1.4" />
                        </svg>
                      </button>
                    </div>
                  )
                })}
                <div className="border-t border-gn-prompt-border py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setOpenHosts(false)
                      setAddHostOpen(true)
                    }}
                    className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                    title="获取新配对码，在另一台机器上接入 hub"
                  >
                    <Plus size={13} strokeWidth={2} aria-hidden />
                    添加 Host
                  </button>
                </div>
              </div>
            </>
          )}
          {/* 单个 host 的操作菜单：右键（网页）/ ⋮ 图标（移动端）打开。 */}
          {menuHost && (
            <HostActionsMenu
              host={menuHost.host}
              pos={menuHost.pos}
              onClose={() => setMenuHost(null)}
              onRename={(h) => {
                setMenuHost(null)
                setRenameTarget(h)
              }}
              onDelete={(h) => {
                setMenuHost(null)
                setDeleteTarget(h)
              }}
              onRestart={(h) => {
                setMenuHost(null)
                setRestartTarget(h)
              }}
              // 重启作用于当前选中 host 的 agent（transport 按选中
              // host 路由）；非当前 host 行不显示重启项，避免误解。
              canRestart={menuHost.host.hostId === selectedHostId}
            />
          )}
          {renameTarget && (
            <RenameHostModal host={renameTarget} onClose={() => setRenameTarget(null)} />
          )}
          {deleteTarget && (
            <DeleteHostModal host={deleteTarget} onClose={() => setDeleteTarget(null)} />
          )}
          {restartTarget && (
            <RestartAgentModal host={restartTarget} onClose={() => setRestartTarget(null)} />
          )}
          {addHostOpen && <AddHostModal onClose={() => setAddHostOpen(false)} />}
        </div>

        <div className="flex-1" />

        {/* Desktop-only inline actions — on mobile they fold into the ⋮ menu below. */}
        <div className="hidden items-center gap-2 lg:flex">
          <ThemePicker />
          {onOpenMcp && (
            <button
              type="button"
              onClick={onOpenMcp}
              className="inline-flex items-center gap-1 rounded border border-transparent px-2 py-0.5 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
              title="MCP 服务器状态"
            >
              <Boxes size={13} strokeWidth={2} aria-hidden />
              mcp
            </button>
          )}
          {onOpenGit && (
            <button
              type="button"
              onClick={onOpenGit}
              className="inline-flex items-center gap-1 rounded border border-transparent px-2 py-0.5 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
              title="Git 面板 — 工作区状态 / diff / 提交"
            >
              <GitBranch size={13} strokeWidth={2} aria-hidden />
              git
            </button>
          )}
          <button
            type="button"
            onClick={() => openExtensions('hooks')}
            className="inline-flex items-center gap-1 rounded border border-transparent px-2 py-0.5 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
            title="扩展（/hooks /plugins /skills /marketplace）"
          >
            <Puzzle size={13} strokeWidth={2} aria-hidden />
            ext
          </button>
          <button
            type="button"
            onClick={openUsage}
            className="inline-flex items-center gap-1 rounded border border-transparent px-2 py-0.5 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
            title="usage — token 用量聚合（按模型/时间窗口）+ billing credits"
          >
            <Activity size={13} strokeWidth={2} aria-hidden />
            usage
          </button>
          <button
            type="button"
            onClick={openSettings}
            className="inline-flex items-center gap-1 rounded border border-transparent px-2 py-0.5 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
            title="设置（F2）"
          >
            <Settings size={13} strokeWidth={2} aria-hidden />
            settings
          </button>
        </div>
        {/* Mobile-only new — sits left of history (no ⋮ dive needed).
            Desktop relies on the sidebar "会话 new" header button. */}
        <div className="lg:hidden">
          <button
            type="button"
            onClick={() => resetToEmpty()}
            className="inline-flex items-center gap-1 rounded border border-transparent px-2 py-0.5 min-h-8 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg"
            title="新建会话（先进入空状态选择工作目录）"
          >
            <Plus size={13} strokeWidth={2} aria-hidden />
            new
          </button>
        </div>
        {/* Mobile-only history trigger — desktop history lives in the persistent left sidebar. */}
        <div className="relative lg:hidden">
          <button
            type="button"
            onClick={() => (historyOpen ? closeMobileHistory() : void openHistory())}
            className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 min-h-8 ${
              historyOpen
                ? 'border-gn-prompt-border bg-gn-bg-highlight text-gn-fg'
                : 'border-transparent hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg'
            }`}
            title="加载历史会话"
          >
            <History size={13} strokeWidth={2} aria-hidden />
            history
          </button>
          {historyOpen && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-30 cursor-default"
                aria-label="close"
                onClick={closeMobileHistory}
              />
              {/* Mobile dropdown — renders the SAME workspace-grouped list as
                  the desktop sidebar (SessionHistoryList), so the two ends
                  stay in sync (分组 / 折叠 / 加载更多 / 重命名 / 删除)，
                  plus the same「会话 + 刷新 + 搜索」header
                  (SessionListHeader). Session search mirrors the desktop
                  sidebar: button → SessionSearchBox replaces the grouped
                  list while a query is active; opening a hit also closes
                  the dropdown.
                  Width is viewport-capped: right-anchored to the history
                  button, a fixed w-80 would poke past the LEFT edge on
                  narrow phones (320px). Header is outside the scroll area
                  (flex-col) so the list's sticky group headers stick below
                  it instead of sliding underneath. */}
              <div
                className="absolute right-0 top-full z-40 mt-1 flex max-h-[70vh] w-[min(84vw,20rem)] flex-col overflow-hidden rounded border border-gn-prompt-border bg-gn-bg-base shadow-xl isolate"
                style={{ backgroundColor: 'var(--color-gn-bg-base)' }}
              >
                {/* py-1.5（非 py-2）：给 labeled 大按钮留高度的同时，
                    头部总高保持 37px 不变。 */}
                <div className="flex min-h-[37px] shrink-0 items-center gap-2 border-b border-gn-prompt-border px-3 py-1.5">
                  <SessionListHeader
                    alignRight
                    labeled
                    searchOpen={historySearchOpen}
                    onToggleSearch={() => setHistorySearchOpen((v) => !v)}
                  />
                </div>
                {historySearchOpen && (
                  <SessionSearchBox
                    onActive={setHistorySearchActive}
                    onRequestClose={() => {
                      // 打开命中后：搜索归位，下拉一并收起（会话已切换）。
                      setHistorySearchOpen(false)
                      setHistorySearchActive(false)
                      closeHistory()
                    }}
                  />
                )}
                <div className="gn-no-scrollbar min-h-0 overflow-y-auto">
                  {historySearchOpen && historySearchActive ? null : <SessionHistoryList />}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Mobile-only "更多" — the secondary action buttons fold into one ⋮
            trigger; clicking expands them vertically under the button. */}
        <div className="relative lg:hidden">
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-label="更多操作"
            title="更多操作：theme / mcp / git / ext / settings"
            className={`rounded border px-2 py-0.5 min-h-8 ${
              moreOpen
                ? 'border-gn-prompt-border bg-gn-bg-highlight text-gn-fg'
                : 'border-transparent hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg'
            }`}
          >
            ⋮
          </button>
          {moreOpen && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-30 cursor-default"
                aria-label="close"
                onClick={() => setMoreOpen(false)}
              />
              <div className="absolute right-0 top-full z-40 mt-1 max-h-[70vh] w-64 max-w-[90vw] overflow-y-auto rounded border border-gn-prompt-border bg-gn-bg-base shadow-xl py-1">
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gn-gutter">
                  more
                </div>
                {/* theme — inline accordion, same options as the desktop picker. */}
                <button
                  type="button"
                  onClick={() => setThemeExpanded((v) => !v)}
                  className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title={themeExpanded ? '收起主题选项' : '展开主题选项'}
                >
                  <span className="min-w-0 flex-1">theme</span>
                  <span className="shrink-0 text-gn-gutter" aria-hidden>
                    {themeExpanded ? '▴' : '▾'}
                  </span>
                </button>
                {themeExpanded && (
                  <div className="border-t border-gn-prompt-border/60 py-1">
                    <ThemeOptions
                      onSelect={() => {
                        setMoreOpen(false)
                        setThemeExpanded(false)
                      }}
                    />
                  </div>
                )}
                {onOpenMcp && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false)
                      onOpenMcp()
                    }}
                    className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                    title="MCP 服务器状态"
                  >
                    <Boxes size={14} strokeWidth={2} aria-hidden />
                    mcp
                  </button>
                )}
                {onOpenGit && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false)
                      onOpenGit()
                    }}
                    className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                    title="Git 面板 — 工作区状态 / diff / 提交"
                  >
                    <GitBranch size={14} strokeWidth={2} aria-hidden />
                    git
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false)
                    openExtensions('hooks')
                  }}
                  className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="扩展（/hooks /plugins /skills /marketplace）"
                >
                  <Puzzle size={14} strokeWidth={2} aria-hidden />
                  ext
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false)
                    openUsage()
                  }}
                  className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="usage — token 用量聚合（按模型/时间窗口）+ billing credits"
                >
                  <Activity size={14} strokeWidth={2} aria-hidden />
                  usage
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false)
                    openSettings()
                  }}
                  className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="设置（F2）"
                >
                  <Settings size={14} strokeWidth={2} aria-hidden />
                  settings
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
