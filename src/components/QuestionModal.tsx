import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useChatStore } from '../store/chat'
import type { AskQuestion } from '../api/types'
import { Glyphs } from '../theme/glyphs'
import { Markdown } from './Markdown'
import { ensureToolsetSettings, toolsetSettings } from '../store/settings'

/**
 * x.ai/ask_user_question card — web counterpart of the TUI question view
 * (question_view.rs). Renders as an inline card above the composer input
 * (portaled into Composer's anchor), one question per step:
 *
 *   Tab / Shift+Tab   next / previous question (clamped)
 *   j/k or ↑/↓        move the option cursor (focused row expands)
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
 * Timeout presentation (honest, per the ask_user_question wire type):
 * the ACP request today carries NO deadline (AskUserQuestionExtRequest =
 * sessionId/toolCallId/questions/mode — see grok-build …/ask_user_question/
 * types.rs), so no countdown is fabricated here. When the wire DOES carry
 * `deadlineAt` (unix ms — a future agent extension), the card shows the
 * real remaining time and, on expiry, waits for the agent to close the
 * interaction (the tool times out agent-side and resolves the request);
 * the FE never auto-answers on timeout. Without a deadline, the card shows
 * a config-derived static hint (`[toolset.ask_user_question]`, defaults
 * enabled / 1800s — the agent's own defaults) only while enabled.
 */
const ANCHOR_ID = 'capri-xai-question-anchor'

/** Agent-side default budget: ask_user_question RESPONSE_TIMEOUT (30 min). */
const DEFAULT_ASK_TIMEOUT_SECS = 1800

/**
 * Extract an optional deadline from the request params. Today's ACP wire
 * (AskUserQuestionExtRequest) has no deadline field — this only fires for
 * a future agent extension `deadlineAt` (unix ms). Invalid / past values
 * are treated as absent so no bogus countdown is ever rendered.
 */
function extractDeadlineMs(params: Record<string, unknown> | undefined): number | undefined {
  const v = params?.deadlineAt
  const n = typeof v === 'number' && Number.isFinite(v) ? v : NaN
  if (Number.isNaN(n) || n <= Date.now()) return undefined
  return n
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

  // Toolset config for the static timeout hint (host-safe subset of
  // [toolset.ask_user_question]). Fire-and-forget: the hint appears once
  // the cached section resolves; a failed fetch just leaves no hint.
  useEffect(() => {
    void ensureToolsetSettings()
  }, [])

  // Deadline, remembered per request: evaluated once when the request
  // arrives (and kept past expiry, so the card shows 「已超时」 instead of
  // reclassifying the request as deadline-less after the fact).
  const [deadlineMs, setDeadlineMs] = useState<number | undefined>(() =>
    extractDeadlineMs(req?.params),
  )
  useEffect(() => {
    setDeadlineMs(extractDeadlineMs(req?.params))
    // 新请求行（requestId 变化）或同请求 params 更新 → 重新评估 deadline。
  }, [req])

  // Live remaining time when the wire carries a deadline (future agent
  // extension; today's ACP request never includes one).
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
  const focusedOpt = q?.options[cur]
  const previewText = focusedOpt?.preview?.trim() ? focusedOpt.preview : undefined

  // 超时呈现（诚实原则：wire 无 deadline 时不造倒计时）：
  // - deadlineAt 存在（未来 agent 扩展）→ 真实剩余时间，到点等 agent 收尾；
  // - 否则基于 [toolset.ask_user_question] 的静态提示，仅 enabled 时显示
  //   （缺省 enabled=true / 1800s，与 agent 侧默认一致）。
  const aq = toolsetSettings()?.ask_user_question
  const remainingMs = deadlineMs != null ? deadlineMs - now : undefined
  const timeoutLine =
    deadlineMs != null
      ? remainingMs !== undefined && remainingMs > 0
        ? `提问倒计时 ${formatRemaining(remainingMs)}`
        : '提问已超时，等待 agent 收尾…'
      : aq?.timeout_enabled === false
        ? undefined
        : (() => {
            const secs = aq?.timeout_secs
            const secsOk =
              typeof secs === 'number' && Number.isInteger(secs) && secs > 0
            const eff = secsOk ? (secs as number) : DEFAULT_ASK_TIMEOUT_SECS
            return secsOk
              ? `本会话提问超时 ${eff} 秒后自动放弃`
              : `本会话提问超时 ${eff} 秒后自动放弃（默认）`
          })()

  return createPortal(
    <div
      className="mx-auto mb-1.5 w-full max-w-[640px] overflow-hidden rounded border border-gn-magenta/40 bg-gn-bg-base"
      role="dialog"
      aria-label="ask user question"
    >
      <header className="gn-modal-header">
        <span className="text-gn-magenta" aria-hidden>
          {Glyphs.diamondFilled}
        </span>
        <span className="text-[13px] font-bold text-gn-fg">
          {planMode ? '设计问题' : '提问'}
        </span>
        {multi ? (
          <span className="text-[11px] text-gn-muted">可多选</span>
        ) : null}
        <span className="ml-auto shrink-0 text-[11px] text-gn-muted">
          {questions.length > 0 ? `第 ${activeTab + 1}/${questions.length} 题` : ''}
        </span>
      </header>

      <div className="gn-no-scrollbar max-h-[50vh] overflow-y-auto bg-gn-bg-base px-3 py-2.5">
        {q ? (
          <fieldset>
            <legend className="mb-2 text-[13px] font-semibold leading-snug text-gn-fg">
              {q.question}
            </legend>
            <div className="flex flex-col gap-1.5">
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
                    className={`flex items-start gap-2 rounded px-3 py-1.5 text-left text-[12.5px] leading-snug transition-colors min-h-9 outline-none ${
 focused
                        ? 'bg-gn-bg-highlight text-gn-fg'
                        : 'text-gn-fg2 hover:bg-gn-bg-highlight'
                    }`}
                  >
                    {oi < 9 ? (
                      <span className="w-4 shrink-0 text-right font-mono text-[10.5px] text-gn-gutter">
                        {oi + 1}
                      </span>
                    ) : null}
                    <span
                      className={`mt-[1px] shrink-0 text-[11px] ${
 active ? 'text-gn-magenta' : 'text-gn-gutter'
                      }`}
                      aria-hidden
                    >
                      {multi
                        ? active
                          ? Glyphs.checkMark
                          : Glyphs.diamondHollow
                        : active
                          ? Glyphs.diamondFilled
                          : Glyphs.diamondHollow}
                    </span>
                    <span className="min-w-0 flex-1">
                      {focused ? (
                        <>
                          <span className="block">{opt.label}</span>
                          {opt.description ? (
                            <span className="block text-[11px] text-gn-muted">
                              {opt.description}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        // Collapsed single line: `label description…` (TUI).
                        <span className="block truncate">
                          {opt.label}
                          {opt.description ? `  ${opt.description}` : ''}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
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
                className="rounded border border-gn-prompt-border bg-gn-bg-dark px-3 py-1.5 text-[12.5px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-magenta/50"
              />
            </div>
          </fieldset>
        ) : null}

        {/* TUI focused_preview: the focused option's preview, panel bottom. */}
        {previewText ? (
          <div className="mt-2 rounded border border-gn-prompt-border bg-gn-bg-dark px-2.5 py-2">
            <div className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-gn-muted">
              preview
            </div>
            <div className="gn-no-scrollbar max-h-36 overflow-y-auto text-[12px] text-gn-fg2">
              <Markdown source={previewText} />
            </div>
          </div>
        ) : null}
      </div>

      <footer className="gn-modal-footer flex flex-wrap items-center gap-2">
        {questions.length > 0 ? (
          <span className="text-[11px] text-gn-muted">
            第 <span className="text-gn-fg2">{activeTab + 1}</span>/
            {questions.length} 题
          </span>
        ) : null}
        {isLast ? (
          <button
            type="button"
            onClick={() => submitAccepted()}
            className="min-h-9 rounded bg-gn-bg-highlight px-4 py-1 text-[12.5px] font-semibold text-gn-fg hover:bg-gn-bg-hover"
          >
            提交
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setActiveTab((t) => clampTab(t + 1))}
            className="min-h-9 rounded bg-gn-bg-base px-3 py-1 text-[12.5px] text-gn-fg2 hover:bg-gn-bg-highlight"
          >
            下一题 →
          </button>
        )}
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
              className="min-h-9 rounded px-3 py-1 text-[12.5px] text-gn-fg2 hover:bg-gn-bg-highlight"
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
              className="min-h-9 rounded px-3 py-1 text-[12.5px] text-gn-fg2 hover:bg-gn-bg-highlight"
            >
              跳过提问，直接规划
            </button>
          </>
        ) : null}
        <button
          type="button"
          onClick={() => void dismissXai(req.requestId)}
          className="ml-auto min-h-9 rounded px-3 py-1 text-[12.5px] text-gn-red hover:bg-gn-diff-del-bg"
        >
          取消
        </button>
      </footer>

      {timeoutLine ? (
        <div
          className="border-t border-gn-prompt-border/60 px-3 py-1.5 text-[11px] text-gn-muted"
          role="status"
        >
          {timeoutLine}
        </div>
      ) : null}

      <div className="border-t border-gn-prompt-border/60 px-3 py-1.5 text-[11px] text-gn-muted">
        <span className="text-gn-fg2">j/k</span> 选择 ·{' '}
        <span className="text-gn-fg2">1-9</span> 直达 ·{' '}
        <span className="text-gn-fg2">Enter</span> 选中 ·{' '}
        <span className="text-gn-fg2">Tab</span> 切题
        {multi ? ' · Space 多选' : ''} · <span className="text-gn-fg2">Esc</span> 关闭
      </div>
    </div>,
    anchorEl,
  )
}
