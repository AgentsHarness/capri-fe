import { useEffect, useState } from 'react'
import { useChatStore } from '../store/chat'
import type { AskQuestion } from '../api/types'
import { Glyphs } from '../theme/glyphs'

/**
 * x.ai/ask_user_question modal — web counterpart of the TUI question view.
 *
 * Answer wire shapes (AskUserQuestionExtResponse):
 *   accepted          { outcome:"accepted", answers:{qText:[labels]},
 *                       annotations?:{qText:{preview?,notes?}} }
 *   chat_about_this   { outcome:"chat_about_this", partial_answers:{qText:label} }  (plan mode)
 *   skip_interview    { outcome:"skip_interview", partial_answers:{qText:label} }   (plan mode)
 *   cancelled         { outcome:"cancelled" }
 */
export function QuestionModal() {
  const xaiRequests = useChatStore((s) => s.xaiRequests)
  const respondXai = useChatStore((s) => s.respondXai)
  const dismissXai = useChatStore((s) => s.dismissXai)

  const req = xaiRequests.find((r) => r.method === 'x.ai/ask_user_question')
  const questions = (req?.params?.questions as AskQuestion[] | undefined) ?? []
  const planMode = (req?.params?.mode as string | undefined) === 'plan'

  // Per-question selection: question idx -> set of option idxs (multi) / single idx.
  const [selected, setSelected] = useState<Record<number, Set<number>>>({})
  // Free-form "Other" input per question.
  const [freeform, setFreeform] = useState<Record<number, string>>({})

  // Reset local state when a new request arrives.
  useEffect(() => {
    setSelected({})
    setFreeform({})
  }, [req?.requestId])

  // Esc cancels.
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        void dismissXai(req.requestId)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req, dismissXai])

  if (!req) return null

  const toggleOption = (qi: number, oi: number, multi?: boolean) => {
    setSelected((prev) => {
      const cur = prev[qi] ?? new Set<number>()
      const next = new Set(cur)
      if (multi) {
        if (next.has(oi)) next.delete(oi)
        else next.add(oi)
      } else {
        next.clear()
        next.add(oi)
      }
      return { ...prev, [qi]: next }
    })
  }

  /** Labels chosen per question (free-form becomes "Other" + notes). */
  const buildAnswers = () => {
    const answers: Record<string, string[]> = {}
    const annotations: Record<string, { preview?: string; notes?: string }> = {}
    questions.forEach((q, qi) => {
      const set = selected[qi] ?? new Set<number>()
      const labels = [...set].map((oi) => q.options[oi]?.label).filter(Boolean)
      const notes = (freeform[qi] ?? '').trim()
      if (notes) {
        labels.push('Other')
        annotations[q.question] = { notes }
      }
      if (labels.length === 0) return
      answers[q.question] = labels
      // Single-select preview annotation (TUI: verbatim Option.preview).
      if (!q.multiSelect && set.size === 1) {
        const oi = [...set][0]
        const preview = q.options[oi]?.preview
        if (preview) annotations[q.question] = { ...annotations[q.question], preview }
      }
    })
    return { answers, annotations }
  }

  const submitAccepted = () => {
    const { answers, annotations } = buildAnswers()
    if (Object.keys(answers).length === 0) return
    void respondXai(req.requestId, {
      outcome: 'accepted',
      answers,
      ...(Object.keys(annotations).length ? { annotations } : {}),
    })
  }

  /** Plan-mode paths: partial answers keyed by question text (label only). */
  const partialAnswers = () => {
    const out: Record<string, string> = {}
    questions.forEach((q, qi) => {
      const set = selected[qi] ?? new Set<number>()
      const labels = [...set].map((oi) => q.options[oi]?.label).filter(Boolean)
      const notes = (freeform[qi] ?? '').trim()
      const pick = labels[0] ?? (notes ? 'Other' : undefined)
      if (pick) out[q.question] = pick
    })
    return out
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="ask user question"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) void dismissXai(req.requestId)
      }}
    >
      <div className="my-4 w-full max-w-[720px] rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl">
        <header className="flex items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5 rounded-t">
          <span className="text-gn-magenta" aria-hidden>
            {Glyphs.diamondFilled}
          </span>
          <span className="text-[13px] font-bold text-gn-fg">
            {planMode ? '设计问题' : '提问'}
          </span>
          <span className="ml-auto text-[11px] text-gn-muted">
            esc 取消
          </span>
        </header>

        <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto px-4 py-4">
          {questions.map((q, qi) => (
            <fieldset key={qi}>
              <legend className="mb-2 text-[13px] font-semibold leading-snug text-gn-fg">
                {q.question}
                {q.multiSelect ? (
                  <span className="ml-2 text-[11px] font-normal text-gn-muted">
                    可多选
                  </span>
                ) : null}
              </legend>
              <div className="flex flex-col gap-1.5">
                {q.options.map((opt, oi) => {
                  const set = selected[qi] ?? new Set<number>()
                  const active = set.has(oi)
                  return (
                    <button
                      key={oi}
                      type="button"
                      onClick={() => toggleOption(qi, oi, q.multiSelect)}
                      className={`flex items-start gap-2 rounded border px-3 py-1.5 text-left text-[12.5px] leading-snug transition-colors min-h-9 ${
                        active
                          ? 'border-gn-magenta/60 bg-gn-bg-highlight text-gn-fg'
                          : 'border-gn-prompt-border text-gn-fg2 hover:bg-gn-bg-highlight'
                      }`}
                    >
                      <span
                        className={`mt-[1px] shrink-0 text-[11px] ${
                          active ? 'text-gn-magenta' : 'text-gn-gutter'
                        }`}
                        aria-hidden
                      >
                        {q.multiSelect
                          ? active
                            ? Glyphs.checkMark
                            : Glyphs.diamondHollow
                          : active
                            ? Glyphs.diamondFilled
                            : Glyphs.diamondHollow}
                      </span>
                      <span className="min-w-0">
                        <span className="block">{opt.label}</span>
                        {opt.description ? (
                          <span className="block text-[11px] text-gn-muted">
                            {opt.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
                <input
                  type="text"
                  value={freeform[qi] ?? ''}
                  onChange={(e) =>
                    setFreeform((prev) => ({ ...prev, [qi]: e.target.value }))
                  }
                  placeholder="其他…（自由输入）"
                  className="rounded border border-gn-prompt-border bg-gn-bg-dark px-3 py-1.5 text-[12.5px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-magenta/50"
                />
              </div>
            </fieldset>
          ))}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-gn-prompt-border px-4 py-3">
          <button
            type="button"
            onClick={submitAccepted}
            className="min-h-10 rounded border border-gn-magenta/50 bg-gn-bg-highlight px-4 py-1.5 text-[12.5px] font-semibold text-gn-fg hover:bg-gn-bg-hover"
          >
            提交
          </button>
          {planMode ? (
            <>
              <button
                type="button"
                onClick={() =>
                  void respondXai(req.requestId, {
                    outcome: 'chat_about_this',
                    partial_answers: partialAnswers(),
                  })
                }
                className="min-h-10 rounded border border-gn-prompt-border px-3 py-1.5 text-[12.5px] text-gn-fg2 hover:bg-gn-bg-highlight"
              >
                与 Agent 继续讨论
              </button>
              <button
                type="button"
                onClick={() =>
                  void respondXai(req.requestId, {
                    outcome: 'skip_interview',
                    partial_answers: partialAnswers(),
                  })
                }
                className="min-h-10 rounded border border-gn-prompt-border px-3 py-1.5 text-[12.5px] text-gn-fg2 hover:bg-gn-bg-highlight"
              >
                跳过提问，直接规划
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => void dismissXai(req.requestId)}
            className="ml-auto min-h-10 rounded border border-gn-red/40 px-3 py-1.5 text-[12.5px] text-gn-red hover:bg-gn-diff-del-bg"
          >
            取消
          </button>
        </footer>
      </div>
    </div>
  )
}
