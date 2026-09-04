import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Glyphs, SPINNER_FRAMES } from '../theme/glyphs'
import {
  fillAllLiteTurns,
  liteFillSummary,
} from '../store/chat/historyFill'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../theme/layout'
import { contextUrgencyColor } from '../theme/contextColor'
import { useChatStore } from '../store/chat'
import { usePromptQueue } from '../store/promptQueue'
import type { ScrollEntry, TopTask } from '../api/types'
import { useSessionSpinner } from '../hooks/sessionState'
import { TodoMark, CheckMarkIcon } from './todoMark'
import { InlineAction } from './InlineAction'
import { fmtTok, fmtElapsedCompact, filterRunningEntries, subagentMeta, type RunningEntry } from '../format'
import type { TodoItem } from '../store/chat'

/**
 * Context length chip — TUI context_bar "used / total" line, top-right.
 * Color follows the TUI urgency breakpoints (blend toward warning/error as
 * usage climbs). Hidden until the host reports a non-zero window.
 *
 * Hovered mirrors TUI context_bar: the tokens swap for a progress bar
 * filling the same width plus the 5-col percentage (`████ 42.0%`).
 * Clicked opens the /context modal (store contextOpen — same surface the
 * `/context` slash command drives) for the full breakdown.
 */
export function ContextChip({
  used,
  size,
}: {
  used?: number
  size?: number
}) {
  const [hovered, setHovered] = useState(false)
  const openContext = useChatStore((s) => s.openContext)
  if (used == null || size == null || size <= 0) return null
  // TUI usage_percentage: clamped to 100 (used can transiently exceed the
  // window before auto-compact; the TUI never renders >100%).
  const pct = Math.min(100, (used / size) * 100)
  // TUI default_breakpoints gradient (fg→accent_user→warning→error).
  const color = contextUrgencyColor(pct)
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
    <button
      type="button"
      onClick={openContext}
      className={`shrink-0 cursor-pointer whitespace-nowrap rounded px-0 py-0.5 text-left font-mono text-[12px] leading-none tabular-nums hover:bg-gn-bg-highlight`}
      style={{ color }}
      title={`上下文 ${Math.round(pct)}% (${fmtTok(used)} / ${fmtTok(size)}) · 点击查看 /context 明细`}
      aria-label={`上下文 ${Math.round(pct)}% · 打开 /context 明细`}
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
        </span>
      ) : (
        defaultStr
      )}
    </button>
  )
}

/**
 * Todo badge — TUI render_todo_badge_spans default format "2/5 ✓".
 * Primary source: plan-update items (chat store TodoItem[], cancelled
 * excluded). Fallback: goal_updated deliverables. Click expands an inline
 * block under the status bar (TUI todo pane) listing every item with its
 * status mark; click again to collapse. Hidden when empty.
 */
export function TodoChip({
  todos,
  goalState,
}: {
  todos?: TodoItem[]
  goalState?: Record<string, unknown>
}) {
  const [open, setOpen] = useState(false)
  // The expanded list is portaled into the sticky status-bar wrapper
  // (RunningTasksBar lives there too) so it renders as an in-flow block
  // BELOW the bar — pushing the scrollback down like RunningTasksBar,
  // never a floating overlay — while the chip itself stays aligned in
  // the bar row.
  const btnRef = useRef<HTMLButtonElement>(null)
  // Host 定位必须在点击后的同一帧完成：useLayoutEffect 在绘制前同步执行，
  // setHost 触发的重渲染也在该帧内完成；若只写进 ref（不触发渲染），面板
  // 要等下一次无关的状态更新才会出现。
  const [host, setHost] = useState<HTMLElement | null>(null)
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
  const expandable = !!todos && todos.length > 0
  // Locate the sticky bar wrapper once the panel is about to open.
  useLayoutEffect(() => {
    if (!open || !expandable) return
    setHost(btnRef.current?.closest<HTMLElement>('.sticky') ?? null)
  }, [open, expandable])
  if (!(total > 0)) return null
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? 'todo-inline-panel' : undefined}
        className={`flex items-center gap-0.5 rounded px-1.5 py-0.5 font-mono text-[12px] leading-none tabular-nums text-gn-fg2 hover:bg-gn-bg-highlight whitespace-nowrap ${expandable ? 'cursor-pointer' : 'cursor-default'} ${ open && expandable ? 'bg-gn-bg-highlight' : '' }`}
        title={objective ? `目标: ${objective}` : '待办进度'}
      >
        <span>
          {completed}/{total}
        </span>
        <span className="text-gn-green">
          <CheckMarkIcon />
        </span>
      </button>
      {open && expandable && host
        ? createPortal(
            <div
              id="todo-inline-panel"
              role="region"
              aria-label={`todo · ${completed}/${total} 完成`}
              className="shrink-0 border-b border-gn-prompt-border/50 bg-gn-bg-base select-none"
            >
              {/* Content column matches scrollback/composer (mx-auto max-w-[960px]) */}
              <div
                className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} max-h-[min(32vh,16rem)] overflow-y-auto`}
              >
                <div className="px-1 pb-0.5 pt-1 text-[10px] uppercase tracking-wider text-gn-gutter">
                  todo · {completed}/{total} 完成
                </div>
                {todos!.map((t, i) => (
                  <div
                    key={t.id ?? i}
                    className="flex items-start gap-2 px-1 py-1 text-[12px] leading-snug hover:bg-gn-bg-highlight"
                  >
                    <span className="mt-[1px] shrink-0 font-mono text-[11px]" aria-hidden>
                      <TodoMark status={t.status} />
                    </span>
                    <span
                      className={`min-w-0 flex-1 break-words ${t.status === 'completed' || t.status === 'cancelled' ? 'text-gn-muted' : 'text-gn-fg'}`}
                    >
                      {t.content}
                    </span>
                  </div>
                ))}
              </div>
            </div>,
            host,
          )
        : null}
    </>
  )
}

/**
 * Goal status-chip label — TUI goal_phase_label + active_phase_label
 * (xai-grok-pager agent_status.rs). Wire statuses come straight from the
 * `goal_updated` session notification.
 */
function goalPhaseLabel(g: Record<string, unknown>): string {
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

/**
 * Goal elapsed (defensive chain — TUI live_elapsed_ms feeds the same
 * line): wire elapsed_ms → started_at → goal_updated receive time.
 */
function goalElapsedMs(g: Record<string, unknown>, receivedAt?: number): number {
  const ems = g.elapsed_ms ?? g.elapsedMs
  if (typeof ems === 'number' && Number.isFinite(ems) && ems >= 0) return ems
  const st = g.started_at ?? g.startedAt ?? g.start_time
  if (st != null && st !== '') {
    const sn = Number(st)
    if (Number.isFinite(sn) && sn > 0) {
      return Math.max(0, Date.now() - (sn < 1e12 ? sn * 1000 : sn))
    }
  }
  if (receivedAt != null) return Math.max(0, Date.now() - receivedAt)
  return 0
}

/**
 * Goal-event todo items (defensive): the wire may carry a task list under
 * `deliverables` (GoalDeliverableInfo: {id, title, status}) or legacy
 * spellings; anything missing simply renders no list.
 */
function goalTodoItems(
  g: Record<string, unknown>,
): { content: string; status: TodoItem['status'] }[] {
  const raw = Array.isArray(g.deliverables)
    ? g.deliverables
    : Array.isArray(g.todos)
      ? g.todos
      : Array.isArray(g.todo_list)
        ? g.todo_list
        : undefined
  if (!raw) return []
  const out: { content: string; status: TodoItem['status'] }[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const content =
      (typeof o.title === 'string' && o.title.trim()) ||
      (typeof o.content === 'string' && o.content.trim())
    if (!content) continue
    const s = typeof o.status === 'string' ? o.status.toLowerCase() : ''
    let status: TodoItem['status'] = 'pending'
    if (s === 'completed' || s === 'done' || s === 'complete') status = 'completed'
    else if (
      s === 'in_progress' ||
      s === 'inprogress' ||
      s === 'active' ||
      s === 'running'
    ) {
      status = 'in_progress'
    } else if (s === 'cancelled' || s === 'failed') {
      status = 'cancelled'
    }
    out.push({ content, status })
  }
  return out
}

/**
 * 精简回放（lite）的工具正文补全进度 —— TopBar 里放在 context 左边。
 *
 * 只在还有 lite 行欠着正文时出现：全部补齐、或本页本来就是全量（开关关 /
 * 旧 host）都不渲染。数字 = 还欠正文的行数。
 *  - ◇N 还没去拉（首屏不再自动补全，点一下 = 一次并发补齐当前视图所有 lite 轮）
 *  - ⠿N 正在拉（braille spinner，与 ⠋N 任务计数同一套帧）
 *  - ✗N 上一轮拉失败，转警告色；展开任意一行或点这里都会重试
 *
 * 目录跳转加载在飞（historyJumpProgress 非空）时，同一芯片显示
 * 「跳转 N/M」——跳转加载的页正是补全的来源，落地后无缝切换回 ◇N 待补全：
 * 整条「加载轮次 → lite→full 补全」链路在一个状态位呈现。
 */
export function LiteFillChip() {
  const summary = useChatStore(liteFillSummary)
  const busy = useChatStore((s) => s.liteFillBusy ?? 0)
  const jump = useChatStore((s) => s.historyJumpProgress)
  const [pending, loading, failed] = summary.split('.').map((n) => Number(n) || 0)
  const active = busy > 0 || loading > 0
  const spinnerFrame = useSessionSpinner(active || jump != null)
  if (jump) {
    return (
      <span
        className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[12px] leading-none tabular-nums text-gn-gray-dim"
        title={`正在跳转到目标轮次 · 已加载到第 ${jump.current}/${jump.total} 轮`}
        aria-label={`跳转中：第 ${jump.current}/${jump.total} 轮`}
      >
        <span className="mr-1 inline-block" aria-hidden>
          {SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}
        </span>
        跳转 {jump.current}/{jump.total}
      </span>
    )
  }
  if (!summary) return null
  const count = pending + loading + failed
  const glyph = active
    ? SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]
    : failed > 0
      ? Glyphs.ballotX
      : Glyphs.diamondHollow
  return (
    <button
      type="button"
      onClick={() => {
        void fillAllLiteTurns()
      }}
      className={`shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[12px] leading-none tabular-nums hover:bg-gn-bg-highlight ${ failed > 0 ? 'text-gn-warning' : 'text-gn-gray-dim' }`}
      title={
        active
          ? `正在补全精简回放裁掉的工具正文 · 还有 ${count} 行`
          : failed > 0
            ? `${failed} 行工具正文补全失败 · 点击重试`
            : `${count} 行工具正文还是精简内容 · 点击立即补全`
      }
      aria-label={`精简回放：${count} 行工具正文待补全`}
    >
      <span className="mr-1 inline-block" aria-hidden>
        {glyph}
      </span>
      {count}
    </button>
  )
}

/** TUI goal_detail budget_color semantics: >80% error, ≥50% warning, else success. */
const GOAL_BUDGET_BAR_W = 14

/** Helper shared by GoalChip / RunningChip dropdown panels. */
function ChipDropdown({
  open,
  onClose,
  children,
  label,
  widthClass,
  anchorRef,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  label: string
  widthClass?: string
  anchorRef: RefObject<HTMLElement | null>
}) {
  // Viewport-pinned placement (same measure-and-clamp pattern as the
  // composer model picker): a pure `absolute right-0` anchor assumes the
  // trigger chip sits flush right, but on mobile the chip cluster wraps —
  // the goal chip often lands mid-row, pushing a w-96 panel past the
  // LEFT edge of the screen. Measure the chip and clamp so both edges
  // stay inside the viewport; re-place on resize/scroll.
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = () => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const pad = 8
      const gap = 4 // mt-1
      const vw = window.innerWidth
      // Match the panel's width classes: w-96 capped by max-w-[92vw]
      // (w-80 fallback keeps the same viewport math).
      const width = Math.min(
        widthClass === 'w-96' ? 384 : widthClass === 'w-80' ? 320 : 384,
        Math.floor(vw * 0.92),
      )
      // Prefer right-aligning to the chip (TUI goal-detail sits under
      // the status item), then shift left so the panel never leaves the
      // screen on either side.
      const left = Math.max(pad, Math.min(r.right - width, vw - pad - width))
      setPos({ left, top: r.bottom + gap, width })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchorRef, widthClass])
  if (!open) return null
  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-30 cursor-default"
        aria-label="close"
        onClick={onClose}
      />
      {pos ? (
        <div
          className={`fixed z-40 max-h-[55vh] max-w-[92vw] overflow-y-auto gn-menu ${widthClass ?? 'w-80'}`}
          style={{ left: pos.left, top: pos.top, width: pos.width }}
        >
          <div className="px-3 pb-1 pt-1.5 text-[10px] uppercase tracking-wider text-gn-gutter">
            {label}
          </div>
          {children}
        </div>
      ) : null}
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
  // Panel visibility lives in the store so the GoalChip can toggle the
  // goal detail panel.
  const open = useChatStore((s) => s.goalPanelOpen)
  const setOpen = useChatStore((s) => s.setGoalPanelOpen)
  const goalStatus = useChatStore((s) => s.goalStatus)
  const goalPause = useChatStore((s) => s.goalPause)
  const goalResume = useChatStore((s) => s.goalResume)
  const goalClear = useChatStore((s) => s.goalClear)
  const goalReceivedAt = useChatStore((s) => s.goalReceivedAt)
  const setWorkflowPanelOpen = useChatStore((s) => s.setWorkflowPanelOpen)
  // Anchor for the viewport-pinned goal panel (ChipDropdown measures the
  // chip's rect and clamps the panel inside the screen).
  const wrapRef = useRef<HTMLDivElement>(null)
  // Action feedback: the status line carries the last instruction's
  // confirmation. Hub/host-level failures live ONLY in the top banner
  // (ErrorBanner) — stat stays session/action-scoped, no error echo.
  const statusText = useChatStore((s) => s.statusText)
  // Hooks must run unconditionally — derive the Active flag before the
  // early returns so the elapsed tick + spinner keep their stable order.
  const status = typeof goalState?.status === 'string' ? goalState.status : ''
  const active = status === 'active'
  const spinnerFrame = useSessionSpinner(active)
  const elapsed = useLiveGoalElapsed(goalElapsedMs(goalState ?? {}, goalReceivedAt), active)
  if (!goalState) return null
  // A cleared goal leaves the status bar (the "目标已清除" event already landed).
  if (status === 'cleared') return null

  const label = goalPhaseLabel(goalState)
  const phase = typeof goalState.phase === 'string' ? goalState.phase : ''
  const paused = ['user_paused', 'paused', 'back_off_paused', 'no_progress_paused', 'infra_paused', 'blocked'].includes(status)
  const failed = status === 'failed' || status === 'interrupted'

  const tokens = liveGoalTokens(goalState, contextUsed)
  const budget = Number(goalState.token_budget ?? 0)

  const tokensDisplay = budget > 0 ? `${fmtTok(tokens)}/${fmtTok(budget)} tokens` : `${fmtTok(tokens)} tokens`

  // TUI goal_detail: budget progress bar with budget_color semantics
  // (>80% red · ≥50% yellow · else green); todo list from the goal event.
  const goalTodos = goalTodoItems(goalState)
  const budgetPct = budget > 0 ? Math.min(1, tokens / budget) : 0
  const budgetColorClass =
    budgetPct > 0.8 ? 'text-gn-red' : budgetPct >= 0.5 ? 'text-gn-yellow' : 'text-gn-green'
  const budgetFilled = Math.round(budgetPct * GOAL_BUDGET_BAR_W)

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
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex min-w-0 items-center rounded px-1.5 py-0.5 font-mono text-[12px] leading-none tabular-nums ${chipClass}`}
        title={objective ? `目标: ${objective}` : '目标状态'}
      >
        {active && (
          <span className="mr-1 shrink-0" aria-hidden>
            {SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}
          </span>
        )}
        {/* Long goal lines (label + tokens + elapsed) truncate on mobile
            instead of wrapping inside the chip; the full text is one tap
            away in the goal panel / title tooltip. */}
        <span className="truncate max-w-[min(58vw,26rem)] lg:max-w-none">
          [Goal: {label}] {tokensDisplay} {fmtElapsedCompact(elapsed)}
        </span>
      </button>
      <ChipDropdown
        open={open}
        onClose={() => setOpen(false)}
        label={`goal · ${label}${active ? ' · 运行中' : ''}`}
        widthClass="w-96"
        anchorRef={wrapRef}
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
        {/* Goal-event todo list (defensive — only when the wire carried
            deliverables/todos). TUI goal_detail MAX_TODO_DISPLAY=15. */}
        {goalTodos.length > 0 && (
          <div className="border-t border-gn-prompt-border px-3 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-gn-gutter">
              todos · {goalTodos.length}
            </div>
            <div className="mt-0.5 max-h-[26vh] overflow-y-auto">
              {goalTodos.slice(0, 15).map((t, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 py-0.5 text-[12px] leading-snug"
                >
                  <span className="mt-[1px] shrink-0 font-mono text-[11px]" aria-hidden>
                    <TodoMark status={t.status} />
                  </span>
                  <span
                    className={`min-w-0 flex-1 break-words ${t.status === 'completed' || t.status === 'cancelled' ? 'text-gn-muted' : 'text-gn-fg'}`}
                  >
                    {t.content}
                  </span>
                </div>
              ))}
              {goalTodos.length > 15 && (
                <div className="py-0.5 font-mono text-[10.5px] text-gn-gutter">
                  +{goalTodos.length - 15} more
                </div>
              )}
            </div>
          </div>
        )}
        <div className="border-t border-gn-prompt-border px-3 py-1.5 font-mono text-[11px] text-gn-muted">
          <div className="flex items-center justify-between gap-2">
            <span>{tokensDisplay}</span>
            <span className="tabular-nums">elapsed {fmtElapsedCompact(elapsed)}</span>
          </div>
          {/* TUI goal_detail budget bar ([bar] NN%) — budget_color semantics. */}
          {budget > 0 && (
            <div className="mt-1.5 flex items-center gap-2">
              <span className="shrink-0 text-gn-gutter">budget</span>
              <span className="inline-flex items-center gap-1.5 tabular-nums">
                <span aria-hidden className="whitespace-nowrap">
                  <span className={budgetColorClass}>
                    {'█'.repeat(budgetFilled)}
                  </span>
                  <span className="text-gn-gray-dim">
                    {'░'.repeat(GOAL_BUDGET_BAR_W - budgetFilled)}
                  </span>
                </span>
                <span className={budgetColorClass}>
                  {(budgetPct * 100).toFixed(0)}%
                </span>
              </span>
            </div>
          )}
          {(status || phase) && (
            <div className="mt-1 text-gn-gutter">
              status · {status}
              {phase ? ` · phase ${phase}` : ''}
            </div>
          )}
          {(lastEvent || lastEventDetail) && (
            <div className="mt-1 truncate text-gn-gray-dim" title={`${lastEvent} ${lastEventDetail}`}>
              {lastEvent}
              {lastEventDetail ? ` · ${lastEventDetail}` : ''}
            </div>
          )}
        </div>
        {/* ── goal controls — HOST ENGINE (capri-host goal.go /api/goal/*,
            TUI /goal parity; see chat.ts goalSet docs). */}
        <div className="flex flex-wrap items-center gap-2 border-t border-gn-prompt-border px-3 py-1.5">
          <InlineAction
            label="状态"
            tone="neutral"
            title="查询当前自主目标状态"
            onRun={() => goalStatus()}
          />
          <InlineAction
            label="暂停"
            tone="neutral"
            disabled={!active}
            title="暂停当前自主目标"
            onRun={() => goalPause()}
          />
          <InlineAction
            label="恢复"
            tone="neutral"
            disabled={!paused}
            title="恢复当前自主目标"
            onRun={() => goalResume()}
          />
          <InlineAction
            label="清除"
            title="清除当前自主目标"
            onRun={() => goalClear()}
          />
          <InlineAction
            label="工作流 ↗"
            tone="plan"
            className="ml-auto"
            title="打开 /workflows 工作流运行面板"
            onRun={() => {
              setOpen(false)
              setWorkflowPanelOpen(true)
            }}
          />
        </div>
        {/* ── action feedback: live status line（hub/host 错误只在顶部横幅）── */}
        <div className="border-t border-gn-prompt-border px-3 py-1.5 font-mono text-[10.5px]">
          {statusText && (
            <div className="truncate text-gn-muted" title={statusText}>
              status · {statusText}
            </div>
          )}
        </div>
      </ChipDropdown>
    </div>
  )
}

function kindLabel(e: RunningEntry): string {
  if (e.kind === 'subagent') return 'Agent'
  if (e.kind === 'bg_task') return 'Task'
  return 'Workflow'
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
      className={`shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[12px] leading-none tabular-nums text-gn-accent-running hover:bg-gn-bg-highlight ${ open ? 'bg-gn-bg-highlight' : '' }`}
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
 *  - 「运行中」— live bg_tasks / subagents / workflows (click opens the
 *    block viewer, kill/cancel buttons) — the original strip, kept
 *    verbatim;
 *  - 「调度任务」— /loop scheduled tasks (prompt summary, interval,
 *    nextFireAt, delete button).
 * Shown when {@link RunningChip} is open — not a floating popup, sticks
 * under the status bar.
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
  const spinnerFrame = useSessionSpinner(count > 0 && open)
  const cancelSubagent = useChatStore((s) => s.cancelSubagent)
  const killTask = useChatStore((s) => s.killTask)
  const openViewer = useChatStore((s) => s.openViewer)
  const openTaskViewer = useChatStore((s) => s.openTaskViewer)
  if (!open || (count === 0 && scheduledTasks.length === 0)) return null

  return (
    <div
      id="running-tasks-bar"
      className="shrink-0 border-b border-gn-prompt-border/50 bg-gn-bg-base select-none"
      role="region"
      aria-label={`Running tasks · ${count} · scheduled ${scheduledTasks.length}`}
    >
      {/* Content column matches scrollback/composer (mx-auto max-w-[960px]) */}
      <div
        className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} flex max-h-[min(28vh,12rem)] flex-col overflow-y-auto py-0`}
      >
        {/* 运行中区块：直接列出任务，无标题行。 */}
        {count > 0 && (
          <>
            {topTasks.map((t) => (
              <div
                key={`restored-${t.taskId}`}
                className="group flex min-h-[25px] cursor-pointer items-center gap-1.5 py-0 text-[12px] leading-none hover:bg-gn-bg-highlight"
                title={
                  t.restored
                    ? '恢复的运行中任务（宿主探活确认仍在运行；由 TUI 进程持有，无法在此 kill）· 点击查看日志'
                    : '点击查看日志'
                }
                onClick={() => {
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
                className="group flex min-h-[25px] cursor-pointer items-center gap-1.5 py-0 text-[12px] leading-none hover:bg-gn-bg-highlight"
                title="点击查看日志"
                onClick={() => openViewer(e.id)}
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
                {e.kind === 'subagent' && (e.persona || e.role || e.model || e.reasoningEffort) && (
                  <span className="shrink-0 font-mono text-[10px] text-gn-gutter">
                    {subagentMeta(e.persona, e.role, e.model, e.reasoningEffort)}
                  </span>
                )}
                {e.detail && (
                  <span
                    className="hidden max-w-[28vw] truncate font-mono text-[10px] text-gn-muted sm:inline"
                    title={e.detail}
                  >
                    {e.detail}
                  </span>
                )}
                {e.kind === 'subagent' && e.subagentId && (
                  <InlineAction
                    label="cancel"
                    title="x.ai/subagent/cancel"
                    onRun={() => void cancelSubagent(e.subagentId!)}
                  />
                )}
                {e.kind === 'bg_task' && e.taskId && (
                  <InlineAction
                    label="kill"
                    title="x.ai/task/kill"
                    onRun={() => void killTask(e.taskId!)}
                  />
                )}
              </div>
            ))}
          </>
        )}
        {scheduledTasks.length > 0 && (
          <>
            <div className="flex items-center gap-2 px-1 pb-0.5 pt-1">
              <span className="text-[10px] uppercase tracking-wider text-gn-gutter">
                调度任务 · {scheduledTasks.length}
              </span>
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
                <InlineAction
                  label="delete"
                  title="x.ai/scheduler/delete"
                  onRun={() => void deleteScheduledTask(t.taskId)}
                />
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

// ── MCP / queue / credits chips (TUI status-bar items) ───────────────

/**
 * Wire statuses that count as "connected" for the MCP chip — the agent
 * serializes McpServerStatus lowercase (`ready`); a couple of defensive
 * aliases keep the count honest against older spellings.
 */
function isMcpConnected(status?: string): boolean {
  if (!status) return false
  const s = status.toLowerCase()
  return s === 'ready' || s === 'connected' || s === 'running' || s === 'ok'
}

/**
 * `⠋ MCP (N/M)` chip — TUI mcp_status_line (gray_dim, after the goal
 * chip): connected/total server counts from the x.ai/mcp/server_status
 * stream (store mcpServers). Hidden until the stream reports servers;
 * click opens the MCP panel.
 */
export function McpChip({ onOpen }: { onOpen: () => void }) {
  const mcpServers = useChatStore((s) => s.mcpServers)
  const total = mcpServers.length
  if (total === 0) return null
  const connected = mcpServers.filter((s) => isMcpConnected(s.status)).length
  return (
    <button
      type="button"
      onClick={onOpen}
      className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[12px] leading-none tabular-nums text-gn-gray-dim hover:bg-gn-bg-highlight hover:text-gn-muted"
      title={`MCP 服务器 ${connected}/${total} 已连接 · 点击打开 MCP 面板`}
    >
      <span className="mr-1" aria-hidden>
        ⠋
      </span>
      MCP ({connected}/{total})
    </button>
  )
}

/**
 * `+N` queue badge — TUI queue item (accent_user, after the context
 * chip): mid-turn queued prompt count. Hidden at 0; click expands /
 * collapses the composer's inline queue strip (no popup).
 */
export function QueueBadge() {
  const queue = usePromptQueue((s) => s.queue)
  const open = useChatStore((s) => s.queuePanelOpen)
  const setQueuePanelOpen = useChatStore((s) => s.setQueuePanelOpen)
  if (queue.length === 0) return null
  return (
    <button
      type="button"
      onClick={() => setQueuePanelOpen(!open)}
      aria-expanded={open}
      className={`shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[12px] leading-none tabular-nums text-gn-fg2 hover:bg-gn-bg-highlight ${ open ? 'bg-gn-bg-highlight' : '' }`}
      title={open ? '收起排队消息' : `展开排队消息 · ${queue.length} 条`}
    >
      +{queue.length}
    </button>
  )
}
