import type { AcpEvent } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { nid } from '../ids'
import { imageSrc } from '../format'
import {
  appendStreamBuf,
  assertStreamInvariants,
  flushLiveStream,
  sealThought,
} from '../stream'
import {
  adoptLiveTurnStart,
} from '../turn'
import { classifyUserPrompt, findOptimisticUserAbsorbIndex } from '../history'
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
        }

        set({
          ...sealed,
          openAssistantId: undefined,
          pendingOptimisticUserId: undefined,
          entries: [
            ...entries,
            {
              id: nid(),
              kind: 'user',
              text: classified.text,
              isCron: classified.isCron || undefined,
              ts,
              expanded: false,
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
        if (openAssistantId) {
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
        // 权威回合开始修正（队列收养回合的本地锚定误差，见
        // adoptLiveTurnStart）。
        adoptLiveTurnStart(set, get, ev)
        const text = ev.text || ''
        const ts = ev.ts ?? Date.now()
        // seal open thought when assistant starts speaking
        const sealed = sealThought(get())
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
          const id = nid()
          set({
            ...base,
            conn: 'busy',
            statusText: 'Responding…',
            awaitingNext: false,
            openAssistantId: id,
            openThoughtId: undefined,
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
        // 权威回合开始修正（队列收养回合的本地锚定误差，见
        // adoptLiveTurnStart）。
        adoptLiveTurnStart(set, get, ev)
        const text = ev.text || ''
        if (!text) break
        const s = get()
        let openThoughtId = s.openThoughtId
        let entries = s.entries
        // Stream switch (assistant → thought, or a stale live stream):
        // seal the previous stream into ITS entry before the new one
        // starts, so no text is lost when the pointer moves. After the
        // map, liveStream must not keep pointing at the old entry — the
        // first-chunk path reassigns it; the continue path clears it.
        const prevLs = s.liveStream
        let sealedForeignLive = false
        if (prevLs && prevLs.entryId !== openThoughtId) {
          entries = entries.map((e) => {
            if (e.id !== prevLs.entryId || !('text' in e)) return e
            const nextText = e.text + prevLs.text
            if (e.kind === 'assistant') {
              // Mid-turn seal of the interrupted assistant stream.
              return {
                ...e,
                text: nextText,
                streaming: false,
                ...(prevLs.elapsedMs != null
                  ? { elapsedMs: prevLs.elapsedMs }
                  : {}),
              }
            }
            return {
              ...e,
              text: nextText,
              ...(prevLs.elapsedMs != null
                ? { elapsedMs: prevLs.elapsedMs }
                : {}),
            }
          })
          sealedForeignLive = true
        }

        // If placeholder missing (reconnect mid-turn / first thought
        // chunk), create one. Invariant: entry.text stays empty during
        // streaming; ALL in-flight text lives in liveStream (same as
        // assistant first chunk). UI merges with mergeLiveText(e.text, live).
        if (!openThoughtId || !entries.some((e) => e.id === openThoughtId && e.kind === 'thought')) {
          const id = nid()
          openThoughtId = id
          entries = [
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
            },
          ]
          set({
            conn: 'busy',
            statusText: 'Thinking…',
            awaitingNext: false,
            openThoughtId,
            openAssistantId: undefined,
            entries,
            // Seed liveStream with the first chunk (do NOT put first
            // chunk only into entry.text — later deltas append to
            // liveStream; seal does entry.text += liveStream.text).
            liveStream: {
              entryId: id,
              text,
              ...(ev.elapsedMs != null ? { elapsedMs: ev.elapsedMs } : {}),
            },
          })
          assertStreamInvariants(get(), 'thought:first')
          break
        }
        // 已有进行中的思考块：文本进合并缓冲，rAF 统一落库（每帧至多一次
        // set()——移动端思考流渲染卡顿的主因）。
        if (sealedForeignLive) {
          // Apply the sealed foreign stream + drop the stale liveStream
          // pointer so UI does not double-render (entry already has text).
          set({
            entries,
            openAssistantId: undefined,
            liveStream: null,
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
