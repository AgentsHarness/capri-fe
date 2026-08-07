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
  enqueue: (item: Omit<QueuedPrompt, 'id' | 'ts'>) => void
  /** Remove and return the head; undefined when empty. */
  dequeue: () => QueuedPrompt | undefined
  removeAt: (id: string) => void
  clear: () => void
  setSending: (v: boolean) => void
}

export const usePromptQueue = create<PromptQueueState>((set, get) => ({
  queue: [],
  sending: false,
  enqueue: (item) =>
    set((s) => ({
      queue: [...s.queue, { ...item, id: qid(), ts: Date.now() }],
    })),
  dequeue: () => {
    const head = get().queue[0]
    if (!head) return undefined
    set((s) => ({ queue: s.queue.slice(1) }))
    return head
  },
  removeAt: (id) =>
    set((s) => ({ queue: s.queue.filter((q) => q.id !== id) })),
  clear: () => set({ queue: [] }),
  setSending: (v) => set({ sending: v }),
}))
