/**
 * Hook batch → scrollback attachment (TUI `scrollback/state/mod.rs`
 * `last_tool_call_entry_id` / `attach_hooks` / `push_lifecycle_hooks` /
 * `latest_turn_marker_accepting` / `attach_stop_hooks_to_marker`).
 *
 * Pure functions over the entry list, so live events and history replay share
 * one routing rule and both are testable without a store.
 *
 * One deliberate improvement over the TUI: the wire announces a tool's
 * `pre_tool_use` batch BEFORE the `tool_call` envelope that creates the row
 * (observed in persisted history), so a purely positional "last tool row"
 * attach would land the batch on the PREVIOUS call. Batches that cannot find
 * their own row are queued by tool name (`toolHookTargetId` returns undefined)
 * and claimed by the row when it appears — see `claimPendingToolHooks`.
 */
import type { HookGroup, HookRun, ScrollEntry, ToolCall, ToolHookData } from '../../api/types'
import { nid } from './ids'
import { toolTitle } from './tools'

/** Tool-call phase a batch belongs to (TUI HookPhase). */
export type HookPhase = 'pre' | 'post'

/** A tool-hook batch waiting for the row it gates. */
export type PendingToolHook = {
  phase: HookPhase
  /** Wire `tool_name` — the claim key; unset matches any new row. */
  toolName?: string
  runs: HookRun[]
}

/**
 * Turn-end (`stop` family) batches held for the live turn's marker (TUI
 * `PendingStopHooks`).
 */
export type PendingStopHooks = {
  /** The turn the stash belongs to; a stash that cannot be matched to the
   *  ending turn flushes standalone instead of attaching to its marker. */
  promptId?: string
  /** `(event, runs)` per batch in arrival order (`stop_failure` before `stop`
   *  on error turns). */
  groups: HookGroup[]
  /** Whether a repeat of the same event name merges into the existing group —
   *  only batches that actually carried a prompt id are trusted for that. */
  mergeSameName: boolean
}

/**
 * TUI `last_tool_call_entry_id` — the last REAL tool row. `lifecycle` rows
 * look like tool rows but are hook chrome, so a tool batch never misattaches
 * to them (that is the whole reason lifecycle events get their own row).
 */
export function lastToolCallEntryId(entries: ScrollEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === 'tool') return entries[i].id
  }
  return undefined
}

/** Function names a tool row is known by, lowercased, best-effort. */
export function toolNameKeys(e: Extract<ScrollEntry, { kind: 'tool' }>): string[] {
  const raw = e.raw as ToolCall | undefined
  const meta = (raw?._meta ?? (raw as { meta?: unknown } | undefined)?.meta) as
    | Record<string, unknown>
    | undefined
  const ext = meta?.['x.ai/tool'] as { name?: unknown } | undefined
  const names = [
    typeof ext?.name === 'string' ? ext.name : undefined,
    raw ? toolTitle(raw) : undefined,
    e.kindName,
    // The agent's hook tool_name is the function name; some gateways put it
    // in the call id (`call-…-0` style ids never match, others may).
    e.toolCallId,
  ]
  const out: string[] = []
  for (const n of names) {
    const v = typeof n === 'string' ? n.trim().toLowerCase() : ''
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** Whether this row is the call the batch gated. */
function rowGatesTool(e: ScrollEntry, toolName: string): boolean {
  if (e.kind !== 'tool') return false
  const needle = toolName.trim().toLowerCase()
  if (!needle) return false
  return toolNameKeys(e).some((k) => k === needle || k.endsWith(`:${needle}`))
}

/**
 * Target row for a tool-hook batch: the newest row that belongs to the gated
 * tool. Without a name match the positional fallback (TUI's rule) is only
 * trusted while that row is still in flight — a completed, differently-named
 * row is proof the batch belongs to a call that has not been announced yet.
 */
export function toolHookTargetId(
  entries: ScrollEntry[],
  phase: HookPhase,
  toolName?: string,
): string | undefined {
  void phase
  if (toolName) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (rowGatesTool(entries[i], toolName)) return entries[i].id
    }
  }
  const lastId = lastToolCallEntryId(entries)
  if (!lastId) return undefined
  if (!toolName) return lastId
  const last = entries.find((e) => e.id === lastId)
  const inFlight =
    last?.kind === 'tool' && (last.status === 'pending' || last.status === 'in_progress')
  return inFlight ? lastId : undefined
}

/**
 * TUI `attach_hooks` — set (never append) the phase's runs: one batch per
 * phase per call, so a re-delivery of the same batch stays idempotent.
 */
export function attachToolHooks(
  entries: ScrollEntry[],
  entryId: string,
  phase: HookPhase,
  runs: HookRun[],
): ScrollEntry[] {
  return entries.map((e) => {
    if (e.id !== entryId || e.kind !== 'tool') return e
    const hooks: ToolHookData = { ...(e.hooks ?? {}) }
    if (phase === 'pre') hooks.pre = runs
    else hooks.post = runs
    return { ...e, hooks }
  })
}

/**
 * Claim queued batches whose tool this freshly created row belongs to (TUI has
 * no equivalent — see this module's header). Keeps the queue immutable-friendly.
 */
export function claimPendingToolHooks(
  entries: ScrollEntry[],
  entry: ScrollEntry,
  pending: PendingToolHook[],
): { entries: ScrollEntry[]; pending: PendingToolHook[] } {
  if (!pending.length) return { entries, pending }
  const mine = pending.filter((p) => !p.toolName || rowGatesTool(entry, p.toolName))
  if (!mine.length) return { entries, pending }
  let next = entries
  for (const p of mine) {
    next = attachToolHooks(next, entry.id, p.phase, p.runs)
  }
  return { entries: next, pending: pending.filter((p) => !mine.includes(p)) }
}

/** TUI `push_lifecycle_hooks` — a standalone lifecycle row for one batch. */
export function lifecycleEntry(event: string, runs: HookRun[]): ScrollEntry {
  return { id: nid(), kind: 'lifecycle', event, runs, expanded: false }
}

/**
 * Turn-terminal marker ("Worked for Xs" / "Turn completed." / "Turn
 * cancelled …" / "Turn failed …") — TUI `SessionEvent::is_turn_terminal`. The
 * FE has no typed marker, so the marker text IS the identity; the idle-watcher
 * cue ("… still running") is not terminal.
 */
export function isTurnTerminalMarker(e: ScrollEntry): boolean {
  if (e.kind !== 'session_event') return false
  const t = e.text
  return (
    t === 'Turn completed.' ||
    t.startsWith('Turn cancelled') ||
    t.startsWith('Turn failed') ||
    // TUI session_event.rs message() forms: HookDenied cancels and halts.
    t.startsWith('Turn blocked by a hook') ||
    t.startsWith('Agent was unable to make progress') ||
    t.startsWith('Worked for ')
  )
}

/**
 * TUI `latest_turn_marker_accepting` — the most recent turn-terminal marker
 * that can still accept a `stop`-family batch arriving after it (viewer order).
 * Blocks appended after the marker are skipped. A stamped batch needs the
 * marker to carry the same prompt id; an unstamped one is positional (the
 * marker must be the very last row) — without a prompt id there is no proof
 * it belongs any further back. A same-name repeat is always refused.
 */
export function latestTurnMarkerAccepting(
  entries: ScrollEntry[],
  event: string,
  batchPromptId: string | undefined,
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind !== 'session_event') continue
    if (!isTurnTerminalMarker(e)) continue
    const marker = e
    if (marker.stopHooks?.some((g) => g.event === event)) return undefined
    const accept =
      batchPromptId != null
        ? marker.promptId != null && marker.promptId === batchPromptId
        : i === entries.length - 1
    return accept ? marker.id : undefined
  }
  return undefined
}

/**
 * TUI `attach_stop_hooks_to_marker` — fold one turn-end batch into a
 * turn-terminal marker. Refuses (attached=false) when the target is not such a
 * marker or the batch belongs to a different turn, so a stray caller cannot
 * attach hooks to the wrong entry.
 */
export function attachStopHooksToMarker(
  entries: ScrollEntry[],
  entryId: string,
  group: HookGroup,
  batchPromptId: string | undefined,
): { entries: ScrollEntry[]; attached: boolean } {
  const target = entries.find((e) => e.id === entryId)
  if (!target || target.kind !== 'session_event' || !isTurnTerminalMarker(target)) {
    return { entries, attached: false }
  }
  const attributable = batchPromptId != null ? target.promptId === batchPromptId : true
  if (!attributable) return { entries, attached: false }
  return attachStopHookGroups(entries, entryId, [group])
}

/** Fold a list of groups into a marker row and rest it in the folded state. */
export function attachStopHookGroups(
  entries: ScrollEntry[],
  entryId: string,
  groups: HookGroup[],
): { entries: ScrollEntry[]; attached: boolean } {
  if (!groups.length) return { entries, attached: false }
  return {
    entries: entries.map((e) =>
      e.id === entryId && e.kind === 'session_event'
        ? {
            ...e,
            stopHooks: [...(e.stopHooks ?? []), ...groups],
            // The summary is the resting state — but a row the user has
            // already expanded (TUI `display_mode_pinned` approximation)
            // keeps its view; only fold rows still at the collapsed default.
            ...(e.open ? {} : { open: false }),
          }
        : e,
    ),
    attached: true,
  }
}
