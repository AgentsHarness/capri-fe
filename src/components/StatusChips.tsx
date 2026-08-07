import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { SPINNER_FRAMES } from '../theme/glyphs'
import { useChatStore } from '../store/chat'
import { useSessionSpinner } from './SessionStateIcon'
import type { ScrollEntry, TopTask } from '../api/types'
import type { TodoItem } from '../store/chat'

/**
 * TUI context_bar fmt_tokens: "500", "5.2K", "50K", "1.2M" — one decimal
 * below 10, integer above (the top bar and the composer prompt flags share
 * this so the two surfaces never disagree).
 */
export function fmtTok(n: number): string {
  if (n >= 1_000_000) {
    return n >= 10_000_000 ? `${Math.round(n / 1_000_000)}M` : `${(n / 1_000_000).toFixed(1)}M`
  }
  if (n >= 1_000) {
    return n >= 10_000 ? `${Math.round(n / 1_000)}k` : `${(n / 1_000).toFixed(1)}k`
  }
  return String(n)
}

/**
 * Context length chip — TUI context_bar "used / total" line, top-right.
 * Color follows the TUI urgency breakpoints (blend toward warning/error as
 * usage climbs). Hidden until the host reports a non-zero window.
 *
 * Hovered mirrors TUI context_bar: the tokens swap for a progress bar
 * filling the same width plus the 5-col percentage (`████ 42.0%`), with
 * the turn-accumulated count (host `turnTokens`, from
 * response_completed / turn_completed usage) shown separately to the
 * right of the bar — "████ 42.0% ⇣1.5M" — so the context-window usage
 * and the turn total never get conflated.
 */
export function ContextChip({
  used,
  size,
  turnTokens,
}: {
  used?: number
  size?: number
  turnTokens?: number
}) {
  const [hovered, setHovered] = useState(false)
  if (used == null || size == null || size <= 0) return null
  const pct = (used / size) * 100
  const color = pct >= 90 ? 'text-gn-red' : pct >= 70 ? 'text-gn-yellow' : 'text-gn-muted'
  // TUI context_bar: the default "used / total" string drives the hover
  // bar width (bar + gap + 5-col percentage keeps the line width stable).
  // Our compact fmtTok strings can be as short as "500/1M" (6 chars), which
  // would yield a zero-width bar — floor it so the bar is always visible.
  const defaultStr = `${fmtTok(used)}/${fmtTok(size)}`
  const barWidth = Math.max(6, defaultStr.length - 6)
  // Two-segment bar like TUI progress_bar_spans: filled cells in the
  // urgency color, the remaining track in a dim shade — both the used and
  // the total parts stay visible.
  const filled = Math.min(barWidth, Math.round((pct / 100) * barWidth))
  const pctStr = `${pct.toFixed(1)}%`.padStart(5, ' ')
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[12px] leading-none tabular-nums ${color}`}
      title={`上下文 ${Math.round(pct)}% (${fmtTok(used)} / ${fmtTok(size)})${
        turnTokens != null ? ` · 本回合累计 ${fmtTok(turnTokens)}` : ''
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {hovered ? (
        <span className="inline-flex items-center gap-1.5">
          {/* Bar (filled + track) stays one contiguous run — the gap goes
              between the bar and the percentage, like TUI's BAR_PCT_GAP. */}
          <span aria-hidden className="whitespace-nowrap">
            <span>{'█'.repeat(filled)}</span>
            <span className="text-gn-gray-dim">{'░'.repeat(barWidth - filled)}</span>
          </span>
          <span className="text-gn-fg2">{pctStr}</span>
          {turnTokens != null ? (
            <span className="text-gn-gutter">⇣{fmtTok(turnTokens)}</span>
          ) : null}
        </span>
      ) : (
        defaultStr
      )}
    </span>
  )
}

/**
 * Inline SVG check mark (glyphPaths checkMark path). The U+2713 character
 * has no glyph in ui-monospace and falls back to another font whose taller
 * em-box inflates the 10px chip line box — pushing the text down. An
 * `inline-block` 1em SVG keeps the line height exact and centers visually.
 */
function CheckMarkIcon() {
  return (
    <svg viewBox="0 0 1 1" className="block h-[1em] w-[1em]" aria-hidden>
      <path
        d="M0.17 0.51 L0.4 0.72 L0.83 0.3"
        stroke="currentColor"
        strokeWidth={0.09}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Inline SVG ballot X (glyphPaths ballotX path) — same fallback fix as ✓. */
function BallotXIcon() {
  return (
    <svg viewBox="0 0 1 1" className="block h-[1em] w-[1em]" aria-hidden>
      <path
        d="M0.26 0.26 L0.74 0.74 M0.74 0.26 L0.26 0.74"
        stroke="currentColor"
        strokeWidth={0.09}
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * Status mark for one todo item (TUI todo pane glyphs). Exported so the
 * scrollback plan block renders the same marks as the badge panel.
 */
export function todoMark(status: TodoItem['status']) {
  switch (status) {
    case 'completed':
      return (
        <span className="text-gn-green">
          <CheckMarkIcon />
        </span>
      )
    case 'in_progress':
      return <span className="text-gn-yellow">▶</span>
    case 'cancelled':
      return (
        <span className="text-gn-muted">
          <BallotXIcon />
        </span>
      )
    default:
      return <span className="text-gn-muted">□</span>
  }
}

/**
 * Todo badge — TUI render_todo_badge_spans default format "2/5 ✓".
 * Primary source: plan-update items (chat store TodoItem[], cancelled
 * excluded). Fallback: goal_updated deliverables. Click expands a panel
 * listing every item with its status mark. Hidden when empty.
 */
export function TodoChip({
  todos,
  goalState,
}: {
  todos?: TodoItem[]
  goalState?: Record<string, unknown>
}) {
  const [open, setOpen] = useState(false)
  let total = 0
  let completed = 0
  let objective = ''
  if (todos && todos.length > 0) {
    total = todos.filter((t) => t.status !== 'cancelled').length
    completed = todos.filter((t) => t.status === 'completed').length
  } else {
    total = Number(goalState?.total_deliverables ?? 0)
    completed = Number(goalState?.completed_deliverables ?? 0)
    objective = typeof goalState?.objective === 'string' ? goalState.objective : ''
  }
  if (!(total > 0)) return null
  const expandable = !!todos && todos.length > 0
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        className={`flex items-center gap-0.5 rounded px-1.5 py-0.5 font-mono text-[12px] leading-none tabular-nums text-gn-fg2 hover:bg-gn-bg-highlight ${expandable ? 'cursor-pointer' : 'cursor-default'}`}
        title={objective ? `目标: ${objective}` : '待办进度'}
      >
        <span>
          {completed}/{total}
        </span>
        <span className="text-gn-green">
          <CheckMarkIcon />
        </span>
      </button>
      {open && expandable && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-30 cursor-default"
            aria-label="close"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full z-40 mt-1 max-h-[50vh] w-72 max-w-[92vw] overflow-y-auto rounded border border-gn-prompt-border bg-gn-bg-base shadow-xl py-1">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gn-gutter">
              todo · {completed}/{total} 完成
            </div>
            {todos!.map((t, i) => (
              <div
                key={t.id ?? i}
                className="flex items-start gap-2 px-3 py-1.5 text-[12px] leading-snug hover:bg-gn-bg-highlight"
              >
                <span className="mt-[1px] shrink-0 font-mono text-[11px]" aria-hidden>
                  {todoMark(t.status)}
                </span>
                <span
                  className={`min-w-0 flex-1 break-words ${t.status === 'completed' || t.status === 'cancelled' ? 'text-gn-muted' : 'text-gn-fg'}`}
                >
                  {t.content}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Shorten a workspace path the way the TUI status bar does: a path under
 * the user's home dir renders as "~/…" so it fits without truncation.
 */
export function shortCwd(cwd: string, homeDir?: string): string {
  if (homeDir && homeDir !== '/' && cwd.startsWith(homeDir)) {
    const rest = cwd.slice(homeDir.length)
    return rest === '' ? '~' : `~${rest}`
  }
  return cwd
}

/**
 * Format elapsed milliseconds compactly like the TUI status bar:
 * `5s`, `3m`, `2h` (xai-grok-pager agent_status::format_elapsed_compact).
 */
export function fmtElapsedCompact(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000))
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h`
  if (secs >= 60) return `${Math.floor(secs / 60)}m`
  return `${secs}s`
}

/**
 * Goal status-chip label — TUI goal_phase_label + active_phase_label
 * (xai-grok-pager agent_status.rs). Wire statuses come straight from the
 * `goal_updated` session notification.
 */
export function goalPhaseLabel(g: Record<string, unknown>): string {
  const status = typeof g.status === 'string' ? g.status : ''
  // Transient overlays win: verifying → planning → steady-state phase.
  if (g.verifying_completion) {
    const a = Number(g.classifier_runs_attempted ?? 0)
    const m = Number(g.classifier_max_runs ?? 0)
    // Omit "(n/m)" until the first counter arrives ("Verifying" > "Verifying (0/0)").
    return a > 0 || m > 0 ? `Verifying (${a}/${m})` : 'Verifying'
  }
  if (g.planning) return 'Planning'
  switch (status) {
    case 'active': {
      const phase = typeof g.phase === 'string' ? g.phase : ''
      if (phase === 'planning') return 'Planning'
      if (phase === 'executing') return 'Executing'
      return 'Idle'
    }
    case 'user_paused':
    case 'paused':
      return 'Paused'
    case 'back_off_paused':
      return 'Paused (back-off)'
    case 'no_progress_paused':
      return 'Paused (no progress)'
    case 'infra_paused':
      return 'Paused (error)'
    case 'blocked':
      return 'Paused (verification blocked)'
    case 'failed':
      return 'Failed'
    case 'interrupted':
      return 'Interrupted'
    case 'budget_limited':
      return 'Budget'
    case 'complete':
      return 'Done'
    default:
      return 'Paused'
  }
}

/**
 * Live token usage — TUI GoalDisplayState::live_tokens_used: while Active,
 * parent context delta (context_used − baseline) + finished subagent tokens
 * + live subagent tokens, floored at tokens_used. Inactive goals just show
 * tokens_used.
 */
function liveGoalTokens(g: Record<string, unknown>, contextUsed?: number): number {
  const status = typeof g.status === 'string' ? g.status : ''
  const tokensUsed = Number(g.tokens_used ?? 0)
  if (status !== 'active') return tokensUsed
  if (contextUsed == null) return tokensUsed
  const baseline = Number(g.token_baseline ?? 0)
  const parentDelta = Math.max(contextUsed - baseline, 0)
  const finished = Number(g.finished_subagent_tokens ?? 0)
  const liveSub = Number(g.live_subagent_tokens ?? 0)
  return Math.max(parentDelta + finished + liveSub, tokensUsed)
}

/** Tick `elapsed_ms` locally while the goal is Active (TUI live_elapsed_ms). */
function useLiveGoalElapsed(elapsedMs: number, active: boolean): number {
  const receivedAt = useRef(Date.now())
  const [, setNow] = useState(Date.now())
  useEffect(() => {
    receivedAt.current = Date.now()
    if (!active) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active, elapsedMs])
  if (!active) return elapsedMs
  return elapsedMs + Math.floor((Date.now() - receivedAt.current) / 1000) * 1000
}

/** Helper shared by GoalChip / RunningChip dropdown panels. */
function ChipDropdown({
  open,
  onClose,
  children,
  label,
  widthClass,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  label: string
  widthClass?: string
}) {
  if (!open) return null
  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-30 cursor-default"
        aria-label="close"
        onClick={onClose}
      />
      <div
        className={`absolute right-0 top-full z-40 mt-1 max-h-[55vh] overflow-y-auto rounded border border-gn-prompt-border bg-gn-bg-base shadow-xl py-1 ${widthClass ?? 'w-80 max-w-[92vw]'}`}
      >
        <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gn-gutter">
          {label}
        </div>
        {children}
      </div>
    </>
  )
}

/**
 * Goal status chip — TUI agent status-bar `goal` item:
 * `[Goal: Executing] 12.3k/200k tokens 3m`. Active goals carry a braille
 * spinner; paused/failed states invert onto warning/error backgrounds.
 * Click expands a goal-detail panel (TUI goal-detail modal, simplified).
 */
export function GoalChip({
  goalState,
  contextUsed,
}: {
  goalState?: Record<string, unknown>
  contextUsed?: number
}) {
  const [open, setOpen] = useState(false)
  // Hooks must run unconditionally — derive the Active flag before the
  // early returns so the elapsed tick + spinner keep their stable order.
  const status = typeof goalState?.status === 'string' ? goalState.status : ''
  const active = status === 'active'
  const spinnerFrame = useSessionSpinner(active)
  const elapsed = useLiveGoalElapsed(Number(goalState?.elapsed_ms ?? 0), active)
  if (!goalState) return null
  // A cleared goal leaves the status bar (the "目标已清除" event already landed).
  if (status === 'cleared') return null

  const label = goalPhaseLabel(goalState)
  const paused = ['user_paused', 'paused', 'back_off_paused', 'no_progress_paused', 'infra_paused', 'blocked'].includes(status)
  const failed = status === 'failed' || status === 'interrupted'

  const tokens = liveGoalTokens(goalState, contextUsed)
  const budget = Number(goalState.token_budget ?? 0)

  const tokensDisplay = budget > 0 ? `${fmtTok(tokens)}/${fmtTok(budget)} tokens` : `${fmtTok(tokens)} tokens`

  const chipClass = paused
    ? 'bg-gn-warning text-gn-bg-base'
    : failed
      ? 'bg-gn-red text-gn-bg-base'
      : 'text-gn-plan hover:bg-gn-bg-highlight'

  const objective = typeof goalState.objective === 'string' ? goalState.objective : ''
  const total = Number(goalState.total_deliverables ?? 0)
  const completed = Number(goalState.completed_deliverables ?? 0)
  const currentTitle = typeof goalState.current_deliverable_title === 'string' ? goalState.current_deliverable_title : ''
  const currentRole = typeof goalState.current_subagent_role === 'string' ? goalState.current_subagent_role : ''
  const lastEvent = typeof goalState.last_event === 'string' ? goalState.last_event : ''
  const lastEventDetail = typeof goalState.last_event_detail === 'string' ? goalState.last_event_detail : ''

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`rounded px-1.5 py-0.5 font-mono text-[12px] leading-none tabular-nums ${chipClass}`}
        title={objective ? `目标: ${objective}` : '目标状态'}
      >
        {active && (
          <span className="mr-1 inline-block" aria-hidden>
            {SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}
          </span>
        )}
        [Goal: {label}] {tokensDisplay} {fmtElapsedCompact(elapsed)}
      </button>
      <ChipDropdown
        open={open}
        onClose={() => setOpen(false)}
        label={`goal · ${label}${active ? ' · 运行中' : ''}`}
        widthClass="w-96"
      >
        {objective && (
          <div className="px-3 py-1.5 text-[12px] leading-snug text-gn-fg">
            <span className="text-gn-gutter">objective · </span>
            <span className="break-words">{objective}</span>
          </div>
        )}
        {total > 0 && (
          <div className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
            <span className="font-mono text-[11px] text-gn-green">
              <CheckMarkIcon />
            </span>
            <span className="tabular-nums text-gn-fg2">
              {completed}/{total} 交付物
            </span>
            {currentTitle && (
              <span className="min-w-0 flex-1 truncate text-gn-muted">
                当前: {currentTitle}
                {currentRole ? ` · ${currentRole}` : ''}
              </span>
            )}
          </div>
        )}
        <div className="border-t border-gn-prompt-border px-3 py-1.5 font-mono text-[11px] text-gn-muted">
          <div className="flex items-center justify-between gap-2">
            <span>{tokensDisplay}</span>
            <span className="tabular-nums">elapsed {fmtElapsedCompact(elapsed)}</span>
          </div>
          {(lastEvent || lastEventDetail) && (
            <div className="mt-1 truncate text-gn-gray-dim" title={`${lastEvent} ${lastEventDetail}`}>
              {lastEvent}
              {lastEventDetail ? ` · ${lastEventDetail}` : ''}
            </div>
          )}
        </div>
      </ChipDropdown>
    </div>
  )
}

type RunningEntry = Extract<
  ScrollEntry,
  { kind: 'subagent' | 'bg_task' | 'workflow' }
>

function kindLabel(e: RunningEntry): string {
  if (e.kind === 'subagent') return 'Agent'
  if (e.kind === 'bg_task') return 'Task'
  return 'Workflow'
}

/**
 * Count of live bg_tasks / subagents / workflows — shared by chip + strip.
 * Restored top-strip tasks are counted separately (topTasks) — the host
 * only surfaces liveness-probed tasks, so they are genuinely running.
 */
export function filterRunningEntries(entries: ScrollEntry[]): RunningEntry[] {
  return entries.filter(
    (e): e is RunningEntry =>
      (e.kind === 'subagent' || e.kind === 'bg_task' || e.kind === 'workflow') &&
      !!e.running,
  )
}

/**
 * Status-bar chip `⠋ {N}` — click toggles the sticky {@link RunningTasksBar}
 * (show / hide). Visible whenever anything is running. Counts scrollback
 * running entries + restored top-strip tasks (topTasks).
 */
export function RunningChip({
  entries,
  topTasks = [],
  open,
  onToggle,
}: {
  entries: ScrollEntry[]
  topTasks: TopTask[]
  open: boolean
  onToggle: () => void
}) {
  const count = filterRunningEntries(entries).length + topTasks.length
  const spinnerFrame = useSessionSpinner(count > 0)
  if (count === 0) return null

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="running-tasks-bar"
      className={`rounded px-1.5 py-0.5 font-mono text-[12px] leading-none tabular-nums text-gn-accent-running hover:bg-gn-bg-highlight ${
        open ? 'bg-gn-bg-highlight' : ''
      }`}
      title={
        open
          ? '隐藏运行中的任务列表'
          : '显示运行中的后台任务 / 子代理 / 工作流'
      }
    >
      <span className="mr-1 inline-block" aria-hidden>
        {SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}
      </span>
      {count}
    </button>
  )
}

/**
 * Sticky task panel (TUI `tasks` pane under the status bar).
 *
 * Two sections:
 *  - 「运行中」— live bg_tasks / subagents / workflows (double-click opens
 *    the block viewer, kill/cancel buttons) — the original strip, kept
 *    verbatim;
 *  - 「调度任务」— /loop scheduled tasks (prompt summary, interval,
 *    nextFireAt, delete button).
 * Shown when {@link RunningChip} is open — not a floating popup, sticks
 * under the status bar. A「刷新」button re-syncs both lists
 * (syncLiveTasks + refreshTopTasks).
 */
export function RunningTasksBar({
  entries,
  topTasks,
  open,
}: {
  entries: ScrollEntry[]
  topTasks: TopTask[]
  open: boolean
}) {
  const running = filterRunningEntries(entries)
  const count = running.length + topTasks.length
  const scheduledTasks = useChatStore((s) => s.scheduledTasks)
  const deleteScheduledTask = useChatStore((s) => s.deleteScheduledTask)
  const syncLiveTasks = useChatStore((s) => s.syncLiveTasks)
  const refreshTopTasks = useChatStore((s) => s.refreshTopTasks)
  const sessionId = useChatStore((s) => s.sessionId)
  const cwd = useChatStore((s) => s.cwd)
  const spinnerFrame = useSessionSpinner(count > 0 && open)
  const cancelSubagent = useChatStore((s) => s.cancelSubagent)
  const killTask = useChatStore((s) => s.killTask)
  const openViewer = useChatStore((s) => s.openViewer)
  const openTaskViewer = useChatStore((s) => s.openTaskViewer)
  if (!open || (count === 0 && scheduledTasks.length === 0)) return null

  const refresh = () => {
    void syncLiveTasks()
    if (sessionId && cwd) void refreshTopTasks(sessionId, cwd)
  }

  return (
    <div
      id="running-tasks-bar"
      className="shrink-0 border-b border-gn-prompt-border/50 bg-gn-bg-base select-none"
      role="region"
      aria-label={`Running tasks · ${count} · scheduled ${scheduledTasks.length}`}
    >
      <div className="flex max-h-[min(28vh,12rem)] flex-col overflow-y-auto px-3 py-0.5 sm:px-4">
        {/* Panel header — refresh re-syncs both sections. */}
        <div className="flex items-center justify-end gap-1 py-0.5">
          <button
            type="button"
            onClick={refresh}
            className="rounded border border-transparent px-1.5 py-0.5 text-[10.5px] text-gn-muted hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg"
            title="重新同步运行中任务与调度任务列表"
          >
            刷新
          </button>
        </div>
        {count > 0 && (
          <>
            <div className="px-1 pb-0.5 pt-1 text-[10px] uppercase tracking-wider text-gn-gutter">
              运行中 · {count}
            </div>
            {topTasks.map((t) => (
              <div
                key={`restored-${t.taskId}`}
                className="group flex min-h-6 cursor-pointer items-center gap-1.5 py-[2px] text-[12px] leading-snug hover:bg-gn-bg-highlight"
                title={
                  t.restored
                    ? '恢复的运行中任务（宿主探活确认仍在运行；由 TUI 进程持有，无法在此 kill）· dblclick 查看日志'
                    : 'dblclick 查看日志'
                }
                onDoubleClick={(ev) => {
                  ev.preventDefault()
                  openTaskViewer(t.taskId, {
                    title: t.title,
                    command: t.command,
                    outputFile: t.outputFile,
                  })
                }}
              >
                <span
                  className="shrink-0 font-mono text-[11px] text-gn-accent-running"
                  aria-hidden
                >
                  {SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}
                </span>
                <span className="shrink-0 font-medium text-gn-accent-running">
                  Task
                </span>
                <span className="text-gn-gutter">·</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-gn-fg">
                  {t.title}
                </span>
                {t.restored && (
                  <span className="shrink-0 rounded border border-gn-gutter/60 px-0.5 font-mono text-[9px] leading-[13px] text-gn-gutter">
                    恢复
                  </span>
                )}
                {t.command && t.command !== t.title && (
                  <span
                    className="hidden max-w-[28vw] truncate font-mono text-[10px] text-gn-muted sm:inline"
                    title={t.command}
                  >
                    {t.command}
                  </span>
                )}
              </div>
            ))}
            {running.map((e) => (
              <div
                key={e.id}
                className="group flex min-h-6 cursor-pointer items-center gap-1.5 py-[2px] text-[12px] leading-snug hover:bg-gn-bg-highlight"
                title="dblclick · view stdout"
                onDoubleClick={(ev) => {
                  ev.preventDefault()
                  openViewer(e.id)
                }}
              >
                <span
                  className="shrink-0 font-mono text-[11px] text-gn-accent-running"
                  aria-hidden
                >
                  {SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}
                </span>
                <span className="shrink-0 font-medium text-gn-accent-running">
                  {kindLabel(e)}
                </span>
                <span className="text-gn-gutter">·</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-gn-fg">
                  {e.title}
                </span>
                {e.detail && (
                  <span
                    className="hidden max-w-[28vw] truncate font-mono text-[10px] text-gn-muted sm:inline"
                    title={e.detail}
                  >
                    {e.detail}
                  </span>
                )}
                {e.kind === 'subagent' && e.subagentId && (
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      void cancelSubagent(e.subagentId!)
                    }}
                    className="shrink-0 rounded border border-gn-red/40 px-1.5 py-0.5 text-[10.5px] text-gn-red opacity-80 hover:bg-gn-diff-del-bg hover:opacity-100"
                    title="x.ai/subagent/cancel"
                  >
                    cancel
                  </button>
                )}
                {e.kind === 'bg_task' && e.taskId && (
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      void killTask(e.taskId!)
                    }}
                    className="shrink-0 rounded border border-gn-red/40 px-1.5 py-0.5 text-[10.5px] text-gn-red opacity-80 hover:bg-gn-diff-del-bg hover:opacity-100"
                    title="x.ai/task/kill"
                  >
                    kill
                  </button>
                )}
              </div>
            ))}
          </>
        )}
        {scheduledTasks.length > 0 && (
          <>
            <div className="px-1 pb-0.5 pt-1 text-[10px] uppercase tracking-wider text-gn-gutter">
              调度任务 · {scheduledTasks.length}
            </div>
            {scheduledTasks.map((t) => (
              <div
                key={`sched-${t.taskId}`}
                className="group flex min-h-6 items-center gap-1.5 py-[2px] text-[12px] leading-snug hover:bg-gn-bg-highlight"
                title={t.prompt || t.taskId}
              >
                <span className="shrink-0 font-mono text-[11px] text-gn-plan" aria-hidden>
                  ↻
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-gn-fg">
                  {t.prompt || `Task ${t.taskId.slice(0, 8)}`}
                </span>
                {t.interval && (
                  <span
                    className="shrink-0 font-mono text-[10px] text-gn-muted"
                    title={`间隔 ${t.interval}`}
                  >
                    {t.interval}
                  </span>
                )}
                {t.nextFireAt && (
                  <span
                    className="shrink-0 font-mono text-[10px] text-gn-muted"
                    title={`下次触发 ${t.nextFireAt}`}
                  >
                    {formatScheduledFire(t.nextFireAt)}
                  </span>
                )}
                <button
                  type="button"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    void deleteScheduledTask(t.taskId)
                  }}
                  className="shrink-0 rounded border border-gn-red/40 px-1.5 py-0.5 text-[10.5px] text-gn-red opacity-80 hover:bg-gn-diff-del-bg hover:opacity-100"
                  title="x.ai/scheduler/delete"
                >
                  delete
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Scheduled-task next-fire display: epoch seconds / epoch ms / ISO string
 * all normalize to HH:MM (TUI tasks pane shows the fire time compactly).
 */
function formatScheduledFire(v: string): string {
  if (!v) return ''
  const n = Number(v)
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n < 1e12 ? n * 1000 : n)
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  }
  const d = new Date(v)
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return v
}
