import { describe, expect, it, vi } from 'vitest'
import { flushStreamBuf } from '../stream'
import { handleUserStreamEvent } from './userStream'
import type { AcpEvent, ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'

function makeStore(initial: Partial<ChatState> = {}) {
  let state = { entries: [], ...initial } as ChatState
  const set = vi.fn(
    (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    },
  )
  const get = () => state
  return { set: set as unknown as SetState, get, state: () => state }
}

const thought = (text: string, streamStartMs = 1000): AcpEvent =>
  ({ type: 'thought', text, streamStartMs }) as AcpEvent
const chunk = (text: string, streamStartMs = 1000): AcpEvent =>
  ({ type: 'chunk', text, streamStartMs }) as AcpEvent

const thoughtOf = (s: ChatState) =>
  s.entries.find(
    (e): e is Extract<ScrollEntry, { kind: 'thought' }> => e.kind === 'thought',
  )
const assistantOf = (s: ChatState) =>
  s.entries.find(
    (e): e is Extract<ScrollEntry, { kind: 'assistant' }> => e.kind === 'assistant',
  )
/** 渲染态正文 = 已落库 text + 仍挂在 liveStream 的在途文本。 */
const rendered = (s: ChatState, e: ScrollEntry): string =>
  ('text' in e ? e.text : '') +
  (s.liveStream?.entryId === e.id ? s.liveStream.text : '')

describe('userStream — 同流 thinking → answer 切换', () => {
  it('回答首包视觉收口思考：streaming=false、elapsed 冻结、指针保留', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    const dispatch = (ev: AcpEvent) => {
      flushStreamBuf(set, get)
      handleUserStreamEvent(set, get, ev)
    }
    dispatch(thought('hmm'))
    expect(thoughtOf(state())).toMatchObject({ streaming: true, displayMode: 'expanded' })

    dispatch(chunk('Answer'))
    const s = state()
    const t = thoughtOf(s)
    // 收口：不再挂 "Thinking…"，按 sealThought 同款冻结
    expect(t).toMatchObject({ streaming: false, displayMode: 'collapsed' })
    expect(t?.elapsed).toBeTruthy()
    expect(t?.text).toContain('hmm')
    expect(t?.finishedAt).toBeTruthy()
    // 指针保留（交错思考可续写同一条目），回答行打开
    expect(s.openThoughtId).toBe(t?.id)
    expect(s.openAssistantId).toBeTruthy()
    expect(assistantOf(s)).toMatchObject({ streaming: true })
  })

  it('后续回答 chunk 不再触碰思考条目', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    const dispatch = (ev: AcpEvent) => {
      flushStreamBuf(set, get)
      handleUserStreamEvent(set, get, ev)
    }
    dispatch(thought('hmm'))
    dispatch(chunk('Answer'))
    const afterFirst = thoughtOf(state())
    dispatch(chunk(' more'))
    dispatch(chunk('!'))
    const s = state()
    expect(thoughtOf(s)).toBe(afterFirst)
    expect(thoughtOf(s)).toMatchObject({ streaming: false })
  })

  it('思考恢复：续写同一条目并重新打开（新一段计时）', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    const dispatch = (ev: AcpEvent) => {
      flushStreamBuf(set, get)
      handleUserStreamEvent(set, get, ev)
    }
    dispatch(thought('hmm'))
    dispatch(chunk('Answer'))
    const idBefore = thoughtOf(state())?.id

    dispatch(thought(' more'))
    let s = state()
    const t = thoughtOf(s)
    // 同一条目续写，不另起新行；重新打开为流式展开态
    expect(s.entries.filter((e) => e.kind === 'thought')).toHaveLength(1)
    expect(t?.id).toBe(idBefore)
    expect(t).toMatchObject({ streaming: true, displayMode: 'expanded' })
    expect(t?.elapsed).toBeUndefined()
    expect(t?.finishedAt).toBeUndefined()
    // assistant 指针与行保持活跃（preserveAssistant）
    expect(s.openAssistantId).toBeTruthy()
    expect(assistantOf(s)).toMatchObject({ streaming: true })

    flushStreamBuf(set, get)
    expect(rendered(state(), thoughtOf(state())!)).toBe('hmm more')
    expect(state().openThoughtId).toBe(idBefore)
  })

  it('answer → thought → answer 来回切换：每段都正确收口/重开', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    const dispatch = (ev: AcpEvent) => {
      flushStreamBuf(set, get)
      handleUserStreamEvent(set, get, ev)
    }
    dispatch(thought('a'))
    dispatch(chunk('A'))
    dispatch(thought('b'))
    dispatch(chunk('B'))
    dispatch(chunk('C'))
    const s = state()
    // 各一段思考一条目、一条回答行；思考最终随最后一次 answer 收口
    expect(s.entries.filter((e) => e.kind === 'thought')).toHaveLength(1)
    expect(s.entries.filter((e) => e.kind === 'assistant')).toHaveLength(1)
    expect(thoughtOf(s)).toMatchObject({ streaming: false, displayMode: 'collapsed' })
    expect(thoughtOf(s)?.text).toBe('ab')
    expect(s.openThoughtId).toBe(thoughtOf(s)?.id)
    expect(s.openAssistantId).toBe(assistantOf(s)?.id)
    flushStreamBuf(set, get)
    expect(rendered(state(), assistantOf(state())!)).toBe('ABC')
  })
})
