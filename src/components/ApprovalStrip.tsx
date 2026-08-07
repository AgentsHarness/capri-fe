import { useEffect, useState } from 'react'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../theme/layout'

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
 *   Esc             "park": hand the keyboard back to the scrollback (the
 *                   card stays on screen; Tab/Space returns; parked Esc is
 *                   a swallowed no-op — it never answers or dismisses)
 *   Ctrl+C          cancel the request (respond cancelled)
 * Mouse: click an option, the ✗ reject button, or the reset button — all
 * kept from the previous mouse-only version.
 */
export function ApprovalStrip() {
  const pending = useChatStore((s) => s.pending)
  const respond = useChatStore((s) => s.respondPermission)
  const resetPermissions = useChatStore((s) => s.resetPermissions)
  const [sel, setSel] = useState(0)
  const [parked, setParked] = useState(false)
  const [scopeIdx, setScopeIdx] = useState(0)

  const req = pending[0]
  const options = (req?.params?.options as Option[] | undefined) || []
  const toolCall = req?.params?.toolCall as { title?: string; kind?: string } | undefined
  const hasAlways = options.some(isAlwaysOption)
  // TUI ←/→ presets for the scope an "always" answer would remember. The
  // final text rides along in the permission response as `scope`.
  const scopeText = SCOPE_PRESETS[scopeIdx % SCOPE_PRESETS.length]

  // Reset per-request local state.
  useEffect(() => {
    setSel(0)
    setParked(false)
    setScopeIdx(0)
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
        } else {
          // Other Ctrl chords: keep them from reaching the scrollback keys,
          // but don't preventDefault (browser copy/paste still works).
          e.stopImmediatePropagation()
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
      // The displayed scope text rides along in the response as `scope`.
      const scopeText = SCOPE_PRESETS[scopeIdx % SCOPE_PRESETS.length]
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
        case 'Enter':
          void respond(
            req.requestId,
            opts[sel]?.optionId,
            false,
            isAlwaysOption(opts[sel]) ? scopeText : undefined,
          )
          break
        case 'Escape':
          setParked(true)
          break
        default:
          if (/^[1-9]$/.test(e.key)) {
            const idx = Number(e.key) - 1
            if (idx < n) {
              void respond(
                req.requestId,
                opts[idx].optionId,
                false,
                isAlwaysOption(opts[idx]) ? scopeText : undefined,
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
  }, [req, respond, sel, parked, scopeIdx])

  if (pending.length === 0) return null

  return (
    <div className="border-t border-gn-yellow/30 bg-gn-bg-dark py-2.5">
      <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS}`}>
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
              onClick={() => void respond(req.requestId, undefined, true)}
              className="rounded border border-gn-red/40 px-2 py-[3px] text-[11px] text-gn-red transition-colors hover:bg-gn-diff-del-bg"
              title="拒绝并取消该请求"
            >
              <span className="mr-1 inline-flex items-center">
                <IconGlyph glyph={Glyphs.ballotX} color="currentColor" />
              </span>
              reject
            </button>
          </span>
        </div>
        {toolCall?.title && (
          <div className="mb-2 truncate pl-5 font-mono text-[12px] text-gn-fg2">
            {toolCall.title}
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
        <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap pl-0 sm:pl-5">
          {options.map((opt, i) => (
            <button
              key={opt.optionId}
              type="button"
              onMouseEnter={() => setSel(i)}
              onClick={() =>
                void respond(
                  req.requestId,
                  opt.optionId,
                  false,
                  isAlwaysOption(opt) ? scopeText : undefined,
                )
              }
              className={`min-h-10 rounded border px-3 py-1.5 text-left text-[12.5px] transition-colors ${
                i === sel
                  ? 'border-gn-yellow/60 bg-gn-bg-highlight text-gn-fg'
                  : 'border-gn-prompt-border bg-gn-bg-base text-gn-fg hover:border-gn-magenta/50 hover:bg-gn-bg-highlight'
              }`}
            >
              <span className="mr-2 font-mono text-gn-muted">{i + 1}</span>
              {opt.name || opt.label || opt.optionId}
              {isAlwaysOption(opt) && (
                <span className="ml-1.5 text-[10.5px] text-gn-cyan">always</span>
              )}
            </button>
          ))}
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
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/** TUI ←/→ scope presets for an "always allow" answer. The displayed text
 *  is attached verbatim to the permission response as `{ optionId, scope }`. */
const SCOPE_PRESETS = ['精确', '目录', '通配']

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
