import { create } from 'zustand'
import type { ContentBlock } from '../api/types'
import { transport } from '../api/localTransport'

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
 *
 * ── Host sync layer (x.ai/queue/*, host /api/queue/*) ────────────────
 * Every local mutation (enqueue / edit / remove / clear / reorder /
 * interject) is mirrored to the host as a FIRE-AND-FORGET notification
 * (host answers {ok:true} immediately, no result). Sync failures degrade
 * to local-only behavior — they never block or roll back the mutation.
 * The agent's authoritative queue state comes back via the
 * `queue_changed` SSE broadcast (x.ai/queue/changed) — chat.ts routes it
 * to applyQueueChanged() below, which replaces the local queue with the
 * server snapshot (defensive parse; ignored when the payload does not
 * carry a recognizable `queue` array).
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

/** Best-effort host sync: failures never surface (fire-and-forget). */
function syncQueue(fn: () => Promise<unknown>): void {
  void fn().catch(() => {
    /* 本地队列保持权威 — host 同步失败不影响本地行为 */
  })
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
  enqueue: (item) => {
    const entry: QueuedPrompt = { ...item, id: qid(), ts: Date.now() }
    set((s) => ({ queue: [...s.queue, entry] }))
    // 新增 → x.ai/queue/interject（向 agent 队列插入新条目）。
    syncQueue(() => transport.queueInterject({ id: entry.id, newText: entry.text }))
  },
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
    // 队首出队（发送）→ 从 agent 队列移除同一条目。
    syncQueue(() => transport.queueRemove({ id: head.id }))
    return head
  },
  removeAt: (id) => {
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
    })
    syncQueue(() => transport.queueRemove({ id }))
  },
  clear: () => {
    set({ queue: [], editIndex: null, editDraft: '' })
    syncQueue(() => transport.queueClear())
  },
  setSending: (v) => set({ sending: v }),
  startEdit: (index) => {
    const item = get().queue[index]
    if (!item) return
    set({ editIndex: index, editDraft: item.text })
    // 编辑锁（TUI combine-hold 语义）：agent 在编辑期间保持队列组合。
    syncQueue(() => transport.queueHoldEdit({ id: item.id }))
  },
  setEditDraft: (text) => set({ editDraft: text }),
  saveEdit: () => {
    const { editIndex, editDraft } = get()
    if (editIndex == null) return
    const id = get().queue[editIndex]?.id
    const text = editDraft.trim()
    if (!text) {
      // TUI: an empty edit keeps the original row text — a queued prompt
      // must never be blanked by Save (queue_edit.rs).
      set({ editIndex: null, editDraft: '' })
      if (id) syncQueue(() => transport.queueReleaseEdit({ id }))
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
    if (id) {
      syncQueue(() => transport.queueEdit({ id, newText: text }))
      syncQueue(() => transport.queueReleaseEdit({ id }))
    }
  },
  cancelEdit: () => {
    const id = get().queue[get().editIndex ?? -1]?.id
    set({ editIndex: null, editDraft: '' })
    if (id) syncQueue(() => transport.queueReleaseEdit({ id }))
  },
  moveUp: (index) => {
    const s = get()
    if (index <= 0 || index >= s.queue.length) return
    const next = [...s.queue]
    ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
    set({ queue: next })
    syncQueue(() => transport.queueReorder({ ids: next.map((q) => q.id) }))
  },
  moveDown: (index) => {
    const s = get()
    if (index < 0 || index >= s.queue.length - 1) return
    const next = [...s.queue]
    ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
    set({ queue: next })
    syncQueue(() => transport.queueReorder({ ids: next.map((q) => q.id) }))
  },
}))

/**
 * Depth-first search for a `queue: unknown[]` field in the queue_changed
 * params (walks `result` / `data` / `payload` envelopes — the params
 * shape is not part of any contract and varies by agent version).
 */
function findQueueArray(root: unknown): unknown[] | null {
  const seen = new Set<unknown>()
  const walk = (v: unknown, depth: number): unknown[] | null => {
    if (v == null || depth > 5) return null
    if (typeof v !== 'object' || Array.isArray(v)) return null
    if (seen.has(v)) return null
    seen.add(v)
    const o = v as Record<string, unknown>
    if (Array.isArray(o.queue)) return o.queue
    for (const k of ['result', 'data', 'payload']) {
      const found = walk(o[k], depth + 1)
      if (found) return found
    }
    return null
  }
  return walk(root, 0)
}

/**
 * Apply the agent's authoritative queue snapshot from a `queue_changed`
 * broadcast (chat.ts routes the typed event — and the ext_notification
 * fallback — here). Defensive parse: the params shape is unknown; when no
 * recognizable `queue` array is found the local queue is left untouched
 * (returns false). When parsed, the local queue is REPLACED — ids from
 * the server become authoritative; existing entries keep their image
 * blocks (matched by id), new entries get text-only blocks. Edit state
 * survives only while the edited row still exists.
 */
export function applyQueueChanged(params: unknown): boolean {
  const list = findQueueArray(params)
  if (!list) return false
  const prev = usePromptQueue.getState().queue
  const byId = new Map(prev.map((q) => [q.id, q]))
  const queue: QueuedPrompt[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const o = raw as Record<string, unknown>
    const id =
      (typeof o.id === 'string' && o.id) ||
      (typeof o.queue_id === 'string' && o.queue_id) ||
      ''
    if (!id) continue
    const text =
      (typeof o.text === 'string' && o.text) ||
      (typeof o.content === 'string' && o.content) ||
      (typeof o.prompt === 'string' && o.prompt) ||
      ''
    if (!text) continue
    const existing = byId.get(id)
    queue.push(
      existing
        ? {
            ...existing,
            text,
            blocks: [{ type: 'text', text }, ...existing.blocks.slice(1)],
          }
        : {
            id,
            text,
            blocks: [{ type: 'text', text }],
            ts:
              (typeof o.ts === 'number' && o.ts) ||
              (typeof o.created_at === 'number' && o.created_at) ||
              (typeof o.createdAt === 'number' && o.createdAt) ||
              Date.now(),
          },
    )
  }
  // A non-empty array whose rows are all unparseable → not our shape.
  if (queue.length === 0 && list.length > 0) return false
  usePromptQueue.setState((s) => {
    if (s.editIndex != null) {
      const editedId = s.queue[s.editIndex]?.id
      if (editedId != null && !queue.some((q) => q.id === editedId)) {
        return { queue, editIndex: null, editDraft: '' }
      }
    }
    return { queue }
  })
  return true
}
