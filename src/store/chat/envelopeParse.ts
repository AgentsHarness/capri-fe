import type { AcpEvent, ScrollEntry, ToolCall } from '../../api/types'

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

/**
 * The envelope's own agent timestamp (epoch ms), read from the same
 * `params._meta.agentTimestampMs` the semantic replay keys hash. Modern
 * shells stamp every envelope with it — the shell's coarse `timestamp`
 * is second-granularity and can fall BEHIND the ms timestamps of the
 * chunks inside the newest envelope, so dedupe boundaries must compare
 * live `agentTimestampMs` (ms) against this ms field, not the coarse
 * stamp (see loadHistory snapTail).
 */
export function envelopeAgentTimestampMs(env: unknown): number | undefined {
  const meta = envelopeMeta(env as RawEnvelope)
  const v = meta.agentTimestampMs
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function finiteMetaNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 回放归一化序号（host msgSeq 契约）：存储信封顶层 `msgSeq`，host 归一化
 * （agentTimestampMs → 文件行号，不读 eventId）后的会话内密集名次，0 起。
 * 旧 host / 回退透传路径不带该键 → undefined（FE 回退现有文件序行为）。
 */
export function envelopeMsgSeq(env: unknown): number | undefined {
  return finiteMetaNumber((env as { msgSeq?: unknown })?.msgSeq)
}

/**
 * 存储信封的 `params._meta.eventId`。host 仍把它提升到 live 事件顶层
 * （透传），但 live↔快照接缝不再用它当主键（N 会撞车）。
 */
export function envelopeEventId(env: unknown): string | undefined {
  const meta = (env as RawEnvelope)?.params?._meta
  const id = (meta as { eventId?: unknown } | undefined)?.eventId
  return typeof id === 'string' && id ? id : undefined
}

/**
 * Live-event eventId。host `attachStreamMeta` 把 `params._meta.eventId`
 * 提升为顶层字段；嵌套 `params._meta` / `update._meta` 也接受。
 * 接缝去重走语义键 + snapTail，不读这个字段。
 */
export function eventEventId(ev: unknown): string | undefined {
  if (!ev || typeof ev !== 'object') return undefined
  const e = ev as Record<string, unknown>
  if (typeof e.eventId === 'string' && e.eventId) return e.eventId
  const params = e.params
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const p = params as Record<string, unknown>
    const fromParams = (p._meta as { eventId?: unknown } | undefined)?.eventId
    if (typeof fromParams === 'string' && fromParams) return fromParams
    const update = p.update
    if (update && typeof update === 'object' && !Array.isArray(update)) {
      const fromUpdate = ((update as Record<string, unknown>)._meta as { eventId?: unknown } | undefined)
        ?.eventId
      if (typeof fromUpdate === 'string' && fromUpdate) return fromUpdate
    }
  }
  const update = e.update
  if (update && typeof update === 'object' && !Array.isArray(update)) {
    const fromUpdate = ((update as Record<string, unknown>)._meta as { eventId?: unknown } | undefined)
      ?.eventId
    if (typeof fromUpdate === 'string' && fromUpdate) return fromUpdate
  }
  return undefined
}

/**
 * Live-event agent timestamp (epoch ms). Host forwards `_meta.agentTimestampMs`
 * as a top-level field on chunk / user_chunk / thought; nested `params._meta`
 * / `update._meta` are accepted so gap-pull frames still compare against
 * loadHistory's snapTail.
 */
export function eventAgentTimestampMs(ev: unknown): number | undefined {
  if (!ev || typeof ev !== 'object') return undefined
  const e = ev as Record<string, unknown>
  const direct = finiteMetaNumber(e.agentTimestampMs)
  if (direct != null) return direct
  const params = e.params
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const p = params as Record<string, unknown>
    const fromParams = finiteMetaNumber(
      (p._meta as Record<string, unknown> | undefined)?.agentTimestampMs,
    )
    if (fromParams != null) return fromParams
    const update = p.update
    if (update && typeof update === 'object' && !Array.isArray(update)) {
      const fromUpdate = finiteMetaNumber(
        ((update as Record<string, unknown>)._meta as Record<string, unknown> | undefined)
          ?.agentTimestampMs,
      )
      if (fromUpdate != null) return fromUpdate
    }
  }
  const update = e.update
  if (update && typeof update === 'object' && !Array.isArray(update)) {
    return finiteMetaNumber(
      ((update as Record<string, unknown>)._meta as Record<string, unknown> | undefined)
        ?.agentTimestampMs,
    )
  }
  return undefined
}

type ContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; data: string; mimeType?: string }

/** Preserve image blocks instead of treating their lack of text as empty content. */
function contentParts(value: unknown, out: ContentPart[] = []): ContentPart[] {
  if (typeof value === 'string') {
    out.push({ kind: 'text', text: value })
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) contentParts(item, out)
    return out
  }
  if (!value || typeof value !== 'object') return out
  const object = value as Record<string, unknown>
  if (object.type === 'image' && typeof object.data === 'string') {
    out.push({
      kind: 'image',
      data: object.data,
      mimeType:
        typeof object.mimeType === 'string'
          ? object.mimeType
          : typeof object.mime_type === 'string'
            ? object.mime_type
            : undefined,
    })
    return out
  }
  if (typeof object.text === 'string') {
    out.push({ kind: 'text', text: object.text })
    return out
  }
  if ('content' in object) contentParts(object.content, out)
  return out
}

function stableReplayJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableReplayJson).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .filter((key) => key !== '_meta')
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableReplayJson(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(String(value))
}

function toolReplayPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const object = { ...(value as Record<string, unknown>) }
  delete object.sessionUpdate
  delete object._meta
  return object
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
    // Closed-turn chrome sits after the last user ("Worked for Xs"). Walk
    // past it so a recap echo can still merge; do NOT walk past assistant
    // / tool content — that would absorb a repeated prompt into the
    // previous turn.
    if (e.kind === 'session_event' || e.kind === 'status' || e.kind === 'error') {
      continue
    }
    if (e.kind === 'user' && userPromptTextsMatch(e.text, echoText)) return i
    return -1
  }
  return -1
}

/**
 * Convert one stored session/update envelope into the AcpEvent the live
 * pipeline understands, or null when it carries no renderable content.
 */
function replayImageKey(
  data: string,
  mimeType: string | undefined,
): string {
  return `image:${stableReplayJson({ data, mimeType })}`
}

function replayUpdateKeys(
  up: Record<string, unknown>,
  envelopeMeta?: Record<string, unknown>,
): string[] {
  const kind = typeof up.sessionUpdate === 'string' ? up.sessionUpdate : undefined
  const meta = {
    ...(envelopeMeta ?? {}),
    ...((up._meta ?? {}) as Record<string, unknown>),
  }
  const agentTimestampMs = finiteMetaNumber(meta.agentTimestampMs)
  const parts = contentParts(up.content)
  const textKey = (prefix: string, text: string, isCron?: boolean) =>
    `${prefix}:${stableReplayJson({
      text,
      ...(isCron ? { isCron: true } : {}),
      ...(agentTimestampMs != null ? { agentTimestampMs } : {}),
    })}`
  switch (kind) {
    case 'agent_message_chunk': {
      const text = contentTextParts(parts)
      const keys = text ? [textKey('chunk', text)] : []
      return keys.concat(
        parts
          .filter((part): part is Extract<ContentPart, { kind: 'image' }> => part.kind === 'image')
          .map((part) => replayImageKey(part.data, part.mimeType)),
      )
    }
    case 'agent_thought_chunk': {
      const text = contentTextParts(parts)
      return text ? [textKey('thought', text)] : []
    }
    case 'user_message_chunk': {
      const content = up.content as Record<string, unknown> | undefined
      const blockMeta =
        content && typeof content === 'object'
          ? ((content._meta ?? content.meta) as Record<string, unknown> | undefined)
          : undefined
      const displayText =
        typeof blockMeta?.displayText === 'string' ? blockMeta.displayText : undefined
      const displayAsCron = blockMeta?.displayAsCron === true
      const text = displayText ?? contentParts(up.content)
        .filter((part): part is Extract<ContentPart, { kind: 'text' }> => part.kind === 'text')
        .map((part) => part.text)
        .join('')
      const keys = text
        ? (() => {
            const classified = classifyUserPrompt(text, displayAsCron)
            return classified
              ? [textKey('user', classified.text, classified.isCron)]
              : []
          })()
        : []
      return keys.concat(
        parts
          .filter((part): part is Extract<ContentPart, { kind: 'image' }> => part.kind === 'image')
          .map((part) => replayImageKey(part.data, part.mimeType)),
      )
    }
    case 'tool_call':
      return [`tool_call:${stableReplayJson(toolReplayPayload(up))}`]
    case 'tool_call_update':
      return [`tool_update:${stableReplayJson(toolReplayPayload(up))}`]
    case 'plan':
      return [`plan:${stableReplayJson(up.entries)}`]
    case 'usage_update':
      return [`usage:${stableReplayJson({ used: up.used, size: up.size, cost: up.cost })}`]
    case 'task_backgrounded': {
      const task = historicalTaskEvent(up)
      return task ? [`task:started:${stableReplayJson({ taskId: task.taskId, title: task.title })}`] : []
    }
    case 'task_completed': {
      const task = historicalTaskEvent(up)
      return task
        ? [`task:completed:${stableReplayJson({ taskId: task.taskId, title: task.title, output: task.output })}`]
        : []
    }
    default:
      return kind ? [`notification:${kind}:${stableReplayJson(up)}`] : []
  }
}

/** Stable semantic keys used to deduplicate buffered live events against a snapshot. */
export function replayEventKeys(ev: AcpEvent): string[] {
  switch (ev.type) {
    case 'chunk':
      return [`chunk:${stableReplayJson({ text: ev.text, ...(ev.agentTimestampMs != null ? { agentTimestampMs: ev.agentTimestampMs } : {}) })}`]
    case 'thought':
      return [`thought:${stableReplayJson({ text: ev.text, ...(ev.agentTimestampMs != null ? { agentTimestampMs: ev.agentTimestampMs } : {}) })}`]
    case 'user_chunk':
    case 'user_message': {
      const raw =
        ev.type === 'user_chunk' ? ev.displayText ?? ev.text : ev.text
      const classified = classifyUserPrompt(
        raw,
        ev.type === 'user_message' ? ev.isCron : ev.displayAsCron,
      )
      return classified
        ? [`user:${stableReplayJson({ text: classified.text, ...(classified.isCron ? { isCron: true } : {}), ...(ev.type === 'user_chunk' && ev.agentTimestampMs != null ? { agentTimestampMs: ev.agentTimestampMs } : {}) })}`]
        : []
    }
    case 'image':
      return [replayImageKey(ev.data, ev.mimeType)]
    case 'tool_call':
      return [`tool_call:${stableReplayJson(toolReplayPayload(ev.toolCall))}`]
    case 'tool_call_update':
      return [`tool_update:${stableReplayJson(toolReplayPayload(ev.toolCallUpdate))}`]
    case 'plan':
      return [`plan:${stableReplayJson(ev.entries)}`]
    case 'task_lifecycle':
      return [`task:${ev.kind}:${stableReplayJson({ taskId: ev.taskId, title: ev.title, output: ev.output })}`]
    case 'usage':
      return [`usage:${stableReplayJson({ used: ev.used, size: ev.size, cost: ev.cost })}`]
    case 'session_notification': {
      const update = ev.params?.update
      if (update && typeof update === 'object' && !Array.isArray(update)) {
        const keys = replayUpdateKeys(
          update as Record<string, unknown>,
          (ev.params?._meta as Record<string, unknown> | undefined),
        )
        if (keys.length > 0) return keys
      }
      return [`notification:${stableReplayJson({ method: ev.method, params: ev.params })}`]
    }
    default:
      return []
  }
}

/** Keys for a stored envelope, including every content block in a mixed chunk. */
export function replayEnvelopeKeys(env: unknown): string[] {
  const e = env as RawEnvelope
  const up = e.params?.update
  if (!up) return []
  return replayUpdateKeys(up, envelopeMeta(e))
}

function envelopeMeta(e: RawEnvelope): Record<string, unknown> {
  const updateMeta = e.params?.update?._meta
  return {
    ...(updateMeta && typeof updateMeta === 'object' ? updateMeta : {}),
    ...(e.params?._meta ?? {}),
  } as Record<string, unknown>
}

function envelopeContentMeta(up: Record<string, unknown>): Record<string, unknown> {
  const content = up.content
  if (!content || typeof content !== 'object' || Array.isArray(content)) return {}
  const object = content as Record<string, unknown>
  return (object._meta ?? object.meta ?? {}) as Record<string, unknown>
}

function contentTextParts(parts: ContentPart[]): string {
  return parts
    .filter((part): part is Extract<ContentPart, { kind: 'text' }> => part.kind === 'text')
    .map((part) => part.text)
    .join('')
}

function imageEvents(
  parts: ContentPart[],
  meta: Record<string, unknown>,
  ts: number | undefined,
  role: 'user' | 'assistant',
): AcpEvent[] {
  const agentTimestampMs = finiteMetaNumber(meta.agentTimestampMs)
  return parts
    .filter((part): part is Extract<ContentPart, { kind: 'image' }> => part.kind === 'image')
    .map((part) => ({
      type: 'image' as const,
      data: part.data,
      mimeType: part.mimeType,
      ts,
      role,
      ...(agentTimestampMs != null ? { agentTimestampMs } : {}),
    }))
}

/** Convert one stored envelope into all renderable events, preserving mixed content blocks. */
export function envelopeToEvents(env: unknown): AcpEvent[] {
  const e = env as RawEnvelope
  const events = envelopeToEventsRaw(e)
  // 契约：条目 msgSeq = 产生该条目的第一条事件的 msgSeq——派生事件统一
  // 带上信封顶层 msgSeq（多 chunk 聚合的用户行由 replayUpdates 取首条）。
  const msgSeq = envelopeMsgSeq(e)
  if (msgSeq == null) return events
  return events.map((ev) => ({ ...ev, msgSeq }))
}

function envelopeToEventsRaw(e: RawEnvelope): AcpEvent[] {
  if (!e || (e.method !== 'session/update' && e.method !== '_x.ai/session/update')) {
    return []
  }
  const up = e.params?.update
  if (!up) return []
  const ts = envelopeTimestamp(e)
  const meta = envelopeMeta(e)
  if (e.method === '_x.ai/session/update') {
    if (up.sessionUpdate === 'turn_completed' || up.sessionUpdate === 'response_completed') {
      return [turnCompletedEvent(up, completionEndMs(e), e.params?._meta)]
    }
    const taskEv = historicalTaskEvent(up)
    if (taskEv) return [{ type: 'task_lifecycle', ...taskEv }]
    return [{ type: 'session_notification', method: e.method, params: e.params }]
  }
  switch (up.sessionUpdate) {
    case 'agent_message_chunk': {
      const parts = contentParts(up.content)
      const text = contentTextParts(parts)
      const events: AcpEvent[] = []
      if (text) {
        events.push({
          type: 'chunk',
          text,
          ts,
          ...(finiteMetaNumber(meta.turnStartMs) != null ? { turnStartMs: finiteMetaNumber(meta.turnStartMs) } : {}),
          ...(finiteMetaNumber(meta.streamStartMs) != null ? { streamStartMs: finiteMetaNumber(meta.streamStartMs) } : {}),
          ...(finiteMetaNumber(meta.agentTimestampMs) != null ? { agentTimestampMs: finiteMetaNumber(meta.agentTimestampMs) } : {}),
        })
      }
      events.push(...imageEvents(parts, meta, ts, 'assistant'))
      return events
    }
    case 'agent_thought_chunk': {
      const text = contentTextParts(contentParts(up.content))
      if (!text) return []
      const agentTs = finiteMetaNumber(meta.agentTimestampMs)
      const streamStart = finiteMetaNumber(meta.streamStartMs)
      const elapsedMs =
        agentTs != null && streamStart != null && agentTs >= streamStart
          ? agentTs - streamStart
          : undefined
      return [{
        type: 'thought',
        text,
        ...(elapsedMs != null ? { elapsedMs } : {}),
        ...(finiteMetaNumber(meta.turnStartMs) != null ? { turnStartMs: finiteMetaNumber(meta.turnStartMs) } : {}),
        ...(streamStart != null ? { streamStartMs: streamStart } : {}),
        ...(agentTs != null ? { agentTimestampMs: agentTs } : {}),
      }]
    }
    case 'user_message_chunk': {
      const chunkMeta = (up._meta ?? up.meta) as Record<string, unknown> | undefined
      if (chunkMeta?.hideFromScrollback === true) return []
      if (chunkMeta?.hostTurn === true) return []
      const blockMeta = envelopeContentMeta(up)
      if (blockMeta.hideFromScrollback === true) return []
      const parts = contentParts(up.content)
      const raw =
        typeof blockMeta.displayText === 'string'
          ? blockMeta.displayText
          : contentTextParts(parts)
      const displayAsCron = blockMeta.displayAsCron === true
      const events: AcpEvent[] = []
      if (raw) {
        const classified = classifyUserPrompt(raw, displayAsCron)
        if (classified) {
          events.push({
            type: 'user_message',
            text: classified.text,
            isCron: classified.isCron || undefined,
            ts,
          })
        }
      }
      events.push(...imageEvents(parts, meta, ts, 'user'))
      return events
    }
    case 'tool_call':
      return [{ type: 'tool_call', toolCall: up as unknown as ToolCall, ...(finiteMetaNumber(meta.agentTimestampMs) != null ? { agentTimestampMs: finiteMetaNumber(meta.agentTimestampMs) } : {}) }]
    case 'tool_call_update':
      return [{ type: 'tool_call_update', toolCallUpdate: up as unknown as ToolCall, ...(finiteMetaNumber(meta.agentTimestampMs) != null ? { agentTimestampMs: finiteMetaNumber(meta.agentTimestampMs) } : {}) }]
    case 'plan':
      return [{ type: 'plan', entries: up.entries, ...(finiteMetaNumber(meta.agentTimestampMs) != null ? { agentTimestampMs: finiteMetaNumber(meta.agentTimestampMs) } : {}) }]
    case 'usage_update':
      return [{ type: 'usage', used: up.used as number | undefined, size: up.size as number | undefined, cost: up.cost }]
    case 'current_mode_update': {
      const ms = up.modeState ?? (typeof up.currentModeId === 'string' ? { currentModeId: up.currentModeId } : undefined)
      return ms ? [{ type: 'modes_update', modes: ms }] : []
    }
    case 'config_option_update':
      return [{ type: 'config_options_update', configOptions: up.configOptions }]
    case 'session_info_update': {
      const titleIsManual = meta['x.ai/titleIsManual']
      return [{
        type: 'session_info',
        title: up.title as string | undefined,
        ...(typeof titleIsManual === 'boolean' ? { titleIsManual } : {}),
      }]
    }
    case 'task_backgrounded':
    case 'task_completed': {
      const taskEv = historicalTaskEvent(up)
      return taskEv ? [{ type: 'task_lifecycle', ...taskEv }] : []
    }
    case 'turn_completed':
    case 'response_completed':
      return [turnCompletedEvent(up, completionEndMs(e), e.params?._meta)]
    default:
      return [{ type: 'session_notification', method: e.method, params: e.params }]
  }
}

/** Backward-compatible single-event view; mixed content uses the first block. */
export function envelopeToEvent(env: unknown): AcpEvent | null {
  return envelopeToEvents(env)[0] ?? null
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
 * update.elapsed_ms (1.0.9+ agent) rides along as the authoritative wall-
 * clock duration; old envelopes omit it and replay falls back to deriving
 * from the turn-start/end stamps.
 */
export function turnCompletedEvent(
  up: Record<string, unknown>,
  endMs: number | undefined,
  meta?: unknown,
): AcpEvent {
  const elapsedRaw =
    typeof up.elapsed_ms === 'number'
      ? up.elapsed_ms
      : typeof up.elapsedMs === 'number'
        ? up.elapsedMs
        : undefined
  return {
    type: 'turn_completed',
    stopReason: typeof up.stop_reason === 'string' ? up.stop_reason : undefined,
    agentResult:
      typeof up.agent_result === 'string' ? up.agent_result : undefined,
    endMs,
    ...(typeof elapsedRaw === 'number' &&
    Number.isFinite(elapsedRaw) &&
    elapsedRaw >= 0
      ? { elapsedMs: elapsedRaw }
      : {}),
    ...(meta && typeof meta === 'object' && !Array.isArray(meta) ? { meta } : {}),
  }
}
