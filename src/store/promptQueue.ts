import { create } from 'zustand'
import type { ContentBlock } from '../api/types'
import { transport, AgentTurnError } from '../api/localTransport'

/**
 * ── Server-authoritative prompt queue (TUI 对齐：agent 是权威) ───────
 * 本地 `queue` 只是"显示镜像"：真正的队列住在 agent 的 pending_inputs
 * （x.ai/queue/changed 广播 = 权威快照）。行为与 Grok Build TUI 一致：
 *
 * 1. 回合运行中 Enter（纯文本/图片）→ enqueue 立即发 session/prompt RPC
 *    （`_meta.promptId` = 本端 mint 的 UUID，fire-and-forget，不 await
 *    回合完成）→ agent 从 promptId 提取 queue_meta 插进权威队列 → 本地
 *    插入乐观回显行（optimistic: true）→ 广播确认后去掉 optimistic 并
 *    补 version。
 * 2. 回合结束 → agent 自动 pop 队首开下一回合 → 广播带 running_prompt_id
 *    → applyQueueChanged 收养：渲染用户行、从镜像移除、conn 进 busy
 *    （chat.ts adoptTurn；FE 不再自己发队首）。
 * 3. 队列行 send-now（[发送现在]/双 Enter）→ x.ai/queue/interject
 *    {id, expectedVersion}（version 取自广播副本）→ agent 版本校验后
 *    提升为下一个运行（不取消回合；版本不符是 no-op 并重广播）。
 *    仅当本地行没有 version（乐观回显未确认 / 409 降级）时保留
 *    cancel-then-send 兜底（Composer.sendQueuedHead）。
 * 4. 降级（旧 host / 竞态 409）：mid-turn prompt 被 409 拒绝 → 行标记
 *    degraded（FE-owned），回合结束时由 FE 自动发送（旧流程兜底），
 *    新 host 下仍正常工作。
 *
 * `sending` 是互斥锁：自动发送 effect 与用户手势（双 Enter / [发送现在]）
 * 共享同一条 drain 路径，Enter 永远不会与自动发送竞态出双 prompt。
 *
 * 队列面板行操作（TUI queue.rs / queue_edit.rs）：
 *   - `e` / Enter / 双击进入行编辑；Enter 保存，Esc 取消，Shift+Enter 换行
 *   - `x` 删除行
 *   - Shift+K / Shift+J（TUI SwapUp / SwapDown）重排行
 * 行编辑/删除/重排/清空在本地同步的同时通知 host（queueEdit/queueRemove/
 * queueReorder/queueClear）——行 id 与 agent queue_meta.id 一致（都是
 * promptId），所以这些通知现在对 agent 侧队列真实生效。
 *
 * ── Session scoping ─────────────────────────────────────────────────
 * 队列是 PER-SESSION 的 prompt-widget 状态（永远不全局）：store 维护
 * per-session stash（`queues` map），活跃会话的队列在 `queue`；chat.ts
 * 在每次 sessionId 变化时调 switchSession()（当前会话队列入 stash、
 * 目标会话队列恢复）。drain 路径在会话标签不匹配活跃会话时拒绝发送——
 * 排队的 prompt 绝不会被投递进别的会话；切走再切回后它仍可见
 * （广播只应用到活跃会话，stash 靠 switchSession 存取）。
 *
 * ── 广播 rails（chat.ts 路由）──────────────────────────────────────
 * x.ai/queue/changed 以 typed `queue_changed` 事件或 ext_notification
 * 兜底到达，统一进 applyQueueChanged()：防御性解析（envelope 走查 +
 * 多键名兼容），解析成功即用权威快照替换本地镜像。drainedIds 只防
 * "已发送/已删除"行的 stale 广播复活（TUI retire_optimistic_echo 语义）。
 */

export type QueuedPrompt = {
  id: string
  /** Display text (paste chips expanded; `[Image: …]` labels retained). */
  text: string
  /** Full prompt blocks — text block first, image blocks in chip order. */
  blocks: ContentBlock[]
  /** Enqueue time (epoch ms). */
  ts: number
  /**
   * Agent 权威版本（来自广播条目 `version`）——有 version 的行才能走
   * send-now interject（版本校验）。乐观回显行在被广播确认前没有。
   */
  version?: number
  /**
   * 乐观回显：prompt RPC 已发出、等待 agent 广播确认。该行 agent-owned
   * （已在/将在权威队列里）——FE 不得自行发送，等收养广播。
   */
  optimistic?: boolean
  /**
   * 409 降级（旧 host 拒绝 mid-turn prompt，或竞态）：agent 侧没有该行，
   * FE-owned——回合结束时由 FE 自动发送（旧流程兜底）。
   */
  degraded?: boolean
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
    /* 本地队列保持显示 —— host 同步失败不影响本地行为（广播会校正） */
  })
}

/**
 * 409 判定（降级触发条件）：AgentTurnError 的 status 字段（新代码）
 * 或错误文本兜底（老 host 的 409 文案 "上一条消息还在处理中"）。
 */
function isConflictError(e: unknown): boolean {
  return (
    e instanceof AgentTurnError &&
    (e.status === 409 ||
      (typeof e.message === 'string' &&
        (e.message.includes('409') || e.message.includes('上一条消息还在处理中'))))
  )
}

/**
 * 结算一条在途 prompt 的 RPC 结果（enqueue 的 fire-and-forget 链）：
 * - `ran`：RPC 在回合完成时 resolve = 该 prompt 已经作为回合跑完——
 *   从显示镜像移除（正常流程收养广播先移除；这里是漏广播兜底），并记
 *   入 drainedIds 防 stale 广播复活。
 * - `degraded`：RPC 被拒（409 = 旧 host；其它错误同样降级保留，避免
 *   静默丢失用户意图）——行标记 degraded，回合结束时由 FE 自动发送。
 * 行可能在活跃队列或 stash（RPC 在飞期间会话被切走）。
 */
function settlePromptRow(
  promptId: string,
  sessionId: string,
  outcome: 'ran' | 'degraded',
): void {
  usePromptQueue.setState((s) => {
    const active = s.sessionId === sessionId
    const list = active ? s.queue : s.queues[sessionId]
    if (!list) return s
    const idx = list.findIndex((q) => q.id === promptId)
    if (idx === -1) return s
    if (outcome === 'ran') {
      const nextList = list.filter((q) => q.id !== promptId)
      return {
        ...(active
          ? { queue: nextList }
          : { queues: { ...s.queues, [sessionId]: nextList } }),
        drainedIds: new Set(s.drainedIds).add(promptId),
      }
    }
    const nextList = list.map((q) =>
      q.id === promptId ? { ...q, optimistic: false, degraded: true } : q,
    )
    return {
      ...(active
        ? { queue: nextList }
        : { queues: { ...s.queues, [sessionId]: nextList } }),
    }
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
   * removeAt / clear / RPC-resolved). A stale `queue_changed` broadcast
   * must never resurrect them; applyQueueChanged drops these rows (TUI
   * retire_optimistic_echo parity: once a row is gone it never reappears
   * in a later broadcast).
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
  /**
   * Server-authoritative enqueue: 立即 fire-and-forget 发 session/prompt
   * （`_meta.promptId` = 行 id）→ agent 把它插进权威队列；本地插入乐观
   * 回显行。409（旧 host）→ 行降级为 FE-owned（回合结束自动发送）；
   * 其它错误 → 行同样降级保留 + onError 渲染错误行。不再向 host 镜像
   * queueInterject——prompt RPC 本身就是入队。
   */
  enqueue: (
    item: Omit<QueuedPrompt, 'id' | 'ts' | 'version' | 'optimistic' | 'degraded'>,
    sessionId: string,
    opts?: { onError?: (e: unknown) => void },
  ) => void
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
  enqueue: (item, sessionId, opts) => {
    const promptId = qid()
    const entry: QueuedPrompt = {
      ...item,
      id: promptId,
      ts: Date.now(),
      optimistic: true,
    }
    set((s) => ({ queue: [...s.queue, entry], sessionId }))
    // Server-authoritative: prompt RPC 本身就是入队（agent 从
    // `_meta.promptId` 提取 queue_meta 插进 pending_inputs；busy 排队、
    // idle 直接运行）。fire-and-forget：不 await 回合完成——RPC 在回合
    // 完成时才 resolve，这里只关心 reject（降级）与 resolve（跑完了，
    // 清理镜像）。广播（queue_changed）负责确认与收养。
    void transport
      .prompt(item.blocks, { sessionId, promptId })
      .then(
        () => settlePromptRow(promptId, sessionId, 'ran'),
        (e: unknown) => {
          if (isConflictError(e)) {
            // 旧 host / 竞态：mid-turn prompt 被拒 → 回退本地排队，
            // 回合结束时由 FE 自动发送（旧流程仍工作）。
            settlePromptRow(promptId, sessionId, 'degraded')
          } else {
            // 其它错误（网络失败 / agent 拒绝）→ 行降级保留（不丢用户
            // 意图，回合结束重试）+ 调用方渲染错误行。
            settlePromptRow(promptId, sessionId, 'degraded')
            opts?.onError?.(e)
          }
        },
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
    // 队首出队（FE-owned 行发送 / 取消+重发兜底）→ 从 agent 队列移除同
    // 一条目（行 id = promptId = queue_meta.id，agent 侧可匹配；未知 id
    // 是 no-op）。带会话标签，防止切换竞态下 host 把删除落到新会话。
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

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Depth-first search for a `queue: unknown[]` field in the queue_changed
 * params (walks `result` / `data` / `payload` envelopes — the params
 * shape is not part of any contract and varies by agent version).
 * 新 agent 广播（QueueChanged wire）用 `entries`，旧形状用 `queue`，
 * 再兜底 `items`。
 */
function findQueueArray(root: unknown): unknown[] | null {
  const seen = new Set<unknown>()
  const walk = (v: unknown, depth: number): unknown[] | null => {
    if (v == null || depth > 5) return null
    if (typeof v !== 'object' || Array.isArray(v)) return null
    if (seen.has(v)) return null
    seen.add(v)
    const o = v as Record<string, unknown>
    if (Array.isArray(o.entries)) return o.entries
    if (Array.isArray(o.queue)) return o.queue
    if (Array.isArray(o.items)) return o.items
    for (const k of ['result', 'data', 'payload']) {
      const found = walk(o[k], depth + 1)
      if (found) return found
    }
    return null
  }
  return walk(root, 0)
}

/**
 * 在广播 params 中找 `running_prompt_id`（新 agent：QueueChanged wire
 * 顶层 `runningPromptId`，camelCase；旧形状/信封走查兜底 snake_case
 * `running_prompt_id` / `runningId`）。与 findQueueArray 同款 envelope
 * 走查（result/data/payload/params）。
 */
function findRunningPromptId(root: unknown): string | undefined {
  const seen = new Set<unknown>()
  const walk = (v: unknown, depth: number): string | undefined => {
    if (v == null || depth > 5) return undefined
    if (typeof v !== 'object' || Array.isArray(v)) return undefined
    if (seen.has(v)) return undefined
    seen.add(v)
    const o = v as Record<string, unknown>
    for (const k of ['runningPromptId', 'running_prompt_id', 'runningId', 'running_prompt']) {
      const val = o[k]
      if (typeof val === 'string' && val) return val
    }
    for (const k of ['result', 'data', 'payload', 'params']) {
      const found = walk(o[k], depth + 1)
      if (found) return found
    }
    return undefined
  }
  return walk(root, 0)
}

/**
 * QueueChanged wire 的 `runningText`（camelCase；snake_case 兜底）——
 * 运行中行不在 entries 里，客户端用它做 turn-start 用户行 / 乐观行 text
 * 对齐。与 findRunningPromptId 同款 envelope 走查。
 */
function findRunningText(root: unknown): string | undefined {
  const seen = new Set<unknown>()
  const walk = (v: unknown, depth: number): string | undefined => {
    if (v == null || depth > 5) return undefined
    if (typeof v !== 'object' || Array.isArray(v)) return undefined
    if (seen.has(v)) return undefined
    seen.add(v)
    const o = v as Record<string, unknown>
    for (const k of ['runningText', 'running_text']) {
      const val = o[k]
      if (typeof val === 'string' && val) return val
    }
    for (const k of ['result', 'data', 'payload', 'params']) {
      const found = walk(o[k], depth + 1)
      if (found) return found
    }
    return undefined
  }
  return walk(root, 0)
}

/**
 * 收养结果：广播的 running_prompt_id 命中本地镜像中的某行 —— agent 已
 * 把该 prompt pop 进 running 槽位。chat.ts 据此渲染用户行（不再自己发
 * prompt），镜像行由 applyQueueChanged 移除。
 */
export type QueueAdoption = {
  id: string
  text: string
  blocks: ContentBlock[]
  /** 被收养行此前仍是乐观回显（未确认）。 */
  fromOptimistic: boolean
}

/**
 * Apply the agent's authoritative queue snapshot from a `queue_changed`
 * broadcast (chat.ts routes the typed event — and the ext_notification
 * fallback — here). Defensive parse: the params shape is unknown; when no
 * recognizable `queue` array is found the snapshot is skipped (returns
 * null). When parsed, the local queue is REPLACED — ids from the server
 * become authoritative; existing entries keep their image blocks (matched
 * by id), new entries get text-only blocks. Optimistic echo rows are
 * confirmed by the snapshot (optimistic cleared, version kept from the
 * broadcast). Id 未命中时按 text 认领乐观/降级行（host 丢 meta.promptId
 * 时 agent 自造 id 的兜底，避免镜像重复两条）。仍无对上的在途行才
 * re-append（旧 host 409：agent 从没见过）。Edit state survives only while
 * the edited row still exists. `sessionId` (the broadcast's emitting
 * session — chat.ts only forwards broadcasts of the active session) tags
 * the queue so drains stay session-scoped.
 *
 * Returns a QueueAdoption when the broadcast carries a `running_prompt_id`
 * that matched a local queue row (the row is removed from the mirror) —
 * chat.ts renders the adopted turn's user row; otherwise null.
 */
export function applyQueueChanged(
  params: unknown,
  sessionId?: string,
): QueueAdoption | null {
  const { queue: prev, drainedIds } = usePromptQueue.getState()
  const runningId = findRunningPromptId(params)
  const list = findQueueArray(params)
  // 既没有可识别的快照数组、也没有 running 标记 → 不是我们的形状。
  if (!list && !runningId) return null
  const byId = new Map(prev.map((q) => [q.id, q]))
  // 可按 text 对齐的在途行：id 对不上时（host 丢了 meta.promptId、agent
  // 自造 id）用全文匹配把乐观/降级行并进权威 id，避免「广播一条 + 本地
  // 乐观一条」重复两条。每个本地行最多被认领一次。
  const adoptableByText = prev.filter((q) => q.optimistic || q.degraded)
  const claimedLocalIds = new Set<string>()
  const built: QueuedPrompt[] = []
  // 解析成功（id+text 齐全）的行数——区分「广播里没有可解析行」与
  // 「行都合法但已被 drainedIds 过滤」，前者才判定为形状不符。
  let parsed = 0
  if (list) {
    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const o = raw as Record<string, unknown>
      const id = str(o.id) || str(o.queue_id) || ''
      if (!id) continue
      const text = str(o.text) || str(o.content) || str(o.prompt) || ''
      if (!text) continue
      parsed++
      // 已出队/已删除的行：stale 广播不得复活它们。
      if (drainedIds.has(id)) continue
      // 正在运行的行（防御：某些 agent 版本把 running 行留在 entries
      // 里）——收养逻辑会处理它，不留在镜像队列。
      if (runningId && id === runningId) continue
      const version =
        num(o.version) ?? num(o.queue_version) ?? num(o.queueVersion) ?? num(o.v)
      let existing = byId.get(id)
      if (!existing) {
        // id 未命中：按 text 认领一条尚未占用的乐观/降级行（见上方注释）。
        const hit = adoptableByText.find(
          (q) => !claimedLocalIds.has(q.id) && q.text === text,
        )
        if (hit) {
          existing = hit
          claimedLocalIds.add(hit.id)
        }
      } else if (existing.optimistic || existing.degraded) {
        claimedLocalIds.add(existing.id)
      }
      built.push(
        existing
          ? {
              ...existing,
              // 权威 id 以 server 为准（text 对齐时本地 id 可能不同）。
              id,
              text,
              blocks: [{ type: 'text', text }, ...existing.blocks.slice(1)],
              // 广播确认：乐观/降级行拿到权威 version，归 agent-owned。
              optimistic: false,
              degraded: false,
              ...(version !== undefined ? { version } : {}),
            }
          : {
              id,
              text,
              blocks: [{ type: 'text', text }],
              ts: num(o.ts) ?? num(o.created_at) ?? num(o.createdAt) ?? Date.now(),
              ...(version !== undefined ? { version } : {}),
            },
      )
    }
  }
  // 快照可应用？（非空数组但无可解析行 = 形状不符 → 跳过快照替换，
  // 收养仍可独立生效。list 为 null = 只有 running 标记的广播 → 同样
  // 不做快照替换，否则空数组会把本地镜像清空。）
  const snapshot: QueuedPrompt[] | null =
    list == null ? null : parsed === 0 && list.length > 0 ? null : built

  // ── 收养：running_prompt_id 命中本地镜像行 ─────────────────────
  let adoption: QueueAdoption | null = null
  if (runningId && !drainedIds.has(runningId)) {
    let row = byId.get(runningId)
    if (!row) {
      // running id 与本地乐观 id 不同时（meta.promptId 丢失）仍按 text
      // 对齐：QueueChanged 带 runningText。
      const runningText = findRunningText(params)
      if (runningText) {
        row = adoptableByText.find(
          (q) => !claimedLocalIds.has(q.id) && q.text === runningText,
        )
      }
    }
    if (row) {
      claimedLocalIds.add(row.id)
      adoption = {
        id: row.id,
        text: row.text,
        blocks: row.blocks,
        fromOptimistic: row.optimistic === true,
      }
    }
  }

  if (snapshot) {
    // 本地在途行（乐观回显 / 降级，FE 侧尚悬而未决）不在快照里 → 保留
    // 显示：agent 从没见过它（旧 host 409 降级），或 RPC 结果会结算它。
    // 已被 text 对齐认领 / drained / 收养的行绝不回挂（防重复两条）。
    const snapIds = new Set(snapshot.map((q) => q.id))
    for (const row of prev) {
      if (
        (row.optimistic || row.degraded) &&
        row.id !== runningId &&
        !snapIds.has(row.id) &&
        !claimedLocalIds.has(row.id) &&
        !drainedIds.has(row.id)
      ) {
        snapshot.push(row)
      }
    }
  }

  usePromptQueue.setState((s) => {
    const tagged = sessionId ? { sessionId } : {}
    if (snapshot) {
      // 编辑中的行按 id 在快照里重定位（快照可能重排行）；行没了 →
      // 释放编辑锁。
      if (s.editIndex != null) {
        const editedId = s.queue[s.editIndex]?.id
        if (editedId != null) {
          const newIdx = snapshot.findIndex((q) => q.id === editedId)
          if (newIdx === -1) {
            return { queue: snapshot, editIndex: null, editDraft: '', ...tagged }
          }
          if (newIdx !== s.editIndex) {
            return { queue: snapshot, editIndex: newIdx, ...tagged }
          }
        }
      }
      return { queue: snapshot, ...tagged }
    }
    // 只有 running 标记、没有快照：至少把收养行从镜像移除（编辑中的
    // 行被收养 → 释放编辑锁）。
    if (adoption) {
      const idx = s.queue.findIndex((q) => q.id === adoption.id)
      if (idx === -1) return s
      let editIndex = s.editIndex
      if (editIndex != null) {
        if (idx === editIndex) editIndex = null
        else if (idx < editIndex) editIndex -= 1
      }
      return {
        queue: s.queue.filter((q) => q.id !== adoption.id),
        editIndex,
        editDraft: editIndex == null ? '' : s.editDraft,
        ...tagged,
      }
    }
    return s
  })
  return adoption
}
