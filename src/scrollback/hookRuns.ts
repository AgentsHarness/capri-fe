/**
 * Hook runs — TUI `app/acp_handler/session_notification.rs` (parse + the one
 * line a failed run gets).
 *
 * Since the 1.0.41 "Hooks UI" change, hook runs are no longer drawn as rows of
 * their own. A run that succeeded leaves no trace; a run that failed gets one
 * `HookOutcome` line; a run the agent denied is already annotated by the shell
 * (`HookAnnotation` with `kind: "tool_outcome"`). Nothing attaches to tool
 * rows, turn markers, or lifecycle rows.
 *
 * Wire (persisted + live, `extensions/notification.rs`):
 *   {"sessionUpdate":"hook_execution","event_name":"post_tool_use",
 *    "tool_name":"list_dir","prompt_id":"…","runs":[
 *      {"name":"global/probe:post_tool_use[0].hooks[0]",
 *       "status":{"status":"failed","error":"…","blocked":false}}]}
 * The run `status` is a tagged enum. Shells in the wild were observed in
 * three spellings — `{"status":{"status":"success",…}}` (nested internal tag,
 * live 1.0.13), `{"status":"success","elapsed_ms":6}` (fields hoisted onto the
 * run) and `{"Success":{"elapsed_ms":6}}` (external tag) — and both
 * `elapsed_ms` and `elapsedMs` occur, so all of them parse.
 */
import type { HookRun, HookRunStatus } from '../api/types'

/** A parsed `hook_execution` batch — the unit a failure line is derived from. */
export type HookExecutionBatch = {
  /** Wire `event_name`, verbatim (names the failed run's line). */
  event: string
  /** Wire `tool_name` — the tool the batch gated (tool hooks only). */
  toolName?: string
  /** Wire `prompt_id` — the turn the batch belongs to (gates the spinner). */
  promptId?: string
  runs: HookRun[]
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
 * a stop-gate decision is not an error, and the shell annotates it, so it
 * never reaches the failure line.
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
 * batches; re-checking here keeps replayed history from inventing lines.
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

// ── The one line a failed run gets (TUI `failed_hook_line`) ───────────

/**
 * `HookProvenance::config_label` values that name a config tier rather than a
 * hook. `xai-grok-config`'s `from_config_label` matches these exact labels,
 * which is why `global/…` (a real name) stays named while `requirements/…`
 * does not.
 */
const CONFIG_TIER_LABELS: ReadonlySet<string> = new Set([
  'system_managed',
  'managed',
  'requirements/system',
  'requirements/signed',
  'requirements/user',
  'user',
])

/**
 * TUI `strip_spec_path` — `{source}:{event}[i].hooks[j]` becomes `{source}`;
 * anything else is unchanged.
 */
export function stripSpecPath(qualified: string): string {
  const sep = qualified.lastIndexOf(':')
  if (sep <= 0) return qualified
  return isSpecPath(qualified.slice(sep + 1)) ? qualified.slice(0, sep) : qualified
}

/** TUI `is_spec_path` — the `{event}[{i}].hooks[{j}]` shape the parsers stamp. */
function isSpecPath(tail: string): boolean {
  const open = tail.indexOf('[')
  if (open <= 0) return false
  const event = tail.slice(0, open)
  const rest = tail.slice(open + 1)
  const hooksAt = rest.indexOf('].hooks[')
  if (hooksAt < 0) return false
  const eventIdx = rest.slice(0, hooksAt)
  const hookIdx = rest.slice(hooksAt + '].hooks['.length)
  if (!hookIdx.endsWith(']')) return false
  const isIndex = (s: string) => s !== '' && /^[0-9]+$/.test(s)
  return (
    isIndex(eventIdx) &&
    isIndex(hookIdx.slice(0, -1)) &&
    /^[a-z_]+$/.test(event)
  )
}

/**
 * TUI `HookDisplayName::Named` — the user-facing name of a hook, or null when
 * the source is a config tier. A tier's stamped spec path means nothing to the
 * user, so its failure line names only the event (TUI `failed_hook_line`).
 *
 * The deny annotation needs the other form ("a managed policy hook" for a
 * tier), but the shell renders that copy into the message before sending it,
 * so the view only ever reads this one.
 */
export function hookDisplayName(qualified: string): string | null {
  const source = stripSpecPath(qualified)
  return CONFIG_TIER_LABELS.has(source) ? null : source
}

/**
 * TUI `failed_hook_line` — the one scrollback line a failed run gets.
 * Success gets none, and a deny is already annotated by the shell, so only a
 * non-blocked `failed` maps to a line. `"ignored"` is literal: hook failures
 * are fail-open, so the tool call or turn proceeds as if the hook had allowed.
 */
export function failedHookLine(event: string, run: HookRun): string | null {
  if (run.status.type !== 'failed') return null
  const name = hookDisplayName(run.name)
  const subject = name ? `${event} hook (${name})` : `${event} hook`
  const error = (run.status.error.split('\n')[0] ?? '').trim()
  return error ? `${subject} failed, ignored: ${error}` : `${subject} failed, ignored`
}

/** Every failed-run line of a batch, in wire order (the handler appends them). */
export function failedHookLines(batch: HookExecutionBatch): string[] {
  return batch.runs
    .map((run) => failedHookLine(batch.event, run))
    .filter((line): line is string => line != null)
}

// ── Hook annotation prose (TUI `SessionEvent::HookAnnotation`) ─────────

/**
 * What a `HookAnnotation` is (wire `kind`), so the row can pick its bullet:
 * a deny is the tool call's verdict and takes the tool-row bullet, a plain
 * note renders as muted chrome with none.
 */
export type HookAnnotationKind = 'note' | 'tool_outcome'

export function hookAnnotationKind(raw: unknown): HookAnnotationKind {
  return typeof raw === 'string' && raw.toLowerCase() === 'tool_outcome'
    ? 'tool_outcome'
    : 'note'
}

/** Which lead mark a hook note opens with. */
export type HookAnnotationLead = 'warning' | 'blocked' | null

/**
 * Older shells prefix their annotations with a lead glyph — `⚠` (U+26A0) for
 * deny / block / hold notices and `↩` (U+21A9) for stop-gate continuations.
 * 1.0.41+ dropped the glyph for denies (the tool-row bullet carries the
 * meaning), but replayed history still has it, so split it off and let the
 * view draw a real icon instead of a font-dependent character.
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
