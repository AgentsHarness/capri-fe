import { useEffect } from 'react'
import { useChatStore } from '../store/chat'

const NAV_KEYS = new Set([
  'j',
  'k',
  'h',
  'l',
  'J',
  'K',
  'H',
  'L',
  'g',
  'G',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
  ' ',
  'Escape',
])

/** The scrollback scroll container (Scrollback.tsx data-scrollback-box). */
function scrollBox(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-scrollback-box]')
}

/**
 * TUI NextResponse / PrevResponse (Shift+J / Shift+K) and PrevTurn /
 * NextTurn (Shift+H / Shift+L, actions/defaults.rs): select the nearest
 * entry of the given kind in `dir` and scroll it into view.
 */
function jumpToKind(
  st: ReturnType<typeof useChatStore.getState>,
  kind: 'user' | 'assistant',
  dir: 1 | -1,
): void {
  const idx = st.entries.findIndex((e) => e.id === st.selectedId)
  let i = (idx === -1 ? (dir === 1 ? -1 : st.entries.length) : idx) + dir
  while (i >= 0 && i < st.entries.length) {
    const e = st.entries[i]
    if (e?.kind === kind) {
      st.selectEntry(e.id)
      document
        .querySelector(`[data-entry-id="${e.id}"]`)
        ?.scrollIntoView({ block: 'nearest' })
      return
    }
    i += dir
  }
}

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
 * - g / G: scroll to top / bottom (G restores bottom-follow)
 * - PgUp / PgDn: page the conversation (also from the prompt, TUI docs)
 * - Ctrl+J / Ctrl+K: scroll a line down / up without moving selection
 * - Ctrl+U / Ctrl+D: half page up / down
 * - Shift+J / Shift+K: next / previous assistant response
 * - Shift+H / Shift+L: previous / next user turn (TUI PrevTurn/NextTurn)
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
      // Ctrl+J / Ctrl+K / Ctrl+U / Ctrl+D (TUI ScrollDown / ScrollUp /
      // HalfPageUp / HalfPageDown): scroll the conversation without moving
      // the selection. Inert while a modal surface owns the keys.
      if (
        e.ctrlKey &&
        (e.key === 'j' ||
          e.key === 'J' ||
          e.key === 'k' ||
          e.key === 'K' ||
          e.key === 'u' ||
          e.key === 'U' ||
          e.key === 'd' ||
          e.key === 'D')
      ) {
        if (
          store0.viewerEntryId ||
          store0.viewerTask ||
          store0.xaiRequests.length > 0 ||
          store0.cancelPanelOpen ||
          store0.queuePanelOpen
        ) {
          return
        }
        const box = scrollBox()
        if (!box) return
        e.preventDefault()
        const line = e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K'
        const amount = line
          ? 48
          : Math.max(120, Math.round(box.clientHeight / 2))
        const up =
          e.key === 'k' || e.key === 'K' || e.key === 'u' || e.key === 'U'
        box.scrollBy({ top: up ? -amount : amount })
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

      // Typing in the prompt: Esc→cancel flow while busy; PgUp/PgDn page
      // the conversation without stealing focus (TUI docs: "prompt
      // focused — PgUp/PgDn scroll the conversation").
      if (inField) {
        const store = useChatStore.getState()
        if (e.key === 'Escape' && store.conn === 'busy') {
          e.preventDefault()
          void store.requestCancelTurn()
          return
        }
        if (e.key === 'PageUp' || e.key === 'PageDown') {
          const box = scrollBox()
          if (box) {
            e.preventDefault()
            box.scrollBy({
              top: (e.key === 'PageUp' ? -1 : 1) * box.clientHeight * 0.9,
            })
          }
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
        case 'g': {
          // TUI GotoTop: jump to the scrollback top (follow pauses
          // automatically — the box's onScroll sees the distance grow).
          e.preventDefault()
          const box = scrollBox()
          if (box) box.scrollTop = 0
          return
        }
        case 'G': {
          // TUI GotoBottom: jump to the bottom; landing near the bottom
          // re-engages the existing bottom-follow.
          e.preventDefault()
          const box = scrollBox()
          if (box) box.scrollTop = box.scrollHeight
          return
        }
        case 'PageUp':
        case 'PageDown':
          e.preventDefault()
          scrollBox()?.scrollBy({
            top:
              (e.key === 'PageUp' ? -1 : 1) *
              (scrollBox()?.clientHeight ?? 0) *
              0.9,
          })
          return
        case 'J':
          // TUI NextResponse: next assistant reply
          e.preventDefault()
          jumpToKind(store, 'assistant', 1)
          return
        case 'K':
          // TUI PrevResponse: previous assistant reply
          e.preventDefault()
          jumpToKind(store, 'assistant', -1)
          return
        case 'H':
          // TUI PrevTurn: previous user prompt
          e.preventDefault()
          jumpToKind(store, 'user', -1)
          return
        case 'L':
          // TUI NextTurn: next user prompt
          e.preventDefault()
          jumpToKind(store, 'user', 1)
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
