import { useEffect } from 'react'
import { useChatStore } from '../store/chat'

const NAV_KEYS = new Set([
  'j',
  'k',
  'h',
  'l',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
  ' ',
  'Escape',
])

/**
 * True when the event target sits on (or inside) an interactive control —
 * links, buttons, selects, details/summary or any explicitly-tabbable
 * element. Those own Tab/Enter/Space natively (audit B1).
 */
function onInteractiveControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest(
      'a[href], button, select, summary, [tabindex]:not([tabindex="-1"])',
    )
  )
}

/**
 * Global keybindings matching TUI scrollback navigation:
 * - Tab: toggle prompt ↔ scrollback focus
 * - j/k / ↑↓: move selection (scrollback focus)
 * - ← / → / h / l: collapse / expand selected foldable block (inline)
 * - Enter: open block viewer (TUI OpenBlockViewer)
 * - Space: toggle inline expand
 * - Esc: close viewer if open, else scrollback → prompt (or the cancel
 *   flow when busy: saved preference acts directly, running subagents
 *   open the cancel panel, otherwise the turn is cancelled)
 * - Ctrl+C: TUI ladder — a non-empty draft is cleared first (turn keeps
 *   running); an empty draft cancels the running turn (subagents keep
 *   running). Idle with a draft clears it; idle and empty does nothing.
 * - Tab / Enter / Space: pane-switch and scrollback bindings yield to
 *   native behavior on interactive controls (link/button/select), so
 *   keyboard focus traversal and activation stay reachable (audit B1).
 */
export function useScrollbackKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore pure modifier chords (Ctrl-F also opens viewer — handled below)
      if (e.metaKey || e.altKey) return

      const store0 = useChatStore.getState()

      // Ctrl+F → OpenBlockViewer (TUI alt_keys for OpenBlockViewer)
      if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
        if (store0.viewerEntryId || store0.viewerTask) return
        const target = e.target as HTMLElement | null
        const inField =
          !!target &&
          (target.tagName === 'TEXTAREA' ||
            target.tagName === 'INPUT' ||
            target.isContentEditable)
        if (inField) return
        e.preventDefault()
        if (store0.focusMode !== 'scrollback') store0.setFocus('scrollback')
        useChatStore.getState().openViewer()
        return
      }
      // Ctrl+C — TUI ladder (03-keyboard-shortcuts.md): a non-empty draft
      // is cleared first and the turn keeps running; an EMPTY draft
      // cancels the running turn directly (subagents keep running; no
      // panel, no preference check). Idle with a draft clears it; idle
      // and empty does nothing. Skipped while the viewer / x.ai surfaces
      // / cancel panel own the keys, and while a text selection exists
      // (browser copy must win).
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
        const st = useChatStore.getState()
        if (
          (st.viewerEntryId || st.viewerTask) ||
          st.xaiRequests.length > 0 ||
          st.cancelPanelOpen
        ) {
          return
        }
        const t = e.target as HTMLElement | null
        const inField =
          !!t &&
          (t.tagName === 'TEXTAREA' ||
            t.tagName === 'INPUT' ||
            t.isContentEditable)
        if (inField) {
          const el = t as HTMLTextAreaElement | HTMLInputElement
          if (
            el.selectionStart != null &&
            el.selectionEnd != null &&
            el.selectionStart !== el.selectionEnd
          ) {
            return // copy the selection, not a clear/cancel
          }
        }
        if (st.composerDraftLen > 0) {
          // Draft first: clear it, keep the turn (TUI Ctrl+C semantics).
          e.preventDefault()
          st.clearComposerDraft()
          return
        }
        if (st.conn === 'busy') {
          e.preventDefault()
          void st.cancelTurn({})
        }
        return
      }
      if (e.ctrlKey) return

      const target = e.target as HTMLElement | null
      const inField =
        !!target &&
        (target.tagName === 'TEXTAREA' ||
          target.tagName === 'INPUT' ||
          target.isContentEditable)

      // Viewer open: only Esc is handled here (BlockViewer also listens);
      // don't steal other keys from the dialog.
      if (store0.viewerEntryId || store0.viewerTask) {
        if (e.key === 'Escape') {
          e.preventDefault()
          store0.closeViewer()
        }
        return
      }

      // x.ai interactive surface (ask_user_question modal / plan approval):
      // the modals own Esc + navigation while open.
      if (store0.xaiRequests.length > 0) return
      // Cancel-turn panel owns the keyboard while open (defense in depth —
      // the panel's own capture listener already stops the keys).
      if (store0.cancelPanelOpen) return
      // Queue dropdown owns the row keys while open (its own capture
      // listener handles x/e/j/k/swap; Esc closes the panel in Composer).
      if (store0.queuePanelOpen) return

      // Activation keys on a focused control (link/button/select row)
      // must reach the control — the scrollback bindings below (Enter →
      // viewer, Space → fold toggle) must not swallow native keyboard
      // activation (same audit-B1 class as the Tab fix). j/k/←/→ don't
      // collide with any control, so they keep working globally.
      if (
        (e.key === 'Enter' || e.key === ' ') &&
        !inField &&
        onInteractiveControl(target)
      ) {
        return
      }

      // Tab: TUI pane-switch (prompt ↔ scrollback) — but native focus
      // traversal wins whenever focus already sits on an interactive
      // control (link / button / select / another field): hijacking Tab
      // unconditionally made every link and button keyboard-unreachable
      // (audit B1). The composer textarea keeps the pane-switch binding.
      if (e.key === 'Tab') {
        const isComposer =
          target instanceof HTMLElement && target.id === 'composer-input'
        if (isComposer || (!inField && !onInteractiveControl(target))) {
          e.preventDefault()
          const store = useChatStore.getState()
          if (store.focusMode === 'prompt') {
            store.setFocus('scrollback')
            if (inField) target?.blur()
          } else {
            store.setFocus('prompt')
            requestAnimationFrame(() => {
              document.getElementById('composer-input')?.focus()
            })
          }
        }
        return
      }

      // Typing in the prompt: only Esc→cancel flow while busy
      if (inField) {
        const store = useChatStore.getState()
        if (e.key === 'Escape' && store.conn === 'busy') {
          e.preventDefault()
          void store.requestCancelTurn()
        }
        return
      }

      if (!NAV_KEYS.has(e.key)) return

      // Enter scrollback on first nav key
      let store = useChatStore.getState()
      if (store.focusMode !== 'scrollback') {
        if (e.key === 'Escape') return
        store.setFocus('scrollback')
        store = useChatStore.getState()
      }

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault()
          store.selectDelta(1)
          return
        case 'k':
        case 'ArrowUp':
          e.preventDefault()
          store.selectDelta(-1)
          return
        case 'ArrowRight':
        case 'l':
          // Inline expand (TUI fold → Truncated)
          e.preventDefault()
          store.setExpanded(true)
          return
        case 'ArrowLeft':
        case 'h':
          // Inline collapse
          e.preventDefault()
          store.setExpanded(false)
          return
        case 'Enter':
          // Open block viewer (TUI OpenBlockViewer default_key: Enter)
          e.preventDefault()
          store.openViewer()
          return
        case ' ':
          // Space: inline fold toggle (not viewer)
          e.preventDefault()
          store.toggleSelected()
          return
        case 'Escape':
          // TUI: Esc while a turn runs goes through the cancel flow —
          // saved preference acts directly, running subagents open the
          // cancel panel, otherwise the turn is cancelled outright.
          // Idle Esc moves focus back to the prompt.
          e.preventDefault()
          if (store.conn === 'busy') {
            void store.requestCancelTurn()
          } else {
            store.setFocus('prompt')
            requestAnimationFrame(() => {
              document.getElementById('composer-input')?.focus()
            })
          }
          return
        default:
          break
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
