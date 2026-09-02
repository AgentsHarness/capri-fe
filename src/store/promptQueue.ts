import { create } from 'zustand'
import type { ContentBlock } from '../api/types'
import { transport } from '../api/client'
import { pushToast } from './toast'

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
 *    提升为下一个运行；运行中回合 front 已提交时 agent 会取消它、该行
 *    立即开跑（send_now_cancels_running_turn——goal 活跃或 front 未提交
 *    则豁免）；版本不符是 no-op 并重广播。
 *    乐观回显行（无 version）是 agent-owned——FE 只等收养广播，绝不
 *    cancel-then-send（重发会双跑）；仅 RPC 失败降级行（degraded，
 *    agent 从没见过）保留 cancel-then-send 兜底（Composer.sendQueuedItem）。
 * 4. RPC 失败（网络 / agent 拒绝 / 竞态 409）：行标记 degraded
 *    （FE-owned，agent 从未见过），行上渲染红色失败徽标（失败原因作
 *    tooltip）；不再自动重发——由用户手动双 Enter / [发送现在] 投递
 *    （server-authoritative 下 mid-turn prompt 由 agent 排队，失败即
 *    异常，不静默兜底；也不向 scrollback 渲染错误行，主输出流不被打断）。
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
 * 删除/清空与出队是异步竞态：本地立即移除、host 通知随后才到 agent。若
 * agent 已把该行 pop 进 running 槽位，remove 追不上、消息照常开回合——
 * 此时删除登记（deletedRows）让 applyQueueChanged 认出竞态：该行仍收养出
 * 用户行（不留没有用户行的隐形回合），并 toast 告知「删除未生效」（见
 * settleDeletedRunning）。
 *
 * ── Session scoping ─────────────────────────────────────────────────
 * 队列是 PER-SESSION 的 prompt-widget 状态（永远不全局）：store 维护
 * per-session stash（`queues` map），活跃会话的队列在 `queue`；chat.ts
 * 在每次 sessionId 变化时调 switchSession()（当前会话队列入 stash、
 * 目标会话队列恢复）。drain 路径在会话标签不匹配活跃会话时拒绝发送——
 * 排队的 prompt 绝不会被投递进别的会话；切走再切回后它仍可见
 * （切走期间的 queue_changed 广播以 stash 模式喂给该会话的镜像——
 * applyQueueChanged 的 toStash 分支——切回时 stash 即权威快照，
 * agent 已收养开跑的行绝不会仍显示 queued）。
 *
 * ── 广播 rails（chat.ts 路由）──────────────────────────────────────
 * x.ai/queue/changed 以 typed `queue_changed` 事件或 ext_notification
 * 兜底到达，统一进 applyQueueChanged()：防御性解析（envelope 走查 +
 * 多键名兼容），解析成功即用权威快照替换本地镜像。drainedIds 只防
 * "已发送/已删除"行的 stale 广播复活（TUI retire_optimistic_echo 语义）。
 */

export type QueuedPrompt = {
  id: string
  /**
   * Display text. Paste chips are expanded; image-only prompts carry the
   * joined `[Image: …]` labels as a display fallback (the wire blocks
   * hold the real images, never label text).
   */
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
   * RPC 失败（网络 / agent 拒绝 / 竞态 409）：agent 侧没有该行，
   * FE-owned——保留显示供手动重发（双 Enter / [发送现在]），不再自动
   * 投递（legacy 409 自动重发已移除）。行上渲染红色失败徽标（错误原因
   * 见 errorText，作 tooltip），不再向 scrollback 渲染错误行。
   */
  degraded?: boolean
  /**
   * 失败原因（fetch 拒绝文本 / agent 错误 / 409 竞态）——仅 degraded 行
   * 有值，供徽标 tooltip 展示（用户想知道为什么没发出去时可见，主
   * 输出流不被裸错误文本打断）。
   */
  errorText?: string
}

/** Mint a prompt id (UUID when available). Shared with chat.ts send() —
 * 队列行 id 与直接发送的回合 pid 同源（agent 侧 queue_meta 身份）。 */
export function qid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `q_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Max sessions kept in the per-session queue stash (oldest dropped). */
const QUEUE_SESSIONS_MAX = 50

/** 删除行登记的保留上限（最旧的先淘汰）。导出供测试断言边界。 */
export const DELETED_ROWS_MAX = 64

/**
 * 记下用户删除 / 清空的行（id → 行本体）。删除是本地先行、
 * `x.ai/queue/remove` 异步生效：agent 可能已经把该行 pop 进 running 槽位
 * （队首 + 上一回合刚收口），晚到的 remove 即 no-op，消息照常开一个回合。
 * applyQueueChanged 靠这份登记认出竞态（deletedRunning 分支）。Map 保持插入
 * 顺序，超限先丢最旧的登记。
 */
function rememberDeleted(
  prev: Map<string, QueuedPrompt>,
  rows: QueuedPrompt[],
): Map<string, QueuedPrompt> {
  if (rows.length === 0) return prev
  const next = new Map(prev)
  for (const r of rows) next.set(r.id, r)
  while (next.size > DELETED_ROWS_MAX) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  return next
}

/** 队列正文可能很长，提示条里截断成一行。 */
function clipRowText(text: string, max = 24): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * Best-effort host sync: failures surface via `onError` when the caller
 * cares. 默认静默（显示类操作失败会被下一次广播校正）；破坏性操作
 * （删除/清空）必须传 onError —— 静默失败意味着 agent 侧队列里那条
 * 消息照常执行，用户以为删了实际会发出去。
 */
function syncQueue(
  fn: () => Promise<unknown>,
  opts?: { onError?: (e: unknown) => void },
): void {
  void fn().catch((e) => {
    if (opts?.onError) opts.onError(e)
  })
}

/** 破坏性队列操作同步失败的用户提醒（toast）。 */
function queueSyncToast(prefix: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e)
  pushToast(`${prefix}: ${msg}`)
}

/**
 * 结算「删除晚于出队」竞态：本地已删的行被 agent 收养开跑（remove 没能
 * 赶上）。只提示一次（登记即注销，后续同一回合的广播不再重复），并给出
 * 唯一可行的补救——中止已开跑的回合。
 */
function settleDeletedRunning(id: string, text: string): void {
  const st = usePromptQueue.getState()
  if (!st.deletedRows.has(id)) return
  const deletedRows = new Map(st.deletedRows)
  deletedRows.delete(id)
  usePromptQueue.setState({ deletedRows })
  pushToast(
    `删除未生效：「${clipRowText(text)}」已开始执行，无法撤回（点 [stop] 可中止本回合）`,
  )
}

/**
 * 结算一条在途 prompt 的 RPC 结果（enqueue 的 fire-and-forget 链）：
 * - `ran`：旧 host 下 RPC 在回合完成时 resolve（响应带 stopReason）=
 *   该 prompt 已经作为回合跑完——从显示镜像移除（正常流程收养广播先
 *   移除；这里是漏广播兜底），并记入 drainedIds 防 stale 广播复活。
 *   新 host 受理即返回（无 stopReason）不得走这条：行仍在权威队列里，
 *   过早 drained 会让后续 queue_changed 快照把该行滤掉，queued 闪一下
 *   就再也回不来。
 * - `failed`：RPC 被拒（网络失败 / agent 拒绝 / 竞态 409）——行保留为
 *   degraded（FE-owned，附带失败原因 errorText），用户手动重发；不再
 *   渲染 scrollback 错误行（队列行徽标即提示，主输出流不被打断）。
 */
function settlePromptRow(
  promptId: string,
  sessionId: string,
  outcome: 'ran' | 'failed',
  errorText?: string,
): void {
  usePromptQueue.setState((s) => {
    const active = s.sessionId === sessionId
    const list = active ? s.queue : s.queues[sessionId]
    if (!list) return s
    const idx = list.findIndex((q) => q.id === promptId)
    if (idx === -1) return s
    if (outcome === 'ran') {
      return {
        ...(active
          ? { queue: list.filter((q) => q.id !== promptId) }
          : { queues: { ...s.queues, [sessionId]: list.filter((q) => q.id !== promptId) } }),
        drainedIds: new Set(s.drainedIds).add(promptId),
      }
    }
    const nextList = list.map((q) =>
      q.id === promptId
        ? { ...q, optimistic: false, degraded: true, ...(errorText ? { errorText } : {}) }
        : q,
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
   * Ids that left the LOCAL queue for deletion (removeAt / clear /
   * RPC-resolved). A stale `queue_changed` broadcast must never resurrect
   * them; applyQueueChanged drops these rows (TUI
   * retire_optimistic_echo parity: once a row is gone it never reappears
   * in a later broadcast).
   */
  drainedIds: Set<string>
  /**
   * 用户删除/清空过的行（id → 行本体，含正文与 blocks），与 `drainedIds`
   * 同步登记、比它更晚过期。用途见 `rememberDeleted`：认出「本地删了但
   * agent 已经开跑」的竞态，把该行照常收养出用户行并提示删除无效。
   */
  deletedRows: Map<string, QueuedPrompt>
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
   * 回显行。RPC 失败（网络 / agent 拒绝 / 竞态 409）→ 行标记 degraded
   * （FE-owned，保留手动重发）并记录失败原因 errorText（队列行红色
   * 徽标展示）。不再向 scrollback 渲染错误行：主回合输出不因排队消息
   * 的 RPC 失败而被打断。不再向 host 镜像 queueInterject——prompt RPC
   * 本身就是入队。排队消息由 composer 上方的内联队列区展示。
   */
  enqueue: (
    item: Omit<QueuedPrompt, 'id' | 'ts' | 'version' | 'optimistic' | 'degraded' | 'errorText'>,
    sessionId: string,
  ) => void
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
  /** 拖拽落点：把 from 行挪到 to（含端点，与当前列表下标一致）。 */
  moveTo: (from: number, to: number) => void
}

export const usePromptQueue = create<PromptQueueState>((set, get) => ({
  queues: {},
  queue: [],
  sending: false,
  drainedIds: new Set(),
  deletedRows: new Map(),
  editIndex: null,
  editDraft: '',
  enqueue: (item, sessionId) => {
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
    // idle 直接运行）。fire-and-forget：不 await 回合完成。
    //
    // 新 host：POST 受理即返回 {ok:true}，无 stopReason。行保持乐观回显，
    // 等 queue_changed 确认（清 optimistic + 补 version）或收养
    // （running_prompt_id）。绝不能在此处按 'ran' 移除并写入 drainedIds
    // ——否则权威快照会被 drainedIds 滤掉，UI 上 queued 闪一下就消失，
    // 但 agent 侧已经入队。
    //
    // 旧 host：POST 阻塞到该 prompt 作为回合跑完，响应带 stopReason，
    // 才走漏广播兜底（收养广播通常已先移除该行，settle 是 no-op）。
    // reject（网络 / agent 拒绝 / 409）→ 行标记 degraded，手动重发。
    void transport
      .prompt(item.blocks, { sessionId, promptId })
      .then(
        (result) => {
          if (result?.stopReason) {
            settlePromptRow(promptId, sessionId, 'ran')
          }
        },
        (e: unknown) => {
          // 任何失败（网络 / agent 拒绝 / 竞态 409）→ 行标记 degraded
          // （FE-owned，不丢用户意图，手动重发）并记录失败原因（队列
          // 行红色徽标 + tooltip）。不再向 scrollback 渲染错误行。
          const msg = e instanceof Error ? e.message : String(e)
          settlePromptRow(promptId, sessionId, 'failed', msg)
        },
      )
  },
  requeueFront: (sessionId, item) => {
    set((s) => {
      const list = s.queues[sessionId] ?? []
      const drainedIds = new Set(s.drainedIds)
      drainedIds.delete(item.id)
      // 行回到镜像：撤销删除登记，否则它开跑时会被误报成「删除未生效」。
      const deletedRows = new Map(s.deletedRows)
      deletedRows.delete(item.id)
      return {
        queues: { ...s.queues, [sessionId]: [item, ...list] },
        queue: s.sessionId === sessionId ? [item, ...s.queue] : s.queue,
        drainedIds,
        deletedRows,
      }
    })
  },
  removeAt: (id) => {
    const s = get()
    // 删除携带本端最后见过的权威版本：agent 侧 remove 按 (id, version)
    // 精确匹配（editable_queue_meta_matches），缺省 = 0 只匹配从未编辑
    // 过的行——编辑过的行（version ≥ 1）不带 expectedVersion 会被 no-op，
    // 行照常执行（「以为删了实际会发出去」）。无 version 的 FE-owned 行
    // （乐观/降级）省略键，与 agent 默认 0 同义。
    const targetVersion = s.queue.find((q) => q.id === id)?.version
    // 被删的正是编辑中的行：编辑锁须随行释放（清 editIndex 前先留证）。
    const editedId =
      s.editIndex != null && s.queue[s.editIndex]?.id === id
        ? s.queue[s.editIndex]?.id
        : undefined
    set((st) => {
      const idx = st.queue.findIndex((q) => q.id === id)
      if (idx === -1) return st
      const row = st.queue[idx]
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
        // 正文留一份：agent 侧 remove 若晚于出队（该行已开跑），
        // applyQueueChanged 用它收养出用户行并提示删除无效。
        deletedRows: rememberDeleted(st.deletedRows, [row]),
        editIndex,
        editDraft: editIndex == null ? '' : st.editDraft,
      }
    })
    // 编辑中的行被删除：释放它的编辑锁（TUI combine-hold 语义），否则
    // host 侧队列保持组合、后续新条目被合并。
    if (editedId) {
      syncQueue(() => transport.queueReleaseEdit({ id: editedId }, s.sessionId))
    }
    // 删除失败必须提醒：行已从本地镜像移除（drainedIds），但 agent 侧
    // 队列里仍在——回合结束会照常执行，用户以为删了实际会发出去。
    syncQueue(
      () =>
        transport.queueRemove(
          targetVersion != null
            ? { id, expectedVersion: targetVersion }
            : { id },
          s.sessionId,
        ),
      {
        onError: (e) => queueSyncToast('删除队列消息失败（消息仍会发送）', e),
      },
    )
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
      // 逐行留正文：清空同样可能晚于 agent 出队（队首已在开跑）。
      deletedRows: rememberDeleted(st.deletedRows, st.queue),
    }))
    // 清空时编辑锁在飞 → 释放，防止 host 侧队列永久保持组合。
    if (editedId) {
      syncQueue(() => transport.queueReleaseEdit({ id: editedId }, s.sessionId))
    }
    // 清空失败必须提醒：本地镜像已空，但 agent 侧队列原样保留，
    // 所有消息仍会按序执行。
    syncQueue(() => transport.queueClear(s.sessionId), {
      onError: (e) => queueSyncToast('清空队列失败（消息仍会发送）', e),
    })
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
  moveUp: (index) => get().moveTo(index, index - 1),
  moveDown: (index) => get().moveTo(index, index + 1),
  moveTo: (from, to) => {
    const s = get()
    const n = s.queue.length
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return
    const next = [...s.queue]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    let editIndex = s.editIndex
    if (editIndex != null) {
      if (editIndex === from) editIndex = to
      else if (from < editIndex && to >= editIndex) editIndex -= 1
      else if (from > editIndex && to <= editIndex) editIndex += 1
    }
    set({ queue: next, editIndex })
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
 * re-append（RPC 失败降级：agent 从没见过）。Edit state survives only while
 * the edited row still exists.
 *
 * `sessionId` (the broadcast's emitting session) 标签队列使 drain 保持
 * 会话作用域。非活跃会话的广播（切走期间收到）走 stash 模式：快照写
 * 进该会话的 stash（queues[sid]）保持切回时镜像权威，不渲染收养（用户
 * 行由切回时的历史回放渲染）、不动活跃队列的编辑锁——返回 null。
 *
 * Returns a QueueAdoption when the broadcast carries a `running_prompt_id`
 * that matched a local queue row (the row is removed from the mirror) —
 * chat.ts renders the adopted turn's user row; otherwise null.
 */
export function applyQueueChanged(
  params: unknown,
  sessionId?: string,
): QueueAdoption | null {
  const st = usePromptQueue.getState()
  // 非活跃会话的广播（切走期间 agent 已 pop 队首开跑）：快照仍要喂给
  // 该会话的 stash——否则切回时镜像陈旧，已被收养的行还显示 queued。
  // stash 模式只更新镜像、不渲染收养（切回时用户行由历史回放渲染）。
  const toStash = sessionId != null && st.sessionId !== sessionId
  const prev = toStash ? st.queues[sessionId ?? ''] ?? [] : st.queue
  const { drainedIds } = st
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
  // 例外：命中的是本端删除过的行（deletedRunning）时，说明 queue/remove
  // 晚于 agent 出队——删除已经追不上，这条消息正在开它的回合。drainedIds
  // 的「永别」过滤针对的是 stale 广播复活，不能把它吞成一个没有用户行的
  // 隐形回合：照常收养出用户行，并提示删除未生效（settleDeletedRunning）。
  const deletedRunning =
    runningId && !toStash && drainedIds.has(runningId)
      ? st.deletedRows.get(runningId)
      : undefined
  let adoption: QueueAdoption | null = null
  if (runningId && (deletedRunning || !drainedIds.has(runningId))) {
    let row = byId.get(runningId) ?? deletedRunning
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
  if (adoption && deletedRunning) settleDeletedRunning(adoption.id, adoption.text)

  if (snapshot) {
    // 本地在途行（乐观回显 / 降级，FE 侧尚悬而未决）不在快照里 → 保留
    // 显示：agent 从没见过它（RPC 失败降级），或 RPC 结果会结算它。
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
    if (toStash) {
      // 非活跃会话：只更新 stash 镜像。快照整体替换（running 行已在
      // 构建时排除、在途行按原逻辑回挂）；仅 running 标记的广播按
      // 收养 id 兜底移除。编辑锁/收养渲染属于活跃队列，这里不碰。
      let list = s.queues[sessionId ?? ''] ?? []
      if (snapshot) list = snapshot
      else if (adoption) list = list.filter((q) => q.id !== adoption.id)
      return { queues: { ...s.queues, [sessionId ?? '']: list } }
    }
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
  return toStash ? null : adoption
}
