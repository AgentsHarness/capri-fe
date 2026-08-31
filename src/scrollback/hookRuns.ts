/**
 * Hook runs — TUI `scrollback/blocks/tool/hook.rs` port (parse + counts +
 * suffix text).
 *
 * Hook runs are displayed as part of tool call blocks rather than as
 * standalone scrollback entries: the tool header comes first, then
 * pre_tool_use, then post_tool_use. Turn-end batches (`stop` family) fold
 * into the turn-terminal marker line, and every other lifecycle event gets a
 * `lifecycle` row of its own.
 *
 * Wire (persisted + live, `extensions/notification.rs`):
 *   {"sessionUpdate":"hook_execution","event_name":"post_tool_use",
 *    "tool_name":"list_dir","prompt_id":"…","runs":[
 *      {"name":"global/probe:post_tool_use[0].hooks[0]",
 *       "status":{"status":"success","elapsed_ms":6}}]}
 * The run `status` is a tagged enum. Shells in the wild were observed in
 * three spellings — `{"status":{"status":"success",…}}` (nested internal tag,
 * live 1.0.13), `{"status":"success","elapsed_ms":6}` (fields hoisted onto the
 * run) and `{"Success":{"elapsed_ms":6}}` (external tag) — and both
 * `elapsed_ms` and `elapsedMs` occur, so all of them parse.
 */
import type {
  HookCounts,
  HookGroup,
  HookRun,
  HookRunStatus,
  HookSuffixPart,
  ToolHookData,
} from '../api/types'

/** A parsed `hook_execution` batch — one scrollback attachment unit. */
export type HookExecutionBatch = {
  /** Wire `event_name`, verbatim (what a lifecycle row shows as its header). */
  event: string
  /** Wire `tool_name` — the tool the batch gated (tool hooks only). */
  toolName?: string
  /** Wire `prompt_id` — the turn the batch belongs to (gates marker merges). */
  promptId?: string
  runs: HookRun[]
}

/** TUI `render_hooks_expanded` text budget: 120 columns × 3 lines. */
export const HOOK_TEXT_MAX_COLS = 120
export const HOOK_TEXT_MAX_LINES = 3

/** Events that ride on a tool row (TUI `is_tool_hook`). */
export function isToolHookEvent(event: string): boolean {
  return event === 'pre_tool_use' || event === 'post_tool_use'
}

/**
 * TUI `HookEvent::is_turn_end` — the events that report a turn ending, at
 * most one of which fires per turn. Exhaustive on purpose: a fourth turn-end
 * event must be listed here to keep folding into the terminal marker.
 */
export function isTurnEndHookEvent(event: string): boolean {
  return event === 'stop' || event === 'stop_failure' || event === 'stop_cancelled'
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function metaNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  }
  return undefined
}

function truthy(value: unknown): boolean {
  return value === true || value === 'true' || value === 1
}

function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : ''
}

/** Read one status carrier: the tag, the elapsed ms, the error, blocked flag. */
function statusFields(carrier: Record<string, unknown>): {
  tag: string
  elapsedMs?: number
  error?: string
  blocked: boolean
} {
  const nested = (carrier.status ?? carrier.type ?? carrier.state) as unknown
  const tag = typeof nested === 'string' ? lower(nested) : lower(carrier.status)
  return {
    tag,
    elapsedMs: metaNumber(carrier.elapsed_ms, carrier.elapsedMs),
    error: nonBlank(carrier.error) ?? nonBlank(carrier.message) ?? nonBlank(carrier.reason),
    blocked:
      truthy(carrier.blocked) ||
      tag === 'blocked' ||
      lower(nonBlank(carrier.decision) ?? '').includes('deny'),
  }
}

/**
 * TUI maps a `Failed` run carrying `blocked: true` onto the Blocked status —
 * a stop-gate decision is not an error. `Skipped` runs never count anywhere.
 */
function toHookRunStatus(raw: unknown): HookRunStatus {
  // Bare string (`"skipped"`) or a payload object, in any of the three
  // spellings documented on this module.
  if (typeof raw === 'string') return statusToRun({ tag: lower(raw), blocked: false })
  if (!raw || typeof raw !== 'object') return { type: 'success' }
  const obj = raw as Record<string, unknown>

  // One more nesting level: {"status":{"status":"success",…}} and
  // {"status":{"Failed":{…}}} both hand us an object worth re-reading.
  const nested = obj.status
  if (nested && typeof nested === 'object') return toHookRunStatus(nested)

  // Externally tagged: {"Failed": {…}} / {"Success": {…}} / {"Skipped": null}.
  // A tagged payload is always an object or null, so a same-named scalar key
  // (`blocked: true` rides on the internally tagged form) never matches.
  const outerKey = Object.keys(obj).find(
    (k) =>
      ['success', 'skipped', 'failed', 'blocked'].includes(k.toLowerCase()) &&
      (obj[k] === null || typeof obj[k] === 'object'),
  )
  if (outerKey) {
    const payload = (obj[outerKey] ?? {}) as Record<string, unknown>
    return statusToRun(statusFields({ ...payload, status: outerKey }))
  }
  return statusToRun(statusFields(obj))
}

function statusToRun(f: ReturnType<typeof statusFields>): HookRunStatus {
  if (f.tag === 'skipped') return { type: 'skipped' }
  if (f.tag === 'failed' || f.tag === 'error' || f.blocked) {
    const error = f.error ?? ''
    if (f.blocked) return { type: 'blocked', detail: error, elapsedMs: f.elapsedMs }
    return { type: 'failed', error, elapsedMs: f.elapsedMs }
  }
  return { type: 'success', elapsedMs: f.elapsedMs }
}

/** Parse the wire `runs[]` array (defensively — a malformed entry is dropped). */
export function parseHookRuns(raw: unknown): HookRun[] {
  if (!Array.isArray(raw)) return []
  const runs: HookRun[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const name =
      nonBlank(obj.name) ?? nonBlank(obj.hook_name) ?? nonBlank(obj.hookName) ?? ''
    if (!name) continue
    // A string `status` is the hoisted (fields-on-the-run) spelling, so the
    // run object itself is the carrier; otherwise read the nested status.
    const carrier = typeof obj.status === 'string' ? obj : 'status' in obj ? obj.status : obj
    const output = nonBlank(obj.output) ?? nonBlank(obj.output_text)
    runs.push({ name, status: toHookRunStatus(carrier), ...(output ? { output } : {}) })
  }
  return runs
}

/**
 * Parse a `hook_execution` update payload. Returns null when the batch has
 * nothing to render — TUI's sender already drops empty and all-skipped
 * batches; re-checking here keeps replayed history from inventing rows.
 */
export function parseHookExecution(fields: Record<string, unknown>): HookExecutionBatch | null {
  const event =
    nonBlank(fields.event_name) ?? nonBlank(fields.eventName) ?? nonBlank(fields.event) ?? ''
  if (!event) return null
  const runs = parseHookRuns(fields.runs)
  if (!runs.some((r) => r.status.type !== 'skipped')) return null
  const toolName = nonBlank(fields.tool_name) ?? nonBlank(fields.toolName)
  const promptId = nonBlank(fields.prompt_id) ?? nonBlank(fields.promptId)
  return {
    event,
    ...(toolName ? { toolName } : {}),
    ...(promptId ? { promptId } : {}),
    runs,
  }
}

// ── Counts (TUI HookRunCounts) ────────────────────────────────────────

export function emptyHookCounts(): HookCounts {
  return { success: 0, blocked: 0, failed: 0 }
}

export function addHookCounts(a: HookCounts, b: HookCounts): HookCounts {
  return { success: a.success + b.success, blocked: a.blocked + b.blocked, failed: a.failed + b.failed }
}

export function countHookRuns(runs: HookRun[] | undefined): HookCounts {
  const counts = emptyHookCounts()
  for (const run of runs ?? []) {
    if (run.status.type === 'success') counts.success += 1
    else if (run.status.type === 'blocked') counts.blocked += 1
    else if (run.status.type === 'failed') counts.failed += 1
  }
  return counts
}

export function countHookGroups(groups: HookGroup[] | undefined): HookCounts {
  let counts = emptyHookCounts()
  for (const group of groups ?? []) counts = addHookCounts(counts, countHookRuns(group.runs))
  return counts
}

/** TUI `HookRunCounts::total` — skipped runs are excluded everywhere. */
export function hookCountsTotal(counts: HookCounts): number {
  return counts.success + counts.blocked + counts.failed
}

/** Tool row hook data → the counts behind `[hooks: 2/1]`. */
export function countToolHooks(data: ToolHookData | undefined): HookCounts {
  if (!data) return emptyHookCounts()
  return addHookCounts(countHookRuns(data.pre), countHookRuns(data.post))
}

/** Whether a tool row's hook data has anything a fold would reveal. */
export function toolHooksHaveContent(data: ToolHookData | undefined): boolean {
  return hookCountsTotal(countToolHooks(data)) > 0
}

export function hookGroupsHaveContent(groups: HookGroup[] | undefined): boolean {
  return hookCountsTotal(countHookGroups(groups)) > 0
}

/** Aggregate counts over a group's members (TUI `HookRunCounts::add_data`). */
export function groupHookCounts(
  members: Array<{ hooks?: ToolHookData }>,
): HookCounts {
  let total = emptyHookCounts()
  for (const m of members) total = addHookCounts(total, countToolHooks(m.hooks))
  return total
}

// ── Suffix text (TUI render_hook_counts_inline_suffix) ───────────────

export type HookCountShape =
  /** Individual rows keep the completed/failed split: blocked completed
   *  normally and stays in the green numerator. */
  | 'compact'
  /** Aggregate rows name every outcome because no member detail is visible. */
  | 'labeled'

export function hookSuffixParts(
  counts: HookCounts,
  shape: HookCountShape,
): HookSuffixPart[] | null {
  if (hookCountsTotal(counts) === 0) return null
  const parts: HookSuffixPart[] = [{ text: '  [hooks: ', tone: 'muted' }]
  if (shape === 'compact') {
    const completed = counts.success + counts.blocked
    if (completed > 0) parts.push({ text: String(completed), tone: 'success' })
    if (completed > 0 && counts.failed > 0) parts.push({ text: '/', tone: 'muted' })
    if (counts.failed > 0) parts.push({ text: String(counts.failed), tone: 'error' })
  } else if (counts.blocked === 0 && counts.failed === 0) {
    parts.push({ text: String(counts.success), tone: 'success' })
  } else {
    const segments: [number, string, HookSuffixPart['tone']][] = [
      [counts.success, 'ok', 'success'],
      [counts.blocked, 'blocked', 'blocked'],
      [counts.failed, 'failed', 'error'],
    ]
    let first = true
    for (const [count, label, tone] of segments) {
      if (count === 0) continue
      if (!first) parts.push({ text: ', ', tone: 'muted' })
      first = false
      parts.push({ text: `${count} ${label}`, tone })
    }
  }
  parts.push({ text: ']', tone: 'muted' })
  return parts
}

/**
 * Right-side summary for stop hooks merged onto a turn-terminal marker line:
 * `stop  [hooks: 2]` per group, groups joined by two spaces (TUI
 * `render_stop_hooks_summary`). Null when nothing ran.
 */
export function stopHookSummaryParts(groups: HookGroup[] | undefined): HookSuffixPart[] | null {
  const spans: HookSuffixPart[] = []
  for (const group of groups ?? []) {
    const counts = hookSuffixParts(countHookRuns(group.runs), 'compact')
    if (!counts) continue
    if (spans.length) spans.push({ text: '  ', tone: 'muted' })
    // TUI: bold muted event name, then the compact suffix which already
    // starts with two spaces (`  [hooks: N]`).
    spans.push({ text: group.event, tone: 'muted', bold: true })
    spans.push(...counts)
  }
  return spans.length ? spans : null
}

/** Plain text of a suffix (tooltips, transcripts, tests). */
export function hookSuffixText(parts: HookSuffixPart[] | null): string {
  return parts?.map((p) => p.text).join('') ?? ''
}

// ── Expanded detail text helpers ──────────────────────────────────────

/** TUI `truncate_str` — width-based cut at 120 columns with a trailing `…`. */
export function truncateHookText(text: string, maxCols = HOOK_TEXT_MAX_COLS): string {
  let width = 0
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i) ?? 0
    const cw = cp > 0x1100 && (cp < 0x2000 || cp > 0x206f) ? 2 : 1
    if (width + cw > maxCols) {
      return `${text.slice(0, i)}…`
    }
    width += cw
    if (cp > 0xffff) i++
  }
  return text
}

/** A run's error / blocked detail / output, clipped to the TUI 3-line budget. */
export function hookTextLines(text: string): string[] {
  return truncateHookText(text)
    .split('\n')
    .filter((_, i) => i < HOOK_TEXT_MAX_LINES)
}

/**
 * TUI strips the redundant `hook '<name>' ` prefix from an error line before
 * rendering it (the runner already names the hook on the line above).
 */
export function cleanHookError(error: string, name: string): string {
  return error.startsWith(`hook '${name}' `) ? error.slice(`hook '${name}' `.length) : error
}

/** ` (12ms)` — TUI's elapsed suffix; skipped runs have none. */
export function hookElapsedLabel(elapsedMs: number | undefined): string {
  return elapsedMs != null ? ` (${Math.round(elapsedMs)}ms)` : ''
}

// ── Hook annotation prose (TUI `SessionEvent::HookAnnotation`) ─────────

/** Which lead mark the agent's own sentence opens with. */
export type HookAnnotationLead = 'warning' | 'blocked' | null

/**
 * The agent sends its hook annotations as one-line prose already carrying a
 * lead glyph — `⚠` (U+26A0) for deny / block / hold notices and `↩` (U+21A9)
 * for stop-gate continuations (xai-grok-shell `send_hook_annotation` call
 * sites). Split that glyph off so the view can draw a real icon instead of a
 * font-dependent character.
 */
export function splitHookAnnotation(text: string): {
  lead: HookAnnotationLead
  text: string
} {
  const m = /^([⚠]\uFE0F?|[↩])\s*/u.exec(text)
  if (!m) return { lead: null, text }
  return {
    lead: m[1] === '↩' ? 'blocked' : 'warning',
    text: text.slice(m[0].length),
  }
}
