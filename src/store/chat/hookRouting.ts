/**
 * Hook batch routing — the FE counterpart of the TUI's `HookExecution` arm in
 * `app/acp_handler/session_notification.rs` plus the scrollback attach helpers
 * in `scrollback/state/mod.rs`.
 *
 * Destinations, decided in this order (TUI `HookExecution` arm):
 *  1. `pre_tool_use` / `post_tool_use` → the tool row they gated (queued when
 *     the row has not been created yet — the wire announces the hook first).
 *  2. `stop` / `stop_failure` / `stop_cancelled`:
 *       replay → lifecycle (never stash);
 *       foreign pid (and not a wake) → lifecycle;
 *       live turn and not a wake → stash (`batch_pid ?? current_pid`);
 *       else a marker that accepts, else lifecycle.
 *  3. anything else (`session_start`, `session_end`, `user_prompt_submit`, …)
 *     → a standalone `lifecycle` row.
 *
 * Pure over (entries, routing) so live events and history replay share one
 * rule and the whole matrix tests without a store.
 */
import type { HookGroup, ScrollEntry } from '../../api/types'
import type { HookExecutionBatch } from '../../scrollback/hookRuns'
import { isToolHookEvent, isTurnEndHookEvent } from '../../scrollback/hookRuns'
import {
  attachStopHooksToMarker,
  attachToolHooks,
  latestTurnMarkerAccepting,
  lifecycleEntry,
  toolHookTargetId,
  type HookPhase,
  type PendingStopHooks,
  type PendingToolHook,
} from './hookAttach'
import { isWakePrompt } from './promptOrigin'

/** Store-side hook routing state; both queues live and die with the session. */
export type HookRouting = {
  /**
   * Tool-hook batches whose row has not been created yet. The wire announces
   * `pre_tool_use` BEFORE the `tool_call` envelope, so a batch waits here and
   * the row that matches its `tool_name` claims it.
   */
  pendingToolHooks: PendingToolHook[]
  /** Turn-end batches held for the live turn's marker. */
  pendingStopHooks?: PendingStopHooks
}

export const emptyHookRouting = (): HookRouting => ({ pendingToolHooks: [] })

/** Queue cap: a tool row that never arrives must not grow state unbounded. */
export const MAX_PENDING_TOOL_HOOKS = 8

export type HookRouteContext = {
  /** A turn is in flight (busy / cancelling) — its marker is not pushed yet. */
  turnActive: boolean
  /** The live turn's prompt id, when this client anchored one. */
  currentPromptId?: string
  /**
   * TUI `meta.is_replay || loading_replay`. Stop batches never stash during
   * history replay — they land as standalone lifecycle rows in arrival order.
   */
  isReplay?: boolean
}

export type HookRouteTarget =
  | 'tool'
  | 'tool-queued'
  | 'marker'
  | 'stash'
  | 'lifecycle'

export type HookRouteResult = {
  entries: ScrollEntry[]
  routing: HookRouting
  /** Where the batch went — asserted by the routing tests. */
  target: HookRouteTarget
}

/** Route one parsed batch. A batch with runs is never silently dropped. */
export function routeHookBatch(
  entries: ScrollEntry[],
  routing: HookRouting,
  batch: HookExecutionBatch,
  ctx: HookRouteContext,
): HookRouteResult {
  const group: HookGroup = {
    event: batch.event,
    runs: batch.runs,
    ...(batch.promptId ? { promptId: batch.promptId } : {}),
  }

  // ── 1. tool phases ────────────────────────────────────────────────────
  if (isToolHookEvent(batch.event)) {
    const phase: HookPhase = batch.event === 'pre_tool_use' ? 'pre' : 'post'
    const targetId = toolHookTargetId(entries, phase, batch.toolName)
    if (targetId) {
      return {
        entries: attachToolHooks(entries, targetId, phase, batch.runs),
        routing,
        target: 'tool',
      }
    }
    const queued: PendingToolHook = {
      phase,
      ...(batch.toolName ? { toolName: batch.toolName } : {}),
      runs: batch.runs,
    }
    return {
      entries,
      routing: {
        ...routing,
        pendingToolHooks: [...routing.pendingToolHooks, queued].slice(
          -MAX_PENDING_TOOL_HOOKS,
        ),
      },
      target: 'tool-queued',
    }
  }

  // ── 2. turn-end family ────────────────────────────────────────────────
  if (isTurnEndHookEvent(batch.event)) {
    // Replay never stashes (TUI `!meta.is_replay && !loading_replay` gate).
    if (ctx.isReplay) {
      return {
        entries: [...entries, lifecycleEntry(batch.event, batch.runs)],
        routing,
        target: 'lifecycle',
      }
    }

    // A batch stamped for another turn is a late or misrouted broadcast: it
    // can never merge into THIS turn's marker. Wake pids are exempt — they
    // are not the live turn, but they also must not be treated as foreign
    // noise (TUI `!batch_is_wake` on the foreign predicate).
    const batchIsWake = batch.promptId != null && isWakePrompt(batch.promptId)
    const foreign =
      batch.promptId != null &&
      ctx.currentPromptId != null &&
      batch.promptId !== ctx.currentPromptId &&
      !batchIsWake

    if (foreign) {
      return {
        entries: [...entries, lifecycleEntry(batch.event, batch.runs)],
        routing,
        target: 'lifecycle',
      }
    }

    // Live turn: stash immediately (do not look at an existing marker).
    // Wake batches skip this — they have no PromptResponse / viewer
    // finalize, so they never fold into the live turn's marker.
    if (!batchIsWake && ctx.turnActive) {
      const { stash, flushed } = stashStopBatch(routing.pendingStopHooks, group, {
        stashPromptId: batch.promptId ?? ctx.currentPromptId,
        mergeSameName: batch.promptId != null,
      })
      return {
        entries: [...entries, ...flushed.map((g) => lifecycleEntry(g.event, g.runs))],
        routing: { ...routing, pendingStopHooks: stash },
        target: 'stash',
      }
    }

    const markerId = latestTurnMarkerAccepting(entries, batch.event, batch.promptId)
    if (markerId) {
      const { entries: next, attached } = attachStopHooksToMarker(
        entries,
        markerId,
        group,
        batch.promptId,
      )
      if (attached) return { entries: next, routing, target: 'marker' }
    }
    return {
      entries: [...entries, lifecycleEntry(batch.event, batch.runs)],
      routing,
      target: 'lifecycle',
    }
  }

  // ── 3. everything else is lifecycle chrome ────────────────────────────
  return {
    entries: [...entries, lifecycleEntry(batch.event, batch.runs)],
    routing,
    target: 'lifecycle',
  }
}

/**
 * Add a turn-end batch to the stash (TUI `stash_live_stop_batch`): a stash for
 * a different turn is flushed out — returned here for the caller to render —
 * so those runs stay visible instead of migrating onto the next turn's marker.
 */
export function stashStopBatch(
  prev: PendingStopHooks | undefined,
  group: HookGroup,
  opts: {
    /** TUI `stash_pid = batch_prompt_id.or(current_prompt_id)`. */
    stashPromptId?: string
    /** TUI `merge_same_name = batch_prompt_id.is_some()` — per incoming batch. */
    mergeSameName: boolean
  },
): { stash: PendingStopHooks; flushed: HookGroup[] } {
  const fresh = (): PendingStopHooks => ({
    ...(opts.stashPromptId ? { promptId: opts.stashPromptId } : {}),
    groups: [group],
    mergeSameName: opts.mergeSameName,
  })
  if (!prev) return { stash: fresh(), flushed: [] }
  if (prev.promptId !== opts.stashPromptId) {
    return { stash: fresh(), flushed: prev.groups }
  }
  const idx = prev.groups.findIndex((g) => g.event === group.event)
  if (idx >= 0 && opts.mergeSameName) {
    const groups = [...prev.groups]
    groups[idx] = { ...groups[idx], runs: [...groups[idx].runs, ...group.runs] }
    return { stash: { ...prev, groups }, flushed: [] }
  }
  if (idx >= 0) {
    // Same event name twice and this delivery is unstamped: keep the existing
    // stash (TUI does not replace it) and emit the new batch standalone —
    // typically the session-end `stop` after the turn's own.
    return { stash: prev, flushed: [group] }
  }
  return { stash: { ...prev, groups: [...prev.groups, group] }, flushed: [] }
}

/**
 * Drain the turn-end stash when a turn-terminal marker is pushed. A stash
 * whose prompt id provably is not the ending turn's renders standalone instead
 * of folding into the wrong marker (TUI `push_turn_terminal_marker`).
 */
export function drainPendingStopHooks(
  routing: HookRouting,
  endingPromptId: string | undefined,
): {
  fold: HookGroup[]
  standalone: ScrollEntry[]
  routing: HookRouting
} {
  const stash = routing.pendingStopHooks
  if (!stash) return { fold: [], standalone: [], routing }
  const cleared: HookRouting = { ...routing, pendingStopHooks: undefined }
  const stale = stash.promptId != null && stash.promptId !== endingPromptId
  if (stale) {
    return {
      fold: [],
      standalone: stash.groups.map((g) => lifecycleEntry(g.event, g.runs)),
      routing: cleared,
    }
  }
  return { fold: stash.groups, standalone: [], routing: cleared }
}

/**
 * Empty the tool queue at turn end / session reset. A batch whose row never
 * arrived belonged to a call that is deliberately off screen (suppressed
 * plumbing tool, page-boundary orphan update); rendering it would invent a
 * tool row the user never sees, which is what TUI's silent drop avoids.
 */
export function clearPendingToolHooks(routing: HookRouting): HookRouting {
  if (!routing.pendingToolHooks.length) return routing
  return { ...routing, pendingToolHooks: [] }
}

/** Read the routing queues off a store snapshot (both are optional in tests). */
export function hookRoutingOf(s: {
  pendingToolHooks?: PendingToolHook[]
  pendingStopHooks?: PendingStopHooks
}): HookRouting {
  return {
    pendingToolHooks: s.pendingToolHooks ?? [],
    ...(s.pendingStopHooks ? { pendingStopHooks: s.pendingStopHooks } : {}),
  }
}

/** The store patch that commits routed queues back. */
export function hookRoutingPatch(routing: HookRouting): {
  pendingToolHooks: PendingToolHook[]
  pendingStopHooks?: PendingStopHooks
} {
  return {
    pendingToolHooks: routing.pendingToolHooks,
    pendingStopHooks: routing.pendingStopHooks,
  }
}

/**
 * TUI `push_turn_terminal_marker`: fold the turn-end stash into the marker a
 * turn end is about to push.
 *
 *  - A stash that belongs to the ending turn merges into the marker line
 *    (`stop  [hooks: 2]`, detail on expand).
 *  - A stale stash (provably another turn's) is emitted above the marker as
 *    standalone lifecycle rows, so nothing disappears onto the wrong turn.
 *  - `marker === null` (this site does not push a marker — bash turns, no
 *    output, or a marker a different rail owns) holds the stash: a later
 *    marker in the same turn still folds it, and the stale rule above keeps it
 *    from ever landing on another turn's row.
 */
export function withTurnTerminalMarker(
  routing: HookRouting,
  marker: Extract<ScrollEntry, { kind: 'session_event' }> | null,
  endingPromptId: string | undefined,
): { entries: ScrollEntry[]; routing: HookRouting } {
  if (!marker) return { entries: [], routing }
  const drained = drainPendingStopHooks(routing, endingPromptId)
  const tail = [...drained.standalone]
  // TUI `push_end_marker_block` keeps the marker's pid even when nothing
  // folds — a late stamped stop batch re-attaching to the tail needs it for
  // the attribution check, so never leave the marker unstamped.
  const markerBase =
    endingPromptId != null && marker.promptId == null
      ? { ...marker, promptId: endingPromptId }
      : marker
  tail.push(
    drained.fold.length
      ? {
          ...markerBase,
          stopHooks: [...(markerBase.stopHooks ?? []), ...drained.fold],
          // The summary is the resting state; per-hook detail on expand.
          open: false,
        }
      : markerBase,
  )
  return { entries: tail, routing: drained.routing }
}
