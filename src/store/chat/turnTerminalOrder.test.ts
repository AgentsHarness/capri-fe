import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import { useChatStore } from '../chat'
import { flushStreamBuf } from './stream'
import { replayUpdates } from './envelopeReplay'

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

/**
 * 采样终态失败时 agent 先发 retry_state 通知、再以 prompt 错误收口，两个
 * 信号各带同一份 reason。TUI 只留重试横幅（terminal_marker：error +
 * error_banner_present → None，rate_limit → None）；FE 曾把 "推理失败: …"
 * 与 "Turn failed: …" 两行都画出来。
 */
describe('失败回合：重试横幅与 TurnFailed 标记只留一条', () => {
  type FailureLine = Extract<ScrollEntry, { kind: 'session_event' }>
  const isFailureLine = (e: ScrollEntry): e is FailureLine =>
    e.kind === 'session_event' &&
    (e.retryBanner === true || e.text.startsWith('Turn failed'))
  const failures = () => useChatStore.getState().entries.filter(isFailureLine)

  const retryState = (extra: Record<string, unknown>) =>
    ({
      type: 'retry_state',
      sessionId: S,
      update: { sessionUpdate: 'retry_state', ...extra },
    }) as never

  const failTurn = (stopReason: string, agentResult?: string) =>
    ({
      type: 'turn_completed',
      sessionId: S,
      stopReason,
      meta: { promptId: 'p1' },
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'p1',
        stop_reason: stopReason,
        ...(agentResult != null ? { agent_result: agentResult } : {}),
      },
    }) as never

  it('retry_state failed 先到 → 只留横幅行（不再补 Turn failed）', () => {
    reset()
    const h = (ev: unknown) => useChatStore.getState().handleEvent(ev as never)
    h(retryState({ type: 'failed', errorType: 'auth', message: 'Unauthorized (401)' }))
    h(failTurn('error', 'Unauthorized (401)'))

    const lines = failures()
    expect(lines).toHaveLength(1)
    expect(lines[0].retryBanner).toBe(true)
  })

  it('限流：exhausted 横幅 + rate_limit 收口 → 同样只留横幅', () => {
    reset()
    const h = (ev: unknown) => useChatStore.getState().handleEvent(ev as never)
    h(retryState({ type: 'exhausted', attempts: 3, reason: 'API error (429)', isRateLimited: true }))
    h(failTurn('rate_limit'))

    const lines = failures()
    expect(lines).toHaveLength(1)
    expect(lines[0].retryBanner).toBe(true)
  })

  it('没有横幅（RPC 层失败 / 通知丢失）→ TurnFailed 标记照常出现', () => {
    reset()
    const h = (ev: unknown) => useChatStore.getState().handleEvent(ev as never)
    h(failTurn('error', 'connection reset'))

    const lines = failures()
    expect(lines).toHaveLength(1)
    expect(lines[0].retryBanner).toBeUndefined()
  })

  // 另外两条收口载体（谁先到谁画标记）：x.ai/session/prompt_complete 与
  // generic session_notification 的 turn_completed。它们都要走同一抑制，
  // 否则"横幅 + Turn failed"会因为到达顺序不同而复现。
  it('prompt_complete 先到 → 同样只留横幅', () => {
    reset()
    const h = (ev: unknown) => useChatStore.getState().handleEvent(ev as never)
    h(retryState({ type: 'failed', errorType: 'server', message: 'boom' }))
    h({
      type: 'prompt_complete',
      sessionId: S,
      params: { promptId: 'p1', stopReason: 'error', agentResult: 'boom' },
    } as never)

    const lines = failures()
    expect(lines).toHaveLength(1)
    expect(lines[0].retryBanner).toBe(true)
  })

  it('generic turn_completed（回放载体）先到 → 同样只留横幅', () => {
    reset()
    const h = (ev: unknown) => useChatStore.getState().handleEvent(ev as never)
    h(retryState({ type: 'failed', errorType: 'server', message: 'boom' }))
    h({
      type: 'session_notification',
      sessionId: S,
      params: { sessionUpdate: 'turn_completed', stop_reason: 'error', agent_result: 'boom' },
    } as never)

    const lines = failures()
    expect(lines).toHaveLength(1)
    expect(lines[0].retryBanner).toBe(true)
  })

  it('retrying（非终态）不落行，也不抑制随后的失败标记', () => {
    reset()
    const h = (ev: unknown) => useChatStore.getState().handleEvent(ev as never)
    h(retryState({ type: 'retrying', attempt: 1, maxRetries: 3, reason: 'overloaded' }))
    expect(failures()).toHaveLength(0)

    h(failTurn('error', 'overloaded'))
    expect(failures()).toHaveLength(1)
    expect(failures()[0].retryBanner).toBeUndefined()
  })

  it('横幅来自上一回合（隔了用户行）→ 新回合的失败标记仍要画', () => {
    reset()
    useChatStore.setState({
      sessionId: S,
      cwd: '/w',
      conn: 'busy',
      turnStartedAt: TURN_START,
      currentPromptId: 'p1',
      entries: [
        { id: 'u0', kind: 'user', text: '第一条', ts: TURN_START - 1000 },
        { id: 'b0', kind: 'session_event', text: '推理失败（server）: boom', warning: true, retryBanner: true },
        { id: 'u1', kind: 'user', text: '第二条', ts: TURN_START },
      ] as never,
    } as never)
    const h = (ev: unknown) => useChatStore.getState().handleEvent(ev as never)
    h(failTurn('error', 'boom'))

    const lines = failures()
    expect(lines).toHaveLength(2)
    expect(lines[1].retryBanner).toBeUndefined()
  })

  // 重开会话：日志里 retry_state 横幅先于收口信封落盘，回放同样不能补标记。
  it('历史回放：横幅 + turn_completed(error) 只回放出一行', () => {
    reset()
    const envelope = (update: Record<string, unknown>, meta: Record<string, unknown>) => ({
      method: 'session/update',
      params: { update, _meta: meta },
    })
    replayUpdates(() => useChatStore.getState(), [
      envelope(
        { sessionUpdate: 'retry_state', type: 'failed', errorType: 'auth', message: 'Unauthorized (401)' },
        { agentTimestampMs: TURN_START + 1000 },
      ),
      envelope(
        {
          sessionUpdate: 'turn_completed',
          stop_reason: 'error',
          agent_result: 'Unauthorized (401)',
        },
        { turnStartMs: TURN_START, agentTimestampMs: TURN_START + 2000 },
      ),
    ])

    const lines = failures()
    expect(lines).toHaveLength(1)
    expect(lines[0].retryBanner).toBe(true)
  })
})
