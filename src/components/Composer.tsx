import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from 'react'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import {
  COMPOSER_BODY_PAD_LEFT_PX,
  CONTENT_COLUMN_CLASS,
  COLUMN_PAD_X_CLASS,
} from '../theme/layout'
import { IconGlyph } from './IconGlyph'

/** ── TUI paste-chip port (PromptWidget::handle_paste) ──────────────────
 * Pastes at/above the chip threshold become an atomic `[Pasted: N lines]`
 * element instead of inline text; the full content is stashed and only
 * materialized on expand (enter / double-click / paste-again) or submit.
 */
const CHIP_MIN_LINES = 4 // TUI: 4, or 2 in compact mode (web has none)
const CHIP_DISPLAY_BYTES = 10_000

type PasteChip = { id: string; label: string; content: string }

/** Bare \r → \n, leaving \r\n pairs intact (PromptWidget::normalize_cr). */
function normalizeCr(text: string): string {
  return text.replace(/\r(?!\n)/g, '\n')
}

/** Content line count — Rust str::lines(): a trailing \n adds no line. */
function contentLines(text: string): number {
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

function utf8Len(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Chip label: `[Pasted: N lines]`, or byte size for >10 KB pastes. */
function pasteChipLabel(cleaned: string): string {
  const bytes = utf8Len(cleaned)
  if (bytes > CHIP_DISPLAY_BYTES) {
    const size =
      bytes >= 1_000_000
        ? `${(bytes / 1_000_000).toFixed(1)} MB`
        : bytes >= 1000
          ? `${Math.floor(bytes / 1000)} KB`
          : `${bytes} bytes`
    return `[Pasted: ${size}]`
  }
  const n = contentLines(cleaned)
  return `[Pasted: ${n} line${n === 1 ? '' : 's'}]`
}

/** Text range of the chip occurrence containing `pos` (or ending at it). */
function chipOccurrenceAt(
  text: string,
  chips: PasteChip[],
  pos: number,
  mode: 'inside' | 'end',
): { chip: PasteChip; start: number; end: number } | null {
  for (const chip of chips) {
    let from = 0
    for (;;) {
      const start = text.indexOf(chip.label, from)
      if (start === -1) break
      const end = start + chip.label.length
      if (mode === 'inside' ? pos >= start && pos < end : pos === end) {
        return { chip, start, end }
      }
      from = end
    }
  }
  return null
}

/**
 * Chip occurrence the caret is on (start edge), inside, or right after
 * (end edge) — TUI paste_element_for_preview + double-click expansion.
 */
function chipOccurrenceAtCaret(
  text: string,
  chips: PasteChip[],
  pos: number,
): { chip: PasteChip; start: number; end: number } | null {
  for (const chip of chips) {
    let from = 0
    for (;;) {
      const start = text.indexOf(chip.label, from)
      if (start === -1) break
      const end = start + chip.label.length
      if (pos >= start && pos <= end) return { chip, start, end }
      from = end
    }
  }
  return null
}

/** Expand every chip into its stashed content (submit path). */
function expandChips(text: string, chips: PasteChip[]): string {
  let out = text
  for (const chip of chips) {
    const idx = out.indexOf(chip.label)
    if (idx !== -1) {
      out = out.slice(0, idx) + chip.content + out.slice(idx + chip.label.length)
    }
  }
  return out
}

/**
 * Drop chips whose label no longer appears in the text (user edits).
 * Occurrences are paired to chips in insertion order so a paste-then-edit
 * never leaves a stale chip that hijacks a later identical label.
 */
function pruneChips(text: string, chips: PasteChip[]): PasteChip[] {
  const kept: PasteChip[] = []
  let pos = 0
  for (const chip of chips) {
    const idx = text.indexOf(chip.label, pos)
    if (idx === -1) continue
    kept.push(chip)
    pos = idx + chip.label.length
  }
  return kept
}

function chipId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `chip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** ── Composer frame ───────────────────────────────────────────────────
 * Rounded border box (container border + radius) — no font glyphs, no
 * corner elements. The session title floats on the top border and the
 * model · flags caption on the bottom border, each masking the line
 * behind them with the base background ("断线").
 */
export function Composer() {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  // TUI paste chips: stashed multi-line content behind `[Pasted: N lines]`
  // labels in the textarea (PromptWidget::handle_paste).
  const [chips, setChips] = useState<PasteChip[]>([])
  // Pending caret position to restore after a programmatic text edit.
  const caretRef = useRef<{ pos: number } | null>(null)
  // Live caret position — textarea selection changes don't re-render, so
  // onSelect/keyup/mouseup mirror it here for the paste preview overlay.
  const [caretPos, setCaretPos] = useState(0)
  const send = useChatStore((s) => s.send)
  const cancel = useChatStore((s) => s.cancel)
  const conn = useChatStore((s) => s.conn)
  const usage = useChatStore((s) => s.usage)
  const hostName = useChatStore((s) => s.hostName)
  const statusText = useChatStore((s) => s.statusText)
  const modelName = useChatStore((s) => s.modelName)
  const reasoningEffort = useChatStore((s) => s.reasoningEffort)
  const sessionTitle = useChatStore((s) => s.sessionTitle)
  const permissionMode = useChatStore((s) => s.permissionMode)
  const yoloMode = useChatStore((s) => s.yoloMode)
  const autoMode = useChatStore((s) => s.autoMode)
  const focusMode = useChatStore((s) => s.focusMode)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const busy = conn === 'busy'
  const promptFocused = focused || focusMode === 'prompt'

  // Collapse unfocused prompt height (PromptViewConfig.collapse_unfocused)
  const collapsed = !promptFocused && !text

  // TUI max_prompt_height = area.height / 2 (agent_view/render.rs):
  // the prompt grows to fit every wrapped line, capped at half the
  // viewport; beyond that the textarea scrolls internally with the
  // cursor kept visible (scrollbar hidden via gn-no-scrollbar).
  const [maxPromptH, setMaxPromptH] = useState(() =>
    Math.max(20, Math.round(window.innerHeight / 2)),
  )
  useEffect(() => {
    const onResize = () =>
      setMaxPromptH(Math.max(20, Math.round(window.innerHeight / 2)))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = collapsed ? 20 : maxPromptH
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
  }, [text, collapsed, maxPromptH])

  // TUI collapsed render forces scroll to top (set_scroll_override(Some(0))).
  useEffect(() => {
    const el = taRef.current
    if (!el || !collapsed) return
    el.scrollTop = 0
  }, [collapsed])

  // Restore the caret after a programmatic text edit (chip insert/expand).
  useEffect(() => {
    const el = taRef.current
    if (!el || caretRef.current == null) return
    el.selectionStart = el.selectionEnd = caretRef.current.pos
    setCaretPos(caretRef.current.pos)
    caretRef.current = null
  })

  // Keep focus in sync with store focusMode (Tab toggles)
  useEffect(() => {
    if (focusMode === 'prompt') {
      taRef.current?.focus()
    } else {
      taRef.current?.blur()
    }
  }, [focusMode])

  const onSubmit = async () => {
    if (!text.trim() || busy) return
    // TUI: chip content is part of the buffer — expand before sending.
    const t = expandChips(text, chips)
    setText('')
    setChips([])
    await send(t)
    taRef.current?.focus()
  }

  /** Inline a chip's stashed content at its label range (TUI expand_element). */
  const expandChipAt = (at: { chip: PasteChip; start: number; end: number }) => {
    setText((t) => t.slice(0, at.start) + at.chip.content + t.slice(at.end))
    setChips((cs) => cs.filter((c) => c.id !== at.chip.id))
    caretRef.current = { pos: at.start + at.chip.content.length }
  }

  /**
   * True when [start,end) touches a chip label without fully covering it —
   * an edit that would corrupt the label. A selection fully covering a chip
   * is fine: the whole element goes (TUI expands selections to element
   * boundaries, so partial selections are widened, never half-edited).
   */
  const partiallyOverlapsChip = (start: number, end: number) =>
    chips.some((c) => {
      let from = 0
      for (;;) {
        const i = text.indexOf(c.label, from)
        if (i === -1) return false
        const e2 = i + c.label.length
        if (start < e2 && end > i && !(start <= i && end >= e2)) return true
        from = e2
      }
    })

  /**
   * TUI handle_paste port: short pastes fall through to the native inline
   * insert; at/above the chip threshold the text is replaced by an atomic
   * `[Pasted: …]` label and the content is stashed until expand/submit.
   * Pasting a chip's exact content again with the cursor right after it
   * expands it instead of duplicating (repaste-to-expand).
   */
  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const raw = e.clipboardData.getData('text')
    if (!raw) return // empty / image paste → native no-op
    const cleaned = normalizeCr(raw)
    const el = taRef.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    if (start === end) {
      const at = chipOccurrenceAt(text, chips, start, 'end')
      if (at && cleaned === at.chip.content) {
        e.preventDefault()
        expandChipAt(at)
        return
      }
    }
    if (
      contentLines(cleaned) < CHIP_MIN_LINES &&
      utf8Len(cleaned) <= CHIP_DISPLAY_BYTES
    ) {
      return // short paste → native inline insert
    }
    e.preventDefault()
    const label = pasteChipLabel(cleaned)
    setText((t) => t.slice(0, start) + label + t.slice(end))
    setChips((cs) => [...cs, { id: chipId(), label, content: cleaned }])
    caretRef.current = { pos: start + label.length }
  }

  /**
   * Push the caret out of any chip interior (TUI: chips are atomic blocks,
   * the caret never renders inside them — it sits on the start or end edge).
   * Directional moves clamp toward the edge they came from; clicks clamp to
   * the nearest edge.
   */
  const clampCaret = (dir: 'start' | 'end' | 'nearest') => {
    const el = taRef.current
    if (!el || el.selectionStart !== el.selectionEnd) return
    const inside = chipOccurrenceAt(text, chips, el.selectionStart, 'inside')
    if (!inside) return
    const pos = el.selectionStart
    const target =
      dir === 'start'
        ? inside.start
        : dir === 'end'
          ? inside.end
          : pos - inside.start <= inside.end - pos
            ? inside.start
            : inside.end
    el.setSelectionRange(target, target)
    setCaretPos(target)
  }

  /**
   * Paste preview overlay (TUI render_preview_overlay + paste_preview_hint):
   * show the stashed content while the caret is on (start edge) or right
   * after (end edge) a chip, prompt focused. On-chip wins over adjacent.
   */
  const preview = useMemo(() => {
    if (!promptFocused || chips.length === 0) return null
    for (const chip of chips) {
      let from = 0
      for (;;) {
        const start = text.indexOf(chip.label, from)
        if (start === -1) break
        if (caretPos === start) return { chip, onChip: true }
        from = start + chip.label.length
      }
    }
    for (const chip of chips) {
      let from = 0
      for (;;) {
        const start = text.indexOf(chip.label, from)
        if (start === -1) break
        if (caretPos === start + chip.label.length) {
          return { chip, onChip: false }
        }
        from = start + chip.label.length
      }
    }
    return null
  }, [text, chips, caretPos, promptFocused])

  // Preview content: first/last 3 lines with a dots separator when longer
  // (PreviewConfig.preview_lines = 3).
  const previewLines = useMemo(() => {
    if (!preview) return null
    const lines = preview.chip.content.split('\n')
    if (lines.length <= 6) return lines
    return [
      ...lines.slice(0, 3),
      `⋮ (${lines.length - 6} more lines)`,
      ...lines.slice(-3),
    ]
  }, [preview])

  const borderColor = promptFocused
    ? 'var(--color-gn-prompt-border-active)'
    : 'var(--color-gn-prompt-border)'

  // Caption opacity: focused 0.6 / unfocused 0.4 of text_secondary (chrome_caption_style)
  const captionColor = promptFocused
    ? 'color-mix(in srgb, var(--color-gn-fg2) 60%, var(--color-gn-bg-base))'
    : 'color-mix(in srgb, var(--color-gn-fg2) 40%, var(--color-gn-bg-base))'
  const sepColor = promptFocused
    ? 'var(--color-gn-gray-dim)'
    : 'color-mix(in srgb, var(--color-gn-gray-dim) 60%, var(--color-gn-bg-base))'
  const flagColor = promptFocused
    ? 'var(--color-gn-gray)'
    : 'color-mix(in srgb, var(--color-gn-gray) 50%, var(--color-gn-bg-base))'

  // Prefix: accent_user when focused, gray_dim when not (PromptStyle::accent_color)
  const prefixColor = promptFocused
    ? 'var(--color-gn-accent-user)'
    : 'var(--color-gn-gray-dim)'

  const modelLabel = useMemo(() => {
    // Offline / error: surface connection state in the model slot
    if (conn === 'offline' || conn === 'error') return 'disconnected'
    if (conn === 'connecting') return 'connecting…'
    const base = (modelName && modelName.trim()) || 'grok'
    if (reasoningEffort) return `${base} (${reasoningEffort})`
    return base
  }, [conn, modelName, reasoningEffort])

  const flags = useMemo(() => {
    const out: { text: string; color?: string }[] = []
    if (hostName) out.push({ text: hostName })
    if (usage?.used != null && usage?.size != null) {
      out.push({ text: `${fmtTok(usage.used)}/${fmtTok(usage.size)}` })
    }
    // Permission mode from x.ai/yolo_mode_changed (TUI prompt mode flag:
    // ask / auto / always-approve). Only non-default modes are surfaced.
    const mode =
      permissionMode ||
      (yoloMode ? 'always-approve' : undefined) ||
      (autoMode ? 'auto' : undefined)
    if (mode && mode !== 'ask' && mode !== 'default') {
      out.push({ text: mode, color: 'var(--color-gn-cyan)' })
    }
    if (busy) out.push({ text: 'busy', color: 'var(--color-gn-yellow)' })
    else if (conn === 'error' || conn === 'offline') {
      out.push({ text: statusText || 'offline', color: 'var(--color-gn-red)' })
    }
    return out
  }, [hostName, usage, busy, conn, statusText, permissionMode, yoloMode, autoMode])

  const title =
    sessionTitle && sessionTitle.trim() ? sessionTitle.trim() : undefined

  return (
    <div className="safe-pb bg-gn-bg-base pt-1">
      <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS}`}>
        {/*
          PromptWidget chrome — rounded border box:
          - border + radius on the container (focus recolors via borderColor)
          - session title floats on the top border (断线)
          - model · flags caption floats on the bottom border, right-aligned
        */}
        <div
          className="relative rounded-[6px] border pt-[4px] pb-[4px] font-ui transition-colors"
          style={{ borderColor }}
          data-prompt-focused={promptFocused ? '1' : '0'}
          onMouseDown={(e) => {
            // Clicking chrome focuses the textarea (don't steal from buttons)
            if ((e.target as HTMLElement).closest('button, a')) return
            taRef.current?.focus()
          }}
        >
          {/* Session title on the top border (断线). */}
          {title ? (
            <div
              className="pointer-events-none absolute -top-[5px] left-1/2 max-w-[50%] -translate-x-1/2 truncate px-1.5 text-[11px] leading-none"
              style={{
                color: captionColor,
                background: 'var(--color-gn-bg-base)',
              }}
              title={title}
            >
              {title}
            </div>
          ) : null}

          {/* ── Body: ❯ textarea ──
              Content pad-left = ICON_COL_INSET (15px) so ❯ shares the
              scrollback icon track. */}
          <div
            className={`flex min-w-0 items-start gap-1.5 pr-3 ${
              collapsed ? 'py-0' : 'py-1'
            }`}
            style={{
              paddingLeft: COMPOSER_BODY_PAD_LEFT_PX,
              // Unfocused dim (blend_area 0.66 toward bg) for content only
              opacity: promptFocused ? 1 : 0.72,
            }}
          >
              <span className="mt-[2px] shrink-0" style={{ color: prefixColor }}>
                <IconGlyph glyph={Glyphs.promptArrow} color={prefixColor} />
              </span>
              <textarea
                id="composer-input"
                ref={taRef}
                rows={1}
                value={text}
                onChange={(e) => {
                  const v = e.target.value
                  setText(v)
                  // Keep chips in sync with the editable label text.
                  setChips((cs) => pruneChips(v, cs))
                }}
                onFocus={() => {
                  setFocused(true)
                  useChatStore.getState().setFocus('prompt')
                }}
                onBlur={() => setFocused(false)}
                onKeyDown={(e) => {
                  const el = taRef.current
                  // Chip atomicity: a directional move that lands inside a
                  // chip label is clamped to the edge it came from (TUI
                  // renders the caret on the block edge, never inside).
                  if (
                    e.key === 'ArrowLeft' ||
                    e.key === 'ArrowUp' ||
                    e.key === 'Home' ||
                    e.key === 'PageUp'
                  ) {
                    requestAnimationFrame(() => clampCaret('start'))
                  }
                  if (
                    e.key === 'ArrowRight' ||
                    e.key === 'ArrowDown' ||
                    e.key === 'End' ||
                    e.key === 'PageDown'
                  ) {
                    requestAnimationFrame(() => clampCaret('end'))
                  }
                  // Whole-chip delete (TextArea element-at-cursor): Backspace
                  // at/after the label end, Delete at/inside its start — the
                  // entire chip goes in one step.
                  if (
                    (e.key === 'Backspace' || e.key === 'Delete') &&
                    el &&
                    el.selectionStart === el.selectionEnd
                  ) {
                    const at = chipOccurrenceAt(
                      text,
                      chips,
                      e.key === 'Backspace'
                        ? el.selectionStart - 1
                        : el.selectionStart,
                      'inside',
                    )
                    if (at) {
                      e.preventDefault()
                      setText((t) => t.slice(0, at.start) + t.slice(at.end))
                      setChips((cs) =>
                        cs.filter((c) => c.id !== at.chip.id),
                      )
                      caretRef.current = { pos: at.start }
                      return
                    }
                  }
                  // Selection-based delete: a selection touching a chip
                  // without fully covering it is widened to the full chip
                  // boundary (TUI selection expands to element edges), then
                  // the native delete takes the whole elements. A fully
                  // covering selection (e.g. Cmd+A) passes through untouched.
                  if (
                    (e.key === 'Backspace' || e.key === 'Delete') &&
                    el &&
                    el.selectionStart !== el.selectionEnd
                  ) {
                    const selStart = el.selectionStart
                    const selEnd = el.selectionEnd
                    let lo = selStart
                    let hi = selEnd
                    for (;;) {
                      let changed = false
                      for (const c of chips) {
                        let from = 0
                        for (;;) {
                          const i = text.indexOf(c.label, from)
                          if (i === -1) break
                          const e2 = i + c.label.length
                          if (lo < e2 && hi > i) {
                            const nlo = Math.min(lo, i)
                            const nhi = Math.max(hi, e2)
                            if (nlo !== lo || nhi !== hi) {
                              lo = nlo
                              hi = nhi
                              changed = true
                            }
                          }
                          from = e2
                        }
                      }
                      if (!changed) break
                    }
                    if (lo !== selStart || hi !== selEnd) {
                      el.setSelectionRange(lo, hi)
                    }
                    // Fall through — native delete, onChange prunes chips.
                  } else if (
                    // TUI atomic chips: character edits that would land
                    // inside (partially cover) a chip label are swallowed.
                    el &&
                    e.key.length === 1 &&
                    !e.metaKey &&
                    !e.ctrlKey &&
                    !e.altKey &&
                    partiallyOverlapsChip(el.selectionStart, el.selectionEnd)
                  ) {
                    e.preventDefault()
                    return
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    // TUI: Enter ON a chip expands it (paste_preview_hint);
                    // anywhere else it keeps its normal submit behavior.
                    if (el && el.selectionStart === el.selectionEnd) {
                      const at = chipOccurrenceAt(
                        text,
                        chips,
                        el.selectionStart,
                        'inside',
                      )
                      if (at) {
                        e.preventDefault()
                        expandChipAt(at)
                        return
                      }
                    } else if (el) {
                      // Selection spanning exactly one chip label → expand.
                      const sel = text.slice(el.selectionStart, el.selectionEnd)
                      const chip = chips.find((c) => c.label === sel)
                      if (chip) {
                        e.preventDefault()
                        expandChipAt({
                          chip,
                          start: el.selectionStart,
                          end: el.selectionEnd,
                        })
                        return
                      }
                    }
                    e.preventDefault()
                    void onSubmit()
                    return
                  }
                  if (e.key === 'Escape' && busy) {
                    e.preventDefault()
                    void cancel()
                  }
                }}
                onBeforeInput={(e) => {
                  // IME / drag-drop inserts into a chip label are swallowed.
                  const el = taRef.current
                  if (!el) return
                  if (partiallyOverlapsChip(el.selectionStart, el.selectionEnd)) {
                    e.preventDefault()
                  }
                }}
                onPaste={onPaste}
                onSelect={() => {
                  // Mirror the live caret (selectionchange) for the preview.
                  const t = taRef.current
                  if (t) setCaretPos(t.selectionStart)
                }}
                onKeyUp={() => {
                  const t = taRef.current
                  if (t) setCaretPos(t.selectionStart)
                }}
                onMouseUp={() => {
                  // Click inside a chip label snaps to its nearest edge.
                  clampCaret('nearest')
                  const t = taRef.current
                  if (t) setCaretPos(t.selectionStart)
                }}
                onDoubleClick={(e) => {
                  // TUI: double-click expands a paste chip (from either position).
                  const t = taRef.current
                  if (!t) return
                  const at = chipOccurrenceAtCaret(text, chips, t.selectionStart)
                  if (at) {
                    e.preventDefault()
                    expandChipAt(at)
                  }
                }}
                title={
                  chips.length > 0
                    ? 'enter / double-click / paste-again on [Pasted] chip to expand'
                    : undefined
                }
                placeholder={promptFocused ? '' : 'Build anything'}
                spellCheck={false}
                className="gn-no-scrollbar min-h-[20px] flex-1 resize-none bg-transparent font-ui text-[13.5px] leading-[1.55] text-gn-fg outline-none placeholder:text-gn-gray"
              />
              {busy ? (
                <button
                  type="button"
                  onClick={() => void cancel()}
                  className="ml-1 shrink-0 self-end rounded px-2 py-0.5 text-[11px] text-gn-yellow hover:bg-gn-bg-hover min-h-8 sm:min-h-0"
                >
                  esc
                </button>
              ) : null}
            </div>

          {/* Model + flags on the bottom border (断线), right-aligned. */}
          <div
            className="pointer-events-none absolute -bottom-[5px] right-2 flex max-w-[75%] items-center gap-0 truncate px-1 text-[11px] leading-none"
            style={{
              background: 'var(--color-gn-bg-base)',
            }}
            title={[modelLabel, ...flags.map((f) => f.text)].join(' · ')}
          >
            <span style={{ color: captionColor }} className="truncate">
              {modelLabel}
            </span>
            {flags.map((f, i) => (
              <span key={i} className="inline-flex items-center">
                <span style={{ color: sepColor }} className="px-1">
                  {Glyphs.middleDot}
                </span>
                <span
                  className="truncate"
                  style={{ color: f.color || flagColor }}
                >
                  {f.text}
                </span>
              </span>
            ))}
          </div>

          {/* Paste preview overlay (TUI render_preview_overlay) — floats
              above the prompt frame while the caret is on/after a chip:
              first/last 3 lines with a ⋮ separator, hint in the footer. */}
          {preview && previewLines && (
            <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 w-[75%] -translate-x-1/2 overflow-hidden rounded border border-gn-prompt-border-active bg-gn-bg-dark shadow-2xl">
              <div className="gn-no-scrollbar max-h-44 overflow-y-auto py-0.5">
                {previewLines.map((line, i) => (
                  <div
                    key={i}
                    className={`truncate px-2 font-mono text-[11.5px] leading-[1.5] ${
                      line.startsWith('⋮ (') ? 'text-gn-gray-dim' : 'text-gn-fg'
                    }`}
                  >
                    {line || ' '}
                  </div>
                ))}
              </div>
              <div className="border-t border-gn-prompt-border/60 px-2 py-[3px] text-[10px] text-gn-muted">
                {preview.onChip ? 'enter' : 'paste again'} or double-click to
                expand
              </div>
            </div>
          )}
        </div>

        {/* Shortcuts hint — separate from prompt chrome (TUI shortcuts_bar lives elsewhere) */}
        <div className="mt-0.5 hidden px-1 text-[10px] text-gn-gutter sm:flex sm:justify-end">
          enter send · tab scrollback · ←/→ fold · enter view · esc cancel
          {chips.length > 0 ? ' · enter on [Pasted] chip expands' : ''}
        </div>
      </div>
    </div>
  )
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
