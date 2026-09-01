import type { ChatState } from './types'
import type { AcpEvent, ScrollEntry, ToolCall } from '../../api/types'
import { modelDisplayName } from './model'
import {
  type RawEnvelope,
  completionEndMs,
  envelopeMsgSeq,
  envelopeToEvents,
  envelopeTimestamp,
  liteMark,
} from './envelopeParse'
import { toolCallIdOf } from './tools'

function replayUpdateKind(env: unknown): string | undefined {
  const e = env as RawEnvelope
  return typeof e.params?.update?.sessionUpdate === 'string'
    ? e.params.update.sessionUpdate
    : undefined
}

function replayMeta(env: unknown): Record<string, unknown> | undefined {
  const e = env as RawEnvelope
  const paramsMeta = e.params?._meta
  if (paramsMeta && typeof paramsMeta === 'object') {
    return paramsMeta as Record<string, unknown>
  }
  const updateMeta = e.params?.update?._meta
  return updateMeta && typeof updateMeta === 'object'
    ? (updateMeta as Record<string, unknown>)
    : undefined
}

function replayMetaNumber(
  env: unknown,
  key: 'turnStartMs' | 'turn_start_ms' | 'agentTimestampMs',
): number | undefined {
  const value = replayMeta(env)?.[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function replayTurnStartMs(env: unknown): number | undefined {
  return (
    replayMetaNumber(env, 'turnStartMs') ??
    replayMetaNumber(env, 'turn_start_ms')
  )
}

function isReplayTurnEnd(kind: string | undefined): boolean {
  return kind === 'turn_completed' || kind === 'response_completed'
}

function isReplayUserChunk(kind: string | undefined): boolean {
  return kind === 'user_message_chunk'
}

function isReplayAgentStream(kind: string | undefined): boolean {
  return kind === 'agent_message_chunk' || kind === 'agent_thought_chunk'
}

/** agent UserRunTurnTracker：连续 user run + promptIndex；幽灵 run 不计。 */
type userRunTurnTracker = {
  seenMarker: boolean
  inUser: boolean
  hasCurrentPI: boolean
  currentRunPI: number
}

function newUserRunTurnTracker(): userRunTurnTracker {
  return { seenMarker: false, inUser: false, hasCurrentPI: false, currentRunPI: 0 }
}

function trackerOnUserChunk(
  t: userRunTurnTracker,
  promptIndex: number | undefined,
): { newRun: boolean; counts: boolean } {
  const hasPI = promptIndex != null
  if (hasPI) t.seenMarker = true
  const counts = !t.seenMarker || hasPI
  let newRun = !t.inUser
  if (t.inUser && (t.seenMarker || hasPI)) {
    newRun = hasPI !== t.hasCurrentPI || (hasPI && promptIndex !== t.currentRunPI)
  }
  if (newRun) {
    t.hasCurrentPI = hasPI
    t.currentRunPI = hasPI ? promptIndex! : 0
  }
  t.inUser = true
  return { newRun, counts }
}

function trackerOnNonUser(t: userRunTurnTracker): void {
  t.inUser = false
  t.hasCurrentPI = false
}

/**
 * Storage order is normally the agent order, but a late flush can append
 * envelopes after the turn they belong to. Two shapes are relocated:
 *
 * - A late agent chunk/thought that proves it belongs to the closed turn
 *   (same turnStartMs and an agent time at or before the terminal) moves
 *   back before the terminal; every other post-terminal agent chunk or
 *   thought is discarded until the next user chunk establishes a new turn.
 * - A cancelled turn's user echo can be persisted AFTER its own
 *   turn_completed (late echo flush) while its `_meta.agentTimestampMs`
 *   still predates the terminal. Move it back to just after the previous
 *   user chunk so replay renders [user prompt, …, "Turn cancelled by user
 *   in 18s."] instead of marker-above-prompt (the initial page only loads
 *   the newest turn, so the marker would sit at the very top of the
 *   scrollback). An echo at or after the terminal is the NEXT turn's
 *   prompt and stays put.
 */
export function reorderLateAgentEvents(updates: unknown[]): unknown[] {
  const ordered: unknown[] = []
  let activeTurnStartMs: number | undefined
  /** Index (in ordered) of the newest user chunk — echo insertion anchor. */
  let lastUserIdx = -1
  let closed:
    | { turnStartMs?: number; endMs?: number; insertAt: number }
    | undefined

  for (const env of updates) {
    const kind = replayUpdateKind(env)
    if (closed && isReplayUserChunk(kind)) {
      // Late echo of the closed turn's own prompt (agentTimestampMs at or
      // before the terminal's end) → relocate before the turn content.
      // No comparable stamp → treat as the next turn's prompt (legacy).
      const echoTs = replayMetaNumber(env, 'agentTimestampMs')
      if (closed.endMs != null && echoTs != null && echoTs <= closed.endMs) {
        ordered.splice(lastUserIdx + 1, 0, env)
        closed.insertAt += 1
        lastUserIdx += 1
        continue
      }
      closed = undefined
      activeTurnStartMs = undefined
    }

    if (closed && isReplayAgentStream(kind)) {
      const turnStartMs = replayTurnStartMs(env)
      const agentTimestampMs = replayMetaNumber(env, 'agentTimestampMs')
      const belongsToClosedTurn =
        closed.turnStartMs != null &&
        turnStartMs === closed.turnStartMs &&
        closed.endMs != null &&
        agentTimestampMs != null &&
        agentTimestampMs <= closed.endMs
      if (belongsToClosedTurn) {
        ordered.splice(closed.insertAt, 0, env)
        closed.insertAt += 1
      }
      continue
    }

    if (isReplayTurnEnd(kind)) {
      const terminalStartMs = replayTurnStartMs(env) ?? activeTurnStartMs
      ordered.push(env)
      // response_completed + turn_completed can both be persisted for one
      // turn. Keep the first terminal as the insertion point for late chunks.
      if (!closed) {
        closed = {
          turnStartMs: terminalStartMs,
          endMs: completionEndMs(env as RawEnvelope),
          insertAt: ordered.length - 1,
        }
      }
      activeTurnStartMs = undefined
      continue
    }

    if (closed) {
      ordered.push(env)
      continue
    }

    const turnStartMs = replayTurnStartMs(env)
    if (turnStartMs != null) activeTurnStartMs = turnStartMs
    ordered.push(env)
    if (isReplayUserChunk(kind)) lastUserIdx = ordered.length - 1
  }
  return ordered
}

// ── history envelope replay ───────────────────────────────────────
// A stored update is the JSONL envelope {timestamp, method, params} with
// params = {sessionId, update}. Mirrors the host's session/update mapping.

export function replayUpdates(
  getStore: () => ChatState,
  updates: unknown[],
  opts?: { applyUsage?: boolean },
): {
  turnStartedAt?: number
  turnOpen: boolean
  /** 回放新产生条目的 id → 信封顶层 msgSeq（调用方盖到条目上）。 */
  entryMsgSeq: Map<string, number>
  /** 工具条目 id → 本页最后一条碰到它的信封 msgSeq（lite 补全的窗口右端）。 */
  entryMsgSeqEnd: Map<string, number>
  /** 工具条目 id → 本页为该条目裁掉的字节数（`_meta.lite.omitted` 累计）。 */
  entryLiteOmitted: Map<string, number>
} {
  updates = reorderLateAgentEvents(updates)
  // 回放产生的条目按「产生它的第一条事件」盖信封顶层 msgSeq：新条目只会
  // 追加在尾部（删除只发生在既有条目上），从尾向前扫到已知 id 即停，均摊
  // O(1)。聚合用户行的 msgSeq 由 flushUser 的事件直接携带（userStream 落
  // 到条目上），这里遇到已带 msgSeq 的条目只标记已见、不覆盖。
  // entries 兜底：测试用的最小 store mock 可能不带该字段。
  const seenIds = new Set((getStore().entries ?? []).map((e) => e.id))
  const entryMsgSeq = new Map<string, number>()
  const entryMsgSeqEnd = new Map<string, number>()
  const entryLiteOmitted = new Map<string, number>()
  /**
   * lite 投影下工具行的补全坐标：`msgSeqEnd` = 本页最后一条碰到该行的信封
   * 行号（按需补全要按 [msgSeq, msgSeqEnd] 精确回拉），`liteOmitted` = 本页
   * 为该行为裁掉的字节。行归属取回放自己维护的 toolIndex（新建行也已登记），
   * 匿名 call（无 toolCallId）无从对齐 → 不参与补全。
   */
  const stampToolTouch = (seq: number | undefined, ev: AcpEvent) => {
    const tc: ToolCall | undefined =
      ev.type === 'tool_call' ? ev.toolCall : ev.type === 'tool_call_update' ? ev.toolCallUpdate : undefined
    if (!tc) return
    const toolCallId = toolCallIdOf(tc)
    if (!toolCallId) return
    const entryId = getStore().toolIndex?.[toolCallId]
    if (!entryId) return
    if (seq != null) entryMsgSeqEnd.set(entryId, seq)
    const lite = liteMark(tc)
    if (lite) entryLiteOmitted.set(entryId, lite.omitted + (entryLiteOmitted.get(entryId) ?? 0))
  }
  const stampNewEntries = (seq: number | undefined) => {
    const es = getStore().entries ?? []
    for (let i = es.length - 1; i >= 0; i--) {
      const entry = es[i]!
      if (seenIds.has(entry.id)) break
      seenIds.add(entry.id)
      if (seq != null && entry.msgSeq == null) entryMsgSeq.set(entry.id, seq)
    }
  }
  let userBuf = ''
  let userIsCron = false
  let userTs: number | undefined
  let turnStartTs: number | undefined
  /** Whether turnStartTs came from the authoritative _meta.turnStartMs. */
  let turnStartIsMeta = false
  let anyEvent = false
  let sawTurnEnd = false
  /**
   * After turn_completed, only a new user_message opens the next turn.
   * Stray agent_thought/chunk after completion still carry the *old*
   * turnStartMs and must not re-arm turnOpen (that froze Responding…
   * through loadMoreHistory on closed sessions).
   */
  let userAfterEnd = false
  // Model id of the last replayed user_message_chunk (page-local).
  let prevReplayModelId: string | undefined
  const userRun = newUserRunTurnTracker()
  // Newest envelope's session-accumulated token count of this page; the
  // usage event is fired once after the loop (last envelope wins).
  let pageMetaUsed: number | undefined
  let userMsgSeq: number | undefined
  const flushUser = () => {
    if (userBuf) {
      getStore().handleEvent({
        type: 'user_message',
        text: userBuf,
        isCron: userIsCron || undefined,
        ts: userTs,
        // 多 chunk 聚合的用户行取首条 chunk 的 msgSeq。
        ...(userMsgSeq != null ? { msgSeq: userMsgSeq } : {}),
      })
      userBuf = ''
      userIsCron = false
      userTs = undefined
      userMsgSeq = undefined
    }
  }
  for (const env of updates) {
    // Every envelope carries the session-accumulated token count in
    // `_meta.totalTokens`. The live bridge surfaces it as a usage event
    // (TUI ⇣ counter / context chip); replay must do the same or the
    // context chip stays empty after restoring history. Pages are
    // fetched newest-first, so only the newest page applies it (see
    // opts.applyUsage) — otherwise the chip would end up at the OLDEST
    // page's count and every scroll-up page would rewrite it with older
    // values.
    if (opts?.applyUsage !== false) {
      const metaUsed = envelopeTotalTokens(env)
      if (metaUsed != null && metaUsed > 0) pageMetaUsed = metaUsed
    }
    // Model switch point: consecutive user chunks served by different
    // models. Insert the "模型已从 xx 切换到 xx" line BEFORE the
    // buffered user row flushes, so it renders above the first message
    // of the new model.
    const rawUp = (env as RawEnvelope).params?.update
    let skipUserText = false
    if (rawUp?.sessionUpdate === 'user_message_chunk') {
      const chunkMeta = rawUp._meta as Record<string, unknown> | undefined
      if (chunkMeta?.hostTurn === true) {
        flushUser()
        trackerOnNonUser(userRun)
        skipUserText = true
      } else {
        const pidx =
          typeof chunkMeta?.promptIndex === 'number' &&
          Number.isFinite(chunkMeta.promptIndex)
            ? chunkMeta.promptIndex
            : undefined
        const { newRun, counts } = trackerOnUserChunk(userRun, pidx)
        if (newRun) flushUser()
        skipUserText = newRun && !counts
        if (!skipUserText) {
          const mid =
            typeof chunkMeta?.modelId === 'string' && chunkMeta.modelId
              ? chunkMeta.modelId
              : undefined
          if (mid) {
            if (prevReplayModelId && prevReplayModelId !== mid) {
              getStore().appendLocalEntry({
                kind: 'session_event',
                text: `模型已从 ${modelDisplayName(getStore, prevReplayModelId)} 切换到 ${modelDisplayName(getStore, mid)}`,
                warning: true,
              })
            }
            prevReplayModelId = mid
          }
        }
      }
    } else {
      trackerOnNonUser(userRun)
    }
    // History replay shows stored task lifecycle events as display-only
    // informational lines (envelopeToEvent) — never captured into the
    // task system. The live running set is established once at resume via
    // the host's liveness probe (replayRunningTasks).
    const seq = envelopeMsgSeq(env)
    const events = envelopeToEvents(env)
    if (events.length === 0) {
      // 无渲染事件的信封（如隐藏注入）也可能已通过上面的模型切换分支
      // 产生提示行——统一在此盖戳/标记已见。
      stampNewEntries(seq)
      continue
    }
    for (const ev of events) {
      // Older pages are transcript-only: never let a stored usage_update
      // overwrite the current session's context chip. The newest page applies
      // its accumulated total once after the loop.
      if (ev.type === 'usage' && opts?.applyUsage === false) continue
      anyEvent = true
      if (ev.type === 'turn_completed') {
      sawTurnEnd = true
      userAfterEnd = false
      // Attach this closing turn's real start (tracked from the envelope
      // meta below) so the marker renders "Worked for X" / "Turn failed
      // in X" with the true duration. `endMs` is the completion's own
      // agentTimestampMs (turnCompletedEvent prefers it over the coarse
      // envelope write stamp — a late-flushed log would otherwise inflate
      // the duration by minutes). Reset the tracker so the NEXT turn's
      // start is captured from its own envelopes — the old
      // first-start→last-end pairing spanned multiple turns whenever a
      // page covered more than one closed turn.
      ev.turnStartedAt = turnStartTs
      turnStartTs = undefined
      turnStartIsMeta = false
    }
    // Authoritative turn start: the shell stamps `_meta.turnStartMs`
    // (epoch ms; the TUI tracker reads it the same way) on every streamed
    // update of the turn. Adopt it whenever it appears — a meta-carrying
    // chunk refines/overrides any agentTs fallback captured earlier in
    // the same turn. The completion envelope itself never re-opens a turn.
    // After turn_completed, ignore turnStartMs on non-user events until a
    // new user_message arrives (stray post-completion thought/chunk keeps
    // the old turn's turnStartMs and must not re-open the turn).
    if (ev.type !== 'turn_completed' && !(sawTurnEnd && !userAfterEnd)) {
      const meta = (env as RawEnvelope).params?._meta as
        | Record<string, unknown>
        | undefined
      const tsMs = meta?.turnStartMs ?? meta?.turn_start_ms
      let parsed: number | undefined
      if (typeof tsMs === 'number' && Number.isFinite(tsMs)) {
        parsed = tsMs
      } else if (typeof tsMs === 'string') {
        const p = Date.parse(tsMs)
        if (Number.isFinite(p)) parsed = p
      }
      if (parsed != null) {
        if (!turnStartIsMeta || parsed !== turnStartTs) {
          turnStartTs = parsed
          turnStartIsMeta = true
        }
      } else if (!turnStartIsMeta) {
        // Fallback: the turn's EARLIEST agent timestamp (user chunks
        // carry the prompt time; a turn-end envelope like retry_state
        // would otherwise be misread as the start). Min-refinement never
        // overrides the authoritative turnStartMs.
        let cand: number | undefined
        const ats = meta?.agentTimestampMs
        if (typeof ats === 'number' && Number.isFinite(ats) && ats > 0) {
          cand = ats
        } else if (typeof ats === 'string') {
          const p = Date.parse(ats)
          if (Number.isFinite(p)) cand = p
        }
        // No agentTs → the coarse envelope write stamp (epoch seconds).
        if (cand == null) cand = envelopeTimestamp(env as RawEnvelope)
        if (cand != null && (turnStartTs == null || cand < turnStartTs)) {
          turnStartTs = cand
        }
      }
    }
    // A STILL-RUNNING task's "started" row belongs ONLY in the top task
    // strip (host liveness probe) — never as a dangling scrollback row
    // without its completion. Live rows are unaffected (this path is
    // history replay only; the live pipeline uses handleTaskBackgrounded).
    if (ev.type === 'task_lifecycle' && ev.kind === 'started') {
      const taskId = ev.taskId
      if (taskId && getStore().topTasks.some((t) => t.taskId === taskId)) {
        continue
      }
    }
    if (ev.type === 'user_message') {
      if (skipUserText) continue
      // Aggregate consecutive chunks of one user turn; keep cron if any
      // chunk (or the framed full text) is a scheduled-task inject.
      if (sawTurnEnd) userAfterEnd = true
      userBuf += ev.text
      if (ev.isCron) userIsCron = true
      if (ev.ts != null) userTs = ev.ts
      if (userMsgSeq == null && ev.msgSeq != null) userMsgSeq = ev.msgSeq
      continue
    }
      flushUser()
      getStore().handleEvent(ev)
      stampToolTouch(seq, ev)
    }
    stampNewEntries(seq)
  }
  flushUser()
  // Apply the page's newest token count once (after the loop, so no
  // per-envelope chip flicker; the last envelope of the page is the
  // newest point in time).
  if (pageMetaUsed != null) {
    getStore().handleEvent({ type: 'usage', used: pageMetaUsed })
  }
  // The LAST turn is open when it never completed (no turn_completed in
  // the page), or when a *new user prompt* started after the page's last
  // completion (userAfterEnd). Stray post-completion thought/chunk alone
  // does not keep the turn open.
  return {
    turnStartedAt: turnStartTs,
    turnOpen:
      anyEvent &&
      (sawTurnEnd ? userAfterEnd && turnStartTs != null : true),
    entryMsgSeq,
    entryMsgSeqEnd,
    entryLiteOmitted,
  }
}

/**
 * 把 replayUpdates 的 lite 统计盖到回放条目上（`msgSeqEnd` 取较大者，
 * `liteOmitted` 累加）。两个 map 都空时原数组返回。
 */
export function applyEntryLiteStats(
  entries: ScrollEntry[],
  msgSeqEnd: Map<string, number> | undefined,
  liteOmitted: Map<string, number> | undefined,
): ScrollEntry[] {
  if ((!msgSeqEnd || msgSeqEnd.size === 0) && (!liteOmitted || liteOmitted.size === 0)) {
    return entries
  }
  let changed = false
  const next = entries.map((e) => {
    if (e.kind !== 'tool') return e
    const end = msgSeqEnd?.get(e.id)
    const omitted = liteOmitted?.get(e.id)
    if (end == null && omitted == null) return e
    const prevEnd = e.msgSeqEnd
    const prevOmitted = e.liteOmitted
    const nextEnd = end != null && (prevEnd == null || end > prevEnd) ? end : prevEnd
    const nextOmitted = omitted != null ? omitted + (prevOmitted ?? 0) : prevOmitted
    if (nextEnd === prevEnd && nextOmitted === prevOmitted) return e
    changed = true
    return {
      ...e,
      ...(nextEnd != null ? { msgSeqEnd: nextEnd } : {}),
      ...(nextOmitted != null ? { liteOmitted: nextOmitted } : {}),
    }
  })
  return changed ? next : entries
}

/**
 * 把 replayUpdates 返回的 entryMsgSeq 盖到回放产生的条目上（按 id 对齐；
 * 已带 msgSeq 的条目不覆盖）。stamps 为空时原数组返回，避免无谓重排。
 */
export function applyEntryMsgSeq<T extends ScrollEntry>(
  entries: T[],
  stamps: Map<string, number> | undefined,
): T[] {
  if (!stamps || stamps.size === 0) return entries
  let changed = false
  const next = entries.map((e) => {
    if (e.msgSeq != null) return e
    const seq = stamps.get(e.id)
    if (seq == null) return e
    changed = true
    return { ...e, msgSeq: seq } as T
  })
  return changed ? next : entries
}

/** Accumulated session tokens from a stored envelope's `_meta.totalTokens`. */
export function envelopeTotalTokens(env: unknown): number | undefined {
  const e = env as RawEnvelope
  const meta = e.params?._meta as Record<string, unknown> | undefined
  return typeof meta?.totalTokens === 'number' ? meta.totalTokens : undefined
}
