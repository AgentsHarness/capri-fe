import { create } from 'zustand'
import type { ContentBlock } from '../api/types'

/**
 * ── TUI mid-turn send queue (PromptWidget queue semantics) ───────────
 * While a turn is running (conn === 'busy'), Enter with content QUEUES
 * instead of sending; the queue head is auto-sent when the turn ends
 * (conn → ready && awaitingNext), or immediately on double-Enter.
 *
 * `sending` is a mutual-exclusion flag: the auto-send effect and user
 * gestures (double-Enter / [发送现在]) share one drain path, so a user
 * Enter can never race the auto-send into a double prompt.
 *
 * Queue-panel row operations (TUI queue.rs / queue_edit.rs):
 *   - `e` / Enter / double-click enters edit mode for a row; the row
 *     becomes a textarea (Enter saves, Esc cancels, Shift+Enter newline)
 *   - `x` deletes a row
 *   - Shift+K / Shift+J (TUI SwapUp / SwapDown) reorder rows
 */

export type QueuedPrompt = {
  id: string
  /** Display text (paste chips expanded; `[Image: …]` labels retained). */
  text: string
  /** Full prompt blocks — text block first, image blocks in chip order. */
  blocks: ContentBlock[]
  /** Enqueue time (epoch ms). */
  ts: number
}

function qid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `q_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

type PromptQueueState = {
  queue: QueuedPrompt[]
  /** True while a queued prompt is being sent (guards auto-send races). */
  sending: boolean
  /**
   * Queue-panel edit mode (TUI PromptMode::EditingQueued): index of the
   * row being edited. The row renders as a textarea; Enter saves, Esc
   * cancels, Shift+Enter inserts a newline.
   */
  editIndex: number | null
  /** Live draft text of the row being edited. */
  editDraft: string
  enqueue: (item: Omit<QueuedPrompt, 'id' | 'ts'>) => void
  /** Remove and return the head; undefined when empty. */
  dequeue: () => QueuedPrompt | undefined
  removeAt: (id: string) => void
  clear: () => void
  setSending: (v: boolean) => void
  /** Enter edit mode for queue row `index` (TUI QueueEvent::EditSelected). */
  startEdit: (index: number) => void
  setEditDraft: (text: string) => void
  /** Enter-save the edited row back into the queue (never blanked). */
  saveEdit: () => void
  /** Esc — discard the draft and leave edit mode. */
  cancelEdit: () => void
  /** TUI SwapUp — move the row one slot earlier. */
  moveUp: (index: number) => void
  /** TUI SwapDown — move the row one slot later. */
  moveDown: (index: number) => void
}

export const usePromptQueue = create<PromptQueueState>((set, get) => ({
  queue: [],
  sending: false,
  editIndex: null,
  editDraft: '',
  enqueue: (item) =>
    set((s) => ({
      queue: [...s.queue, { ...item, id: qid(), ts: Date.now() }],
    })),
  dequeue: () => {
    const head = get().queue[0]
    if (!head) return undefined
    set((s) => ({
      queue: s.queue.slice(1),
      // The edited row was the head — leave edit mode; otherwise shift.
      editIndex:
        s.editIndex == null
          ? null
          : s.editIndex === 0
            ? null
            : s.editIndex - 1,
      editDraft: s.editIndex === 0 ? '' : s.editDraft,
    }))
    return head
  },
  removeAt: (id) =>
    set((s) => {
      const idx = s.queue.findIndex((q) => q.id === id)
      if (idx === -1) return s
      const queue = s.queue.filter((q) => q.id !== id)
      let editIndex = s.editIndex
      if (editIndex != null) {
        if (idx === editIndex) editIndex = null // deleted the edited row
        else if (idx < editIndex) editIndex -= 1
        if (editIndex != null && editIndex >= queue.length) editIndex = null
      }
      return {
        queue,
        editIndex,
        editDraft: editIndex == null ? '' : s.editDraft,
      }
    }),
  clear: () => set({ queue: [], editIndex: null, editDraft: '' }),
  setSending: (v) => set({ sending: v }),
  startEdit: (index) => {
    const item = get().queue[index]
    if (!item) return
    set({ editIndex: index, editDraft: item.text })
  },
  setEditDraft: (text) => set({ editDraft: text }),
  saveEdit: () => {
    const { editIndex, editDraft } = get()
    if (editIndex == null) return
    const text = editDraft.trim()
    if (!text) {
      // TUI: an empty edit keeps the original row text — a queued prompt
      // must never be blanked by Save (queue_edit.rs).
      set({ editIndex: null, editDraft: '' })
      return
    }
    set((s) => ({
      editIndex: null,
      editDraft: '',
      queue: s.queue.map((q, i) =>
        i === editIndex
          ? {
              ...q,
              text,
              // Rebuild the text block; image blocks ride along.
              blocks: [{ type: 'text', text }, ...q.blocks.slice(1)],
            }
          : q,
      ),
    }))
  },
  cancelEdit: () => set({ editIndex: null, editDraft: '' }),
  moveUp: (index) =>
    set((s) => {
      if (index <= 0 || index >= s.queue.length) return s
      const next = [...s.queue]
      ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
      return { queue: next }
    }),
  moveDown: (index) =>
    set((s) => {
      if (index < 0 || index >= s.queue.length - 1) return s
      const next = [...s.queue]
      ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
      return { queue: next }
    }),
}))
