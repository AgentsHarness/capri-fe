import type { AcpEvent, ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { nid } from '../ids'
import { imageSrc } from '../format'
import {
  appendStreamBuf,
  assertStreamInvariants,
  flushLiveStream,
  flushStreamBuf,
  sealAssistantStream,
  sealThought,
  sealThoughtVisual,
} from '../stream'
import {
  adoptLiveTurnStart,
} from '../turn'
import {
  classifyUserPrompt,
  findOptimisticUserAbsorbIndex,
  userPromptTextsMatch,
} from '../history'

function finiteStreamStart(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Keep the TUI stream boundary rule: assistant and thought chunks with the
 * same streamStartMs share one assistant stream; a changed value closes both
 * open streaming entries before the new event is handled.
 */
function rejectClosedTurnAgentOutput(
  set: SetState,
  get: () => ChatState,
  ev: Extract<AcpEvent, { type: 'chunk' | 'thought' }>,
): boolean {
  const completed = get().lastCompletedTurn
  if (!completed) return false
  const incoming = finiteStreamStart(ev.streamStartMs)
  // A different stamped stream can only be a new server-side turn. Let it
  // through and retire the old guard; an unmarked event is ambiguous and is
  // dropped until the next user event explicitly opens a turn.
  if (
    incoming != null &&
    completed.streamStartMs != null &&
    incoming !== completed.streamStartMs
  ) {
    set({ lastCompletedTurn: undefined })
    return false
  }
  // A terminal event leaves the view idle until the next user prompt. Agent
  // chunks that arrive in that gap are late delivery from the closed turn;
  // accepting one would recreate a streaming row and flip the composer back
  // to Thinking…/Responding….
  return true
}

/**
 * Keep the TUI stream boundary rule: assistant and thought chunks with the
 * same streamStartMs share one assistant stream; a changed value closes both
 * open streaming entries before the new event is handled.
 */
function prepareAgentStream(
  set: SetState,
  get: () => ChatState,
  streamStartMs: unknown,
): void {
  const incoming = finiteStreamStart(streamStartMs)
  if (incoming == null) return
  const current = get().currentStreamStartMs
  if (current == null) {
    set({ currentStreamStartMs: incoming })
    return
  }
  if (current === incoming) return

  // A same-kind rAF buffer is not flushed by handleChatEvent's type switch;
  // commit it before closing the previous stream.
  flushStreamBuf(set, get)
  const before = get()
  const withThoughtSealed = sealThought(flushLiveStream(before))
  const sealed = sealAssistantStream({ ...before, ...withThoughtSealed })
  set({ ...sealed, currentStreamStartMs: incoming })
}
export function handleUserStreamEvent(
  set: SetState,
  get: () => ChatState,
  ev: AcpEvent,
): boolean {
  switch (ev.type) {
      case 'user_message':
      case 'user_chunk': {
        // 多会话广播（host withSid 约定）：非当前会话的回合流事件忽略
        // （后台回合的 echo 不能进当前 transcript；replay 无 sessionId，
        // 照常通过）。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // A user event opens the next turn, including a hidden injected
        // prompt. Clear the closed-turn guard before classification so the
        // following agent chunk is not mistaken for late output — except a
        // recap echo of the last prompt after a closed snapshot load
        // (page-refresh gap-pull): that must NOT open a new turn, or the
        // last assistant is painted twice.
        const closedTurn = get().lastCompletedTurn
        const pendingUserId = get().pendingOptimisticUserId
        if (get().awaitingNext || closedTurn) {
          if (
            !(
              ev.type === 'user_chunk' &&
              closedTurn &&
              !pendingUserId
            )
          ) {
            set({ awaitingNext: false, lastCompletedTurn: undefined })
          }
        }
        // 权威回合开始修正（队列收养回合的本地锚定误差，见
        // adoptLiveTurnStart）。
        adoptLiveTurnStart(set, get, ev)
        // Live echo (user_chunk) or history replay (user_message). Classify
        // like TUI handle_user_message: cron → UserPromptBlock::cron, other
        // system-reminder / auto-wake echoes → hidden, else normal prompt.
        const raw = ev.text || ''
        if (!raw) break
        // The host forwards chunk/content-block meta on live user_chunk
        // events (same shape the replay path reads): hideFromScrollback
        // drops the row, displayText overrides the raw text, displayAsCron
        // marks cron framing. Without this, live and replay classified the
        // same system-injected prompt differently.
        if (ev.type === 'user_chunk') {
          if (ev.hideFromScrollback === true) break
        }
        const metaText =
          ev.type === 'user_chunk' && typeof ev.displayText === 'string'
            ? ev.displayText
            : undefined
        const metaCron = ev.type === 'user_chunk' && ev.displayAsCron === true
        const classified = classifyUserPrompt(
          metaText ?? raw,
          ev.type === 'user_message' ? ev.isCron : metaCron,
        )
        if (!classified) break
        // Close the assistant stream: merge liveStream text into the
        // entry BEFORE the streaming:false seal, then seal any thought.
        const flushed = flushLiveStream(get())
        const sealed = sealThought(flushed)
        const entries = sealed.entries.map((e) =>
          e.id === sealed.openAssistantId && e.kind === 'assistant'
            ? { ...e, streaming: false }
            : e,
        )
        const ts = ev.type === 'user_message' ? (ev.ts ?? Date.now()) : Date.now()

        // send() already appended a UserPromptBlock for interactive prompts;
        // the agent then echoes the same turn as user_message_chunk →
        // user_chunk. Absorb the echo into that row so scrollback does not
        // show two identical user messages. Cron/inject paths never set
        // pendingOptimisticUserId and still create a fresh row.
        if (ev.type === 'user_chunk') {
          const absorbIdx = findOptimisticUserAbsorbIndex(
            entries,
            get().pendingOptimisticUserId,
            classified.text,
          )
          if (absorbIdx >= 0) {
            // agent 盖章的发送时刻（params._meta.agentTimestampMs，host
            // 透传）：收养场景用户行 ts 是本地收养时刻（可能晚几分钟），
            // 修正为真实发送时刻，与回放路径的 envelope 时间戳对齐。
            const anyEv = ev as { agentTimestampMs?: unknown }
            const agentTs =
              typeof anyEv.agentTimestampMs === 'number' &&
              Number.isFinite(anyEv.agentTimestampMs) &&
              anyEv.agentTimestampMs > 0
                ? anyEv.agentTimestampMs
                : undefined
            set({
              ...sealed,
              openAssistantId: undefined,
              currentStreamStartMs: undefined,
              pendingOptimisticUserId: undefined,
              entries: entries.map((e, i) =>
                i === absorbIdx && e.kind === 'user'
                  ? {
                      ...e,
                      // Prefer classified body (wrappers / cron framing stripped).
                      text: classified.text,
                      isCron: classified.isCron || e.isCron || undefined,
                      expanded: false,
                      ...(agentTs != null ? { ts: agentTs } : {}),
                    }
                  : e,
              ),
            })
            break
          }
          // Closed-turn recap (no pending optimistic row): the echo matches
          // the last user prompt sitting above the "Worked for" marker.
          // Ignore it so gap-pull after refresh does not append a second
          // copy of the last turn. A genuinely new prompt has different
          // text (or pendingOptimisticUserId from send()).
          if (closedTurn && !pendingUserId) {
            let lastUserText: string | undefined
            for (let i = entries.length - 1; i >= 0; i--) {
              const e = entries[i]
              if (e.kind === 'user') {
                lastUserText = e.text
                break
              }
            }
            if (
              lastUserText != null &&
              userPromptTextsMatch(lastUserText, classified.text)
            ) {
              break
            }
            // Different text → real next prompt; drop the closed-turn guard
            // that was kept above so later agent chunks are accepted.
            set({ awaitingNext: false, lastCompletedTurn: undefined })
          }
        }

        set({
          ...sealed,
          openAssistantId: undefined,
          currentStreamStartMs: undefined,
          pendingOptimisticUserId: undefined,
          entries: [
            ...entries,
            {
              id: nid(),
              kind: 'user',
              text: classified.text,
              isCron: classified.isCron || undefined,
              isInterjection:
                (ev.type === 'user_message' ? ev.isInterjection : classified.isInterjection) ||
                undefined,
              ts,
              expanded: false,
              // 回放聚合用户行携带首条 chunk 的 msgSeq（live 事件无）。
              ...(ev.msgSeq != null ? { msgSeq: ev.msgSeq } : {}),
            },
          ],
        })
        break
      }
      case 'image': {
        // 多会话广播（host withSid 约定）：非当前会话忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // Image content block (agent_message_chunk / user_message_chunk).
        // 1. Open assistant row → append (sealing any open thought, same
        //    as text chunks);
        // 2. else pending optimistic user row → merge there (user-sent
        //    image echoed back — no duplicate row);
        // 3. else standalone image entry.
        const src = imageSrc(ev.data, ev.mimeType)
        if (!src) break
        const sealed = sealThought(get())
        const { openAssistantId, entries } = sealed
        const img = { data: src, mimeType: ev.mimeType }
        if (openAssistantId && ev.role !== 'user') {
          set({
            ...sealed,
            conn: 'busy',
            statusText: 'Responding…',
            awaitingNext: false,
            entries: entries.map((e) =>
              e.id === openAssistantId && e.kind === 'assistant'
                ? { ...e, images: [...(e.images ?? []), img] }
                : e,
            ),
          })
          break
        }
        const pendingId = get().pendingOptimisticUserId
        if (pendingId) {
          const idx = entries.findIndex((e) => e.id === pendingId && e.kind === 'user')
          if (idx >= 0) {
            set({
              ...sealed,
              openAssistantId: undefined,
              entries: entries.map((e) =>
                e.id === pendingId && e.kind === 'user'
                  ? { ...e, images: [...(e.images ?? []), img] }
                  : e,
              ),
            })
            break
          }
        }
        set({
          ...sealed,
          openAssistantId: undefined,
          entries: [
            ...entries,
            {
              id: nid(),
              kind: 'image',
              data: src,
              mimeType: ev.mimeType,
              ts: ev.ts ?? Date.now(),
            },
          ],
        })
        break
      }
      case 'chunk': {
        // 多会话广播（host withSid 约定）：非当前会话忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        if (rejectClosedTurnAgentOutput(set, get, ev)) break
        prepareAgentStream(set, get, ev.streamStartMs)
        // 权威回合开始修正（队列收养回合的本地锚定误差，见
        // adoptLiveTurnStart）。
        adoptLiveTurnStart(set, get, ev)
        const text = ev.text || ''
        const ts = ev.ts ?? Date.now()
        // A same-stream thought may be followed by assistant text and then
        // more thought text. Keep the thought pointer alive in that case so
        // the later thought chunk continues the same scrollback block.
        const current = get()
        const incomingStreamStart = finiteStreamStart(ev.streamStartMs)
        const keepThoughtOpen =
          incomingStreamStart != null &&
          current.currentStreamStartMs === incomingStreamStart &&
          current.openThoughtId != null &&
          current.entries.some(
            (e) => e.id === current.openThoughtId && e.kind === 'thought',
          )
        const sealed = keepThoughtOpen
          ? {
              entries: current.entries,
              openAssistantId: current.openAssistantId,
              openThoughtId: current.openThoughtId,
              liveStream: current.liveStream,
            }
          : sealThought(current)
        const { openAssistantId } = sealed
        if (openAssistantId) {
          // 已有回答条目：文本只进合并缓冲（rAF 统一落库，见
          // appendStreamBuf）。sealThought 若刚收口思考，先把结果落库，
          // 否则 entries / openThoughtId 的更新会被丢掉。
          if (
            sealed.entries !== get().entries ||
            sealed.openThoughtId !== get().openThoughtId ||
            sealed.liveStream !== get().liveStream
          ) {
            set({ ...get(), ...sealed })
          }
          // 同流 thinking → answer：视觉收口思考（指针保留、参与集合
          // 不动），回答行接管直播——否则上一条 thinking 整段回答期间
          // 都挂着 "Thinking…"。后续 thinking chunk 由 resume 路径重开。
          const visuallySealed = sealThoughtVisual(get())
          if (visuallySealed !== get()) set(visuallySealed)
          appendStreamBuf(set, get, 'assistant', text)
        } else {
          // 空白首包不建空壳——纯换行/空格不是回答。后续真正文再开行。
          if (!text.trim()) break
          // 指针已空但 liveStream 仍挂着上一段：先写回，再开新行。
          // 写回即收口：被打断的 assistant 流当场结束（同 sealedForeignLive）。
          let base = { ...get(), ...sealed }
          if (base.liveStream) {
            const foreignId = base.liveStream.entryId
            base = flushLiveStream(base)
            base = {
              ...base,
              entries: base.entries.map((e) =>
                e.id === foreignId && e.kind === 'assistant'
                  ? { ...e, streaming: false }
                  : e,
              ),
            }
          }
          // 同流 thinking → answer 首包：视觉收口思考（指针保留），回答行
          // 开新条目——同 Path B，上一条 thinking 不能整段回答期间挂
          // "Thinking…"。
          base = sealThoughtVisual(base)
          const id = nid()
          set({
            ...base,
            conn: 'busy',
            statusText: 'Responding…',
            awaitingNext: false,
            openAssistantId: id,
            // Keep a same-stream thought alive across an interleaved assistant
            // chunk; a later thought chunk will append to that same entry.
            openThoughtId: keepThoughtOpen ? base.openThoughtId : undefined,
            entries: [
              ...base.entries,
              { id, kind: 'assistant', text: '', streaming: true, ts },
            ],
            liveStream: { entryId: id, text },
          })
        }
        break
      }
      case 'thought': {
        // 多会话广播（host withSid 约定）：非当前会话忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        if (rejectClosedTurnAgentOutput(set, get, ev)) break
        prepareAgentStream(set, get, ev.streamStartMs)
        // 权威回合开始修正（队列收养回合的本地锚定误差，见
        // adoptLiveTurnStart）。
        adoptLiveTurnStart(set, get, ev)
        const text = ev.text || ''
        if (!text) break

        // Same streamStartMs may legally transition assistant → thought.
        // Commit the assistant's pending live text, but keep its pointer open
        // so a later assistant chunk returns to the same entry. A changed
        // streamStartMs was already sealed by prepareAgentStream above.
        let base = get()
        if (base.liveStream && base.liveStream.entryId !== base.openThoughtId) {
          base = flushLiveStream(base)
          set(base)
        }
        let openThoughtId = base.openThoughtId
        const preserveAssistant =
          finiteStreamStart(ev.streamStartMs) != null && base.openAssistantId != null
        const entries = preserveAssistant
          ? base.entries.map((e) =>
              e.id === base.openAssistantId && e.kind === 'assistant'
                ? { ...e, streaming: true }
                : e,
            )
          : base.entries

        // If placeholder missing (reconnect mid-turn / first thought chunk),
        // create one. Invariant: entry.text stays empty during streaming;
        // ALL in-flight text lives in liveStream.
        if (
          !openThoughtId ||
          !entries.some((e) => e.id === openThoughtId && e.kind === 'thought')
        ) {
          const id = nid()
          openThoughtId = id
          set({
            ...base,
            conn: 'busy',
            statusText: 'Thinking…',
            awaitingNext: false,
            openThoughtId,
            // Preserve openAssistantId for assistant → thought → assistant
            // interleaving within one generation stream.
            openAssistantId: preserveAssistant ? base.openAssistantId : undefined,
            entries: [
              ...entries,
              {
                id,
                kind: 'thought',
                text: '',
                displayMode: 'expanded',
                streaming: true,
                startedAt: Date.now(),
                // Replay carries the server-reported original duration
                // (agentTimestampMs - streamStartMs); live chunks have none
                // and seal against the local timer instead.
                ...(ev.elapsedMs != null ? { elapsedMs: ev.elapsedMs } : {}),
                ...(ev.liteOmitted ? { liteOmitted: ev.liteOmitted } : {}),
              },
            ],
            // Seed liveStream with the first chunk; later deltas append via
            // rAF and sealThought moves the complete text into the entry.
            liveStream: {
              entryId: id,
              text,
              ...(ev.elapsedMs != null ? { elapsedMs: ev.elapsedMs } : {}),
            },
          })
          assertStreamInvariants(get(), 'thought:first')
          break
        }

        // Existing thought: text goes through the frame coalescing buffer.
        // 若条目被同流 answer 视觉收口过（sealThoughtVisual），先重新
        // 打开：新一段思考计时、展开态正文——指针一直活着，续写仍进
        // 同一条目；不重开的话 rAF flush 会把 liveStream 挂到非流式
        // 条目上，正文也不会渲染。
        const openEntry = get().entries.find(
          (e): e is Extract<ScrollEntry, { kind: 'thought' }> =>
            e.id === openThoughtId && e.kind === 'thought',
        )
        if (openEntry && !openEntry.streaming) {
          set({
            ...get(),
            entries: get().entries.map((e) =>
              e.id === openThoughtId && e.kind === 'thought'
                ? {
                    ...e,
                    streaming: true,
                    displayMode: 'expanded',
                    startedAt: Date.now(),
                    elapsed: undefined,
                    elapsedMs: undefined,
                    finishedAt: undefined,
                  }
                : e,
            ),
          })
        }
        appendStreamBuf(set, get, 'thought', text, ev.elapsedMs)
        break
      }
    default:
      return false
  }
  return true
}
