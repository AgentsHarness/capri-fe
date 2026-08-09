import { useEffect, useRef, useState } from 'react'
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

/**
 * Workspace + git + status chips — the whole TUI status-bar row (branch +
 * `~`-shortened cwd on the left, ⠋N / goal / ⠋ MCP / context / queue /
 * todo / credits on the right — TUI status.push order). Click ⠋N toggles
 * the sticky {@link RunningTasksBar} under the bar.
 */
export function WorkspaceBar({ onOpenMcp }: { onOpenMcp?: () => void }) {
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
    <div className="sticky top-0 z-30 shrink-0 bg-gn-bg-base">
      {/* Content column matches scrollback/composer (mx-auto max-w-[960px]).
          Mobile: the row wraps — left (branch/cwd) stays on the first line,
          the chip cluster is one unit that wraps to a right-aligned second
          line instead of overflowing/clipping past the viewport edge. */}
      <div
        className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} flex min-h-[37px] min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-2 text-[14px] select-none`}
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
            turnTokens={usage?.turnTokens}
          />
          <QueueBadge />
          <TodoChip todos={todos} goalState={goalState} />
        </div>
      </div>
      {/* Sticky task rows under the bar (not a floating popup). */}
      <RunningTasksBar entries={entries} topTasks={topTasks} open={tasksOpen} />
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
  const selectedHostId = useChatStore((s) => s.selectedHostId)
  const switchHost = useChatStore((s) => s.switchHost)
  const conn = useChatStore((s) => s.conn)
  const hostError = useChatStore((s) => s.error)
  const hostNotice = useChatStore((s) => s.statusWarning)
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
  // The theme row expands inline (accordion) inside the 更多 menu.
  const [themeExpanded, setThemeExpanded] = useState(false)

  // Host label reflects connection health: abnormal → "connecting" / "error".
  // An active host status message (error / connection warning) replaces the
  // label so it is always visible right where the host is named.
  const notice = hostError || hostNotice
  const hostLabel = notice
    ? `⚠ ${notice}`
    : conn === 'connecting'
      ? 'connecting'
      : conn === 'error' || conn === 'offline'
        ? 'error'
        : hostName || 'Local Host'
  const hostLabelColor = notice
    ? hostError
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
          <button
            type="button"
            onClick={() => setOpenHosts((v) => !v)}
            className={`flex max-w-[40vw] sm:max-w-xs items-center gap-1 truncate rounded px-1.5 py-0.5 hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8 ${hostLabelColor}`}
            title={
              notice
                ? `${notice}${hostName ? ` · ${hostName}` : ''}`
                : conn === 'connecting' || conn === 'error' || conn === 'offline'
                  ? `连接状态: ${conn}${hostName ? ` · ${hostName}` : ''}`
                  : hostName || 'Local Host'
            }
          >
            <span className="truncate">{hostLabel}</span>
            <span className="text-gn-gutter">▾</span>
          </button>
          {openHosts && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-30 cursor-default"
                aria-label="close"
                onClick={() => setOpenHosts(false)}
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
                    <button
                      key={h.hostId}
                      type="button"
                      onClick={() => {
                        setOpenHosts(false)
                        void switchHost(h.hostId)
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-gn-bg-highlight ${current ? 'bg-gn-bg-highlight' : ''}`}
                      title={h.online ? `切换到 ${h.hostName}` : `${h.hostName}（离线）`}
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
                  )
                })}
                <div className="border-t border-gn-prompt-border px-3 py-2 text-[11px] text-gn-muted leading-snug">
                  {hosts.length > 1 || (hosts.length === 1 && !hosts[0].local)
                    ? '经 acp-hub 中转 · 点击切换 Host'
                    : '本地模式 · 直连 acp-host'}
                </div>
              </div>
            </>
          )}
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
            title="设置（F2 · config.toml 只读展示）"
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
            onClick={() => (historyOpen ? closeHistory() : void openHistory())}
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
                onClick={closeHistory}
              />
              {/* Mobile dropdown — renders the SAME workspace-grouped list as
                  the desktop sidebar (SessionHistoryList), so the two ends
                  stay in sync (分组 / 折叠 / 加载更多 / 重命名 / 删除).
                  Width is viewport-capped: right-anchored to the history
                  button, a fixed w-80 would poke past the LEFT edge on
                  narrow phones (320px). */}
              <div
                className="absolute right-0 top-full z-40 mt-1 max-h-[70vh] w-[min(84vw,20rem)] overflow-y-auto rounded border border-gn-prompt-border bg-gn-bg-base shadow-xl isolate"
                style={{ backgroundColor: 'var(--color-gn-bg-base)' }}
              >
                <SessionHistoryList />
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
                  title="设置（F2 · config.toml 只读展示）"
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
