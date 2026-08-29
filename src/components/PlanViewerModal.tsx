import { useEffect, useRef } from 'react'
import { useChatStore } from '../store/chat'
import { CheckMarkIcon, TodoMark } from './todoMark'

/**
 * /view-plan modal — web counterpart of the TUI `/view-plan` command
 * (Action::ShowPlan → AgentView::show_plan_preview, dispatch/modes.rs).
 * Renders the CURRENT session's saved plan from the chat store's
 * plan-derived todo state (todos + todoCounts — the same source as the
 * status-bar badge; live plan events never land in the scrollback,
 * events/tools.ts). No fetch needed: the store is authoritative and stays
 * readable mid-turn, so the modal works inside plan mode too (TUI
 * behavior). The wire plan event carries no title field (entries + an
 * optional planMode flag only) — the header uses the command name, like
 * the other modals.
 */
export function PlanViewerModal() {
  const open = useChatStore((s) => s.planViewerOpen)
  const close = useChatStore((s) => s.closePlanViewer)
  const todos = useChatStore((s) => s.todos)
  const todoCounts = useChatStore((s) => s.todoCounts)
  const panelRef = useRef<HTMLDivElement>(null)

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

  if (!open) return null

  const hasPlan = !!todos && todos.length > 0
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
        className="mt-8 flex max-h-[min(80vh,36rem)] w-full max-w-[520px] flex-col rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl outline-none"
      >
        <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
          <span className="font-mono text-[13px] font-bold text-gn-fg">/view-plan</span>
          {hasPlan && (
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

        {!hasPlan ? (
          <div className="py-6 text-center text-[12px] text-gn-muted">
            当前会话还没有 plan
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-gn-prompt-border/50 px-4 py-1.5 text-[12px]">
              <span className="font-mono tabular-nums text-gn-fg2">
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
            plan 更新 · 与 TUI /view-plan 一致
          </span>
        </footer>
      </div>
    </div>
  )
}