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
})