import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../theme/layout'

/**
 * x.ai/exit_plan_mode approval strip — web counterpart of the TUI plan
 * approval view (plan_approval_view.rs + agent_view/plan.rs). Approving
 * leaves plan mode and starts the implement turn.
 *
 * Plan review is LINE-BASED like the TUI's commenting mode: the preview
 * shows the plan with 1:1 line numbers; clicking a line selects it
 * (Shift+click / drag selects a range). Sending "请求修改" with a
 * selection composes a line comment in the TUI format:
 *   single line: "Proposed plan line 12:"
 *   range:       "Proposed plan lines 1-3:"
 *   body:        "> <snippet>" per selected line, then "Comment:\n<正文>"
 * (plan_approval_view.rs format_feedback / inline_plan_snippets).
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

/**
 * TUI inline_plan_snippets + format_feedback (plan_approval_view.rs):
 * `{label}\n{> snippet lines}\n\nComment:\n{正文}`. Lines are 1-based;
 * `end` is inclusive (the TUI's half-open range end − 1).
 */
function buildLineComment(lines: string[], start: number, end: number, text: string): string {
  const label =
    start === end
      ? `Proposed plan line ${start}:`
      : `Proposed plan lines ${start}-${end}:`
  const snippets = lines
    .slice(start - 1, end)
    .map((l) => `> ${l}`)
    .join('\n')
  return `${label}\n${snippets}\n\nComment:\n${text}`
}

export function PlanApproval() {
  const xaiRequests = useChatStore((s) => s.xaiRequests)
  const respondXai = useChatStore((s) => s.respondXai)
  const dismissXai = useChatStore((s) => s.dismissXai)

  const req = xaiRequests.find((r) => r.method === 'x.ai/exit_plan_mode')
  const [feedback, setFeedback] = useState('')
  const [showPlan, setShowPlan] = useState(true)
  const feedbackRef = useRef<HTMLInputElement>(null)
  // Selected plan line range (1-based inclusive; null = none selected).
  const [selStart, setSelStart] = useState<number | null>(null)
  const [selEnd, setSelEnd] = useState<number | null>(null)
  /** Drag anchor: the line the drag started on (null = not dragging). */
  const [dragAnchor, setDragAnchor] = useState<number | null>(null)

  // Pure derivations — memoized so the keydown effect's deps stay stable
  // across renders (planLines/selection recompute only when their inputs
  // change; a fresh array/object per render would re-attach the listener).
  const planContent =
    typeof req?.params?.planContent === 'string' ? req.params.planContent : undefined
  // TUI plan.rs: whitespace-only bodies count as "no plan".
  const hasPlan = planContent != null && planContent.trim() !== ''
  const planLines = useMemo(
    () => (hasPlan && planContent != null ? planContent.split('\n') : []),
    [hasPlan, planContent],
  )

  /** 选中范围（1-based 升序）；null = 无选中。 */
  const selection = useMemo(
    () =>
      selStart != null && selEnd != null
        ? { start: Math.min(selStart, selEnd), end: Math.max(selStart, selEnd) }
        : null,
    [selStart, selEnd],
  )

  // Fresh state for each new request.
  useEffect(() => {
    setFeedback('')
    setShowPlan(true)
    setSelStart(null)
    setSelEnd(null)
    setDragAnchor(null)
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
      // Enter: empty feedback → approve; text present → request changes
      // (with a line selection, the feedback is composed as a line
      // comment — same format as the 请求修改 button).
      // Claimed from the body (focus outside inputs) or the feedback input.
      if (e.key === 'Enter' && (!typing || inFeedback)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const fb = feedback.trim()
        if (fb) {
          let body = fb
          if (selection) {
            body = buildLineComment(planLines, selection.start, selection.end, fb)
          }
          void respondXai(req.requestId, { outcome: 'cancelled', feedback: body })
        } else {
          void respondXai(req.requestId, { outcome: 'approved' })
        }
        return
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req, respondXai, dismissXai, feedback, selection, planLines])

  if (!req) return null

  const selectLine = (line: number, extend: boolean) => {
    if (extend) {
      // Shift+点击: 从当前锚点扩展到该行（TUI Commenting 范围选择）。
      if (selStart != null) {
        setSelEnd(line)
      } else {
        setSelStart(line)
        setSelEnd(line)
      }
    }
  }

  /** 请求修改：选中行 → 组装行级评论；否则仅正文。 */
  const sendRevision = () => {
    const fb = feedback.trim()
    let body = fb
    if (fb && selection) {
      body = buildLineComment(planLines, selection.start, selection.end, fb)
    }
    void respondXai(req.requestId, {
      outcome: 'cancelled',
      ...(body ? { feedback: body } : {}),
    })
  }

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
            <div className="mb-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowPlan((v) => !v)}
                className="text-[11px] font-semibold text-gn-muted hover:text-gn-fg"
              >
                {showPlan ? '▾ 收起计划' : '▸ 查看计划'} ({planLines.length} 行)
              </button>
              {showPlan && selection && (
                <span className="min-w-0 truncate font-mono text-[10.5px] text-gn-cyan">
                  已选中第 {selection.start}-
                  {selection.end} 行 · 请求修改时生成行级评论
                </span>
              )}
            </div>
            {showPlan && (
              <div className="gn-no-scrollbar max-h-[50vh] overflow-y-auto text-[12.5px]">
                {/* 行号 1:1 —— TUI Commenting 模式的计划预览（行号 + 点击选行）。 */}
                <div
                  className="select-none"
                  onMouseUp={() => setDragAnchor(null)}
                  onMouseLeave={() => setDragAnchor(null)}
                >
                  {planLines.map((line, i) => {
                    const n = i + 1
                    const selected =
                      selection != null && n >= selection.start && n <= selection.end
                    return (
                      <div
                        key={n}
                        onMouseDown={(e) => {
                          // 单击 = 锚定到该行；按住拖动 = 范围扩展；
                          // Shift+点击在 onClick 里从锚点扩展。
                          if (!e.shiftKey) {
                            setDragAnchor(n)
                            setSelStart(n)
                            setSelEnd(n)
                          }
                        }}
                        onMouseEnter={() => {
                          // 拖动经过的行加入范围。
                          if (dragAnchor != null) {
                            setSelStart(dragAnchor)
                            setSelEnd(n)
                          }
                        }}
                        onClick={(e) => {
                          if (e.shiftKey) selectLine(n, true)
                        }}
                        className={`flex cursor-pointer items-stretch hover:bg-gn-bg-highlight ${
 selected ? 'bg-gn-bg-highlight' : ''
                        }`}
                        title={
                          selection
                            ? 'Shift+点击或拖动扩展选择范围'
                            : '点击选中该行（Shift+点击或拖动选范围）'
                        }
                      >
                        <span
                          className={`shrink-0 w-8 select-none border-r border-gn-prompt-border/40 pr-1.5 text-right font-mono text-[10.5px] leading-[1.45] tabular-nums ${
 selected ? 'text-gn-cyan' : 'text-gn-gutter'
                          }`}
                        >
                          {n}
                        </span>
                        <span
                          className={`min-w-0 flex-1 whitespace-pre-wrap break-all pl-1.5 leading-[1.45] ${
 selected ? 'text-gn-fg' : 'text-gn-fg2'
                          }`}
                        >
                          {line || ' '}
                        </span>
                      </div>
                    )
                  })}
                </div>
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
            className="inline-flex min-h-10 items-center gap-1 rounded bg-gn-bg-base px-3 py-1.5 text-[12.5px] text-gn-fg hover:bg-gn-bg-highlight"
          >
            {Glyphs.checkMark}
            批准并开始实施
          </button>
          <button
            type="button"
            onClick={() => {
              if (feedback.trim()) {
                sendRevision()
              } else {
                feedbackRef.current?.focus()
              }
            }}
            className="min-h-10 rounded bg-gn-bg-base px-3 py-1.5 text-[12.5px] text-gn-fg2 hover:bg-gn-bg-highlight"
            title={
              selection
                ? '以行级评论发送修改意见（Proposed plan lines …）'
                : '发送修改意见'
            }
          >
            请求修改
          </button>
          <button
            type="button"
            onClick={() => void respondXai(req.requestId, { outcome: 'abandoned' })}
            className="min-h-10 rounded bg-gn-bg-base px-3 py-1.5 text-[12.5px] text-gn-red hover:bg-gn-diff-del-bg"
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
