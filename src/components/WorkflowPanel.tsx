import { useEffect, useRef } from 'react'
import { useChatStore } from '../store/chat'
import type { WorkflowRun } from '../store/chat'

/**
 * /workflows run dashboard (TUI /workflows pane) — modal.
 *
 * Data plane: `workflowRuns` fed by `workflow_updated` session
 * notifications (runId/name/status/phase guaranteed; progress / script /
 * agent roster / start time parsed defensively).
 *
 * Control plane: the ACP wire defines NO workflow-control methods, so
 * pause/resume/stop go through the PROMPT path (chat.workflowControl —
 * instructs the agent to use the workflow tool). The row is optimistically
 * updated to the target status with a 「控制指令已发送」 marker; the next
 * workflow_updated for the run is authoritative and corrects both. Save
 * script is local-only (clipboard copy of the event's script payload).
 *
 * Row status machine (local optimistic vs event correction):
 *   running --pause--> paused   --resume--> running   (pendingControl marker)
 *   running/paused --stop--> cancelled
 *   done/failed/cancelled are terminal (save-script only)
 */
export function WorkflowPanel() {
  const open = useChatStore((s) => s.workflowPanelOpen)
  const setOpen = useChatStore((s) => s.setWorkflowPanelOpen)
  const runs = useChatStore((s) => s.workflowRuns)
  // Action feedback: status line + error line (same pattern as GoalChip).
  const statusText = useChatStore((s) => s.statusText)
  const error = useChatStore((s) => s.error)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setOpen])

  if (!open) return null

  // Newest first — fall back to first-seen when the wire has no start time.
  const list = Object.values(runs).sort(
    (a, b) =>
      (b.startedAt ?? b.firstSeenAt) - (a.startedAt ?? a.firstSeenAt),
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-[1px] p-4"
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
        className="mt-8 w-full max-w-[560px] rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl outline-none"
      >
        <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
          <span className="font-mono text-[13px] font-bold text-gn-fg">/workflows</span>
          <span className="text-[11px] text-gn-muted">
            工作流运行面板 · {list.length}
          </span>
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
          ) : (
            list.map((run) => <RunRow key={run.runId} run={run} />)
          )}
        </div>

        <footer className="rounded-b border-t border-gn-prompt-border px-4 py-2 font-mono text-[10.5px]">
          {statusText && (
            <div className="truncate text-gn-muted" title={statusText}>
              status · {statusText}
            </div>
          )}
          {error && (
            <div className="truncate text-gn-red" title={error}>
              error · {error}
            </div>
          )}
          <div className="mt-0.5 text-gn-gutter">
            控制走提示词路径（协议未定义 workflow 控制 wire 方法）· 状态由 workflow_updated 校正
          </div>
        </footer>
      </div>
    </div>
  )
}

/** Status badge class per wire status (unknown → neutral). */
function badgeClass(status: string): string {
  switch (status) {
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
  if (status === 'done') return 'Done'
  if (status === 'cancelled') return 'Cancelled'
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : '—'
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

const ctlBtn =
  'rounded border border-gn-prompt-border px-2 py-0.5 text-[11px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg disabled:cursor-not-allowed disabled:opacity-40'
const dangerBtn =
  'rounded border border-gn-red/40 px-2 py-0.5 text-[11px] text-gn-red opacity-80 hover:bg-gn-diff-del-bg hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40'

function RunRow({ run }: { run: WorkflowRun }) {
  const workflowControl = useChatStore((s) => s.workflowControl)
  const saveWorkflowScript = useChatStore((s) => s.saveWorkflowScript)
  const inFlight = !!run.pendingControl
  return (
    <div className="border-b border-gn-prompt-border/50 px-4 py-2 last:border-b-0">
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
        {run.status === 'running' && (
          <>
            <button
              type="button"
              disabled={inFlight}
              onClick={() => workflowControl(run.runId, 'pause')}
              className={ctlBtn}
              title="提示词路径: 请暂停工作流（workflow 工具 pause）"
            >
              暂停
            </button>
            <button
              type="button"
              disabled={inFlight}
              onClick={() => workflowControl(run.runId, 'stop')}
              className={dangerBtn}
              title="提示词路径: 请停止工作流（workflow 工具 stop）"
            >
              停止
            </button>
          </>
        )}
        {run.status === 'paused' && (
          <>
            <button
              type="button"
              disabled={inFlight}
              onClick={() => workflowControl(run.runId, 'resume')}
              className={ctlBtn}
              title="提示词路径: 请恢复工作流（workflow 工具 resume）"
            >
              恢复
            </button>
            <button
              type="button"
              disabled={inFlight}
              onClick={() => workflowControl(run.runId, 'stop')}
              className={dangerBtn}
              title="提示词路径: 请停止工作流（workflow 工具 stop）"
            >
              停止
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => void saveWorkflowScript(run.runId)}
          className={ctlBtn}
          title="复制该运行的工作流脚本到剪贴板（仅当 workflow_updated 携带 script 字段）"
        >
          保存脚本
        </button>
      </div>
    </div>
  )
}
