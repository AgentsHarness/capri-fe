import { useEffect, useState } from 'react'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../theme/layout'
import type { PendingReq, PermissionScope, ScrollEntry } from '../api/types'

type Option = { optionId: string; name?: string; kind?: string; label?: string }

/**
 * Permission strip — maps to TUI PermissionView sitting above the prompt.
 * Numbered options 1–N, diamond cue for "waiting on you".
 *
 * Keyboard model (card owns the keyboard while open, TUI PermissionView):
 *   ↑/↓ or j/k      move the selection (clamped)
 *   Tab/Shift+Tab   walk the options, wrapping
 *   1–9             pick that option directly
 *   Enter           confirm the focused option
 *   ←/→             cycle the "always allow" scope preset (only when an
 *                   always/始终 option exists — 精确 → 目录 → 通配)
 *   Ctrl+F          expand/collapse the bash command body (TUI Ctrl-F)
 *   Esc             "park": hand the keyboard back to the scrollback (the
 *                   card stays on screen; Tab/Space returns; parked Esc is
 *                   a swallowed no-op — it never answers or dismisses)
 *   Ctrl+C          cancel the request (respond cancelled)
 * Mouse: click an option, the ✗ reject button (opens the inline followup
 * input — Enter confirms, Esc closes), or the reset button — all kept
 * from the previous mouse-only version.
 */
export function ApprovalStrip() {
  const pending = useChatStore((s) => s.pending)
  const respond = useChatStore((s) => s.respondPermission)
  const resetPermissions = useChatStore((s) => s.resetPermissions)
  const [sel, setSel] = useState(0)
  const [parked, setParked] = useState(false)
  const [scopeIdx, setScopeIdx] = useState(0)
  /** Bash command body Ctrl+F expand/collapse (TUI args_expanded). */
  const [expanded, setExpanded] = useState(false)
  /** Reject-with-followup inline input (TUI RejectOnce followup row). */
  const [followupOpen, setFollowupOpen] = useState(false)
  const [followupText, setFollowupText] = useState('')
  /** optionId of the reject option awaiting followup confirmation (TUI
   *  RejectOnce: picking the reject row opens the followup input first —
   *  the reply is only sent once the feedback is confirmed). */
  const [rejectOption, setRejectOption] = useState<string | undefined>(undefined)

  const req = pending[0]
  const options = (req?.params?.options as Option[] | undefined) || []
  const toolCall = req?.params?.toolCall as
    | { title?: string; kind?: string; rawInput?: unknown; raw_input?: unknown }
    | undefined
  /** Bash command text — toolCall.title is already the command (TUI
   *  build_permission_display's raw-command source). */
  const command = typeof toolCall?.title === 'string' ? toolCall.title : ''
  // Collapsed budget for the command body (TUI PERMISSION_COLLAPSED_ROWS).
  // Independent of `expanded` so Ctrl+F can collapse an expanded view again.
  const commandLines = command ? command.split('\n') : []
  const collapsible = commandLines.length > PERMISSION_COLLAPSED_ROWS
  const hasAlways = options.some(isAlwaysOption)
  // TUI ←/→ presets for the scope an "always" answer would remember. The
  // structured scope rides along in the permission response as `scope`.
  const scopeText = SCOPE_PRESETS[scopeIdx % SCOPE_PRESETS.length]

  /** Structured scope for the current ←/→ preset, or undefined when there
   *  is no command to scope. Mirrors TUI BashCommandSelectedTerms
   *  construction (dispatch/permissions.rs L86-107): arrow word-scope is a
   *  literal command-prefix word list (is_glob false), the free-form
   *  pattern is a single text (is_glob true). */
  function scopeForPreset(): PermissionScope | undefined {
    const words = command.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return undefined
    const rawInput =
      (toolCall?.rawInput as Record<string, unknown> | undefined) ??
      (toolCall?.raw_input as Record<string, unknown> | undefined)
    // '目录' carries the command's first word + its working directory
    // (raw_input cwd/workdir, falling back to the session cwd).
    const cmdCwd =
      (typeof rawInput?.cwd === 'string' && rawInput.cwd) ||
      (typeof rawInput?.workdir === 'string' && rawInput.workdir) ||
      useChatStore.getState().cwd
    switch (SCOPE_PRESETS[scopeIdx % SCOPE_PRESETS.length]) {
      case '目录':
        return {
          commandParts: [words[0], cmdCwd].filter(
            (p): p is string => !!p && p.length > 0,
          ),
          isGlob: false,
        }
      case '通配':
        // The whole command as a single glob pattern (TUI pattern editor).
        return { commandParts: [command], isGlob: true }
      default: // '精确' — every word, literal prefix.
        return { commandParts: words, isGlob: false }
    }
  }

  /** Subagent provenance line above the title (TUI resolve_subagent_label,
   *  acp_handler/permissions.rs L207-237): direct source/subagent fields in
   *  the request params when the host ships them, else the request's
   *  session_id looked up in the tracked subagent registry (tier 1), else
   *  a plain "Child session (untracked)" marker for non-root sessions
   *  (tier 2). Root session → no provenance. */
  function subagentProvenance(req: PendingReq | undefined): string | undefined {
    if (!req) return undefined
    const params = req.params ?? {}
    const src = params.source ?? params.subagent
    if (typeof src === 'string' && src) return `Subagent "${src}":`
    if (src && typeof src === 'object') {
      const o = src as Record<string, unknown>
      const name =
        (typeof o.description === 'string' && o.description) ||
        (typeof o.name === 'string' && o.name) ||
        (typeof o.subagent_type === 'string' && o.subagent_type) ||
        ''
      const type =
        typeof o.subagent_type === 'string' && o.subagent_type !== name
          ? o.subagent_type
          : undefined
      if (name) return type ? `Subagent "${name}" (${type}):` : `Subagent "${name}":`
    }
    const st = useChatStore.getState()
    const sid =
      (typeof params.session_id === 'string' && params.session_id) ||
      (typeof params.sessionId === 'string' && params.sessionId) ||
      ''
    if (!sid || sid === st.sessionId) return undefined
    // Tier 1: tracked subagent (subagentIndex keyed by subagent/child id).
    const entryId = st.subagentIndex[sid]
    const entry = entryId
      ? st.entries.find(
          (e): e is Extract<ScrollEntry, { kind: 'subagent' }> =>
            e.id === entryId && e.kind === 'subagent',
        )
      : undefined
    if (entry) return `Subagent "${entry.title}":`
    // Tier 2: non-root session with no tracked info.
    return 'Child session (untracked):'
  }

  // Reset per-request local state.
  useEffect(() => {
    setSel(0)
    setParked(false)
    setScopeIdx(0)
    setExpanded(false)
    setFollowupOpen(false)
    setFollowupText('')
    setRejectOption(undefined)
  }, [req?.requestId])

  // Keyboard ownership while a permission request is open. Capture phase +
  // stopImmediatePropagation so this card wins over the global scrollback
  // keys (and over the cancel panel / question modal, which register after).
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const st = useChatStore.getState()
      // Fullscreen block viewer owns keys while open (TUI viewer layer).
      if (st.viewerEntryId || st.viewerTask) return
      // The request was resolved while this listener was live.
      if (st.pending.length === 0 || st.pending[0].requestId !== req.requestId) return
      // Fresh options straight from the store (never stale closures).
      const opts = (st.pending[0].params?.options as Option[] | undefined) || []
      const hasAlwaysOpt = opts.some(isAlwaysOption)
      // Browser chords (Cmd/Ctrl/Alt) pass through untouched.
      if (e.metaKey || e.altKey) return

      // Typing a message draft in the prompt: the card only keeps Tab
      // (walk options) / Esc (park) / Ctrl+C (cancel) so the draft can be
      // edited and Enter can still send/queue it.
      const typingDraft = (() => {
        const t = e.target as HTMLElement | null
        if (!t) return false
        if (
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'INPUT' ||
          t.isContentEditable
        ) {
          return (t as HTMLTextAreaElement).value.trim() !== ''
        }
        return false
      })()

      if (e.ctrlKey) {
        if (e.key === 'c' || e.key === 'C') {
          e.preventDefault()
          e.stopImmediatePropagation()
          void respond(req.requestId, undefined, true)
        } else if ((e.key === 'f' || e.key === 'F') && collapsible) {
          // TUI Ctrl-F: expand/collapse the bash command body. When the
          // body fits the collapsed budget, the chord falls through to the
          // browser (find) / scrollback (block viewer).
          e.preventDefault()
          e.stopImmediatePropagation()
          setExpanded((x) => !x)
        } else {
          // Other Ctrl chords: keep them from reaching the scrollback keys,
          // but don't preventDefault (browser copy/paste still works).
          e.stopImmediatePropagation()
        }
        return
      }

      if (followupOpen) {
        // Reject-followup inline input owns the row (TUI FollowupInput):
        // Enter confirms, Esc closes; every other key edits the input and
        // must NOT reach the option keys below.
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopImmediatePropagation()
          const text = followupText.trim()
          const ro = rejectOption
          setFollowupOpen(false)
          setFollowupText('')
          setRejectOption(undefined)
          // Empty text = plain reject; non-empty rides along as
          // followupMessage (host contract, TUI dispatch_permission_followup).
          void respond(req.requestId, ro, true, undefined, text || undefined)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopImmediatePropagation()
          setFollowupOpen(false)
          setFollowupText('')
          setRejectOption(undefined)
          setParked(false)
        }
        return
      }

      if (parked) {
        // Parked: Tab / Space hand the keyboard back to the card. Esc is a
        // swallowed no-op (TUI Escape table: pending needs-input overlay).
        if (e.key === 'Tab' || (e.key === ' ' && !typingDraft)) {
          e.preventDefault()
          e.stopImmediatePropagation()
          setParked(false)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopImmediatePropagation()
        }
        return
      }

      if (typingDraft) {
        if (e.key === 'Tab') {
          e.preventDefault()
          e.stopImmediatePropagation()
          const dir = e.shiftKey ? -1 : 1
          if (opts.length > 0) {
            setSel((s) => (s + dir + opts.length) % opts.length)
          }
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopImmediatePropagation()
          setParked(true)
        }
        return
      }

      // ── card keyboard (active) ──
      const n = opts.length
      if (n === 0) {
        // No options: only Esc (park) and Ctrl+C (above) make sense; every
        // other key is swallowed so it can't act on the scrollback/prompt.
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopImmediatePropagation()
          setParked(true)
        } else {
          e.preventDefault()
          e.stopImmediatePropagation()
        }
        return
      }
      let handled = true
      switch (e.key) {
        case 'ArrowUp':
        case 'k':
          setSel((s) => Math.max(0, s - 1))
          break
        case 'ArrowDown':
        case 'j':
          setSel((s) => Math.min(n - 1, s + 1))
          break
        case 'Tab': {
          const dir = e.shiftKey ? -1 : 1
          setSel((s) => (s + dir + n) % n)
          break
        }
        case 'ArrowLeft':
        case 'h':
        case 'ArrowRight':
        case 'l':
          // ←/→ widen/narrow the scope an "always" answer remembers. With
          // no always option they are swallowed no-ops (never fold keys).
          if (hasAlwaysOpt) {
            setScopeIdx((i) =>
              e.key === 'ArrowLeft' || e.key === 'h'
                ? (i + SCOPE_PRESETS.length - 1) % SCOPE_PRESETS.length
                : (i + 1) % SCOPE_PRESETS.length,
            )
          }
          break
        case 'Enter': {
          const opt = opts[sel]
          // TUI RejectOnce: a reject row never answers directly — it opens
          // the followup input first; the reply fires on confirmation.
          if (isRejectOption(opt)) {
            setRejectOption(opt.optionId)
            setFollowupOpen(true)
            setFollowupText('')
            break
          }
          void respond(
            req.requestId,
            opt?.optionId,
            false,
            isAlwaysOption(opt) ? scopeForPreset() : undefined,
          )
          break
        }
        case 'Escape':
          setParked(true)
          break
        default:
          if (/^[1-9]$/.test(e.key)) {
            const idx = Number(e.key) - 1
            if (idx < n) {
              const opt = opts[idx]
              if (isRejectOption(opt)) {
                setRejectOption(opt.optionId)
                setFollowupOpen(true)
                setFollowupText('')
                break
              }
              void respond(
                req.requestId,
                opt.optionId,
                false,
                isAlwaysOption(opt) ? scopeForPreset() : undefined,
              )
              break
            }
          }
          handled = false
      }
      if (handled) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req, respond, sel, parked, scopeIdx, followupOpen, followupText, rejectOption, expanded, collapsible])

  if (pending.length === 0) return null

  const provenance = subagentProvenance(req)

  return (
    // Background band is confined to the content column (max-w-[960px],
    // same as scrollback/composer) — the strip must not read wider than
    // the conversation it approves.
    <div
      className={`${CONTENT_COLUMN_CLASS} border-t border-gn-yellow/30 bg-gn-bg-dark py-2.5`}
    >
      <div className={COLUMN_PAD_X_CLASS}>
        {provenance && (
          <div className="mb-1 text-[11px] text-gn-muted">{provenance}</div>
        )}
        <div className="mb-1.5 flex items-center gap-2 text-[12px]">
          <span className="text-gn-yellow animate-pulse" aria-hidden>
            <IconGlyph glyph={Glyphs.diamondFilled} color="currentColor" />
          </span>
          <span className="font-bold text-gn-yellow">waiting on you</span>
          <span className="text-gn-muted truncate">{req.method}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => void resetPermissions()}
              className="rounded border border-gn-prompt-border px-2 py-[3px] text-[11px] text-gn-muted transition-colors hover:border-gn-prompt-border-active hover:bg-gn-bg-highlight hover:text-gn-fg"
              title="x.ai/permissions/reset — 忘记已记忆的权限规则（始终允许模式等）"
            >
              重置权限规则
            </button>
            <button
              type="button"
              onClick={() => {
                // Opens the followup input INSIDE the reject option row
                // (TUI RejectOnce followup — no separate input line); a
                // second click closes it. Without a reject option the
                // button rejects directly (nothing to attach feedback to).
                if (followupOpen) {
                  setFollowupOpen(false)
                  setFollowupText('')
                  setRejectOption(undefined)
                  return
                }
                const firstReject = options.find(isRejectOption)
                if (firstReject) {
                  setRejectOption(firstReject.optionId)
                  setFollowupOpen(true)
                  setFollowupText('')
                } else {
                  void respond(req.requestId, undefined, true)
                }
              }}
              className={`rounded border px-2 py-[3px] text-[11px] transition-colors ${
                followupOpen
                  ? 'border-gn-red/70 bg-gn-diff-del-bg text-gn-red'
                  : 'border-gn-red/40 text-gn-red hover:bg-gn-diff-del-bg'
              }`}
              title="拒绝并取消该请求（可附带给 agent 的反馈）"
            >
              <span className="mr-1 inline-flex items-center">
                <IconGlyph glyph={Glyphs.ballotX} color="currentColor" />
              </span>
              reject
            </button>
          </span>
        </div>
        {command && (
          <div className="mb-2 pl-5">
            <div className="whitespace-pre-wrap break-words font-mono text-[12px] leading-snug text-gn-fg2">
              {commandLines
                .slice(0, expanded || !collapsible ? commandLines.length : PERMISSION_COLLAPSED_ROWS - 1)
                .join('\n')}
            </div>
            {collapsible && !expanded && (
              <div className="mt-0.5 text-[11px] text-gn-muted">
                … Ctrl-F to expand
              </div>
            )}
          </div>
        )}
        {hasAlways && (
          <div className="mb-2 flex items-center gap-2 pl-5 text-[11.5px] text-gn-cyan">
            <span>←/→ 调整始终允许范围</span>
            <span className="rounded border border-gn-cyan/40 bg-gn-bg-base px-1.5 py-[1px] font-mono">
              {scopeText}
            </span>
          </div>
        )}
        {/* TUI PermissionView: options are full-width rows, one per line —
            j/k ↑/↓ walk them, Enter or 1-N pick. Always vertical; never
            wraps into a horizontal row on wide screens. The reject row
            embeds its followup input (TUI RejectOnce followup) instead of
            opening a separate input line. */}
        <div className="flex flex-col gap-1.5 pl-0 sm:pl-5">
          {options.map((opt, i) =>
            isRejectOption(opt) && followupOpen && rejectOption === opt.optionId ? (
              <div
                key={opt.optionId}
                className="flex min-h-10 w-full items-center gap-1.5 rounded border border-gn-red/50 bg-gn-bg-base px-3 py-1.5"
              >
                <span className="mr-1.5 font-mono text-gn-muted">{i + 1}</span>
                <input
                  autoFocus
                  value={followupText}
                  onChange={(e) => setFollowupText(e.target.value)}
                  placeholder="给 agent 的反馈（可选，Enter 拒绝）…"
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] text-gn-fg outline-none placeholder:text-gn-muted"
                />
                <button
                  type="button"
                  onClick={() => {
                    const text = followupText.trim()
                    const ro = rejectOption
                    setFollowupOpen(false)
                    setFollowupText('')
                    setRejectOption(undefined)
                    void respond(req.requestId, ro, true, undefined, text || undefined)
                  }}
                  className="shrink-0 rounded border border-gn-red/40 px-2 py-1 text-[11px] text-gn-red transition-colors hover:bg-gn-diff-del-bg"
                  title="Enter 确认 · Esc 关闭"
                >
                  确认拒绝
                </button>
              </div>
            ) : (
              <button
                key={opt.optionId}
                type="button"
                onMouseEnter={() => setSel(i)}
                onClick={() => {
                  // TUI RejectOnce: clicking a reject row opens the followup
                  // input inside the row instead of answering directly.
                  if (isRejectOption(opt)) {
                    setRejectOption(opt.optionId)
                    setFollowupOpen(true)
                    setFollowupText('')
                    return
                  }
                  void respond(
                    req.requestId,
                    opt.optionId,
                    false,
                    isAlwaysOption(opt) ? scopeForPreset() : undefined,
                  )
                }}
                className={`min-h-10 w-full rounded border px-3 py-1.5 text-left text-[12.5px] transition-colors ${
                  i === sel
                    ? // Selected row: yellow border + solid dot, background
                      // stays base — no dark-gray fill.
                      'border-gn-yellow/60 bg-gn-bg-base text-gn-fg'
                    : 'border-gn-prompt-border bg-gn-bg-base text-gn-fg hover:border-gn-magenta/50 hover:bg-gn-bg-highlight'
                }`}
              >
                <span className="mr-1.5 font-mono text-gn-muted">{i + 1}</span>
                {/* Radio marker: solid for always-allow rows AND the
                    selected row (TUI `1 (●) …` rows), hollow otherwise. */}
                <span
                  className={`mr-1.5 ${
                    isAlwaysOption(opt)
                      ? 'text-gn-cyan'
                      : i === sel
                        ? 'text-gn-yellow'
                        : 'text-gn-muted'
                  }`}
                  aria-hidden
                >
                  {isAlwaysOption(opt) || i === sel ? '●' : '○'}
                </span>
                {opt.name || opt.label || opt.optionId}
                {isAlwaysOption(opt) && (
                  <span className="ml-1.5 text-[10.5px] text-gn-cyan">always</span>
                )}
              </button>
            ),
          )}
        </div>
        <div className="mt-1.5 pl-5 text-[11px] text-gn-muted">
          {parked ? (
            <span>
              <span className="text-gn-fg2">Tab/Space</span> 返回权限卡 ·{' '}
              <span className="text-gn-fg2">Ctrl+C</span> 取消请求
            </span>
          ) : (
            <span>
              ↑/↓ 或 j/k 选择 · <span className="text-gn-fg2">1-9</span> 直接选 ·{' '}
              <span className="text-gn-fg2">Enter</span> 确认 ·{' '}
              <span className="text-gn-fg2">Esc</span> 暂停键盘
              {hasAlways ? ' · ←/→ 调整始终允许范围' : ''}
              {collapsible && !expanded ? ' · Ctrl+F 展开命令' : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/** TUI ←/→ scope presets for an "always allow" answer. Each maps to a
 *  structured BashCommandSelectedTerms (see scopeForPreset): 精确 = every
 *  command word, 目录 = first word + working directory, 通配 = the whole
 *  command as a glob. */
const SCOPE_PRESETS = ['精确', '目录', '通配']

/** TUI PERMISSION_COLLAPSED_ROWS (permission_view.rs) — bash body rows
 *  shown before folding with "… Ctrl-F to expand". */
const PERMISSION_COLLAPSED_ROWS = 5

const ALWAYS_RE = /always|always_allow|alwaysAllow|始终|总是/i

/** An option carrying "always allow" semantics (optionId or label). */
function isAlwaysOption(opt: Option | undefined): boolean {
  if (!opt) return false
  return (
    ALWAYS_RE.test(opt.optionId || '') ||
    ALWAYS_RE.test(opt.label || '') ||
    ALWAYS_RE.test(opt.name || '')
  )
}

const REJECT_RE = /reject|拒绝/i

/** An option carrying reject semantics — selecting it opens the followup
 *  input first (TUI RejectOnce) instead of answering immediately. */
function isRejectOption(opt: Option | undefined): boolean {
  if (!opt) return false
  return (
    REJECT_RE.test(opt.optionId || '') ||
    REJECT_RE.test(opt.label || '') ||
    REJECT_RE.test(opt.name || '')
  )
}
