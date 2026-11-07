import { useEffect, useRef, type Ref } from 'react'
import { GitBranch } from 'lucide-react'
import { useChatStore } from '../../store/chat'
import { activeContextWindow } from '../../store/chat/model'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../../theme/layout'
import {
  ContextChip,
  DetachedChip,
  GoalChip,
  LiteFillChip,
  McpChip,
  QueueBadge,
  SessionCostChip,
  RunningChip,
  RunningTasksBar,
  TodoChip,
} from './StatusChips'
import { baseCwd, filterRunningEntries, shortCwd } from '../../format'

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
  guest = false,
}: {
  onOpenMcp?: () => void
  /** 访客只读壳：状态芯片全部照常显示，但只有 lite 补全芯片可点；
   *  其余一律降级成静态文本（打开的面板在访客壳里没挂载，动作都是写操作）。 */
  guest?: boolean
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
  const sessionStatus = useChatStore((s) => s.sessionStatus)
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
          Mobile: single row (h-[37px], nowrap) with base cwd and compact chips;
          overflow chips scroll horizontally with no-scrollbar instead of
          wrapping to a second line.
          会话切换加载中（historyLoading）只有栏内内容淡出：栏本身保持
          常驻可见，高度不变（min-h 仍在布局里），wsBarH 连续测量，
          钉住的用户提示头始终与栏底齐平。 */}
      <div
        className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} flex h-[37px] min-w-0 flex-nowrap items-center gap-x-2 py-0 text-[13px] select-none transition-opacity duration-300 ${
          fadeHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
        }`}
        aria-hidden={fadeHidden || undefined}
        inert={fadeHidden || undefined}
      >
        {/* Git head (x.ai/git_head_changed) — TUI status-bar branch.
            Detached HEAD renders as a branch icon + "detached" (TUI
            render.rs: empty branch → "{icon} detached"); worktrees get
            the `wt` badge. */}
        {gitInfo?.branch ? (
          <span
            className="flex min-w-0 max-w-[28vw] shrink-0 sm:shrink items-center gap-1 truncate font-mono text-[13px] leading-none text-gn-cyan sm:max-w-[24vw]"
            title={
              gitInfo.isWorktree
                ? `${gitInfo.branch} · worktree${gitInfo.mainRepo ? ` of ${gitInfo.mainRepo}` : ''}`
                : gitInfo.branch
            }
          >
            <GitBranch size={12} className="shrink-0" aria-hidden />
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
            className="flex min-w-0 max-w-[32vw] shrink items-center truncate font-mono text-[13px] leading-none text-gn-gray-dim sm:max-w-[52vw]"
            title={cwd}
          >
            <span className="truncate sm:hidden">{baseCwd(cwd)}</span>
            <span className="hidden truncate sm:inline">{shortCwd(cwd, homeDir)}</span>
            {gitInfo?.isWorktree && gitInfo.mainRepo ? (
              <span
                className="hidden min-w-0 max-w-[10vw] truncate sm:inline sm:max-w-[16vw]"
                title={gitInfo.mainRepo}
              >
                {' '}
                (worktree of {shortCwd(gitInfo.mainRepo, homeDir)})
              </span>
            ) : null}
          </span>
        ) : null}

        {/* Chip cluster — right-aligned; wraps horizontally with no-scrollbar
            on narrow screens instead of wrapping to a second line. */}
        <div className="ml-auto flex min-w-0 max-w-[75vw] sm:max-w-none shrink-0 flex-nowrap items-center gap-1.5 sm:gap-2 overflow-x-auto overflow-y-hidden py-0.5 gn-no-scrollbar touch-pan-x">
          {/* ⠋N toggles sticky task list · goal · ⠋ MCP · context · queue · todo · credits
              (TUI status.push order: bg_tasks → goal → mcp → context → queue → badge → credits) */}
          <RunningChip
            entries={entries}
            topTasks={topTasks}
            open={tasksOpen}
            onToggle={() => setTasksBarOpen(!tasksOpen)}
          />
          {/* 游离后台进程（本 agent 无法终止的那些）——只提示，不进任务列表 */}
          <DetachedChip readonly={guest} />
          <GoalChip goalState={goalState} contextUsed={usage?.used} readonly={guest} />
          {/* 访客没有 MCP 面板，但连接数照样是只读状态读数。 */}
          {(onOpenMcp || guest) && <McpChip onOpen={onOpenMcp ?? (() => {})} readonly={guest} />}
          {/* 精简回放的正文补全进度（只在有 lite 行欠着正文时出现）。
              访客唯一保留可点的芯片：补全是只读拉取。 */}
          <LiteFillChip />
          <ContextChip
            used={usage?.used}
            size={
              usage?.size ??
              // 目录回退用「生效中的窗口」（会话选择优先），不能只看模型默认
              // totalContextTokens——选了 500k 却显示 256k 会与菜单里高亮的
              // chip 自相矛盾。
              activeContextWindow(
                models.find(
                  (m) =>
                    !!modelName &&
                    (m.modelId.toLowerCase() === modelName.trim().toLowerCase() ||
                      (m.name != null &&
                        m.name.trim().toLowerCase() === modelName.trim().toLowerCase())),
                ),
              ) ??
              models[0]?.contextWindow
            }
            agentPct={sessionStatus?.usedPercent}
            thresholdPct={sessionStatus?.autoCompactThresholdPercent}
            readonly={guest}
          />
          <QueueBadge />
          <TodoChip todos={todos} goalState={goalState} />
          {/* 会话费用（TUI status.push 末尾的 credits 位）。 */}
          <SessionCostChip />
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
        <RunningTasksBar
          entries={entries}
          topTasks={topTasks}
          open={tasksOpen}
          readonly={guest}
        />
      </div>
    </div>
  )
}
