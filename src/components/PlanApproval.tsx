import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../theme/layout'
import { Markdown } from './Markdown'

/**
 * x.ai/exit_plan_mode approval strip — web counterpart of the TUI plan
 * approval view (plan_approval_view.rs + agent_view/plan.rs). Approving
 * leaves plan mode and starts the implement turn.
 *
 * Keyboard (the strip owns these keys while mounted, TUI plan approval):
 *   a        approve
 *   s        focus the revision-feedback input
 *   Enter    empty feedback → approve; text → send the revision
 *   Esc      稍后再说 (dismissXai → { outcome:"cancelled" })
 * Keys typed into the composer draft or the feedback input itself pass
 * through untouched, except Enter on the feedback input (the submit
 * action).
 *
 * Response shapes (ExitPlanModeExtResponse):
 *   approved   { outcome:"approved" }
 *   cancelled  { outcome:"cancelled", feedback? }   ("request changes")
 *   abandoned  { outcome:"abandoned" }              ("quit plan")
 */
export function PlanApproval() {
  const xaiRequests = useChatStore((s) => s.xaiRequests)
  const respondXai = useChatStore((s) => s.respondXai)
  const dismissXai = useChatStore((s) => s.dismissXai)

  const req = xaiRequests.find((r) => r.method === 'x.ai/exit_plan_mode')
  const [feedback, setFeedback] = useState('')
  const [showPlan, setShowPlan] = useState(false)
  const feedbackRef = useRef<HTMLInputElement>(null)

  // Fresh state for each new request.
  useEffect(() => {
    setFeedback('')
    setShowPlan(false)
  }, [req?.requestId])

  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      const inFeedback = feedbackRef.current != null && t === feedbackRef.current

      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        void dismissXai(req.requestId)
        return
      }
      // Enter: empty feedback → approve; text present → request changes.
      // Claimed from the body (focus outside inputs) or the feedback input.
      if (e.key === 'Enter' && (!typing || inFeedback)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const fb = feedback.trim()
        if (fb) {
          void respondXai(req.requestId, { outcome: 'cancelled', feedback: fb })
        } else {
          void respondXai(req.requestId, { outcome: 'approved' })
        }
        return
      }
      if (typing) return // letters type normally (composer draft / feedback)
      if (e.key === 'a') {
        e.preventDefault()
        e.stopImmediatePropagation()
        void respondXai(req.requestId, { outcome: 'approved' })
        return
      }
      if (e.key === 's') {
        e.preventDefault()
        e.stopImmediatePropagation()
        feedbackRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req, respondXai, dismissXai, feedback])

  if (!req) return null
  const planContent =
    typeof req.params?.planContent === 'string' ? req.params.planContent : undefined
  // TUI plan.rs: whitespace-only bodies count as "no plan".
  const hasPlan = planContent != null && planContent.trim() !== ''

  return (
    <div className="border-t border-gn-yellow/30 bg-gn-bg-dark py-2.5">
      <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS}`}>
        <div className="mb-1.5 flex items-center gap-2 text-[12px]">
          <span className="text-gn-yellow animate-pulse" aria-hidden>
            {Glyphs.diamondFilled}
          </span>
          <span className="font-bold text-gn-yellow">plan approval</span>
          <span className="text-gn-muted truncate">
            批准后退出计划模式并开始实施
          </span>
        </div>

        {hasPlan ? (
          <div className="mb-2 rounded border border-gn-prompt-border bg-gn-bg-base px-3 py-2">
            <button
              type="button"
              onClick={() => setShowPlan((v) => !v)}
              className="mb-1 text-[11px] font-semibold text-gn-muted hover:text-gn-fg"
            >
              {showPlan ? '▾ 收起计划' : '▸ 查看计划'} (
              {planContent.split('\n').length} 行)
            </button>
            {showPlan && (
              <div className="gn-no-scrollbar max-h-[50vh] overflow-y-auto text-[12.5px]">
                <Markdown source={planContent} />
              </div>
            )}
          </div>
        ) : (
          <div className="mb-2 rounded border border-dashed border-gn-prompt-border bg-gn-bg-base px-3 py-2 text-[12px] text-gn-muted">
            No plan written — approve or request changes
          </div>
        )}

        <div className="mb-2">
          <input
            ref={feedbackRef}
            type="text"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="修改意见（留空时 Enter 直接批准）"
            className="min-h-9 w-full rounded border border-gn-prompt-border bg-gn-bg-base px-3 text-[12.5px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-yellow/60"
          />
        </div>

        <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap pl-0 sm:pl-5">
          <button
            type="button"
            onClick={() => void respondXai(req.requestId, { outcome: 'approved' })}
            className="min-h-10 rounded border border-gn-green/50 bg-gn-bg-base px-3 py-1.5 text-[12.5px] text-gn-fg hover:bg-gn-bg-highlight"
          >
            <span className="mr-1 inline-flex items-center">
              {Glyphs.checkMark}
            </span>
            批准并开始实施
          </button>
          <button
            type="button"
            onClick={() => feedbackRef.current?.focus()}
            className="min-h-10 rounded border border-gn-prompt-border bg-gn-bg-base px-3 py-1.5 text-[12.5px] text-gn-fg2 hover:bg-gn-bg-highlight"
          >
            请求修改
          </button>
          <button
            type="button"
            onClick={() => void respondXai(req.requestId, { outcome: 'abandoned' })}
            className="min-h-10 rounded border border-gn-red/40 bg-gn-bg-base px-3 py-1.5 text-[12.5px] text-gn-red hover:bg-gn-diff-del-bg"
          >
            退出计划模式
          </button>
          <button
            type="button"
            onClick={() => void dismissXai(req.requestId)}
            className="min-h-10 rounded px-3 py-1.5 text-[12.5px] text-gn-muted hover:bg-gn-bg-highlight sm:ml-auto"
          >
            稍后再说
          </button>
        </div>

        <div className="mt-1.5 pl-0 text-[11px] text-gn-muted sm:pl-5">
          <span className="text-gn-fg2">a</span> 批准 ·{' '}
          <span className="text-gn-fg2">Enter</span> 提交 ·{' '}
          <span className="text-gn-fg2">s</span> 写意见
        </div>
      </div>
    </div>
  )
}
