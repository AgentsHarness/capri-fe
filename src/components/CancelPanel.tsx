import { useCallback, useEffect, useState } from 'react'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../theme/layout'

/**
 * Cancel-turn panel — web counterpart of the TUI CancelTurnPanel.
 *
 * Opens on Esc / [stop] only while a turn is running AND at least one
 * subagent of the current turn is still running AND no saved preference
 * exists (store.requestCancelTurn decides). While open it is a blocking
 * inline card above the composer — never a fullscreen overlay (TUI: the
 * prompt area blocks in place) — and it owns the keyboard:
 *
 *   1–4             confirm that option directly
 *   ↑/↓ or j/k      move the selection
 *   Tab/Shift+Tab   walk the options, wrapping
 *   Enter           confirm the focused option
 *   Esc             option 2 — keep everything running (never a dead end)
 *   Ctrl+C          cancel the turn directly (subagents keep running)
 *
 * Options (TUI CancelTurnChoice::ALL — modal.rs):
 *   1 Stop running    — cancel() + cancelSubagent × running subagents
 *   2 Continue to run — close the panel, nothing is cancelled
 *   3 Always stop     — = 1 and persist the preference (true); the panel
 *                       never asks again
 *   4 Always continue — = 2 and persist the preference (false)
 *
 * With a saved preference (3/4) the panel never opens — Esc / [stop] act
 * directly (store.requestCancelTurn). The permission card takes keyboard
 * priority while a request is pending (TUI: permission prompt > cancel
 * panel > question card).
 */
const CANCEL_OPTIONS = [
  { label: 'Stop running', desc: '取消当前回合并取消运行中的子代理' },
  { label: 'Continue to run', desc: '继续运行，关闭面板' },
  { label: 'Always stop', desc: '=1 并记住偏好，之后不再询问' },
  { label: 'Always continue', desc: '=2 并记住偏好，之后不再询问' },
] as const

export function CancelPanel() {
  const open = useChatStore((s) => s.cancelPanelOpen)
  const closeCancelPanel = useChatStore((s) => s.closeCancelPanel)
  const cancelTurn = useChatStore((s) => s.cancelTurn)
  const setCancelSubagentsPref = useChatStore((s) => s.setCancelSubagentsPref)
  const [sel, setSel] = useState(0)

  // Selection resets whenever the panel (re)opens.
  useEffect(() => {
    setSel(0)
  }, [open])

  const pick = useCallback(
    (i: number) => {
      if (i === 0) void cancelTurn({ cancelSubagents: true })
      else if (i === 1) closeCancelPanel()
      else if (i === 2) {
        setCancelSubagentsPref(true)
        void cancelTurn({ cancelSubagents: true })
      } else {
        setCancelSubagentsPref(false)
        closeCancelPanel()
      }
    },
    [closeCancelPanel, cancelTurn, setCancelSubagentsPref],
  )

  // Keyboard ownership while open: capture + stopImmediatePropagation so
  // nothing behind the card (scrollback keys, composer, question modal)
  // sees a key. Every unmodified key is swallowed — blocking card.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const st = useChatStore.getState()
      // Fullscreen block viewer owns keys while open.
      if (st.viewerEntryId || st.viewerTask) return
      // Permission card has keyboard priority (TUI ordering).
      if (st.pending.length > 0) return
      // Browser chords (Cmd/Ctrl/Alt) pass through untouched — except
      // Ctrl+C which cancels the turn directly (TUI interactions.rs:
      // Ctrl+C → Action::CancelTurn, subagents keep running).
      if (e.metaKey || e.altKey) return
      if (e.ctrlKey) {
        if (e.key === 'c' || e.key === 'C') {
          e.preventDefault()
          e.stopImmediatePropagation()
          void cancelTurn({})
        } else {
          e.stopImmediatePropagation()
        }
        return
      }
      e.preventDefault()
      e.stopImmediatePropagation()
      switch (e.key) {
        case 'ArrowUp':
        case 'k':
          setSel((s) => Math.max(0, s - 1))
          break
        case 'ArrowDown':
        case 'j':
          setSel((s) => Math.min(CANCEL_OPTIONS.length - 1, s + 1))
          break
        case 'Tab': {
          const dir = e.shiftKey ? -1 : 1
          setSel(
            (s) => (s + dir + CANCEL_OPTIONS.length) % CANCEL_OPTIONS.length,
          )
          break
        }
        case 'Enter':
          pick(sel)
          break
        case 'Escape':
          // TUI: Esc = keep everything running (option 2).
          closeCancelPanel()
          break
        default:
          if (/^[1-4]$/.test(e.key)) pick(Number(e.key) - 1)
          break // swallow — blocking card
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, sel, pick, closeCancelPanel, cancelTurn])

  if (!open) return null

  return (
    <div className="border-t border-gn-prompt-border bg-gn-bg-dark py-2.5">
      <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS}`}>
        <div className="mb-1.5 flex items-center gap-2 text-[12px]">
          <span className="text-gn-yellow" aria-hidden>
            <IconGlyph glyph={Glyphs.diamondFilled} color="currentColor" />
          </span>
          <span className="font-bold text-gn-yellow">取消回合</span>
          <span className="ml-auto text-[11px] text-gn-muted">
            esc 继续运行
          </span>
        </div>
        <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:pl-5">
          {CANCEL_OPTIONS.map((opt, i) => (
            <button
              key={i}
              type="button"
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(i)}
              className={`min-h-10 rounded px-3 py-1.5 text-left text-[12.5px] transition-colors ${
 i === sel
                  ? 'bg-gn-bg-highlight text-gn-fg'
                  : 'text-gn-fg hover:bg-gn-bg-highlight'
              }`}
            >
              <span
                className={`mr-2 font-mono ${
 i === sel ? 'text-gn-yellow' : 'text-gn-muted'
                }`}
                aria-hidden
              >
                {i + 1}
              </span>
              <span>{opt.label}</span>
              <span className="ml-2 text-[11px] text-gn-muted">{opt.desc}</span>
            </button>
          ))}
        </div>
        <div className="mt-1.5 text-[11px] text-gn-muted sm:pl-5">
          1-4 / ↑↓ 选择 · Enter 确认 · Esc 继续运行 · Ctrl+C 直接取消
        </div>
      </div>
    </div>
  )
}
