import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import { ThemePicker } from './ThemePicker'
import { fmtTime, groupAccentClass, groupByState, sessionGroupKey, sessionSubtitle } from './historyGroups'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../theme/layout'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { SessionStateIcon } from './SessionStateIcon'
import { stateLabel, useSessionSpinner } from './sessionState'
import {
  ContextChip,
  CreditsChip,
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
      {/* Content column matches scrollback/composer (mx-auto max-w-[960px]) */}
      <div
        className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} flex min-w-0 items-center gap-2 py-1 text-[14px] select-none`}
      >
        {/* Git head (x.ai/git_head_changed) — TUI status-bar branch.
            Detached HEAD renders as "⎇ detached" (TUI render.rs: empty
            branch → "{icon} detached"); worktrees get the `wt` badge. */}
        {gitInfo?.branch ? (
          <span
            className="flex min-w-0 max-w-[24vw] items-center gap-1 truncate font-mono text-[13px] text-gn-cyan"
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
            className="flex min-w-0 max-w-[38vw] items-center truncate font-mono text-[13px] text-gn-gray-dim sm:max-w-[52vw]"
            title={cwd}
          >
            {shortCwd(cwd, homeDir)}
            {gitInfo?.isWorktree && gitInfo.mainRepo ? (
              <span
                className="min-w-0 max-w-[16vw] truncate"
                title={gitInfo.mainRepo}
              >
                {' '}
                (worktree of {shortCwd(gitInfo.mainRepo, homeDir)})
              </span>
            ) : null}
          </span>
        ) : null}

        <div className="flex-1" />

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
        <CreditsChip />
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
  onOpenTerm,
}: {
  onOpenMcp?: () => void
  onOpenGit?: () => void
  onOpenTerm?: () => void
}) {
  const hostName = useChatStore((s) => s.hostName)
  const hostId = useChatStore((s) => s.hostId)
  const hosts = useChatStore((s) => s.hosts)
  const selectedHostId = useChatStore((s) => s.selectedHostId)
  const switchHost = useChatStore((s) => s.switchHost)
  const conn = useChatStore((s) => s.conn)
  const hostError = useChatStore((s) => s.error)
  const hostNotice = useChatStore((s) => s.statusWarning)
  const sessionId = useChatStore((s) => s.sessionId)
  const newSession = useChatStore((s) => s.newSession)
  const sessions = useChatStore((s) => s.sessions)
  const historyOpen = useChatStore((s) => s.historyOpen)
  const historyLoading = useChatStore((s) => s.historyLoading)
  const openHistory = useChatStore((s) => s.openHistory)
  const closeHistory = useChatStore((s) => s.closeHistory)
  const continueSession = useChatStore((s) => s.continueSession)
  const forkSession = useChatStore((s) => s.forkSession)
  const renameSession = useChatStore((s) => s.renameSession)
  const requestRecap = useChatStore((s) => s.requestRecap)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const compactSession = useChatStore((s) => s.compactSession)
  const openRewind = useChatStore((s) => s.openRewind)
  const showSessionInfo = useChatStore((s) => s.showSessionInfo)
  const openExtensions = useChatStore((s) => s.openExtensions)
  const openSettings = useChatStore((s) => s.openSettings)
  const historyGroups = useMemo(
    () => groupByState(sessions, sessionId),
    [sessions, sessionId],
  )

  /** Collapsed status groups in the mobile dropdown (处理中/后台任务/待处理/空闲). */
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set())
  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const [openHosts, setOpenHosts] = useState(false)

  // Shared braille spinner for "active" rows in the mobile dropdown.
  const anyActive = useMemo(
    () =>
      sessions.some((s) => sessionGroupKey(s, sessionId) === 'active'),
    [sessions, sessionId],
  )
  const spinnerFrame = useSessionSpinner(anyActive)

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

  return (
    <header className="select-none bg-gn-bg-base">
      {/* Main row: host switcher + actions. */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-[6px] sm:px-4 text-[12px] text-gn-muted">
        <div className="relative min-w-0">
          <button
            type="button"
            onClick={() => setOpenHosts((v) => !v)}
            className={`flex max-w-[46vw] sm:max-w-xs items-center gap-1 truncate rounded px-1.5 py-0.5 hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8 ${hostLabelColor}`}
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

        <ThemePicker />
        {onOpenMcp && (
          <button
            type="button"
            onClick={onOpenMcp}
            className="rounded border border-transparent px-2 py-0.5 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
            title="MCP 服务器状态"
          >
            mcp
          </button>
        )}
        {onOpenGit && (
          <button
            type="button"
            onClick={onOpenGit}
            className="rounded border border-transparent px-2 py-0.5 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
            title="Git 面板 — 工作区状态 / diff / 提交"
          >
            git
          </button>
        )}
        {onOpenTerm && (
          <button
            type="button"
            onClick={onOpenTerm}
            className="rounded border border-transparent px-2 py-0.5 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
            title="终端（x.ai/terminal · 管道终端 + 交互 PTY）"
          >
            term
          </button>
        )}
        <button
          type="button"
          onClick={() => openExtensions('hooks')}
          className="rounded border border-transparent px-2 py-0.5 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
          title="扩展（/hooks /plugins /skills /marketplace）"
        >
          ext
        </button>
        <button
          type="button"
          onClick={openSettings}
          className="rounded border border-transparent px-2 py-0.5 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
          title="设置（F2 · config.toml 只读展示）"
        >
          settings
        </button>
        <button
          type="button"
          onClick={() => void newSession()}
          className="rounded border border-transparent px-2 py-0.5 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
        >
          new
        </button>
        {/* Mobile-only history trigger — desktop history lives in the persistent left sidebar. */}
        <div className="relative lg:hidden">
        <button
          type="button"
          onClick={() => (historyOpen ? closeHistory() : void openHistory())}
          className={`rounded border px-2 py-0.5 min-h-8 ${
            historyOpen
              ? 'border-gn-prompt-border bg-gn-bg-highlight text-gn-fg'
              : 'border-transparent hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg'
          }`}
          title="加载历史会话"
        >
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
            {/* Mobile dropdown — desktop history lives in the left sidebar. */}
            <div className="absolute right-0 top-full z-40 mt-1 max-h-[70vh] w-80 max-w-[92vw] overflow-y-auto rounded border border-gn-prompt-border bg-gn-bg-base shadow-xl py-1">
              {/* Session actions (x.ai ext methods). */}
              <div className="flex items-center gap-1 border-b border-gn-prompt-border px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => {
                    closeHistory()
                    void requestRecap()
                  }}
                  className="rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="x.ai/recap — 生成「我在哪」摘要"
                >
                  recap
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeHistory()
                    void showSessionInfo()
                  }}
                  className="rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="x.ai/session-info — 当前会话详情入滚动区"
                >
                  session-info
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeHistory()
                    void forkSession()
                  }}
                  className="rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="x.ai/session/fork — 从当前会话派生新会话"
                >
                  fork
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeHistory()
                    const title = window.prompt('新会话标题：')
                    if (title && title.trim()) void renameSession(title.trim())
                  }}
                  className="rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="x.ai/session/rename"
                >
                  rename
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeHistory()
                    const note = window.prompt('压缩说明（可留空）：')
                    if (note !== null) void compactSession(note.trim() || undefined)
                  }}
                  className="rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="x.ai/session/compact — 压缩当前会话上下文"
                >
                  compact
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeHistory()
                    openRewind()
                  }}
                  className="rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="x.ai/session/rewind — 回退到历史检查点"
                >
                  rewind
                </button>
              </div>
              {historyGroups.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-gn-muted">没有历史会话</div>
              )}
              {historyGroups.map((g) => {
                const isCollapsed = collapsedGroups.has(g.key)
                return (
                  <div key={g.key}>
                    {/* Status group header — sticky, click to collapse/expand. */}
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.key)}
                      className="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-2 border-y border-gn-prompt-border bg-gn-bg-base px-3 py-1 text-left hover:bg-gn-bg-highlight"
                      title={isCollapsed ? `展开${g.label}会话` : `收起${g.label}会话`}
                    >
                      <span className="shrink-0 text-gn-gutter" aria-hidden>
                        <IconGlyph glyph={isCollapsed ? Glyphs.chevron : Glyphs.chevronDown} />
                      </span>
                      <span
                        className={`min-w-0 truncate text-[10.5px] font-medium tracking-wide ${groupAccentClass(g.key)}`}
                      >
                        {g.label}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-gn-gutter">
                        {g.items.length}
                      </span>
                    </button>
                    {!isCollapsed &&
                      g.items.map((s) => {
                        const active = s.sessionId === sessionId
                        // Row icon follows its bucket: 处理中 spinner /
                        // 后台任务 ◇ + bg badge / 待处理 blue diamond / 空闲 hollow ◇.
                        const key = sessionGroupKey(s, sessionId)
                        const state = key === 'active' ? 'active' : 'idle'
                        const pending = key === 'awaiting'
                        const subtitle = sessionSubtitle(s)
                        return (
                          <div
                            key={s.sessionId}
                            role="button"
                            tabIndex={0}
                            aria-disabled={historyLoading}
                            onClick={() => {
                              if (!historyLoading) void continueSession(s.sessionId, s.cwd || '')
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
                            <SessionStateIcon
                              state={state}
                              pending={pending}
                              spinnerFrame={spinnerFrame}
                            />
                            <span className="min-w-0 flex-1">
                              <span
                                className={`block truncate text-[12px] ${active ? 'text-gn-cyan' : 'text-gn-fg'}`}
                              >
                                {s.title || s.sessionId.slice(0, 12)}
                              </span>
                              <span className="block truncate font-mono text-[10px] text-gn-muted">
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
                            {/* Row-hover delete (x.ai/session/delete — TUI /delete). */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                const ok = window.confirm(
                                  `删除会话「${s.title || s.sessionId.slice(0, 12)}」？此操作不可恢复。`,
                                )
                                if (ok) void deleteSession(s.sessionId, s.cwd || '')
                              }}
                              className="shrink-0 rounded px-1 text-[11px] leading-none text-gn-red opacity-40 hover:bg-gn-diff-del-bg hover:opacity-100"
                              title="删除会话（/delete）"
                              aria-label="删除会话"
                            >
                              ✕
                            </button>
                          </div>
                        )
                      })}
                  </div>
                )
              })}
              {historyLoading && (
                <div className="px-3 py-2 text-[11px] text-gn-muted">加载中…</div>
              )}
            </div>
          </>
        )}
        </div>
      </div>
    </header>
  )
}
