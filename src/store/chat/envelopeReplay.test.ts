import { describe, expect, it } from 'vitest'
import { envelopeTotalTokens, reorderLateAgentEvents, replayUpdates } from './envelopeReplay'
import type { ChatState } from './types'

function env(kind: string, over: Record<string, unknown> = {}, paramsMeta?: Record<string, unknown>): Record<string, unknown> {
  const e: Record<string, unknown> = {
    method: 'session/update',
    params: { update: { sessionUpdate: kind, ...over } },
  }
  if (paramsMeta) (e.params as Record<string, unknown>)._meta = paramsMeta
  return e
}

describe('reorderLateAgentEvents', () => {
  it('正常顺序不变', () => {
    const updates = [env('user_message_chunk', { content: 'q' }), env('agent_message_chunk', { content: 'a' }), env('turn_completed')]
    expect(reorderLateAgentEvents(updates)).toEqual(updates)
  })

  it('收口后的迟到 chunk 插入到 terminal 之前', () => {
    const terminal = env('turn_completed', {}, { turnStartMs: 100, agentTimestampMs: 150 })
    const late = env('agent_message_chunk', {
      content: 'late',
      _meta: { turnStartMs: 100, agentTimestampMs: 149 },
    })
    const ordered = reorderLateAgentEvents([terminal, late])
    expect(ordered).toEqual([late, terminal])
  })

  it('新 user 回合后不再重排旧 chunk', () => {
    const late = env('agent_message_chunk', {
      content: 'late',
      _meta: { turnStartMs: 100, agentTimestampMs: 149 },
    })
    const terminal = env('turn_completed', {}, { agentTimestampMs: 150 })
    const nextUser = env('user_message_chunk', { content: 'next round' })
    const ordered = reorderLateAgentEvents([terminal, nextUser, late])
    expect(ordered[2]).toBe(late)
  })

  it('不属于已收口回合的迟到事件被丢弃', () => {
    const stray = env('agent_thought_chunk', {
      content: 'stray',
      _meta: { turnStartMs: 999, agentTimestampMs: 1000 },
    })
    const terminal = env('turn_completed', {}, { agentTimestampMs: 150 })
    const ordered = reorderLateAgentEvents([terminal, stray])
    expect(ordered).toEqual([terminal])
  })

  it('取消回合迟落的用户回声（agentTs 早于终态）移回 terminal 之前', () => {
    // 真实形态：echo 落盘在 turn_completed 之后，但 agentTimestampMs 仍早于终态。
    const terminal = env('turn_completed', { stop_reason: 'cancelled' }, { agentTimestampMs: 1500 })
    const echo = env('user_message_chunk', { content: 'hi' }, { agentTimestampMs: 1200 })
    expect(reorderLateAgentEvents([terminal, echo])).toEqual([echo, terminal])
  })

  it('回声插到前一条 user 之后，而非页首', () => {
    const userA = env('user_message_chunk', { content: 'q' }, { agentTimestampMs: 100 })
    const thought = env('agent_thought_chunk', { content: 't' }, { agentTimestampMs: 110 })
    const terminal = env('turn_completed', { stop_reason: 'cancelled' }, { agentTimestampMs: 1500 })
    const echo = env('user_message_chunk', { content: 'hi' }, { agentTimestampMs: 120 })
    expect(reorderLateAgentEvents([userA, thought, terminal, echo])).toEqual([
      userA,
      echo,
      thought,
      terminal,
    ])
  })

  it('晚于终态的 user 消息是下一回合的 prompt，不移动', () => {
    const terminal = env('turn_completed', { stop_reason: 'cancelled' }, { agentTimestampMs: 1500 })
    const next = env('user_message_chunk', { content: '继续' }, { agentTimestampMs: 1600 })
    expect(reorderLateAgentEvents([terminal, next])).toEqual([terminal, next])
  })

  it('无 agentTimestampMs 的 user 消息保持原位（旧日志 legacy 行为）', () => {
    const terminal = env('turn_completed', { stop_reason: 'cancelled' }, { agentTimestampMs: 1500 })
    const next = env('user_message_chunk', { content: '继续' })
    expect(reorderLateAgentEvents([terminal, next])).toEqual([terminal, next])
  })
})

describe('envelopeTotalTokens', () => {
  it('读取 params._meta.totalTokens', () => {
    expect(envelopeTotalTokens({ params: { _meta: { totalTokens: 123 } } })).toBe(123)
    expect(envelopeTotalTokens({ params: {} })).toBeUndefined()
    expect(envelopeTotalTokens({})).toBeUndefined()
  })
})

describe('replayUpdates', () => {
  it('回放事件喂给 handleEvent 并聚合 user 文本', () => {
    const handled: unknown[] = []
    const getStore = () =>
      ({
        handleEvent: (ev: unknown) => handled.push(ev),
        appendLocalEntry: () => {},
        topTasks: [],
      }) as unknown as ChatState

    const res = replayUpdates(getStore as never, [
      env('user_message_chunk', { content: '你好' }),
      env('agent_message_chunk', { content: '回复' }),
    ])
    // agent 事件处理前先 flush 缓冲 user；chunk 随后直喂
    expect(handled).toHaveLength(2)
    expect(handled[0]).toMatchObject({ type: 'user_message', text: '你好' })
    expect(handled[1]).toMatchObject({ type: 'chunk', text: '回复' })
    expect(res.turnOpen).toBe(true)
  })

  it('turn_completed 后无新 user → turnOpen false', () => {
    const handled: unknown[] = []
    const getStore = () =>
      ({ handleEvent: (ev: unknown) => handled.push(ev), appendLocalEntry: () => {}, topTasks: [] }) as unknown as ChatState
    const res = replayUpdates(getStore as never, [
      env('user_message_chunk', { content: 'q' }),
      env('turn_completed', { stop_reason: 'completed' }, { agentTimestampMs: 200 }),
    ])
    expect(res.turnOpen).toBe(false)
    // 有 user + turn_completed → handled 至少含 user_message
    expect(handled.some((h) => (h as { type?: string }).type === 'user_message')).toBe(true)
  })

  it('applyUsage=false 时不发 usage；默认按页尾 totalTokens 补发一次', () => {
    const handled: unknown[] = []
    const getStore = () =>
      ({ handleEvent: (ev: unknown) => handled.push(ev), appendLocalEntry: () => {}, topTasks: [] }) as unknown as ChatState
    const usageEnv = env('usage_update', { used: 5, size: 10, cost: 1 }, { totalTokens: 77 })
    const res = replayUpdates(getStore as never, [usageEnv], { applyUsage: false })
    // 页面 usage 事件被跳过
    expect(handled.some((h) => (h as { type?: string }).type === 'usage')).toBe(false)
    void res

    const handled2: unknown[] = []
    const getStore2 = () =>
      ({ handleEvent: (ev: unknown) => handled2.push(ev), appendLocalEntry: () => {}, topTasks: [] }) as unknown as ChatState
    replayUpdates(getStore2 as never, [usageEnv])
    // 默认模式 → 页尾补发总 token 的 usage
    expect(handled2).toContainEqual({ type: 'usage', used: 77 })
  })

  it('model 切换插入提示行', () => {
    const entries: unknown[] = []
    const handled: unknown[] = []
    const getStore = () =>
      ({
        handleEvent: (ev: unknown) => handled.push(ev),
        appendLocalEntry: (e: unknown) => entries.push(e),
        topTasks: [],
        models: [],
      }) as unknown as ChatState
    replayUpdates(getStore as never, [
      env('user_message_chunk', { content: 'a', _meta: { modelId: 'grok-3' } }),
      env('user_message_chunk', { content: 'b', _meta: { modelId: 'grok-4' } }),
    ])
    expect(entries.some((e) => JSON.stringify(e).includes('模型已从'))).toBe(true)
  })

  it('取消回合回声迟落（复刻真实会话形态）：user 行先于收口标记，时长从回声时间推导', () => {
    // 复刻 019fbcfe 会话：[retry_state, turn_completed(cancelled), user 'hi']
    // —— echo 落盘最晚但 agentTimestampMs 最早，replay 必须先 flush user
    // 再追加 marker，且 turnStartedAt 取回声的 agentTs（真实 prompt 时刻）。
    const handled: unknown[] = []
    const getStore = () =>
      ({ handleEvent: (ev: unknown) => handled.push(ev), appendLocalEntry: () => {}, topTasks: [] }) as unknown as ChatState
    const res = replayUpdates(getStore as never, [
      env('retry_state', { type: 'retrying', attempt: 1 }, { agentTimestampMs: 1300 }),
      env('turn_completed', { stop_reason: 'cancelled' }, { agentTimestampMs: 1500 }),
      env('user_message_chunk', { content: 'hi' }, { agentTimestampMs: 1200 }),
    ])
    // retry_state 派发 session_notification（只进状态栏，不产生条目）。
    expect(handled.map((h) => (h as { type?: string }).type)).toEqual([
      'user_message',
      'session_notification',
      'turn_completed',
    ])
    expect(handled[0]).toMatchObject({ type: 'user_message', text: 'hi' })
    expect(handled[2]).toMatchObject({ type: 'turn_completed', turnStartedAt: 1200, endMs: 1500 })
    expect(res.turnOpen).toBe(false)
  })

  it('聚合用户行的 user_message 取首条 chunk 的 msgSeq', () => {
    const handled: unknown[] = []
    const getStore = () =>
      ({ handleEvent: (ev: unknown) => handled.push(ev), appendLocalEntry: () => {}, topTasks: [] }) as unknown as ChatState
    const res = replayUpdates(getStore as never, [
      { ...env('user_message_chunk', { content: '你好' }), msgSeq: 10 },
      { ...env('user_message_chunk', { content: '，世界' }), msgSeq: 11 },
      { ...env('agent_message_chunk', { content: '回' }), msgSeq: 12 },
    ])
    expect(handled[0]).toMatchObject({ type: 'user_message', text: '你好，世界', msgSeq: 10 })
    expect(handled[1]).toMatchObject({ type: 'chunk', text: '回', msgSeq: 12 })
    expect(res.entryMsgSeq).toBeInstanceOf(Map)
  })

  it('回放产生的条目按首条事件盖信封 msgSeq（entryMsgSeq 表）', () => {
    const entries: Array<Record<string, unknown>> = []
    const getStore = () =>
      ({
        handleEvent: (ev: unknown) => {
          const t = (ev as { type?: string }).type
          // 模拟条目创建：不带 msgSeq（由 applyEntryMsgSeq 补盖）。
          if (t === 'chunk') {
            entries.push({ id: `e${entries.length}`, kind: 'assistant', text: '' })
          } else if (t === 'thought') {
            entries.push({ id: `e${entries.length}`, kind: 'thought', text: '' })
          }
        },
        appendLocalEntry: () => {},
        topTasks: [],
        entries,
      }) as unknown as ChatState
    const res = replayUpdates(getStore as never, [
      { ...env('agent_message_chunk', { content: 'x' }), msgSeq: 0 },
      { ...env('agent_thought_chunk', { content: 't' }), msgSeq: 1 },
    ])
    expect(entries).toHaveLength(2)
    expect(res.entryMsgSeq.get('e0')).toBe(0)
    expect(res.entryMsgSeq.get('e1')).toBe(1)
  })

  it('迟落回声与下一回合 prompt 混邻：两条 user 分行，中间被收口标记隔开', () => {
    const handled: unknown[] = []
    const getStore = () =>
      ({ handleEvent: (ev: unknown) => handled.push(ev), appendLocalEntry: () => {}, topTasks: [] }) as unknown as ChatState
    replayUpdates(getStore as never, [
      env('turn_completed', { stop_reason: 'cancelled' }, { agentTimestampMs: 1500 }),
      env('user_message_chunk', { content: '第一条' }, { agentTimestampMs: 1200 }),
      env('user_message_chunk', { content: '继续' }, { agentTimestampMs: 1600 }),
      env('agent_thought_chunk', { content: 't' }, { agentTimestampMs: 1700 }),
    ])
    // 第一条回声移到 terminal 前；「继续」留在 terminal 后开新回合。
    expect(handled.map((h) => (h as { type?: string }).type)).toEqual([
      'user_message',
      'turn_completed',
      'user_message',
      'thought',
    ])
    expect(handled[0]).toMatchObject({ text: '第一条' })
    expect(handled[2]).toMatchObject({ text: '继续' })
  })

  it('hostTurn 注入不画用户行，且结束当前 user run', () => {
    const handled: unknown[] = []
    const getStore = () =>
      ({ handleEvent: (ev: unknown) => handled.push(ev), appendLocalEntry: () => {}, topTasks: [] }) as unknown as ChatState
    replayUpdates(getStore as never, [
      env('user_message_chunk', { content: 'A' }),
      env('user_message_chunk', { content: 'injected', _meta: { hostTurn: true } }),
      env('user_message_chunk', { content: 'B' }),
      env('agent_message_chunk', { content: 'ok' }),
    ])
    const users = handled.filter((h) => (h as { type?: string }).type === 'user_message')
    expect(users).toEqual([
      expect.objectContaining({ text: 'A' }),
      expect.objectContaining({ text: 'B' }),
    ])
  })

  it('见过 promptIndex 之后的无标记 user run 不画用户行', () => {
    const handled: unknown[] = []
    const getStore = () =>
      ({ handleEvent: (ev: unknown) => handled.push(ev), appendLocalEntry: () => {}, topTasks: [] }) as unknown as ChatState
    replayUpdates(getStore as never, [
      env('user_message_chunk', { content: 'A', _meta: { promptIndex: 0 } }),
      env('agent_message_chunk', { content: 'a1' }),
      env('user_message_chunk', { content: 'phantom' }),
      env('agent_message_chunk', { content: 'p1' }),
      env('user_message_chunk', { content: 'B', _meta: { promptIndex: 1 } }),
    ])
    const users = handled.filter((h) => (h as { type?: string }).type === 'user_message')
    expect(users.map((h) => (h as { text?: string }).text)).toEqual(['A', 'B'])
  })
})