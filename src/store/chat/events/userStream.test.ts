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

describe('userStream — runningHook 释放', () => {
  const hookState = {
    eventName: 'pre_tool_use',
    toolName: 'bash',
    count: 1,
  }

  it('首个回答 chunk 解除 hook 等待态', () => {
    const { set, get, state } = makeStore({ sessionId: 's1', runningHook: hookState })
    handleUserStreamEvent(set, get, chunk('hi'))
    expect(state().runningHook).toBeNull()
  })

  it('首个思考 chunk 同样解除', () => {
    const { set, get, state } = makeStore({ sessionId: 's1', runningHook: hookState })
    handleUserStreamEvent(set, get, thought('hmm'))
    expect(state().runningHook).toBeNull()
  })

  it('外来会话的输出不解除本会话等待态', () => {
    const { set, get, state } = makeStore({ sessionId: 's1', runningHook: hookState })
    handleUserStreamEvent(set, get, {
      type: 'chunk',
      text: 'other',
      sessionId: 'other',
    } as AcpEvent)
    expect(state().runningHook).toEqual(hookState)
  })
})

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

describe('userStream — user_message 回放 / 注入', () => {
  it('user_message 带 isInterjection 时创建带 isInterjection 的 user 行', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    handleUserStreamEvent(set, get, {
      type: 'user_message',
      text: '插话内容',
      isInterjection: true,
      ts: 12345,
    })
    const users = state().entries.filter((e) => e.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({
      kind: 'user',
      text: '插话内容',
      isInterjection: true,
      ts: 12345,
    })
  })

  it('user_message 带 isShell（TUI `!` 直连 bash 回放）→ 用户行标 isShell', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    handleUserStreamEvent(set, get, {
      type: 'user_message',
      text: 'git status',
      isShell: true,
      ts: 12345,
    })
    const users = state().entries.filter((e) => e.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ kind: 'user', text: 'git status', isShell: true })
  })

  it('普通 user_message 不带 isShell', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    handleUserStreamEvent(set, get, { type: 'user_message', text: '普通提问', ts: 1 })
    expect(state().entries[0]).toMatchObject({ kind: 'user', text: '普通提问' })
    expect((state().entries[0] as { isShell?: boolean }).isShell).toBeUndefined()
  })
})

/**
 * 已收口回合的输出守卫：自动唤醒轮（kill 通知 / 子代理完成注入）的触发
 * 提示是隐藏 system-reminder，按设计不清 lastCompletedTurn，只能靠流/回合
 * 身份比对放行。放行失败时 thought/chunk 整轮被丢、只剩工具行与回合标记
 * （直播看不到、重放又正常）。
 */
describe('userStream — 已收口回合守卫（自动唤醒轮直播）', () => {
  const closed = (lastCompletedTurn: Record<string, unknown>) => ({
    sessionId: 's1',
    conn: 'ready' as const,
    awaitingNext: true,
    liveStream: null,
    lastCompletedTurn,
  })

  it('同一已收口流的迟到输出仍丢弃', () => {
    const { set, get, state } = makeStore(closed({ turnStartMs: 500, streamStartMs: 1000, endMs: 2000 }))
    handleUserStreamEvent(set, get, chunk('迟到正文', 1000))
    expect(assistantOf(state())).toBeUndefined()
    expect(state().liveStream).toBeNull()
  })

  it('唤醒轮（流起点不同）放行：思考与正文都渲染，并退掉旧守卫', () => {
    const { set, get, state } = makeStore(closed({ turnStartMs: 500, streamStartMs: 1000, endMs: 2000 }))
    handleUserStreamEvent(set, get, thought('唤醒思考', 3000))
    handleUserStreamEvent(set, get, chunk('唤醒正文', 3000))
    expect(rendered(state(), thoughtOf(state())!)).toContain('唤醒思考')
    const a = assistantOf(state())
    expect(a).toBeDefined()
    expect(rendered(state(), a!)).toBe('唤醒正文')
    expect(state().lastCompletedTurn).toBeUndefined()
  })

  it('戳记只剩回合身份（streamStartMs 被重复收尾抹掉）→ 用 turnStartMs 判新回合放行', () => {
    const { set, get, state } = makeStore(closed({ turnStartMs: 500, endMs: 2000 }))
    handleUserStreamEvent(set, get, {
      type: 'thought',
      text: '唤醒思考',
      streamStartMs: 3000,
      turnStartMs: 600,
    } as AcpEvent)
    handleUserStreamEvent(set, get, {
      type: 'chunk',
      text: '唤醒正文',
      streamStartMs: 3000,
      turnStartMs: 600,
    } as AcpEvent)
    const a = assistantOf(state())
    expect(a).toBeDefined()
    expect(rendered(state(), a!)).toBe('唤醒正文')
  })

  it('身份不可比（无流也无回合戳）时保守丢弃', () => {
    const { set, get, state } = makeStore(closed({ endMs: 2000 }))
    handleUserStreamEvent(set, get, chunk('迟到正文', 3000))
    expect(assistantOf(state())).toBeUndefined()
  })
})
