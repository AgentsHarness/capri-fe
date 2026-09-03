import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import type { WorkflowRun } from '../store/chat'
import { fmtElapsedCompact, fmtTok } from '../format'

/**
 * /workflows run dashboard (TUI /workflows pane + workflows_overlay.rs) —
 * modal with a two-level layout:
 *
 *   list  →  Enter / click a run opens its detail view (status,
 *            current_phase, progress, phase rail, agent roster,
 *            elapsed, script) — the store's `selectedWorkflowRunId`
 *            owns the open run (TUI detail_run_id).
 *
 * Data plane: `workflowRuns` fed by `workflow_updated` session
 * notifications (runId/name/status guaranteed; everything else parsed
 * defensively — blocks without data are simply not rendered).
 *
 * Control plane: the ACP wire defines NO workflow-control methods, so
 * pause/resume/stop go through the PROMPT path (chat.workflowControl —
 * instructs the agent to use the workflow tool). The row is optimistically
 * updated to the target status with a 「控制指令已发送」 marker; the next
 * workflow_updated for the run is authoritative and corrects both. Save
 * script is local-only (clipboard copy of the event's script payload).
 *
 * Keys (TUI workflows_overlay.rs): list j/k/↑↓ move · Enter opens detail;
 * detail Esc back to the list, Esc again closes; p/r/x/s act on the
 * selected run (list) or the shown run (detail) — gated by status:
 * running → pause/stop, paused → resume/stop, budget_limited → resume,
 * cancelled/completed → no controls (save-script only).
 */

/** Wire statuses → the small vocabulary the panel gates on (TUI
 *  workflows.rs can_pause/can_resume sets; web aliases included). */
function normalizeStatus(status: string): string {
  switch (status) {
    case 'active':
      return 'running'
    case 'user_paused':
    case 'back_off_paused':
    case 'no_progress_paused':
    case 'infra_paused':
    case 'blocked':
      return 'paused'
    case 'complete':
      return 'done'
    case 'interrupted':
      return 'failed'
    default:
      return status
  }
}

function canPause(status: string): boolean {
  return normalizeStatus(status) === 'running'
}

function canResume(status: string): boolean {
  return normalizeStatus(status) === 'paused' || status === 'budget_limited'
}

function canStop(status: string): boolean {
  const s = normalizeStatus(status)
  return s === 'running' || s === 'paused'
}

export function WorkflowPanel() {
  const open = useChatStore((s) => s.workflowPanelOpen)
  const setOpen = useChatStore((s) => s.setWorkflowPanelOpen)
  const runs = useChatStore((s) => s.workflowRuns)
  const selectedWorkflowRunId = useChatStore((s) => s.selectedWorkflowRunId)
  const setSelectedWorkflowRunId = useChatStore((s) => s.setSelectedWorkflowRunId)
  const workflowControl = useChatStore((s) => s.workflowControl)
  const saveWorkflowScript = useChatStore((s) => s.saveWorkflowScript)
  const panelRef = useRef<HTMLDivElement>(null)
  // List cursor (TUI selected_run); the detail run lives in the store.
  const [cursor, setCursor] = useState(0)
  // Live-elapsed tick while the detail view shows an active run.
  const [, setTick] = useState(0)

  // Newest first — fall back to first-seen when the wire has no start time.
  const list = useMemo(
    () =>
      Object.values(runs).sort(
        (a, b) =>
          (b.startedAt ?? b.firstSeenAt) - (a.startedAt ?? a.firstSeenAt),
      ),
    [runs],
  )

  // Keep the list cursor in range as runs come and go.
  useEffect(() => {
    if (cursor >= list.length) setCursor(Math.max(0, list.length - 1))
  }, [list.length, cursor])

  const detailRun = selectedWorkflowRunId
    ? runs[selectedWorkflowRunId]
    : undefined
  // Control keys act on the detail run when open, the cursor row otherwise.
  const activeRun = detailRun ?? list[cursor]
  const detailActive = !!detailRun && canPause(detailRun.status)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const prevent = () => {
        e.preventDefault()
        e.stopPropagation()
      }
      if (e.key === 'Escape') {
        prevent()
        if (detailRun) setSelectedWorkflowRunId(undefined)
        else setOpen(false)
        return
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        if (detailRun) return
        prevent()
        setCursor((c) => Math.min(list.length - 1, c + 1))
        return
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        if (detailRun) return
        prevent()
        setCursor((c) => Math.max(0, c - 1))
        return
      }
      if (e.key === 'Enter' && !detailRun) {
        const run = list[cursor]
        if (run) {
          prevent()
          setSelectedWorkflowRunId(run.runId)
        }
        return
      }
      if (!activeRun) return
      if (e.key === 'p') {
        if (canPause(activeRun.status)) {
          prevent()
          workflowControl(activeRun.runId, 'pause')
        }
        return
      }
      if (e.key === 'r') {
        if (canResume(activeRun.status)) {
          prevent()
          workflowControl(activeRun.runId, 'resume')
        }
        return
      }
      if (e.key === 'x') {
        if (canStop(activeRun.status)) {
          prevent()
          workflowControl(activeRun.runId, 'stop')
        }
        return
      }
      if (e.key === 's') {
        prevent()
        void saveWorkflowScript(activeRun.runId)
      }
    }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [
    open,
    detailRun,
    list,
    cursor,
    activeRun,
    workflowControl,
    saveWorkflowScript,
    setOpen,
    setSelectedWorkflowRunId,
  ])

  // TUI live_elapsed_ms: tick once a second while an active run's detail
  // is on screen so the elapsed line keeps moving.
  useEffect(() => {
    if (!open || !detailActive) return
    const t = window.setInterval(() => setTick((v) => v + 1), 1000)
    return () => window.clearInterval(t)
  }, [open, detailActive])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center gn-modal-dim p-4"
      role="dialog"
      aria-modal="true"
      aria-label="workflows"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false)
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="mt-8 w-full max-w-[560px] gn-modal-panel"
      >
        <header className="gn-modal-header">
          <span className="font-mono text-[13px] font-bold text-gn-fg">/workflows</span>
          <span className="min-w-0 truncate text-[11px] text-gn-muted">
            {detailRun
              ? `运行详情 · ${detailRun.name}`
              : `工作流运行面板 · ${list.length}`}
          </span>
          {detailRun && (
            <button
              type="button"
              onClick={() => setSelectedWorkflowRunId(undefined)}
              className="shrink-0 rounded px-2 py-0.5 text-[11px] text-gn-plan hover:bg-gn-bg-highlight"
            >
              ← 返回列表 (esc)
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            esc
          </button>
        </header>

        <div className="max-h-[55vh] overflow-y-auto">
          {list.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-gn-muted">
              暂无工作流运行记录
            </div>
          ) : detailRun ? (
            <RunDetail run={detailRun} />
          ) : (
            list.map((run, i) => (
              <RunRow
                key={run.runId}
                run={run}
                selected={i === cursor}
                onOpen={() => setSelectedWorkflowRunId(run.runId)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/** Status badge class per wire status (unknown → neutral). */
function badgeClass(status: string): string {
  switch (normalizeStatus(status)) {
    case 'running':
      return 'border-gn-accent-running/60 text-gn-accent-running'
    case 'paused':
      return 'border-gn-warning/60 text-gn-warning'
    case 'done':
      return 'border-gn-green/60 text-gn-green'
    case 'failed':
      return 'border-gn-red/60 text-gn-red'
    case 'cancelled':
      return 'border-gn-gutter/60 text-gn-gutter'
    default:
      return 'border-gn-prompt-border text-gn-muted'
  }
}

function statusLabel(status: string): string {
  const s = normalizeStatus(status)
  if (s === 'done') return 'Done'
  if (s === 'cancelled') return 'Cancelled'
  if (s === 'budget_limited') return 'Budget limited'
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—'
}

/** Fixed-width bar (ContextChip style) — shown only when the event
 *  carried a progress value. */
function ProgressBar({ p }: { p: number }) {
  const pct = Math.max(0, Math.min(1, p)) * 100
  const width = 14
  const filled = Math.round((pct / 100) * width)
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] tabular-nums text-gn-fg2">
      <span className="whitespace-nowrap" aria-hidden>
        <span className="text-gn-plan">{'█'.repeat(filled)}</span>
        <span className="text-gn-gray-dim">{'░'.repeat(width - filled)}</span>
      </span>
      <span>{pct.toFixed(0)}%</span>
    </span>
  )
}

/** Start time — wire startedAt, falling back to the local first-seen. */
function fmtStart(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Elapsed for a run: wire elapsed_ms, else now − started_at (local
 *  first-seen as the last resort). */
function runElapsedMs(run: WorkflowRun): number | undefined {
  if (run.elapsedMs != null && run.elapsedMs >= 0) return run.elapsedMs
  const start = run.startedAt ?? run.firstSeenAt
  if (start > 0) return Math.max(0, Date.now() - start)
  return undefined
}

/** TUI agent_glyph_and_style (workflows.rs): ● running · ✓ done ·
 *  ✗ failed · ◌ other. */
function agentGlyph(state?: string) {
  switch (state) {
    case 'running':
      return <span className="text-gn-plan">●</span>
    case 'done':
    case 'completed':
    case 'complete':
      return <span className="text-gn-green">✓</span>
    case 'failed':
    case 'interrupted':
      return <span className="text-gn-red">✗</span>
    default:
      return <span className="text-gn-gray-dim">◌</span>
  }
}

const ctlBtn =
  'rounded px-2 py-0.5 text-[11px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg disabled:cursor-not-allowed disabled:opacity-40'
const dangerBtn =
  'rounded px-2 py-0.5 text-[11px] text-gn-red opacity-80 hover:bg-gn-diff-del-bg hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40'

function RunRow({
  run,
  selected,
  onOpen,
}: {
  run: WorkflowRun
  selected: boolean
  onOpen: () => void
}) {
  const workflowControl = useChatStore((s) => s.workflowControl)
  const saveWorkflowScript = useChatStore((s) => s.saveWorkflowScript)
  const inFlight = !!run.pendingControl
  return (
    <div
      className={`cursor-pointer border-b border-gn-prompt-border/50 px-4 py-2 last:border-b-0 ${
 selected ? 'bg-gn-bg-highlight' : ''
      }`}
      onClick={onOpen}
      title="点击或 Enter 查看运行详情"
    >
      <div className="flex items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-gn-fg"
          title={run.name}
        >
          {run.name}
        </span>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none ${badgeClass(run.status)}`}
        >
          {statusLabel(run.status)}
        </span>
        {run.phase && (
          <span className="shrink-0 rounded border border-gn-prompt-border px-1.5 py-0.5 font-mono text-[10px] leading-none text-gn-muted">
            {run.phase}
          </span>
        )}
        {inFlight && (
          <span
            className="shrink-0 rounded border border-gn-warning/70 bg-gn-warning/10 px-1.5 py-0.5 font-mono text-[10px] leading-none text-gn-warning"
            title="控制指令已通过提示词路径发送，等待 workflow_updated 校正"
          >
            控制指令已发送
          </span>
        )}
      </div>
      {run.progress != null && (
        <div className="mt-1.5">
          <ProgressBar p={run.progress} />
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10.5px] text-gn-muted">
        {run.agents && run.agents.length > 0 && (
          <span
            className="min-w-0 max-w-[60%] truncate"
            title={run.agents.join(', ')}
          >
            agents · {run.agents.join(', ')}
          </span>
        )}
        <span
          className="tabular-nums"
          title={`started ${new Date(run.startedAt ?? run.firstSeenAt).toLocaleString()}`}
        >
          started · {fmtStart(run.startedAt ?? run.firstSeenAt)}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {canPause(run.status) && (
          <button
            type="button"
            disabled={inFlight}
            onClick={(e) => {
              e.stopPropagation()
              workflowControl(run.runId, 'pause')
            }}
            className={ctlBtn}
            title="提示词路径: 请暂停工作流（workflow 工具 pause）"
          >
            暂停
          </button>
        )}
        {canResume(run.status) && (
          <button
            type="button"
            disabled={inFlight}
            onClick={(e) => {
              e.stopPropagation()
              workflowControl(run.runId, 'resume')
            }}
            className={ctlBtn}
            title="提示词路径: 请恢复工作流（workflow 工具 resume）"
          >
            恢复
          </button>
        )}
        {canStop(run.status) && (
          <button
            type="button"
            disabled={inFlight}
            onClick={(e) => {
              e.stopPropagation()
              workflowControl(run.runId, 'stop')
            }}
            className={dangerBtn}
            title="提示词路径: 请停止工作流（workflow 工具 stop）"
          >
            停止
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            void saveWorkflowScript(run.runId)
          }}
          className={ctlBtn}
          title="复制该运行的工作流脚本到剪贴板（仅当 workflow_updated 携带 script 字段）"
        >
          保存脚本
        </button>
      </div>
    </div>
  )
}

/**
 * Detail view for one run (TUI workflows.rs render_detail): status,
 * objective, elapsed, progress, phase rail (current phase highlighted),
 * agent roster (name/status/tokens) and the script payload — every block
 * renders only when the event carried the data.
 */
function RunDetail({ run }: { run: WorkflowRun }) {
  const workflowControl = useChatStore((s) => s.workflowControl)
  const saveWorkflowScript = useChatStore((s) => s.saveWorkflowScript)
  const inFlight = !!run.pendingControl
  const elapsed = runElapsedMs(run)

  return (
    <div className="border-b border-gn-prompt-border/50 px-4 py-3">
      <div className="flex items-center gap-2">
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none ${badgeClass(run.status)}`}
        >
          {statusLabel(run.status)}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[13px] font-bold text-gn-fg"
          title={run.name}
        >
          {run.name}
        </span>
        {run.phase && (
          <span className="shrink-0 rounded border border-gn-prompt-border px-1.5 py-0.5 font-mono text-[10px] leading-none text-gn-muted">
            phase · {run.phase}
          </span>
        )}
        {inFlight && (
          <span
            className="shrink-0 rounded border border-gn-warning/70 bg-gn-warning/10 px-1.5 py-0.5 font-mono text-[10px] leading-none text-gn-warning"
            title="控制指令已通过提示词路径发送，等待 workflow_updated 校正"
          >
            控制指令已发送
          </span>
        )}
      </div>

      {run.objective && (
        <div className="mt-1 text-[11.5px] leading-snug text-gn-muted" title={run.objective}>
          {run.objective}
        </div>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10.5px] text-gn-muted">
        <span className="tabular-nums">
          elapsed · {elapsed != null ? fmtElapsedCompact(elapsed) : '—'}
        </span>
        {run.agents && run.agents.length > 0 && (
          <span className="tabular-nums">agents · {run.agents.length}</span>
        )}
      </div>

      {run.progress != null && (
        <div className="mt-2">
          <ProgressBar p={run.progress} />
        </div>
      )}

      {/* Phase rail (TUI phase_rail) — current phase highlighted. */}
      {run.phases && run.phases.length > 0 && (
        <div className="mt-2.5">
          <div className="text-[10px] uppercase tracking-wider text-gn-gutter">
            phases
          </div>
          <div className="mt-0.5 space-y-0.5">
            {run.phases.map((ph) => {
              const current =
                run.phase === ph.title || ph.state === 'active'
              return (
                <div
                  key={ph.title}
                  className={`flex items-center gap-2 font-mono text-[11px] ${
 current ? 'text-gn-plan' : 'text-gn-muted'
                  }`}
                >
                  <span className="w-4 shrink-0" aria-hidden>
                    {current ? '▶' : '·'}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={ph.title}>
                    {ph.title}
                  </span>
                  {ph.state && (
                    <span className="shrink-0 text-gn-gray-dim">{ph.state}</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Agent roster (TUI render_detail roster) — name/status/tokens. */}
      {run.agentRoster && run.agentRoster.length > 0 && (
        <div className="mt-2.5">
          <div className="text-[10px] uppercase tracking-wider text-gn-gutter">
            agents
          </div>
          <div className="mt-0.5 space-y-0.5">
            {run.agentRoster.map((a, i) => (
              <div key={`${a.name}-${i}`} className="flex items-center gap-2 font-mono text-[11px]">
                <span className="w-4 shrink-0" aria-hidden>
                  {agentGlyph(a.status)}
                </span>
                <span className="min-w-0 flex-1 truncate text-gn-fg" title={a.name}>
                  {a.name}
                </span>
                {a.status && (
                  <span className="shrink-0 text-gn-muted">{a.status}</span>
                )}
                {a.tokens != null && a.tokens > 0 && (
                  <span className="shrink-0 tabular-nums text-gn-muted">
                    {fmtTok(a.tokens)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Script payload — the save-script source. */}
      {run.script != null && run.script.trim() !== '' && (
        <div className="mt-2.5">
          <div className="text-[10px] uppercase tracking-wider text-gn-gutter">
            script
          </div>
          <pre className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1.5 font-mono text-[10px] leading-snug text-gn-fg2">
            {run.script}
          </pre>
        </div>
      )}

      {/* Control buttons gated by status (p/r/x keyboard mirrors these). */}
      <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-gn-prompt-border/60 pt-2">
        {canPause(run.status) && (
          <button
            type="button"
            disabled={inFlight}
            onClick={() => workflowControl(run.runId, 'pause')}
            className={ctlBtn}
            title="提示词路径: 请暂停工作流（workflow 工具 pause）"
          >
            暂停 (p)
          </button>
        )}
        {canResume(run.status) && (
          <button
            type="button"
            disabled={inFlight}
            onClick={() => workflowControl(run.runId, 'resume')}
            className={ctlBtn}
            title="提示词路径: 请恢复工作流（workflow 工具 resume）"
          >
            恢复 (r)
          </button>
        )}
        {canStop(run.status) && (
          <button
            type="button"
            disabled={inFlight}
            onClick={() => workflowControl(run.runId, 'stop')}
            className={dangerBtn}
            title="提示词路径: 请停止工作流（workflow 工具 stop）"
          >
            停止 (x)
          </button>
        )}
        <button
          type="button"
          onClick={() => void saveWorkflowScript(run.runId)}
          className={ctlBtn}
          title="复制该运行的工作流脚本到剪贴板（仅当 workflow_updated 携带 script 字段）"
        >
          保存脚本 (s)
        </button>
      </div>
    </div>
  )
}
