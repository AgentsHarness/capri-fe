import type { ChatState } from './types'
import { modelDisplayName } from './model'
import {
  type RawEnvelope,
  envelopeToEvent,
  envelopeTimestamp,
} from './envelopeParse'

// ── history envelope replay ───────────────────────────────────────
// A stored update is the JSONL envelope {timestamp, method, params} with
// params = {sessionId, update}. Mirrors the host's session/update mapping.

export function replayUpdates(
  getStore: () => ChatState,
  updates: unknown[],
  opts?: { applyUsage?: boolean },
): { turnStartedAt?: number; turnOpen: boolean } {
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
  // promptIndex of the last replayed user_message_chunk (page-local) —
  // the agent's authoritative user-message boundary stamp. Storage can
  // persist a short-lived (e.g. cancelled) turn's user echo AFTER its own
  // turn_completed, so two independent user messages can end up adjacent
  // in a history page. Replay must split on the promptIndex change (the
  // agent's own replay rule: a change, including unmarked ↔ marked,
  // opens a new run) instead of blindly concatenating them into one row.
  let prevReplayPromptIdx: number | undefined
  // Newest envelope's session-accumulated token count of this page; the
  // usage event is fired once after the loop (last envelope wins).
  let pageMetaUsed: number | undefined
  const flushUser = () => {
    if (userBuf) {
      getStore().handleEvent({
        type: 'user_message',
        text: userBuf,
        isCron: userIsCron || undefined,
        ts: userTs,
      })
      userBuf = ''
      userIsCron = false
      userTs = undefined
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
    if (rawUp?.sessionUpdate === 'user_message_chunk') {
      const chunkMeta = rawUp._meta as Record<string, unknown> | undefined
      // User-message boundary: flush the buffered previous message when
      // this chunk's promptIndex differs. Both-undefined (old logs
      // without the stamp) keeps the legacy single-run aggregation —
      // backward compatible.
      const pidx =
        typeof chunkMeta?.promptIndex === 'number' &&
        Number.isFinite(chunkMeta.promptIndex)
          ? chunkMeta.promptIndex
          : undefined
      if (prevReplayPromptIdx !== pidx) {
        // Flush BEFORE the model-switch line below so the switch note
        // renders above the NEW message's row, below the flushed one.
        flushUser()
        prevReplayPromptIdx = pidx
      }
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
    // History replay shows stored task lifecycle events as display-only
    // informational lines (envelopeToEvent) — never captured into the
    // task system. The live running set is established once at resume via
    // the host's liveness probe (replayRunningTasks).
    const ev = envelopeToEvent(env)
    if (!ev) continue
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
      // Aggregate consecutive chunks of one user turn; keep cron if any
      // chunk (or the framed full text) is a scheduled-task inject.
      if (sawTurnEnd) userAfterEnd = true
      userBuf += ev.text
      if (ev.isCron) userIsCron = true
      if (ev.ts != null) userTs = ev.ts
      continue
    }
    flushUser()
    getStore().handleEvent(ev)
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
  }
}

/** Accumulated session tokens from a stored envelope's `_meta.totalTokens`. */
export function envelopeTotalTokens(env: unknown): number | undefined {
  const e = env as RawEnvelope
  const meta = e.params?._meta as Record<string, unknown> | undefined
  return typeof meta?.totalTokens === 'number' ? meta.totalTokens : undefined
}
