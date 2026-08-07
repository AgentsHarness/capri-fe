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
 * Global keybindings matching TUI scrollback navigation:
 * - Tab: toggle prompt ↔ scrollback focus
 * - j/k / ↑↓: move selection (scrollback focus)
 * - ← / → / h / l: collapse / expand selected foldable block (inline)
 * - Enter: open block viewer (TUI OpenBlockViewer)
 * - Space: toggle inline expand
 * - Esc: close viewer if open, else scrollback → prompt (or cancel when busy)
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

      // Tab always switches focus panes
      if (e.key === 'Tab') {
        e.preventDefault()
        const store = useChatStore.getState()
        if (store.focusMode === 'prompt') {
          store.setFocus('scrollback')
          if (inField) target.blur()
        } else {
          store.setFocus('prompt')
          requestAnimationFrame(() => {
            document.getElementById('composer-input')?.focus()
          })
        }
        return
      }

      // Typing in the prompt: only Esc→cancel-turn panel while busy
      if (inField) {
        const store = useChatStore.getState()
        if (e.key === 'Escape' && store.conn === 'busy') {
          e.preventDefault()
          store.openCancelPanel()
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
          // TUI: Esc while a turn runs opens the cancel-turn panel
          // (immediate cancel only after the panel resolves); idle Esc
          // moves focus back to the prompt.
          e.preventDefault()
          if (store.conn === 'busy') {
            store.openCancelPanel()
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
