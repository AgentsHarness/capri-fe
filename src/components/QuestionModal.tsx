import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Circle, CircleDot, Diamond, Timer } from 'lucide-react'
import { useChatStore } from '../store/chat'
import type { AskQuestion } from '../api/types'
import { Markdown } from './Markdown'
import { ensureToolsetSettings, toolsetSettings } from '../store/settings'

/**
 * x.ai/ask_user_question card — web counterpart of the TUI question view
 * (question_view.rs). Renders as an inline card above the composer input
 * (portaled into Composer's anchor), one question per step:
 *
 *   Tab / Shift+Tab   next / previous question (clamped)
 *   j/k or ↑/↓        move the option cursor
 *   1-9               jump to that option (single: select + next question;
 *                     multi: toggle)
 *   Enter             select the focused option (single: select + next
 *                     question, submit on the last; multi: toggle) — no-op
 *                     while typing in the freeform input
 *   Space             toggle (multi-select only)
 *   Esc               freeform input state → back to option navigation;
 *                     a second Esc closes (dismissXai → cancelled)
 *
 * Answer wire shapes (AskUserQuestionExtResponse):
 *   accepted          { outcome:"accepted", answers:{qText:[labels]},
 *                       annotations?:{qText:{preview?,notes?}} }
 *   chat_about_this   { outcome:"chat_about_this", partial_answers:{qText:label} }  (plan mode)
 *   skip_interview    { outcome:"skip_interview", partial_answers:{qText:label} }   (plan mode)
 *   cancelled         { outcome:"cancelled" }
 *
 * Timeout presentation (live countdown):
 * - The wire deadline (`deadlineAt`, unix ms — a future agent extension;
 *   today's AskUserQuestionExtRequest carries none) counts down live and,
 *   on expiry, waits for the agent to close the interaction (the tool
 *   times out agent-side and resolves the request); the FE never
 *   auto-answers on timeout.
 * - Without a wire deadline the card derives its deadline from
 *   `[toolset.ask_user_question]` (defaults enabled / 1800s — the agent's
 *   own RESPONSE_TIMEOUT default): arrival time + timeout_secs, ticking
 *   once per second. Same zero behavior: label switches to 「已超时」 and
 *   the agent's own timeout closes the request.
 */
const ANCHOR_ID = 'capri-xai-question-anchor'

/** Agent-side default budget: ask_user_question RESPONSE_TIMEOUT (30 min). */
const DEFAULT_ASK_TIMEOUT_SECS = 1800

/**
 * Resolve the card's deadline. Priority:
 *  1. wire `deadlineAt` (unix ms — future agent extension; today's ACP
 *     AskUserQuestionExtRequest has no deadline field). Past values are
 *     kept (not treated as absent) so a card that opened near the wire
 *     deadline still shows 「已超时」 instead of silently switching to the
 *     config-derived budget.
 *  2. Config budget: arrival (Date.now()) + [toolset.ask_user_question]
 *     timeout_secs × 1000 (default enabled / 1800s — the agent's own
 *     RESPONSE_TIMEOUT). timeout_enabled=false → no deadline (never
 *     expires, no countdown rendered).
 */
function resolveDeadlineMs(params: Record<string, unknown> | undefined): number | undefined {
  const v = params?.deadlineAt
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const aq = toolsetSettings()?.ask_user_question
  if (aq?.timeout_enabled === false) return undefined
  const secs = aq?.timeout_secs
  const secsOk = typeof secs === 'number' && Number.isInteger(secs) && secs > 0
  return Date.now() + (secsOk ? secs : DEFAULT_ASK_TIMEOUT_SECS) * 1000
}

/** Remaining-time label: h:mm:ss ≥ 1h, else mm:ss. */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

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
  // One question per step (TUI active_tab).
  const [activeTab, setActiveTab] = useState(0)
  // Focused option index per question (TUI per_question_cursor).
  const [cursor, setCursor] = useState<Record<number, number>>({})
  // Whether the freeform input owns the keyboard (TUI QuestionFocus::InputMode).
  const [inputActive, setInputActive] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Toolset config for the countdown ([toolset.ask_user_question] —
  // host-safe subset). Fire-and-forget: the countdown starts once the
  // cached section resolves; a failed fetch falls back to the agent's
  // default budget (enabled / 1800s).
  useEffect(() => {
    void ensureToolsetSettings()
  }, [])

  // Deadline, remembered per request: the wire `deadlineAt` when present,
  // else arrival-time + configured timeout_secs (agent default 1800s),
  // captured once on arrival so the countdown never re-arms on re-renders.
  // timeout_enabled=false → no deadline at all (never expires).
  const [deadlineMs, setDeadlineMs] = useState<number | undefined>(() =>
    resolveDeadlineMs(req?.params),
  )
  useEffect(() => {
    setDeadlineMs(resolveDeadlineMs(req?.params))
    // 新请求行（requestId 变化）→ 重新评估 deadline；同请求 params 更新
    // 只在 wire deadline 变化时生效（resolveDeadlineMs 结果稳定）。
  }, [req])

  // Live remaining time (ticks once per second while a deadline exists).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (deadlineMs == null) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [deadlineMs])

  // Portaled anchor: the App-level mount stays put, the card DOM lands in
  // the Composer's anchor so it reads as an inline card above the input.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setAnchor(document.getElementById(ANCHOR_ID))
  }, [])

  // Reset local state when a new request arrives.
  useEffect(() => {
    setSelected({})
    setFreeform({})
    setActiveTab(0)
    setCursor({})
    setInputActive(false)
  }, [req?.requestId])

  /** Toggle (multi) / set (single) an option — pure, stable. */
  const toggleOption = useCallback((qi: number, oi: number, multi?: boolean) => {
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
  }, [])

  /** Clamp a tab step (no wrap, TUI next/prev_question). */
  const clampTab = (t: number) => Math.min(Math.max(0, t), Math.max(0, questions.length - 1))

  /** Labels chosen per question (free-form becomes "Other" + notes). */
  const buildAnswers = (sel: Record<number, Set<number>> = selected) => {
    const answers: Record<string, string[]> = {}
    const annotations: Record<string, { preview?: string; notes?: string }> = {}
    questions.forEach((q, qi) => {
      const set = sel[qi] ?? new Set<number>()
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

  /**
   * `nextSelected` carries the choice made in this very key event: React
   * state updates land on the next render, so buildAnswers() would otherwise
   * read the pre-keystroke selection (the last question then submits the
   * previous pick — or nothing at all).
   */
  const submitAccepted = (nextSelected?: Record<number, Set<number>>) => {
    const { answers, annotations } = buildAnswers(nextSelected ?? selected)
    if (Object.keys(answers).length === 0) return
    void respondXai(req!.requestId, {
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

  // Keyboard ownership while a question is open (window capture, same
  // pattern as the permission strip). Navigation keys apply when focus is
  // NOT in a text field; the freeform input owns its keys while focused.
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)

      // Esc ladder: freeform input state → option navigation → close.
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (inputActive) {
          inputRef.current?.blur()
          setInputActive(false)
        } else {
          void dismissXai(req.requestId)
        }
        return
      }

      // Freeform input owns its keys while focused; Tab moves to the next
      // question and leaves the input (Enter stays a no-op there).
      if (inputActive) {
        if (e.key === 'Tab') {
          e.preventDefault()
          e.stopImmediatePropagation()
          setInputActive(false)
          setActiveTab((t2) => clampTab(t2 + (e.shiftKey ? -1 : 1)))
        }
        return
      }

      // Composer draft / other text fields: only Esc is claimed.
      if (typing) return

      const qi = activeTab
      const q = questions[qi]
      const max = q ? Math.max(0, q.options.length - 1) : 0
      const cur = Math.min(cursor[qi] ?? 0, max)
      let handled = true
      switch (e.key) {
        case 'ArrowDown':
        case 'j':
          setCursor((prev) => ({ ...prev, [qi]: Math.min(max, cur + 1) }))
          break
        case 'ArrowUp':
        case 'k':
          setCursor((prev) => ({ ...prev, [qi]: Math.max(0, cur - 1) }))
          break
        case 'Tab':
          setActiveTab((t2) => clampTab(t2 + (e.shiftKey ? -1 : 1)))
          break
        case 'Enter':
          if (q && cur < q.options.length) {
            if (q.multiSelect) {
              toggleOption(qi, cur, true)
            } else {
              // Single: select + advance; the last question submits.
              const nextSelected = { ...selected, [qi]: new Set([cur]) }
              setSelected(nextSelected)
              if (qi < questions.length - 1) {
                setActiveTab(qi + 1)
              } else {
                submitAccepted(nextSelected)
              }
            }
          }
          break
        case ' ':
          // Space toggles in multi-select only; swallowed otherwise so the
          // native button activation never fires.
          if (q?.multiSelect && cur < q.options.length) toggleOption(qi, cur, true)
          break
        case 'z': {
          // TUI z (interactions.rs): jump to the freeform line and enter
          // input mode immediately (no-op effect when the card has none —
          // every FE card renders the freeform row).
          setInputActive(true)
          requestAnimationFrame(() => inputRef.current?.focus())
          break
        }
        case 'y': {
          // TUI y: copy the focused answer (label + description) so it can
          // be pasted elsewhere. Plain y only — the freeform input owns
          // keys while active (handled above).
          const opt = q?.options[cur]
          if (opt?.label) {
            void navigator.clipboard
              ?.writeText(
                [opt.label, opt.description].filter(Boolean).join('\n\n'),
              )
              .catch(() => {})
          }
          break
        }
        case '[':
          // TUI [ / ]: previous / next question (same as Shift+Tab / Tab).
          setActiveTab((t2) => clampTab(t2 - 1))
          break
        case ']':
          setActiveTab((t2) => clampTab(t2 + 1))
          break
        case 'X':
          // TUI Shift+X: dismiss the whole card — the agent continues
          // without answers (same cancelled outcome as Esc).
          void dismissXai(req.requestId)
          break
        default:
          if (/^[1-9]$/.test(e.key)) {
            const idx = Number(e.key) - 1
            if (q && idx < q.options.length) {
              setCursor((prev) => ({ ...prev, [qi]: idx }))
              if (q.multiSelect) {
                toggleOption(qi, idx, true)
              } else {
                const nextSelected = { ...selected, [qi]: new Set([idx]) }
                setSelected(nextSelected)
                if (qi < questions.length - 1) {
                  setActiveTab(qi + 1)
                } else {
                  submitAccepted(nextSelected)
                }
              }
            }
          } else {
            handled = false
          }
      }
      if (handled) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, dismissXai, inputActive, activeTab, cursor, selected, freeform])

  if (!req) return null
  // Fallback lookup: if the anchor effect hasn't run yet (theoretical
  // first-render race), read the DOM directly so the card still shows.
  const anchorEl =
    anchor ?? (typeof document !== 'undefined' ? document.getElementById(ANCHOR_ID) : null)
  if (!anchorEl) return null

  const q = questions[activeTab]
  const max = q ? Math.max(0, q.options.length - 1) : 0
  const cur = Math.min(cursor[activeTab] ?? 0, max)
  const multi = !!q?.multiSelect
  const isLast = activeTab >= questions.length - 1
  const hasAnyPreview = !!q?.options.some((o) => !!o.preview?.trim())
  const focusedOpt = q?.options[cur]
  const previewText = focusedOpt?.preview?.trim() ? focusedOpt.preview : undefined

  // 超时呈现：resolveDeadlineMs 解析出的 deadline 实时倒数；到点不自动
  // 应答，等待 agent 侧超时收尾（FE 从不代答）。
  const remainingMs = deadlineMs != null ? deadlineMs - now : undefined
  const expired = remainingMs !== undefined && remainingMs <= 0
  const timeoutLine =
    deadlineMs != null
      ? expired
        ? '提问已超时，等待 agent 收尾…'
        : `提问倒计时 ${formatRemaining(remainingMs as number)}`
      : undefined

  return createPortal(
    <div
      className="gn-card-rise mx-auto mb-2 w-full max-w-[640px] overflow-hidden rounded-lg border border-gn-magenta/50 bg-gn-bg-base shadow-xl"
      role="dialog"
      aria-label="ask user question"
    >
      <header className="flex min-h-[38px] items-center gap-2 border-b border-gn-prompt-border/70 bg-gn-bg-dark/60 px-3.5 py-1.5">
        <Diamond size={12} strokeWidth={2.5} className="shrink-0 text-gn-magenta" aria-hidden />
        <span className="text-[13px] font-bold text-gn-fg">{planMode ? '设计问题' : '提问'}</span>
        {multi ? (
          <span className="rounded border border-gn-magenta/30 bg-gn-magenta/10 px-1.5 py-0.5 text-[10.5px] font-medium text-gn-magenta">
            可多选
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {timeoutLine ? (
            <span
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                expired
                  ? 'border-gn-red/40 bg-gn-red/10 text-gn-red font-medium'
                  : 'border-gn-prompt-border/60 bg-gn-bg-code text-gn-muted tabular-nums'
              }`}
              role="status"
            >
              <Timer size={11} strokeWidth={2.5} className="shrink-0" aria-hidden />
              <span>{timeoutLine}</span>
            </span>
          ) : null}
          {questions.length > 0 ? (
            <span className="font-mono text-[11px] text-gn-muted">
              第 {activeTab + 1}/{questions.length} 题
            </span>
          ) : null}
        </div>
      </header>

      <div className="bg-gn-bg-base p-3.5">
        {q ? (
          <fieldset>
            <legend className="mb-2.5 text-[13.5px] font-semibold leading-snug text-gn-fg">
              {q.question}
            </legend>
            {/* 选项区（含自由输入行）内部滚动；当存在预览时限制高度以容纳预览窗 */}
            <div
              className={`gn-no-scrollbar flex flex-col gap-1.5 overflow-y-auto pr-0.5 ${
                hasAnyPreview ? 'max-h-[36vh]' : 'max-h-[48vh]'
              }`}
            >
              {q.options.map((opt, oi) => {
                const set = selected[activeTab] ?? new Set<number>()
                const active = set.has(oi)
                const focused = cur === oi
                return (
                  <button
                    key={oi}
                    type="button"
                    onMouseEnter={() => setCursor((prev) => ({ ...prev, [activeTab]: oi }))}
                    onClick={() => {
                      setCursor((prev) => ({ ...prev, [activeTab]: oi }))
                      toggleOption(activeTab, oi, multi)
                    }}
                    className={`flex min-h-9 items-start gap-2.5 rounded-md border px-3 py-2 text-left text-[12.5px] leading-snug transition-all outline-none ${
                      active
                        ? focused
                          ? 'border-gn-magenta bg-gn-magenta/15 text-gn-fg ring-1 ring-gn-magenta/50'
                          : 'border-gn-magenta/50 bg-gn-magenta/10 text-gn-fg'
                        : focused
                          ? 'border-gn-prompt-border bg-gn-bg-highlight text-gn-fg ring-1 ring-gn-prompt-border'
                          : 'border-gn-prompt-border/60 bg-gn-bg-base text-gn-fg2 hover:border-gn-prompt-border hover:bg-gn-bg-highlight/60'
                    }`}
                  >
                    {oi < 9 ? (
                      <span className="mt-[2px] w-4 shrink-0 text-center font-mono text-[10.5px] text-gn-gutter">
                        {oi + 1}
                      </span>
                    ) : (
                      <span className="w-4 shrink-0" />
                    )}
                    <span
                      className={`mt-[2px] flex w-4 shrink-0 items-center justify-center ${
                        active ? 'text-gn-magenta' : 'text-gn-gutter'
                      }`}
                      aria-hidden
                    >
                      {active ? (
                        multi ? (
                          <Check size={13} strokeWidth={2.5} />
                        ) : (
                          <CircleDot size={13} strokeWidth={2} />
                        )
                      ) : (
                        <Circle size={13} strokeWidth={2} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-gn-fg">{opt.label}</span>
                      {opt.description ? (
                        <span className="mt-0.5 block text-[11.5px] leading-relaxed text-gn-muted">
                          {opt.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                )
              })}
              <div
                className={`flex items-center gap-2.5 rounded-md border px-3 py-1.5 transition-all ${
                  inputActive
                    ? 'border-gn-magenta bg-gn-bg-dark ring-1 ring-gn-magenta/50'
                    : 'border-gn-prompt-border/60 bg-gn-bg-base hover:border-gn-prompt-border'
                }`}
              >
                <span className="w-4 shrink-0 text-center font-mono text-[10.5px] text-gn-gutter">
                  +
                </span>
                <span className="flex w-4 shrink-0 items-center justify-center text-gn-gutter">
                  <Circle size={12} strokeWidth={2} />
                </span>
                <input
                  ref={inputRef}
                  type="text"
                  value={freeform[activeTab] ?? ''}
                  onChange={(e) =>
                    setFreeform((prev) => ({ ...prev, [activeTab]: e.target.value }))
                  }
                  onFocus={() => {
                    setInputActive(true)
                    // TUI activate_freeform_input: single-select exclusivity —
                    // focusing "Other" clears the option selection.
                    if (!multi) setSelected((prev) => ({ ...prev, [activeTab]: new Set() }))
                  }}
                  onBlur={() => setInputActive(false)}
                  placeholder="其他…（自由输入）"
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] text-gn-fg outline-none placeholder:text-gn-gray"
                />
              </div>
            </div>
          </fieldset>
        ) : null}

        {/* 选项预览区域：题目只要存在带 preview 的选项，就预留固定高度（h-28），
            在不同选项间切换时卡片高度恒定不动，彻底杜绝跳变抖动。 */}
        {hasAnyPreview ? (
          <div className="mt-2.5 flex h-28 flex-col rounded-md border border-gn-prompt-border/70 bg-gn-bg-dark p-2.5 transition-colors">
            <div className="mb-1 flex shrink-0 items-center justify-between text-[10.5px] font-semibold uppercase tracking-wider text-gn-muted">
              <span className="flex min-w-0 items-center gap-1.5">
                <span>选项说明</span>
                {focusedOpt?.label && (
                  <span className="max-w-[360px] truncate font-normal normal-case text-gn-fg2">
                    · {focusedOpt.label}
                  </span>
                )}
              </span>
              <span className="shrink-0 font-mono text-[10px] lowercase text-gn-gray">
                preview
              </span>
            </div>
            <div className="gn-no-scrollbar min-h-0 flex-1 overflow-y-auto text-[12px] leading-relaxed text-gn-fg2">
              {previewText ? (
                <Markdown source={previewText} />
              ) : (
                <div className="flex h-full select-none items-center justify-center text-[11.5px] italic text-gn-muted/50">
                  该选项无详细说明
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-gn-prompt-border/70 bg-gn-bg-dark/60 px-3.5 py-2">
        <div className="flex items-center gap-1.5">
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
                className="min-h-8 rounded px-2.5 py-1 text-[12px] text-gn-fg2 transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
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
                className="min-h-8 rounded px-2.5 py-1 text-[12px] text-gn-fg2 transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
              >
                跳过提问，直接规划
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => void dismissXai(req.requestId)}
            className="min-h-8 rounded px-2.5 py-1 text-[12px] text-gn-red transition-colors hover:bg-gn-diff-del-bg"
          >
            取消
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {isLast ? (
            <button
              type="button"
              onClick={() => submitAccepted()}
              className="min-h-8 rounded bg-gn-bg-highlight px-4 py-1 text-[12.5px] font-semibold text-gn-fg transition-colors hover:bg-gn-bg-hover"
            >
              提交
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setActiveTab((t) => clampTab(t + 1))}
              className="min-h-8 rounded border border-gn-prompt-border/80 bg-gn-bg-base px-3 py-1 text-[12.5px] text-gn-fg2 transition-colors hover:bg-gn-bg-highlight"
            >
              下一题 →
            </button>
          )}
        </div>
      </footer>

      <div className="hidden border-t border-gn-prompt-border/50 bg-gn-bg-dark/80 px-3.5 py-1.5 text-[11px] text-gn-muted sm:block">
        <span className="gn-kbd">j</span><span className="gn-kbd">k</span> 选择 · <span className="gn-kbd">1-9</span> 直达 · <span className="gn-kbd">Enter</span> 选中 · <span className="gn-kbd">Tab</span> 切题{multi ? <> · <span className="gn-kbd">Space</span> 多选</> : ''} · <span className="gn-kbd">Esc</span> 关闭
      </div>
    </div>,
    anchorEl,
  )
}
