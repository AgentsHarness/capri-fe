import type { AcpEvent, ScrollEntry } from '../../api/types'
import type { ChatState, SetState } from './types'
import { formatElapsed } from './format'


// ── 流式文本合并缓冲（rAF flush）────────────────────────────
// Pipeline: SSE → streamBuf (rAF) → liveStream → flushLiveStream → entry.text
//
// 移动端思考/回答流渲染卡顿主因：每个 SSE chunk 一次 set() + 一次完整
// 渲染 + 两次强制布局。chunk 文本先落进模块级缓冲，requestAnimationFrame
// 统一落库（每帧至多一次 set()）。顺序保证：handleEvent 入口对"非同类
// 流式事件"强制先 flush——tool_call/chunk/回合终态等收口类事件处理前，
// 缓冲的思考文本必已写入 liveStream（再由边界路径 flushLiveStream 入条目）。
export type StreamBufKind = 'thought' | 'assistant'

export let streamBufText = ''
export let streamBufKind: StreamBufKind | null = null
export let streamBufRaf: number | null = null
/** 缓冲内 chunk 携带的 elapsedMs（replay），flush 时"最后一个 chunk 生效"。 */
export let streamBufElapsedMs: number | undefined
/** DEV: chunks coalesced into the current streamBuf frame (perf.mark detail). */
export let streamBufChunkCount = 0

/** 追加一段流式文本到合并缓冲；首次追加时调度 rAF flush。 */
export function appendStreamBuf(
  set: SetState,
  get: () => ChatState,
  kind: StreamBufKind,
  text: string,
  elapsedMs?: number,
): void {
  if (!text) return
  // 缓冲里是另一种流（异常交错，如回答中回补思考）：先落库保序。
  if (streamBufKind != null && streamBufKind !== kind) flushStreamBuf(set, get)
  streamBufText += text
  streamBufKind = kind
  streamBufChunkCount++
  if (elapsedMs != null) streamBufElapsedMs = elapsedMs
  if (streamBufRaf == null) {
    streamBufRaf = requestAnimationFrame(() => {
      streamBufRaf = null
      flushStreamBuf(set, get)
    })
  }
}

/**
 * 把缓冲的流式文本一次性落库（每帧至多一次）。目标条目已被收口/清除时
 * 丢弃缓冲（stop/会话切换后的残留文本不应再入 scrollback）。
 * 落库目标 = liveStream（不直接写 entry.text）。
 */
export function flushStreamBuf(set: SetState, get: () => ChatState): void {
  const text = streamBufText
  const kind = streamBufKind
  if (!text || !kind) return
  const bufElapsedMs = streamBufElapsedMs
  const chunkCount = streamBufChunkCount
  streamBufText = ''
  streamBufKind = null
  streamBufElapsedMs = undefined
  streamBufChunkCount = 0
  if (streamBufRaf != null) {
    cancelAnimationFrame(streamBufRaf)
    streamBufRaf = null
  }
  const dev = import.meta.env.DEV
  if (
    dev &&
    typeof performance !== 'undefined' &&
    typeof performance.mark === 'function'
  ) {
    try {
      performance.mark('acp:stream-flush', {
        detail: { textLen: text.length, kind, chunks: chunkCount },
      })
    } catch {
      // Older engines may reject mark options; ignore.
    }
  }
  let s = get()
  const openId = kind === 'thought' ? s.openThoughtId : s.openAssistantId
  // liveStream 还挂在另一条上时先写回，禁止用本段缓冲覆盖对方正文。
  // 同一生成流的 assistant → thought 切换保留 assistant 指针；显式
  // 流边界和工具/回合收口再结束它。
  if (s.liveStream && s.liveStream.entryId !== openId) {
    const foreignId = s.liveStream.entryId
    s = flushLiveStream(s)
    set({
      entries: s.entries.map((e) =>
        e.id === foreignId && e.kind === 'assistant'
          ? {
              ...e,
              // A thought from the same agent stream temporarily owns
              // liveStream, but the assistant entry remains logically open.
              streaming: kind === 'thought' && s.openAssistantId === foreignId,
            }
          : e,
      ),
      liveStream: s.liveStream,
    })
    s = get()
  }
  if (kind === 'thought') {
    const openThoughtId = s.openThoughtId
    if (
      !openThoughtId ||
      !s.entries.some((e) => e.id === openThoughtId && e.kind === 'thought')
    ) {
      // 已收口/被清除：丢弃缓冲文本。
      return
    }
    set({
      conn: 'busy',
      statusText: 'Thinking…',
      awaitingNext: false,
      openThoughtId,
      // The assistant pointer stays open when this thought belongs to the
      // same generation stream; it is cleared by an explicit stream boundary
      // or tool/turn seal instead.
      openAssistantId: s.openAssistantId,
      // 只有正在流的行经 liveText 重渲染——分组/折叠/memo 全跳过。
      liveStream: {
        entryId: openThoughtId,
        text:
          (s.liveStream?.entryId === openThoughtId ? s.liveStream.text : '') +
          text,
        // Last chunk wins (TUI tracker updates on every chunk).
        ...(bufElapsedMs != null ? { elapsedMs: bufElapsedMs } : {}),
      },
    })
    assertStreamInvariants(get(), 'flushStreamBuf:thought')
    return
  }
  // assistant
  const openAssistantId = s.openAssistantId
  if (
    !openAssistantId ||
    !s.entries.some((e) => e.id === openAssistantId && e.kind === 'assistant')
  ) {
    return // 已收口：丢弃缓冲文本。
  }
  set({
    conn: 'busy',
    statusText: 'Responding…',
    awaitingNext: false,
    openAssistantId,
    liveStream: {
      entryId: openAssistantId,
      text:
        (s.liveStream?.entryId === openAssistantId ? s.liveStream.text : '') +
        text,
    },
  })
  assertStreamInvariants(get(), 'flushStreamBuf:assistant')
}

/** 会话/历史切换：丢弃未落库的流式文本与字符统计。 */
export function clearStreamBuf(): void {
  streamBufText = ''
  streamBufKind = null
  streamBufElapsedMs = undefined
  streamBufChunkCount = 0
  if (streamBufRaf != null) {
    cancelAnimationFrame(streamBufRaf)
    streamBufRaf = null
  }
}

export function flushLiveStream(s: ChatState): ChatState {
  const ls = s.liveStream
  if (!ls) return s
  if (
    import.meta.env.DEV &&
    typeof performance !== 'undefined' &&
    typeof performance.mark === 'function'
  ) {
    try {
      performance.mark('acp:stream-seal', {
        detail: { textLen: ls.text.length, entryId: ls.entryId },
      })
    } catch {
      // ignore mark option failures
    }
  }
  const next: ChatState = {
    ...s,
    liveStream: null,
    entries: s.entries.map((e) =>
      e.id === ls.entryId && 'text' in e
        ? {
            ...e,
            text: e.text + ls.text,
            // Last chunk wins (TUI tracker updates on every chunk).
            ...(ls.elapsedMs != null ? { elapsedMs: ls.elapsedMs } : {}),
          }
        : e,
    ),
  }
  return next
}

/**
 * Seal an open assistant stream mid-turn (tool_call / plan / send interrupt).
 * Merges liveStream text into its entry via flushLiveStream (once — no
 * double-append), clears openAssistantId, and sets streaming:false on the
 * assistant entry. Idempotent when no assistant is open. Does NOT seal
 * thoughts — callers chain sealThought when needed.
 * settleTurnEntries remains the turn-end path (also sets streaming:false;
 * safe / idempotent).
 */
export function sealAssistantStream(s: ChatState): ChatState {
  s = flushLiveStream(s)
  if (!s.openAssistantId) {
    return s.openAssistantId === undefined
      ? s
      : { ...s, openAssistantId: undefined }
  }
  const id = s.openAssistantId
  const existing = s.entries.find((e) => e.id === id)
  // 空壳（从未落到正文、也无图）与空 Thinking… 一样整行丢掉。
  if (existing?.kind === 'assistant' && isEmptyAssistant(existing)) {
    return {
      ...s,
      openAssistantId: undefined,
      liveStream: s.liveStream?.entryId === id ? null : s.liveStream,
      entries: s.entries.filter((e) => e.id !== id),
    }
  }
  const next: ChatState = {
    ...s,
    openAssistantId: undefined,
    // liveStream already cleared by flushLiveStream; if a foreign stream
    // somehow remained (should not), drop only if it still targets us.
    liveStream:
      s.liveStream?.entryId === id ? null : s.liveStream,
    entries: s.entries.map((e) =>
      e.id === id && e.kind === 'assistant'
        ? { ...e, streaming: false }
        : e,
    ),
  }
  assertStreamInvariants(next, 'sealAssistantStream')
  return next
}

/** 无正文、无内嵌图的回答行——不应留在 scrollback。 */
export function isEmptyAssistant(
  e: Extract<ScrollEntry, { kind: 'assistant' }>,
): boolean {
  return !e.text.trim() && !(e.images && e.images.length > 0)
}

/**
 * DEV-only stream invariant checks. No-op in production. Never throws —
 * console.warn only so a bad state is visible without breaking the turn.
 */
export function assertStreamInvariants(s: ChatState, where?: string): void {
  if (!import.meta.env.DEV) return
  const tag = where ?? '?'
  const ls = s.liveStream
  if (!ls) return
  const entry = s.entries.find((e) => e.id === ls.entryId)
  if (!entry) {
    console.warn(
      `[acp stream] liveStream.entryId missing entry (${tag})`,
      ls.entryId,
    )
    return
  }
  if (entry.kind !== 'thought' && entry.kind !== 'assistant') {
    console.warn(
      `[acp stream] liveStream targets non-stream kind (${tag})`,
      entry.kind,
      ls.entryId,
    )
    return
  }
  // Prefer warn over hard fail for brief seal/race windows.
  if ('streaming' in entry && entry.streaming !== true) {
    console.warn(
      `[acp stream] liveStream targets non-streaming entry (${tag})`,
      ls.entryId,
    )
  }
  // streamBuf still holding a different kind while liveStream is set is
  // checked at flushStreamBuf time (module state not visible here).
}

/**
 * Finish an open thought block when content moves on.
 * Empty placeholder (busy fired but no thought chunks) is removed entirely.
 */
export function sealThought(
  s: ChatState,
): Pick<ChatState, 'entries' | 'openAssistantId' | 'openThoughtId' | 'liveStream'> {
  // Live-streamed thought text lives OUT of entries — merge it in before
  // the empty-placeholder check and the finish bookkeeping.
  if (s.openThoughtId && s.liveStream?.entryId === s.openThoughtId) {
    s = flushLiveStream(s)
  }
  if (!s.openThoughtId) {
    return {
      entries: s.entries,
      openAssistantId: s.openAssistantId,
      openThoughtId: s.openThoughtId,
      liveStream: s.liveStream,
    }
  }
  const tid = s.openThoughtId
  const existing = s.entries.find((e) => e.id === tid)
  // Drop empty Thinking… placeholder if agent never sent thought chunks
  // (after flush, sealed text is on the entry — empty means no chunks).
  if (existing?.kind === 'thought' && !existing.text.trim()) {
    return {
      openAssistantId: s.openAssistantId,
      openThoughtId: undefined,
      liveStream: s.liveStream,
      entries: s.entries.filter((e) => e.id !== tid),
    }
  }
  return {
    openAssistantId: s.openAssistantId,
    openThoughtId: undefined,
    liveStream: s.liveStream,
    entries: s.entries.map((e) => {
      if (e.id !== tid || e.kind !== 'thought') return e
      // Replay: prefer the server-reported original duration; live falls
      // back to the local startedAt timer (same freeze order as the TUI's
      // ThinkingBlock::finish + finish_running_with_time).
      const elapsed =
        e.elapsedMs != null
          ? formatElapsed(e.elapsedMs)
          : e.startedAt != null
            ? formatElapsed(Date.now() - e.startedAt)
            : e.elapsed
      // Collapse body after finish (TUI truncated "Thought for Xs" preview)
      // finishedAt drives the short finish-flash accent (EntryRenderer)
      return {
        ...e,
        streaming: false,
        elapsed,
        displayMode: 'collapsed',
        finishedAt: Date.now(),
      }
    }),
  }
}


/** Flush the rAF stream buffer when the next event is not the same kind. */
export function flushStreamBufBeforeEvent(
  set: SetState,
  get: () => ChatState,
  ev: AcpEvent,
): void {
  if (ev.type === 'thought' ? streamBufKind === 'assistant' : streamBufText !== '') {
    flushStreamBuf(set, get)
  }
}
