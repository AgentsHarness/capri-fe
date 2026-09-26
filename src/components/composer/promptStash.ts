/**
 * Composer draft stash — TUI `agent_view/prompt_stash.rs`.
 *
 * One slot. Ctrl+S / Alt+S on a non-empty draft parks it and clears the
 * composer (leaving `!` mode). The same chord on an empty composer pops
 * the slot. A chord-stashed draft also returns by itself after the next
 * prompt is sent. A double-Esc clear uses the same slot but does not
 * auto-return. Ctrl+Z (or Cmd+Z) as the very next key pops the slot;
 * any other key disarms that.
 */

import type { PasteChip } from './pasteChips'

export type StashCause = 'chord' | 'cleared'

export type ComposerDraft = {
  text: string
  chips: PasteChip[]
  shellMode: boolean
}

export type PromptStashSlot = ComposerDraft & {
  cause: StashCause
  undoArmed: boolean
}

export function draftHasContent(d: ComposerDraft): boolean {
  return d.text.length > 0 || d.chips.length > 0
}

/** Park `draft`, replacing whatever the slot already held. Empty drafts are not stashed. */
export function parkDraft(
  draft: ComposerDraft,
  cause: StashCause,
): PromptStashSlot | null {
  if (!draftHasContent(draft)) return null
  return {
    text: draft.text,
    chips: draft.chips.map((c) => ({ ...c })),
    shellMode: draft.shellMode,
    cause,
    undoArmed: true,
  }
}

/** The next key after a stash consumes the undo arm (TUI `mem::take`). */
export function takeUndoArm(slot: PromptStashSlot | null): {
  slot: PromptStashSlot | null
  armed: boolean
} {
  if (!slot?.undoArmed) return { slot, armed: false }
  return { slot: { ...slot, undoArmed: false }, armed: true }
}

export function isUndoKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return (e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.altKey
}

export function isStashChord(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}): boolean {
  if (e.key !== 's' && e.key !== 'S') return false
  if (e.shiftKey) return false
  // Ctrl+S, or Alt+S without Ctrl/Cmd (TUI's two bindings).
  if (e.ctrlKey && !e.metaKey && !e.altKey) return true
  if (e.altKey && !e.ctrlKey && !e.metaKey) return true
  return false
}

/**
 * After a send emptied the composer, a chord stash comes back.
 * A double-Esc clear stays parked. A queued-row edit never gets overwritten.
 */
export function autoRestoreAfterSend(
  slot: PromptStashSlot | null,
  editingQueue: boolean,
): ComposerDraft | null {
  if (!slot || slot.cause !== 'chord' || editingQueue) return null
  return { text: slot.text, chips: slot.chips, shellMode: slot.shellMode }
}
