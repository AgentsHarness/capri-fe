import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../theme/layout'
import { IconGlyph } from './IconGlyph'
import { Markdown } from './Markdown'

/**
 * x.ai/exit_plan_mode approval card — web counterpart of the TUI plan
 * approval view (plan_approval_view.rs + agent_view/plan.rs). Approving
 * leaves plan mode and starts the implement turn.
 *
 * Plan review is LINE-BASED like the TUI's commenting mode: the preview
 * shows the plan with 1:1 line numbers; clicking a line selects it
 * (Shift+click / drag selects a range).
 * - While a line or range is selected, pressing Enter (or clicking
 *   「保存批注」) saves the line comment to the list and clears the
 *   selection so you can continue commenting on other lines.
 * - Sending 「请求修改」 (or pressing Enter with no active line selection
 *   when comments/feedback exist) formats all saved line comments plus any
 *   overall feedback in the TUI format:
 *     single line: "Proposed plan line 12:"
 *     range:       "Proposed plan lines 1-3:"
 *     body:        "> <snippet>" per selected line, then "Comment:\n<正文>"
 *   (plan_approval_view.rs format_feedback / inline_plan_snippets).
 *
 * Keyboard (the card owns these keys while mounted, TUI plan approval):
 *   Enter    line selected + text → save line comment;
 *            no line selected + (saved comments or text) → send revision;
 *            empty → approve
 *   Esc      line selected → cancel selection/editing;
 *            otherwise → 稍后再说 (dismissXai → { outcome:"cancelled" })
 *
 * Response shapes (ExitPlanModeExtResponse):
 *   approved   { outcome:"approved" }
 *   cancelled  { outcome:"cancelled", feedback? }   ("request changes")
 *   abandoned  { outcome:"abandoned" }              ("quit plan")
 */

export type PlanLineComment = {
  id: number
  start: number
  end: number
  text: string
}

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

/**
 * Assemble the full feedback payload matching TUI PlanApprovalViewState::format_feedback:
 * all line comments in order, followed by optional freeform feedback
 * (prefixed with `Additional feedback:\n` when line comments are also present).
 */
function formatPlanFeedback(
  lines: string[],
  comments: PlanLineComment[],
  freeform: string,
): string {
  const parts = comments.map((c) => buildLineComment(lines, c.start, c.end, c.text))
  const trimmed = freeform.trim()
  if (trimmed) {
    parts.push(parts.length > 0 ? `Additional feedback:\n${trimmed}` : trimmed)
  }
  return parts.join('\n\n')
}

export function PlanApproval() {
  const xaiRequests = useChatStore((s) => s.xaiRequests)
  const respondXai = useChatStore((s) => s.respondXai)
  const dismissXai = useChatStore((s) => s.dismissXai)

  const req = xaiRequests.find((r) => r.method === 'x.ai/exit_plan_mode')
  const [feedback, setFeedback] = useState('')
  const [feedbackFocused, setFeedbackFocused] = useState(false)
  const [showPlan, setShowPlan] = useState(true)
  const [viewMode, setViewMode] = useState<'lines' | 'markdown'>('lines')
  const feedbackRef = useRef<HTMLInputElement>(null)
  // Selected plan line range (1-based inclusive; null = none selected).
  const [selStart, setSelStart] = useState<number | null>(null)
  const [selEnd, setSelEnd] = useState<number | null>(null)
  /** Drag anchor: the line the drag started on (null = not dragging). */
  const [dragAnchor, setDragAnchor] = useState<number | null>(null)
  /** Saved per-line / per-range comments (TUI PlanApprovalViewState.comments). */
  const [comments, setComments] = useState<PlanLineComment[]>([])
  const [editingCommentId, setEditingCommentId] = useState<number | null>(null)
  const nextCommentIdRef = useRef(1)

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

  const hasFeedback = feedback.trim() !== ''
  const hasPendingRevision = hasFeedback || comments.length > 0

  // Fresh state for each new request.
  useEffect(() => {
    setFeedback('')
    setFeedbackFocused(false)
    setShowPlan(true)
    setViewMode('lines')
    setSelStart(null)
    setSelEnd(null)
    setDragAnchor(null)
    setComments([])
    setEditingCommentId(null)
    nextCommentIdRef.current = 1
  }, [req?.requestId])

  // End line-drag selection even if the pointer is released outside the card.
  useEffect(() => {
    if (dragAnchor == null) return
    const onUp = () => setDragAnchor(null)
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [dragAnchor])

  const clearSelection = () => {
    setSelStart(null)
    setSelEnd(null)
    setDragAnchor(null)
    if (editingCommentId != null) {
      setEditingCommentId(null)
      setFeedback('')
    }
  }

  /** Save the current line selection + feedback into `comments` (TUI save_plan_comment). */
  const saveLineComment = (): boolean => {
    const fb = feedback.trim()
    if (!selection || !fb) return false
    if (editingCommentId != null) {
      setComments((prev) =>
        prev.map((c) =>
          c.id === editingCommentId
            ? { ...c, start: selection.start, end: selection.end, text: fb }
            : c,
        ),
      )
    } else {
      const id = nextCommentIdRef.current++
      setComments((prev) => [
        ...prev,
        { id, start: selection.start, end: selection.end, text: fb },
      ])
    }
    setSelStart(null)
    setSelEnd(null)
    setDragAnchor(null)
    setEditingCommentId(null)
    setFeedback('')
    return true
  }

  /**
   * 请求修改：汇总已保存的多行批注 + 当前输入框中的未保存意见（若正选中行则作为行级批注合入，
   * 若未选中行则作为整体修改意见合入）。
   */
  const sendRevision = () => {
    if (!req) return
    const fb = feedback.trim()
    let effectiveComments = comments
    let freeform = ''
    if (fb) {
      if (selection) {
        if (editingCommentId != null) {
          effectiveComments = comments.map((c) =>
            c.id === editingCommentId
              ? { ...c, start: selection.start, end: selection.end, text: fb }
              : c,
          )
        } else {
          effectiveComments = [
            ...comments,
            { id: -1, start: selection.start, end: selection.end, text: fb },
          ]
        }
      } else {
        freeform = fb
      }
    }
    const body = formatPlanFeedback(planLines, effectiveComments, freeform)
    void respondXai(req.requestId, {
      outcome: 'cancelled',
      ...(body ? { feedback: body } : {}),
    })
  }

  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.metaKey || e.altKey) return
      const st = useChatStore.getState()
      if (st.viewerEntryId || st.viewerTask) return
      const t = e.target as HTMLElement | null
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      const inFeedback = feedbackRef.current != null && t === feedbackRef.current
      const onButton = t instanceof Element && t.closest('button') != null

      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (selection) {
          clearSelection()
        } else {
          void dismissXai(req.requestId)
        }
        return
      }
      // Enter:
      // 1) Line selected: saves the line comment so the user can continue
      //    selecting other lines (TUI PlanApprovalFocus::Commenting → save_plan_comment).
      // 2) No line selected + (saved comments or freeform feedback): sends the revision.
      // 3) Empty (no selection, no comments, no feedback): approves the plan.
      if (e.key === 'Enter' && (!typing || inFeedback) && !onButton) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const fb = feedback.trim()
        if (selection) {
          if (fb) {
            saveLineComment()
          } else {
            feedbackRef.current?.focus()
          }
          return
        }
        if (fb || comments.length > 0) {
          sendRevision()
        } else {
          void respondXai(req.requestId, { outcome: 'approved' })
        }
        return
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [req, respondXai, dismissXai, feedback, selection, planLines, comments, editingCommentId])

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

  const startEditComment = (c: PlanLineComment) => {
    setEditingCommentId(c.id)
    setSelStart(c.start)
    setSelEnd(c.end)
    setFeedback(c.text)
    feedbackRef.current?.focus()
  }

  const removeComment = (id: number) => {
    setComments((prev) => prev.filter((c) => c.id !== id))
    if (editingCommentId === id) {
      setEditingCommentId(null)
      setSelStart(null)
      setSelEnd(null)
      setFeedback('')
    }
  }

  return (
    <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} py-1.5`}>
      <div
        className="gn-card-rise mx-auto w-full max-w-[640px] overflow-hidden rounded-lg border border-gn-yellow/50 bg-gn-bg-base shadow-xl ring-1 ring-gn-yellow/30 transition-all"
        role="region"
        aria-label="plan approval"
      >
        <header className="flex min-h-[38px] items-center gap-1.5 border-b border-gn-prompt-border/70 bg-gn-bg-dark/60 px-3 py-1.5 sm:gap-2 sm:px-3.5">
          <span className="shrink-0 text-gn-yellow animate-pulse" aria-hidden>
            <IconGlyph glyph={Glyphs.diamondFilled} color="currentColor" />
          </span>
          <span className="text-[13px] font-bold text-gn-yellow">plan approval</span>
          <span className="min-w-0 truncate text-[11.5px] text-gn-muted">
            批准后退出计划模式并开始实施
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => void dismissXai(req.requestId)}
              className="rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
              aria-label="关闭"
              title="稍后再说 (Esc)"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        </header>

        <div className="space-y-2.5 bg-gn-bg-base p-3.5">
          {hasPlan ? (
            <div className="overflow-hidden rounded-md border border-gn-prompt-border/70 bg-gn-bg-code">
              <div
                className={`flex min-h-[32px] flex-wrap items-center justify-between gap-2 px-2.5 py-1 ${
                  showPlan
                    ? 'border-b border-gn-prompt-border/50 bg-gn-bg-dark/60'
                    : 'bg-gn-bg-dark/40'
                }`}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setShowPlan((v) => !v)}
                    className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11.5px] font-semibold leading-none text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
                  >
                    {showPlan ? (
                      <ChevronDown size={12} strokeWidth={2} className="shrink-0" aria-hidden />
                    ) : (
                      <ChevronRight size={12} strokeWidth={2} className="shrink-0" aria-hidden />
                    )}
                    <span>{showPlan ? '收起计划' : '查看计划'}</span>
                    <span className="font-mono text-[11px] leading-none tabular-nums">
                      ({planLines.length} 行)
                    </span>
                  </button>
                  {comments.length > 0 && (
                    <span className="inline-flex h-5 shrink-0 items-center rounded border border-gn-yellow/35 bg-gn-yellow/10 px-2 font-mono text-[10.5px] leading-none text-gn-yellow">
                      已添加 {comments.length} 条行批注
                    </span>
                  )}
                  {showPlan && selection && (
                    <span className="inline-flex h-5 min-w-0 items-center truncate rounded border border-gn-cyan/30 bg-gn-cyan/10 px-2 font-mono text-[10.5px] leading-none text-gn-cyan">
                      已选中第 {selection.start}-{selection.end} 行 · Enter 保存该行批注
                    </span>
                  )}
                </div>

                {showPlan && (
                  <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    {selection ? (
                      <button
                        type="button"
                        onClick={clearSelection}
                        className="inline-flex h-5 items-center rounded border border-gn-prompt-border/60 bg-gn-bg-base px-2 text-[10.5px] leading-none text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
                        title="取消行选区 (Esc)"
                      >
                        清除选区
                      </button>
                    ) : viewMode === 'lines' ? (
                      <span className="hidden text-[10.5px] leading-none text-gn-muted sm:inline">
                        点击或拖动行号可添加行级评论
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() =>
                        setViewMode((m) => (m === 'lines' ? 'markdown' : 'lines'))
                      }
                      className="inline-flex h-5 items-center rounded border border-gn-prompt-border/60 bg-gn-bg-base px-2 font-mono text-[10.5px] leading-none text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
                      title={
                        viewMode === 'lines'
                          ? '切换为 Markdown 渲染预览'
                          : '切换为带行号的逐行批注视图'
                      }
                    >
                      {viewMode === 'lines' ? '预览' : '行号'}
                    </button>
                  </div>
                )}
              </div>

              {showPlan &&
                (viewMode === 'markdown' ? (
                  <div className="gn-no-scrollbar max-h-[42vh] overflow-y-auto px-3.5 py-2.5 text-[12.5px] leading-relaxed text-gn-fg2">
                    <Markdown source={planContent as string} />
                  </div>
                ) : (
                  <div className="gn-no-scrollbar max-h-[42vh] overflow-y-auto py-1 text-[12.5px]">
                    {/* 行号 1:1 —— TUI Commenting 模式的计划预览（行号 + 点击选行 + 行后内联批注）。 */}
                    <div
                      className="select-none"
                      onMouseUp={() => setDragAnchor(null)}
                      onMouseLeave={() => setDragAnchor(null)}
                    >
                      {planLines.map((line, i) => {
                        const n = i + 1
                        const selected =
                          selection != null && n >= selection.start && n <= selection.end
                        const commented = comments.some((c) => n >= c.start && n <= c.end)
                        const endingComments = comments.filter((c) => c.end === n)
                        return (
                          <div key={n}>
                            <div
                              onMouseDown={(e) => {
                                // 单击已单独选中的行 = 取消选中；否则锚定到该行；
                                // 按住拖动 = 范围扩展；Shift+点击在 onClick 里从锚点扩展。
                                if (!e.shiftKey) {
                                  if (selStart === n && selEnd === n && editingCommentId == null) {
                                    clearSelection()
                                    return
                                  }
                                  if (editingCommentId != null) {
                                    setEditingCommentId(null)
                                    setFeedback('')
                                  }
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
                              className={`flex cursor-pointer items-stretch transition-colors ${
                                selected
                                  ? 'bg-gn-cyan/10 hover:bg-gn-cyan/15'
                                  : commented
                                    ? 'bg-gn-yellow/5 hover:bg-gn-yellow/10'
                                    : 'hover:bg-gn-bg-highlight/60'
                              }`}
                              title={
                                selection
                                  ? 'Shift+点击或拖动扩展选择范围 · 再次点击已选单行取消'
                                  : '点击选中该行（Shift+点击或拖动选范围）'
                              }
                            >
                              <span
                                className={`w-9 shrink-0 select-none border-r py-[1px] pr-2 text-right font-mono text-[10.5px] leading-[20px] tabular-nums ${
                                  selected
                                    ? 'border-gn-cyan/50 bg-gn-cyan/15 font-semibold text-gn-cyan'
                                    : commented
                                      ? 'border-gn-yellow/50 bg-gn-yellow/10 font-semibold text-gn-yellow'
                                      : 'border-gn-prompt-border/40 text-gn-gutter'
                                }`}
                              >
                                {n}
                              </span>
                              <span
                                className={`min-w-0 flex-1 whitespace-pre-wrap break-all py-[1px] pr-2.5 pl-2.5 font-mono text-[12px] leading-[20px] ${
                                  selected || commented ? 'text-gn-fg' : 'text-gn-fg2'
                                }`}
                              >
                                {line || ' '}
                              </span>
                            </div>
                            {endingComments.map((c) => {
                              const isEditing = editingCommentId === c.id
                              const rangeLabel =
                                c.start === c.end ? `L${c.start}` : `L${c.start}-${c.end}`
                              return (
                                <div
                                  key={`comment-${c.id}`}
                                  data-testid={`plan-comment-${c.id}`}
                                  className={`flex items-center gap-2 border-y px-2.5 py-1.5 text-[12px] ${
                                    isEditing
                                      ? 'border-gn-cyan/40 bg-gn-cyan/10'
                                      : 'border-gn-yellow/25 bg-gn-yellow/10'
                                  }`}
                                >
                                  <span
                                    className={`inline-flex h-5 shrink-0 items-center justify-center rounded border px-1.5 font-mono text-[10.5px] leading-none ${
                                      isEditing
                                        ? 'border-gn-cyan/40 bg-gn-bg-base text-gn-cyan'
                                        : 'border-gn-yellow/35 bg-gn-bg-base text-gn-yellow'
                                    }`}
                                  >
                                    {rangeLabel}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => startEditComment(c)}
                                    className="min-w-0 flex-1 text-left whitespace-pre-wrap break-words leading-snug text-gn-fg transition-colors hover:text-gn-yellow"
                                    title="点击编辑此条行级批注"
                                  >
                                    {c.text}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => removeComment(c.id)}
                                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-red"
                                    aria-label={`删除 ${rangeLabel} 批注`}
                                    title="删除批注"
                                  >
                                    <X size={12} aria-hidden />
                                  </button>
                                </div>
                              )
                            })}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-gn-prompt-border/70 bg-gn-bg-dark/60 px-3 py-2.5 text-[12px] text-gn-muted">
              No plan written — approve or request changes
            </div>
          )}

          <div
            className={`flex min-h-9 items-center gap-2 rounded-md border px-3 py-1.5 transition-all ${
              feedbackFocused
                ? 'border-gn-yellow/60 bg-gn-bg-dark ring-1 ring-gn-yellow/30'
                : selection || hasFeedback
                  ? 'border-gn-cyan/40 bg-gn-bg-dark/80'
                  : 'border-gn-prompt-border/70 bg-gn-bg-dark/50 hover:border-gn-prompt-border'
            }`}
          >
            {selection ? (
              <span className="inline-flex h-5 shrink-0 items-center justify-center rounded border border-gn-cyan/30 bg-gn-cyan/15 px-1.5 font-mono text-[10.5px] leading-none text-gn-cyan">
                L
                {selection.start === selection.end
                  ? selection.start
                  : `${selection.start}-${selection.end}`}
              </span>
            ) : (
              <span
                className="inline-flex w-4 shrink-0 items-center justify-center font-mono text-[11px] leading-none text-gn-gutter"
                aria-hidden
              >
                +
              </span>
            )}
            <input
              ref={feedbackRef}
              type="text"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onFocus={() => setFeedbackFocused(true)}
              onBlur={() => setFeedbackFocused(false)}
              placeholder="修改意见（留空时 Enter 直接批准）"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-gn-fg outline-none placeholder:text-gn-gray"
            />
            {selection && (
              <button
                type="button"
                disabled={!hasFeedback}
                onClick={() => {
                  saveLineComment()
                }}
                className="shrink-0 rounded border border-gn-cyan/40 bg-gn-cyan/15 px-2 py-0.5 text-[11px] font-medium text-gn-cyan transition-colors hover:bg-gn-cyan/25 disabled:cursor-not-allowed disabled:opacity-40"
                title="Enter 保存此行批注，继续选择其他行"
              >
                {editingCommentId != null ? '更新批注' : '保存批注'}
              </button>
            )}
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-gn-prompt-border/70 bg-gn-bg-dark/60 px-3.5 py-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void respondXai(req.requestId, { outcome: 'abandoned' })}
              className="min-h-8 rounded px-2.5 py-1 text-[12px] text-gn-red transition-colors hover:bg-gn-diff-del-bg"
            >
              退出计划模式
            </button>
            <button
              type="button"
              onClick={() => void dismissXai(req.requestId)}
              className="min-h-8 rounded px-2.5 py-1 text-[12px] text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            >
              稍后再说
            </button>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (hasPendingRevision) {
                  sendRevision()
                } else {
                  feedbackRef.current?.focus()
                }
              }}
              className={`inline-flex min-h-8 items-center gap-1.5 rounded border px-3 py-1 text-[12.5px] transition-colors ${
                hasPendingRevision
                  ? 'border-gn-yellow/50 bg-gn-bg-highlight font-semibold text-gn-fg ring-1 ring-gn-yellow/30 hover:bg-gn-bg-hover'
                  : 'border-gn-prompt-border/80 bg-gn-bg-base text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg'
              }`}
              title={
                selection || comments.length > 0
                  ? '以行级评论发送修改意见（Proposed plan lines …）'
                  : '发送修改意见'
              }
            >
              <span>请求修改</span>
            </button>
            <button
              type="button"
              onClick={() => void respondXai(req.requestId, { outcome: 'approved' })}
              className={`inline-flex min-h-8 items-center rounded border px-3.5 py-1 text-[12.5px] transition-colors ${
                hasPendingRevision
                  ? 'border-gn-prompt-border/80 bg-gn-bg-base text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg'
                  : 'border-gn-yellow/50 bg-gn-bg-highlight font-semibold text-gn-fg ring-1 ring-gn-yellow/30 hover:bg-gn-bg-hover'
              }`}
            >
              批准并开始实施
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

