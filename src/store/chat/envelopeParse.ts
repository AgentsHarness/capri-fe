import type { AcpEvent, ScrollEntry, ToolCall } from '../../api/types'
import { contentText } from './format'

export function historicalTaskEvent(
  up: Record<string, unknown>,
): { kind: 'started' | 'completed'; title: string; taskId?: string; command?: string; isMonitor?: boolean; failed?: boolean; output?: string } | null {
  const titleOf = (v: unknown): string => {
    const s = typeof v === 'string' ? v.trim() : ''
    return s ? s.slice(0, 80) : ''
  }
  if (up.sessionUpdate === 'task_backgrounded') {
    const monitor = titleOf(up.monitor_description) || titleOf(up.monitorDescription)
    const command = titleOf(up.command)
    return {
      kind: 'started',
      taskId: titleOf(up.task_id) || undefined,
      title:
        monitor ||
        titleOf(up.description) ||
        command ||
        'Task',
      command: command || undefined,
      isMonitor: !!monitor,
    }
  }
  if (up.sessionUpdate === 'task_completed') {
    const snap = (up.task_snapshot ?? {}) as Record<string, unknown>
    const title =
      titleOf(snap.description) ||
      titleOf(snap.display_command) ||
      titleOf(snap.displayCommand) ||
      titleOf(snap.command) ||
      'Task'
    const code = typeof snap.exit_code === 'number' ? snap.exit_code : undefined
    const sig = typeof snap.signal === 'string' && snap.signal ? snap.signal : undefined
    return {
      kind: 'completed',
      taskId: titleOf(snap.task_id) || undefined,
      title,
      command: titleOf(snap.display_command) || titleOf(snap.command) || undefined,
      failed: code != null && code !== 0 || !!sig,
      output: typeof snap.output === 'string' ? snap.output : undefined,
    }
  }
  return null
}

export type RawEnvelope = {
  method?: string
  params?: {
    sessionId?: string
    update?: Record<string, unknown>
    /** Session-accumulated token count (live bridge surfaces it as usage). */
    _meta?: Record<string, unknown>
  }
}

/**
 * Stored JSONL envelope time: {timestamp, method, params}. The shell writes
 * epoch seconds; accept epoch ms and RFC3339 strings defensively.
 */
export function envelopeTimestamp(env: RawEnvelope): number | undefined {
  const ts = (env as { timestamp?: unknown }).timestamp
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return ts > 1e11 ? ts : ts * 1000
  }
  if (typeof ts === 'string') {
    const ms = Date.parse(ts)
    return Number.isFinite(ms) ? ms : undefined
  }
  return undefined
}

/** Strip <fork-context>/<resume-context> wrappers from user message text. */
export function stripContextWrappers(text: string): string {
  for (const tag of ['fork-context', 'resume-context']) {
    const open = `<${tag}>`
    const closeTag = `</${tag}>`
    for (;;) {
      const s = text.indexOf(open)
      if (s < 0) break
      const rel = text.slice(s + open.length).indexOf(closeTag)
      if (rel < 0) break
      const end = s + open.length + rel
      text = text.slice(0, s) + text.slice(end + closeTag.length).trimStart()
    }
  }
  return text
}

/**
 * TUI extract_cron_prompt_body — pull the raw prompt out of
 * format_scheduled_task_prompt framing:
 *   <system-reminder>\nThis is a scheduled task execution…\n</system-reminder>\n\n{prompt}
 * Returns null when the text is not cron-framed.
 */
export function extractCronPromptBody(text: string): string | null {
  if (!text.startsWith('<system-reminder>')) return null
  const endTag = '</system-reminder>'
  const close = text.indexOf(endTag)
  if (close < 0) return null
  const header = text.slice(0, close)
  if (!header.includes('scheduled task execution')) return null
  const body = text.slice(close + endTag.length).trim()
  return body || null
}

/**
 * TUI user_message_hidden_from_scrollback (legacy text-shape arm).
 * Cron is handled earlier by extractCronPromptBody; everything else under
 * <system-reminder> / monitor XML / drain separators stays out of scrollback.
 */
export function userMessageHiddenFromScrollback(text: string): boolean {
  const t = text.trimStart()
  if (t.startsWith('<system-reminder>')) return true
  if (t.startsWith('<monitor-event')) return true
  if (t.trim() === '---') return true
  const first = t.split('\n', 1)[0] ?? ''
  if (
    first.length > 0 &&
    first[0] >= '0' &&
    first[0] <= '9' &&
    first.includes(' monitor events from ') &&
    first.includes(' (use ')
  ) {
    return true
  }
  return false
}

/**
 * Classify a user-message body the way TUI handle_user_message does.
 * Returns null when the chunk must not become a scrollback row.
 */
export function classifyUserPrompt(
  raw: string,
  forcedCron?: boolean,
): { text: string; isCron: boolean } | null {
  const text = stripContextWrappers(raw)
  if (!text) return null
  if (forcedCron) return { text, isCron: true }
  const cronBody = extractCronPromptBody(text)
  if (cronBody != null) return { text: cronBody, isCron: true }
  if (userMessageHiddenFromScrollback(text)) return null
  return { text, isCron: false }
}

/** Normalize user prompt text for optimistic-echo equality checks. */
export function normalizeUserPromptText(text: string): string {
  let t = stripContextWrappers(text).trim()
  // Agent may echo the model-facing <user_query> envelope; send() stores raw input.
  const open = '<user_query>'
  const close = '</user_query>'
  if (t.startsWith(open)) {
    const end = t.endsWith(close)
      ? t.length - close.length
      : t.indexOf(close) > 0
        ? t.indexOf(close)
        : -1
    if (end > open.length) {
      t = t.slice(open.length, end).replace(/^\n/, '').replace(/\n$/, '').trim()
    }
  }
  return t
}

export function userPromptTextsMatch(a: string, b: string): boolean {
  if (a === b) return true
  return normalizeUserPromptText(a) === normalizeUserPromptText(b)
}

/**
 * Index of the optimistic user row that a live user_chunk should merge into.
 * Prefer the pending id from send(); fall back to a trailing user whose text
 * matches (thought shells between user and the end are ignored).
 */
export function findOptimisticUserAbsorbIndex(
  entries: ScrollEntry[],
  pendingId: string | undefined,
  echoText: string,
): number {
  if (pendingId) {
    const byId = entries.findIndex((e) => e.id === pendingId && e.kind === 'user')
    if (byId >= 0) return byId
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'thought') continue
    if (e.kind === 'user' && userPromptTextsMatch(e.text, echoText)) return i
    return -1
  }
  return -1
}

/**
 * Convert one stored session/update envelope into the AcpEvent the live
 * pipeline understands, or null when it carries no renderable content.
 */
export function envelopeToEvent(env: unknown): AcpEvent | null {
  const e = env as RawEnvelope
  if (!e || (e.method !== 'session/update' && e.method !== '_x.ai/session/update')) {
    return null
  }
  const up = e.params?.update
  if (!up) return null
  // x.ai carrier (`_x.ai/session/update` on the wire): the live bridge
  // unwraps it and routes EVERY kind through the session_notification
  // channel (subagent/task/recap/retry/hook/model_changed/…). Replay must
  // do the same or those blocks silently vanish from loaded history.
  // Turn-end markers are the exception: they finalize streaming blocks.
  if (e.method === '_x.ai/session/update') {
    if (up.sessionUpdate === 'turn_completed' || up.sessionUpdate === 'response_completed') {
      return turnCompletedEvent(up, completionEndMs(e))
    }
    // Display-only task rows under the x.ai carrier too (same look as live).
    const taskEv = historicalTaskEvent(up)
    if (taskEv) return { type: 'task_lifecycle', ...taskEv }
    return { type: 'session_notification', method: e.method, params: e.params }
  }
  switch (up.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = contentText(up.content)
      if (!text) return null
      return { type: 'chunk', text, ts: envelopeTimestamp(e) }
    }
    case 'agent_thought_chunk': {
      const text = contentText(up.content)
      if (!text) return null
      // TUI replay parity (NotificationMeta): the persisted envelope's
      // `_meta` keeps the ORIGINAL timestamps, so the replayed thought can
      // seal with the real duration instead of the replay wall-clock
      // (~0ms → bogus "Thought for 0.0s"). Graceful: old envelopes without
      // meta fall back to the local timer path.
      const meta = (e.params?._meta ?? {}) as Record<string, unknown>
      const agentTs =
        typeof meta.agentTimestampMs === 'number' ? meta.agentTimestampMs : undefined
      const streamStart =
        typeof meta.streamStartMs === 'number' ? meta.streamStartMs : undefined
      const elapsedMs =
        agentTs != null && streamStart != null && agentTs >= streamStart
          ? agentTs - streamStart
          : undefined
      return elapsedMs != null
        ? { type: 'thought', text, elapsedMs }
        : { type: 'thought', text }
    }
    case 'user_message_chunk': {
      // Prefer content-block / chunk meta (TUI user_prompt_meta +
      // user_message_chunk_meta); fall back to text-shape classification.
      // Wire shape: update._meta = ContentChunk.meta (hideFromScrollback);
      // content._meta = TextContent.meta (displayText / displayAsCron).
      const chunkMeta = (up._meta ?? up.meta) as Record<string, unknown> | undefined
      if (chunkMeta?.hideFromScrollback === true) return null
      const content = up.content as Record<string, unknown> | undefined
      const blockMeta =
        content && typeof content === 'object'
          ? ((content._meta ?? content.meta) as Record<string, unknown> | undefined)
          : undefined
      if (blockMeta?.hideFromScrollback === true) return null
      const displayText =
        typeof blockMeta?.displayText === 'string' ? blockMeta.displayText : undefined
      const displayAsCron = blockMeta?.displayAsCron === true
      const raw = displayText ?? contentText(up.content)
      if (!raw) return null
      // Pre-classify so history aggregation still carries isCron across chunks
      // that already have displayAsCron; text-shape cron framing is applied
      // after flush (full buffered text) in handleEvent.
      const classified = classifyUserPrompt(raw, displayAsCron)
      if (!classified) return null
      return {
        type: 'user_message',
        text: classified.text,
        isCron: classified.isCron || undefined,
        ts: envelopeTimestamp(e),
      }
    }
    case 'tool_call':
      return { type: 'tool_call', toolCall: up as unknown as ToolCall }
    case 'tool_call_update':
      return { type: 'tool_call_update', toolCallUpdate: up as unknown as ToolCall }
    case 'plan':
      return { type: 'plan', entries: up.entries }
    case 'usage_update':
      return {
        type: 'usage',
        used: up.used as number | undefined,
        size: up.size as number | undefined,
        cost: up.cost,
      }
    case 'current_mode_update': {
      // The stored envelope carries {currentModeId} directly on the update
      // (the session/new|load `modes` shape), NOT inside modeState — the
      // old mapping read up.modeState, so plan/permission mode never
      // survived history replay. Feed either shape through extractModeFlags.
      const ms =
        up.modeState ??
        (typeof up.currentModeId === 'string'
          ? { currentModeId: up.currentModeId }
          : undefined)
      return ms ? { type: 'modes_update', modes: ms } : null
    }
    case 'config_option_update':
      return { type: 'config_options_update', configOptions: up.configOptions }
    case 'session_info_update': {
      // 存储包络的 _meta 带 x.ai/titleIsManual（true=手动改名，false=
      // /rename --auto 结果，缺省=自动标题）——随事件带给消费端
      // （extMisc session_info case 据此阻止自动标题覆盖手动改名）。
      const meta = (e.params?._meta ?? {}) as Record<string, unknown>
      const titleIsManual = meta['x.ai/titleIsManual']
      return {
        type: 'session_info',
        title: up.title as string | undefined,
        ...(typeof titleIsManual === 'boolean' ? { titleIsManual } : {}),
      }
    }
    // Stored task lifecycle events render as display-only bg_task rows
    // in history (same look as live, never captured into the task
    // system): the live running set is established once at resume via
    // the host liveness probe; a captured row for a long-dead task would
    // stick as "running" forever.
    case 'task_backgrounded':
    case 'task_completed': {
      const taskEv = historicalTaskEvent(up)
      return taskEv ? { type: 'task_lifecycle', ...taskEv } : null
    }
    // Turn-end markers: every finished turn is stored with its closing
    // turn_completed (some builds use response_completed). Without it the
    // replayed scrollback would keep the turn's last thought/assistant
    // streaming forever — "stuck mid-thinking" after resuming history.
    case 'turn_completed':
    case 'response_completed':
      return turnCompletedEvent(up, completionEndMs(e))
    default:
      // Standard carrier lifecycle kinds: route through the same
      // session_notification channel as the live bridge's default arm
      // (subagent/task/monitor/response/compact/recap/…).
      return {
        type: 'session_notification',
        method: e.method,
        params: e.params,
      }
  }
}

/**
 * Completion end stamp: the completion envelope's own `_meta.agentTimestampMs`
 * (ms precision, the agent's turn-end time — the same stamp the TUI's
 * anchored elapsed reads). Falls back to the envelope write timestamp
 * (coarse seconds) for old logs without meta.
 */
export function completionEndMs(e: RawEnvelope): number | undefined {
  const meta = (e.params?._meta ?? {}) as Record<string, unknown>
  const ats = meta.agentTimestampMs
  if (typeof ats === 'number' && Number.isFinite(ats) && ats > 0) return ats
  if (typeof ats === 'string') {
    const p = Date.parse(ats)
    if (Number.isFinite(p)) return p
  }
  return envelopeTimestamp(e)
}

/**
 * Build the typed `turn_completed` event from a stored envelope's update.
 * Carries the turn's stop_reason / agent_result (so replay can render the
 * correct marker — TurnFailed / TurnCancelled / Worked for — instead of a
 * blanket "Turn completed.") plus the completion's agentTimestampMs as the
 * turn's end stamp (replayUpdates injects the real start from the meta).
 */
export function turnCompletedEvent(
  up: Record<string, unknown>,
  endMs: number | undefined,
): AcpEvent {
  return {
    type: 'turn_completed',
    stopReason: typeof up.stop_reason === 'string' ? up.stop_reason : undefined,
    agentResult:
      typeof up.agent_result === 'string' ? up.agent_result : undefined,
    endMs,
  }
}
