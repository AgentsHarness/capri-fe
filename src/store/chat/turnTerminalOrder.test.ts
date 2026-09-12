import { describe, expect, it } from 'vitest'
import { useChatStore } from '../chat'
import { flushStreamBuf } from './stream'

/**
 * 终态多载体到达顺序审计。一个回合会被 done（session/prompt RPC 结果）、
 * prompt_complete、turn_completed（x.ai rail）、cancelled 多个载体收尾，
 * 顺序不定。收尾必须幂等：后到者不得抹掉先到者盖下的回合/流身份，否则
 * rejectClosedTurnAgentOutput 会把紧随其后的自动唤醒轮（kill 通知 / 子代理
 * 完成注入：触发提示是隐藏 system-reminder，不清这道守卫）的 thought 与
 * 正文整轮丢掉——直播看不到、重放又正常，只剩工具行和回合标记。
 */
const S = 's1'
const TURN_START = 1_789_240_010_000
const STREAM = 1_789_240_018_637
const WAKE_TURN_START = 1_789_240_030_000
const WAKE_STREAM = 1_789_240_031_000

function reset() {
  useChatStore.setState({
    sessionId: S,
    cwd: '/w',
    entries: [{ id: 'u1', kind: 'user', text: '发task', ts: TURN_START }] as never,
    conn: 'busy',
    awaitingNext: false,
    turnStartedAt: TURN_START,
    currentPromptId: 'p1',
    statusText: 'Responding…',
    lastCompletedTurn: undefined,
    currentStreamStartMs: STREAM,
    liveStream: null,
    openAssistantId: undefined,
    openThoughtId: undefined,
    pendingOptimisticUserId: undefined,
    pending: [],
    xaiRequests: [],
  } as never)
}

const terminal = (type: string, stopReason = 'end_turn') => {
  if (type === 'prompt_complete') {
    return { type, sessionId: S, params: { promptId: 'p1', stopReason } }
  }
  if (type === 'done') {
    return { type, sessionId: S, stopReason, meta: { promptId: 'p1' } }
  }
  if (type === 'cancelled') {
    return { type, sessionId: S, stopReason: 'cancelled' }
  }
  return {
    type,
    sessionId: S,
    stopReason,
    update: { sessionUpdate: 'turn_completed', prompt_id: 'p1', stop_reason: stopReason },
  }
}

/** 隐藏触发提示的自动唤醒轮：整轮走完收尾后，正文必须真的进过滚动区。 */
function wakeTurnRenders(): boolean {
  const h = (ev: unknown) => useChatStore.getState().handleEvent(ev as never)
  h({
    type: 'user_chunk',
    sessionId: S,
    text: '<system-reminder>\nBackground task "x" completed (terminated by signal killed).',
    hideFromScrollback: true,
  })
  h({ type: 'thought', sessionId: S, text: '唤醒思考', streamStartMs: WAKE_STREAM, turnStartMs: WAKE_TURN_START })
  h({ type: 'chunk', sessionId: S, text: '唤醒正文', streamStartMs: WAKE_STREAM, turnStartMs: WAKE_TURN_START })
  flushStreamBuf(useChatStore.setState, useChatStore.getState)
  h({
    type: 'turn_completed',
    sessionId: S,
    stopReason: 'end_turn',
    update: {
      sessionUpdate: 'turn_completed',
      prompt_id: 'task-completed-x',
      stop_reason: 'end_turn',
    },
  })
  const s = useChatStore.getState()
  return s.entries.some((e) => {
    const base = 'text' in e ? (e.text ?? '') : ''
    const live = s.liveStream?.entryId === e.id ? s.liveStream.text : ''
    return base.includes('唤醒正文') || live.includes('唤醒正文')
  })
}

const SUCCESS_ORDERS = [
  ['prompt_complete', 'done'],
  ['done', 'prompt_complete'],
  ['turn_completed', 'done'],
  ['done', 'turn_completed'],
  ['prompt_complete', 'turn_completed'],
  ['turn_completed', 'prompt_complete'],
  ['done', 'prompt_complete', 'turn_completed'],
  ['prompt_complete', 'done', 'turn_completed'],
  ['turn_completed', 'done', 'prompt_complete'],
]

describe('终态多载体到达顺序（正常回合）', () => {
  for (const order of SUCCESS_ORDERS) {
    it(`${order.join(' → ')}：戳记保留 + 唤醒轮可直播`, () => {
      reset()
      const h = (ev: unknown) => useChatStore.getState().handleEvent(ev as never)
      h({ type: 'chunk', sessionId: S, text: '最终答复', streamStartMs: STREAM, turnStartMs: TURN_START })
      for (const t of order) h(terminal(t))

      const stamp = useChatStore.getState().lastCompletedTurn
      expect(stamp?.turnStartMs).toBe(TURN_START)
      expect(stamp?.streamStartMs).toBe(STREAM)
      expect(wakeTurnRenders()).toBe(true)
    })
  }
})

describe('终态多载体到达顺序（取消 / 失败回合）', () => {
  for (const [order, stop] of [
    [['cancelled', 'done'], 'cancelled'],
    [['done', 'cancelled'], 'cancelled'],
    [['turn_completed', 'done'], 'error'],
    [['done', 'turn_completed'], 'error'],
  ] as const) {
    it(`${order.join(' → ')}（${stop}）：唤醒轮仍可直播`, () => {
      reset()
      const h = (ev: unknown) => useChatStore.getState().handleEvent(ev as never)
      h({ type: 'chunk', sessionId: S, text: '部分答复', streamStartMs: STREAM, turnStartMs: TURN_START })
      for (const t of order) h(terminal(t, t === 'cancelled' ? 'cancelled' : stop))

      expect(wakeTurnRenders()).toBe(true)
    })
  }
})
