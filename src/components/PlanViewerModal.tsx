import { useEffect, useRef, useState } from 'react'
import { transport } from '../api/client'
import { useChatStore } from '../store/chat'
import { planDocFromEntries, planDocFromRequests } from '../scrollback/planDoc'
import { Markdown } from './Markdown'
import { CheckMarkIcon, TodoMark } from './todoMark'

/**
 * /view-plan modal — web counterpart of the TUI `/view-plan` command
 * (Action::ShowPlan → AgentView::show_plan_preview, dispatch/modes.rs),
 * which shows the **plan.md document**, not the todo list.
 *
 * Body sources, in TUI precedence order:
 *   1. the on-disk plan.md via host `/api/session-plan` (authoritative,
 *      readable while still in plan mode — the case the /plan re-entry
 *      hint points at);
 *   2. a pending `x.ai/exit_plan_mode` approval request's planContent;
 *   3. the latest exit_plan_mode tool output replayed in the scrollback
 *      (survives reloads, and covers hosts without the plan endpoint).
 * Only when none of those carries a plan does the modal fall back to the
 * plan-derived todo list (the status-bar badge's own source), labelled as
 * such — a todo list is not a plan.
 */
export function PlanViewerModal() {
  const open = useChatStore((s) => s.planViewerOpen)
  const close = useChatStore((s) => s.closePlanViewer)
  const sessionId = useChatStore((s) => s.sessionId)
  const cwd = useChatStore((s) => s.cwd)
  const todos = useChatStore((s) => s.todos)
  const todoCounts = useChatStore((s) => s.todoCounts)
  const xaiRequests = useChatStore((s) => s.xaiRequests)
  const entries = useChatStore((s) => s.entries)
  const panelRef = useRef<HTMLDivElement>(null)
  // plan.md 正文（来源 1），null = 未取到/取不到，'' = 取到但为空。
  const [filePlan, setFilePlan] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, close])

  // 每次打开重新拉一次 plan.md：plan 模式下正文是边写边落盘的。
  useEffect(() => {
    if (!open) return
    setFilePlan(null)
    if (!sessionId || !cwd) return
    let dead = false
    setLoading(true)
    transport
      .sessionPlan(sessionId, cwd)
      .then((content) => {
        if (!dead) setFilePlan(content)
      })
      .catch(() => {
        // 旧 host 无此端点 / 网络失败：交给下面两级兜底来源。
        if (!dead) setFilePlan('')
      })
      .finally(() => {
        if (!dead) setLoading(false)
      })
    return () => {
      dead = true
    }
  }, [open, sessionId, cwd])

  if (!open) return null

  const plan =
    (filePlan && filePlan.trim() ? filePlan : undefined) ??
    planDocFromRequests(xaiRequests) ??
    planDocFromEntries(entries)
  const hasPlan = !!plan?.trim()
  const hasTodos = !!todos && todos.length > 0
  // planTodos counts semantics (exactly the status-bar badge): cancelled
  // items stay in the list but are excluded from `total`.
  const completed = todoCounts?.completed ?? 0
  const total = todoCounts?.total ?? 0
  const inProgress = todoCounts?.inProgress ?? 0
  const pending = todoCounts?.pending ?? 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="view plan"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="mt-8 flex max-h-[min(80vh,36rem)] w-full max-w-[640px] flex-col rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl outline-none"
      >
        <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
          <span className="font-mono text-[13px] font-bold text-gn-fg">/view-plan</span>
          {hasPlan && (
            <span className="font-mono text-[11px] text-gn-muted">plan.md</span>
          )}
          {hasTodos && (
            <span className="font-mono text-[11px] tabular-nums text-gn-muted">
              {completed}/{total} 完成
            </span>
          )}
          <button
            type="button"
            onClick={close}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            esc
          </button>
        </header>

        {hasPlan ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <Markdown source={plan as string} />
          </div>
        ) : loading && !hasTodos ? (
          <div className="py-6 text-center text-[12px] text-gn-muted">
            读取 plan…
          </div>
        ) : !hasTodos ? (
          <div className="py-6 text-center text-[12px] text-gn-muted">
            当前会话还没有 plan
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-gn-prompt-border/50 px-4 py-1.5 text-[12px]">
              <span className="text-gn-muted">
                没有读到 plan 正文，下面是任务清单
              </span>
              <span className="ml-auto font-mono tabular-nums text-gn-fg2">
                {completed}/{total}
              </span>
              <span className="text-gn-green" aria-hidden>
                <CheckMarkIcon />
              </span>
              <span className="text-gn-gutter">
                {inProgress > 0 ? `${inProgress} 进行中` : ''}
                {inProgress > 0 && pending > 0 ? ' · ' : ''}
                {pending > 0 ? `${pending} 待办` : ''}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {todos.map((t, i) => (
                <div
                  key={t.id ?? i}
                  className="flex items-start gap-2 px-4 py-[5px] text-[12.5px] leading-snug"
                >
                  <span className="mt-[1px] shrink-0 font-mono text-[11px]" aria-hidden>
                    <TodoMark status={t.status} />
                  </span>
                  <span
                    className={`min-w-0 flex-1 break-words ${
                      t.status === 'completed' || t.status === 'cancelled'
                        ? 'text-gn-muted'
                        : 'text-gn-fg'
                    }`}
                  >
                    {t.content}
                  </span>
                  {t.priority && (
                    <span className="shrink-0 text-[10px] text-gn-gutter">{t.priority}</span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <footer className="rounded-b border-t border-gn-prompt-border px-4 py-2 text-right">
          <span className="text-[11px] text-gn-gutter">
            {hasPlan ? 'plan.md · 与 TUI /view-plan 一致' : 'plan 更新'}
          </span>
        </footer>
      </div>
    </div>
  )
}
