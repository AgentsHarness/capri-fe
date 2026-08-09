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
 * Enter can never race the auto-send into a double prompt. [发送现在]
 * follows TUI send-now semantics: a running turn is cancelled first
 * (the host rejects prompts mid-turn with 409), then the head is sent.
 *
 * Queue-panel row operations (TUI queue.rs / queue_edit.rs):
 *   - `e` / Enter / double-click enters edit mode for a row; the row
 *     becomes a textarea (Enter saves, Esc cancels, Shift+Enter newline)
 *   - `x` deletes a row
 *   - Shift+K / Shift+J (TUI SwapUp / SwapDown) reorder rows
 *
 * ── Session scoping ─────────────────────────────────────────────────
 * The queue is PER-SESSION prompt-widget state (never global): the store
 * keeps a per-session stash (`queues` map) and the active session's
 * queue in `queue`; chat.ts calls switchSession() on every sessionId
 * change (stash the live queue under its session, restore the target
 * session's). Drain paths additionally refuse to send when the tag no
 * longer matches the active session — a queued prompt must never be
 * delivered into a different session, and it stays visible (and sends)
 * in its own session even after switching away and back (no host
 * broadcast dependency).
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

/** Max sessions kept in the per-session queue stash (oldest dropped). */
const QUEUE_SESSIONS_MAX = 50

/** Best-effort host sync: failures never surface (fire-and-forget). */
function syncQueue(fn: () => Promise<unknown>): void {
  void fn().catch(() => {
    /* 本地队列保持权威 — host 同步失败不影响本地行为 */
  })
}

type PromptQueueState = {
  /**
   * Per-session queue storage (sessionId → its queued prompts). Written
   * whenever the active session changes (switchSession) and read to
   * restore a session's queue when it becomes active again — the queue
   * follows its session WITHOUT depending on host queue_changed
   * broadcasts (not guaranteed on session load). Bounded by
   * QUEUE_SESSIONS_MAX.
   */
  queues: Record<string, QueuedPrompt[]>
  /** The active session's queue — what the queue panel shows and drains. */
  queue: QueuedPrompt[]
  /**
   * Session the active queue belongs to — kept in sync with the chat
   * store's sessionId at enqueue / snapshot / switchSession. Drain paths
   * refuse to send when it no longer matches the active session, so a
   * queued prompt can never be delivered into a different session (TUI
   * parity: the queue is per-session prompt-widget state, never global).
   */
  sessionId?: string
  /** True while a queued prompt is being sent (guards auto-send races). */
  sending: boolean
  /**
   * Ids that left the LOCAL queue for sending / deletion (dequeue /
   * removeAt / clear). A stale `queue_changed` broadcast — the agent-side
   * queue/remove hasn't landed yet — must never resurrect them;
   * applyQueueChanged drops these rows (TUI retire_optimistic_echo parity:
   * once a row is gone it never reappears in a later broadcast).
   */
  drainedIds: Set<string>
  /**
   * Queue-panel edit mode (TUI PromptMode::EditingQueued): index of the
   * row being edited. The row renders as a textarea; Enter saves, Esc
   * cancels, Shift+Enter inserts a newline.
   */
  editIndex: number | null
  /** Live draft text of the row being edited. */
  editDraft: string
  enqueue: (item: Omit<QueuedPrompt, 'id' | 'ts'>, sessionId: string) => void
  /** Remove and return the head; undefined when empty. */
  dequeue: () => QueuedPrompt | undefined
  /**
   * Pop the head of a SPECIFIC session's stash queue (background queue
   * delivery for a non-active session whose turn just ended). Mirrors
   * dequeue's drainedIds semantics; syncs queue/remove to the host.
   */
  dequeueFrom: (sessionId: string) => QueuedPrompt | undefined
  /** Put an item back at the front of a session's stash (send rejected). */
  requeueFront: (sessionId: string, item: QueuedPrompt) => void
  removeAt: (id: string) => void
  clear: () => void
  /**
   * Swap the active queue to `next`'s session: stash the live queue
   * under the session it belongs to (refreshing that map entry — the
   * active session's entry is always rewritten here, so it can never go
   * stale), then restore the target session's queue (empty when
   * unknown). Idempotent: the save runs before the load, so switching to
   * the session already active is a no-op. Called by chat.ts on every
   * sessionId change (subscription) and explicitly at the top of
   * continueSession so the swap happens before any async work.
   */
  switchSession: (next?: string) => void
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
  queues: {},
  queue: [],
  sending: false,
  drainedIds: new Set(),
  editIndex: null,
  editDraft: '',
  enqueue: (item, sessionId) => {
    const entry: QueuedPrompt = { ...item, id: qid(), ts: Date.now() }
    set((s) => ({ queue: [...s.queue, entry], sessionId }))
    // 新增 → x.ai/queue/interject（向 agent 队列插入新条目）。带会话标
    // 签：host 按 active 会话落地，切换竞态下不带标签会插错队列。
    syncQueue(() =>
      transport.queueInterject({ id: entry.id, newText: entry.text }, sessionId),
    )
  },
  dequeue: () => {
    const head = get().queue[0]
    if (!head) return undefined
    set((s) => ({
      queue: s.queue.slice(1),
      // 出队（发送）即永别：后续广播不得复活该行。
      drainedIds: new Set(s.drainedIds).add(head.id),
      // The edited row was the head — leave edit mode; otherwise shift.
      editIndex:
        s.editIndex == null
          ? null
          : s.editIndex === 0
            ? null
            : s.editIndex - 1,
      editDraft: s.editIndex === 0 ? '' : s.editDraft,
    }))
    // 队首出队（发送）→ 从 agent 队列移除同一条目。带会话标签，防止
    // 切换竞态下 host 把删除落到新会话的队列。
    const sid = get().sessionId
    syncQueue(() => transport.queueRemove({ id: head.id }, sid))
    return head
  },
  dequeueFrom: (sessionId) => {
    const s = get()
    const list = s.queues[sessionId]
    if (!list || list.length === 0) return undefined
    const [head, ...rest] = list
    set({
      queues: { ...s.queues, [sessionId]: rest },
      // Defensive: keep the ACTIVE queue in sync if the target session
      // happens to be active (the background path only targets others).
      queue: s.sessionId === sessionId ? rest : s.queue,
      drainedIds: new Set(s.drainedIds).add(head.id),
    })
    syncQueue(() => transport.queueRemove({ id: head.id }, sessionId))
    return head
  },
  requeueFront: (sessionId, item) => {
    set((s) => {
      const list = s.queues[sessionId] ?? []
      const drainedIds = new Set(s.drainedIds)
      drainedIds.delete(item.id)
      return {
        queues: { ...s.queues, [sessionId]: [item, ...list] },
        queue: s.sessionId === sessionId ? [item, ...s.queue] : s.queue,
        drainedIds,
      }
    })
  },
  removeAt: (id) => {
    const s = get()
    // 被删的正是编辑中的行：编辑锁须随行释放（清 editIndex 前先留证）。
    const editedId =
      s.editIndex != null && s.queue[s.editIndex]?.id === id
        ? s.queue[s.editIndex]?.id
        : undefined
    set((st) => {
      const idx = st.queue.findIndex((q) => q.id === id)
      if (idx === -1) return st
      const queue = st.queue.filter((q) => q.id !== id)
      let editIndex = st.editIndex
      if (editIndex != null) {
        if (idx === editIndex) editIndex = null // deleted the edited row
        else if (idx < editIndex) editIndex -= 1
        if (editIndex != null && editIndex >= queue.length) editIndex = null
      }
      return {
        queue,
        // 删除即永别：后续广播不得复活该行。
        drainedIds: new Set(st.drainedIds).add(id),
        editIndex,
        editDraft: editIndex == null ? '' : st.editDraft,
      }
    })
    // 编辑中的行被删除：释放它的编辑锁（TUI combine-hold 语义），否则
    // host 侧队列保持组合、后续新条目被合并。
    if (editedId) {
      syncQueue(() => transport.queueReleaseEdit({ id: editedId }, s.sessionId))
    }
    syncQueue(() => transport.queueRemove({ id }, s.sessionId))
  },
  clear: () => {
    const s = get()
    // 清空前留证：队列清空时若编辑锁在飞，须一并释放。
    const editedId = s.editIndex != null ? s.queue[s.editIndex]?.id : undefined
    set((st) => ({
      queue: [],
      editIndex: null,
      editDraft: '',
      // Keep the session tag: the departure-time stash in switchSession
      // refreshes this session's map entry with the emptied queue, so a
      // cleared queue must not resurrect from the stale stash.
      sessionId: st.sessionId,
      drainedIds: new Set([...st.drainedIds, ...st.queue.map((q) => q.id)]),
    }))
    // 清空时编辑锁在飞 → 释放，防止 host 侧队列永久保持组合。
    if (editedId) {
      syncQueue(() => transport.queueReleaseEdit({ id: editedId }, s.sessionId))
    }
    syncQueue(() => transport.queueClear(s.sessionId))
  },
  switchSession: (next) => {
    const s = get()
    // 编辑中的行随会话切换被丢弃（editIndex 清空）→ 释放它的编辑锁
    // （TUI combine-hold 语义），否则切走的会话队列在 host 侧永远
    // 保持组合。锁属于离开的会话（s.sessionId）。
    const editedId = s.editIndex != null ? s.queue[s.editIndex]?.id : undefined
    // Stash the live queue under the session it belongs to, then restore
    // the target session's queue (empty when unknown). Save-then-load
    // keeps the call idempotent when next === s.sessionId.
    const queues: Record<string, QueuedPrompt[]> = { ...s.queues }
    if (s.sessionId) queues[s.sessionId] = s.queue
    const queue = next ? queues[next] ?? [] : []
    // Bounded storage: drop the oldest sessions beyond the cap.
    const keys = Object.keys(queues)
    if (keys.length > QUEUE_SESSIONS_MAX) {
      for (const k of keys.slice(0, keys.length - QUEUE_SESSIONS_MAX)) {
        delete queues[k]
      }
    }
    if (editedId) {
      syncQueue(() => transport.queueReleaseEdit({ id: editedId }, s.sessionId))
    }
    set({
      queues,
      queue,
      sessionId: next,
      editIndex: null,
      editDraft: '',
      sending: false,
    })
  },
  setSending: (v) => set({ sending: v }),
  startEdit: (index) => {
    const item = get().queue[index]
    if (!item) return
    set({ editIndex: index, editDraft: item.text })
    // 编辑锁（TUI combine-hold 语义）：agent 在编辑期间保持队列组合。
    syncQueue(() => transport.queueHoldEdit({ id: item.id }, get().sessionId))
  },
  setEditDraft: (text) => set({ editDraft: text }),
  saveEdit: () => {
    const { editIndex, editDraft } = get()
    if (editIndex == null) return
    const id = get().queue[editIndex]?.id
    const sid = get().sessionId
    const text = editDraft.trim()
    if (!text) {
      // TUI: an empty edit keeps the original row text — a queued prompt
      // must never be blanked by Save (queue_edit.rs).
      set({ editIndex: null, editDraft: '' })
      if (id) syncQueue(() => transport.queueReleaseEdit({ id }, sid))
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
      syncQueue(() => transport.queueEdit({ id, newText: text }, sid))
      syncQueue(() => transport.queueReleaseEdit({ id }, sid))
    }
  },
  cancelEdit: () => {
    const s = get()
    const id = s.queue[s.editIndex ?? -1]?.id
    set({ editIndex: null, editDraft: '' })
    if (id) syncQueue(() => transport.queueReleaseEdit({ id }, s.sessionId))
  },
  moveUp: (index) => {
    const s = get()
    if (index <= 0 || index >= s.queue.length) return
    const next = [...s.queue]
    ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
    set({ queue: next })
    syncQueue(() => transport.queueReorder({ ids: next.map((q) => q.id) }, s.sessionId))
  },
  moveDown: (index) => {
    const s = get()
    if (index < 0 || index >= s.queue.length - 1) return
    const next = [...s.queue]
    ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
    set({ queue: next })
    syncQueue(() => transport.queueReorder({ ids: next.map((q) => q.id) }, s.sessionId))
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
 * survives only while the edited row still exists. `sessionId` (the
 * broadcast's emitting session — chat.ts only forwards broadcasts of the
 * active session) tags the queue so drains stay session-scoped.
 */
export function applyQueueChanged(params: unknown, sessionId?: string): boolean {
  const list = findQueueArray(params)
  if (!list) return false
  const { queue: prev, drainedIds } = usePromptQueue.getState()
  const byId = new Map(prev.map((q) => [q.id, q]))
  const queue: QueuedPrompt[] = []
  // 解析成功（id+text 齐全）的行数——区分「广播里没有可解析行」与
  // 「行都合法但已被 drainedIds 过滤」，前者才判定为形状不符。
  let parsed = 0
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
    parsed++
    // 已出队/已删除的行：stale 广播不得复活它们。
    if (drainedIds.has(id)) continue
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
  // A non-empty array with no parseable row → not our shape.
  if (parsed === 0 && list.length > 0) return false
  usePromptQueue.setState((s) => {
    const tagged = sessionId ? { sessionId } : {}
    if (s.editIndex != null) {
      const editedId = s.queue[s.editIndex]?.id
      if (editedId != null && !queue.some((q) => q.id === editedId)) {
        return { queue, editIndex: null, editDraft: '', ...tagged }
      }
    }
    return { queue, ...tagged }
  })
  return true
}
