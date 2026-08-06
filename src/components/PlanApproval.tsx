import { useState } from 'react'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../theme/layout'

/**
 * x.ai/exit_plan_mode approval strip — web counterpart of the TUI plan
 * approval view. Approving leaves plan mode and starts the implement turn.
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
  const [requestingChanges, setRequestingChanges] = useState(false)
  const [showPlan, setShowPlan] = useState(false)

  if (!req) return null
  const planContent =
    typeof req.params?.planContent === 'string'
      ? req.params.planContent
      : undefined

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

        {planContent ? (
          <div className="mb-2 rounded border border-gn-prompt-border bg-gn-bg-base px-3 py-2">
            <button
              type="button"
              onClick={() => setShowPlan((v) => !v)}
              className="mb-1 text-[11px] font-semibold text-gn-muted hover:text-gn-fg"
            >
              {showPlan ? '▾ 收起计划' : '▸ 查看计划'} ({planContent.split('\n').length} 行)
            </button>
            {showPlan && (
              <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-gn-fg2">
                {planContent}
              </pre>
            )}
          </div>
        ) : null}

        {requestingChanges ? (
          <div className="mb-2 flex flex-col gap-1.5 sm:flex-row">
            <input
              type="text"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="修改意见（例如：先补测试再实施）"
              className="min-h-9 flex-1 rounded border border-gn-prompt-border bg-gn-bg-base px-3 text-[12.5px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-yellow/60"
              autoFocus
            />
            <button
              type="button"
              onClick={() => {
                void respondXai(req.requestId, {
                  outcome: 'cancelled',
                  ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
                })
              }}
              className="min-h-9 rounded border border-gn-yellow/50 px-3 text-[12.5px] text-gn-yellow hover:bg-gn-bg-highlight"
            >
              发送修改意见
            </button>
          </div>
        ) : null}

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
            onClick={() => {
              setFeedback('')
              setRequestingChanges((v) => !v)
            }}
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
      </div>
    </div>
  )
}
