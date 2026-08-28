import { describe, expect, it } from 'vitest'
import type { AcpEvent, ScrollEntry } from '../../api/types'
import {
  classifyUserPrompt,
  envelopeEventId,
  envelopeMsgSeq,
  envelopeTimestamp,
  envelopeToEvent,
  envelopeToEvents,
  eventAgentTimestampMs,
  eventEventId,
  extractCronPromptBody,
  findOptimisticUserAbsorbIndex,
  normalizeUserPromptText,
  replayEnvelopeKeys,
  replayEventKeys,
  stripContextWrappers,
  turnCompletedEvent,
  userMessageHiddenFromScrollback,
  userPromptTextsMatch,
} from './envelopeParse'

function env(method: string, update: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): unknown {
  const e: Record<string, unknown> = { method, ...extra }
  if (update !== undefined) e.params = { update }
  return e
}

describe('envelopeTimestamp', () => {
  it('epoch 秒 / 毫秒 / RFC3339 字符串', () => {
    expect(envelopeTimestamp({ timestamp: 1_700_000_000 } as never)).toBe(1_700_000_000_000)
    expect(envelopeTimestamp({ timestamp: 1_700_000_000_000 } as never)).toBe(1_700_000_000_000)
    expect(envelopeTimestamp({ timestamp: '2023-11-14T22:13:20Z' } as never)).toBe(Date.parse('2023-11-14T22:13:20Z'))
  })

  it('非法值 → undefined', () => {
    expect(envelopeTimestamp({ timestamp: 'garbage' } as never)).toBeUndefined()
    expect(envelopeTimestamp({} as never)).toBeUndefined()
  })
})

describe('stripContextWrappers', () => {
  it('剥 <fork-context>/<resume-context> 包裹', () => {
    expect(stripContextWrappers('hi <fork-context>x</fork-context> there')).toBe('hi there')
    expect(stripContextWrappers('<resume-context>ctx</resume-context>question?')).toBe('question?')
  })

  it('无包裹原样返回；未闭合不剥', () => {
    expect(stripContextWrappers('plain')).toBe('plain')
    expect(stripContextWrappers('<fork-context>unclosed')).toBe('<fork-context>unclosed')
  })
})

describe('extractCronPromptBody', () => {
  const reminder = '<system-reminder>\nThis is a scheduled task execution reminder.\n</system-reminder>'

  it('cron 框体 → 提取 prompt', () => {
    const text = `${reminder}\n\n请检查测试`
    expect(extractCronPromptBody(text)).toBe('请检查测试')
  })

  it('非 cron 框 / 缺 endTag / 非 reminder → null', () => {
    expect(extractCronPromptBody('<system-reminder>x</system-reminder>')).toBeNull()
    expect(extractCronPromptBody('<system-reminder>scheduled task execution')).toBeNull()
    expect(extractCronPromptBody('plain')).toBeNull()
  })
})

describe('userMessageHiddenFromScrollback', () => {
  it('system-reminder / monitor-event / --- 隐藏', () => {
    expect(userMessageHiddenFromScrollback('<system-reminder>x</system-reminder>')).toBe(true)
    expect(userMessageHiddenFromScrollback('<monitor-event type="x">')).toBe(true)
    expect(userMessageHiddenFromScrollback('---')).toBe(true)
    expect(userMessageHiddenFromScrollback('  ---  ')).toBe(true)
  })

  it('monitor 汇总数字行隐藏', () => {
    expect(userMessageHiddenFromScrollback('12 monitor events from host (use /monitor)')).toBe(true)
  })

  it('普通消息不隐藏', () => {
    expect(userMessageHiddenFromScrollback('hello')).toBe(false)
  })
})

describe('classifyUserPrompt', () => {
  it('普通文本 → isCron false；空文本 → null', () => {
    expect(classifyUserPrompt('hello')).toEqual({ text: 'hello', isCron: false })
    // 纯空白不进隐藏判定，原样返回
    expect(classifyUserPrompt('  ')).toEqual({ text: '  ', isCron: false })
    expect(classifyUserPrompt('')).toBeNull()
  })

  it('forcedCron / cron 框体 → isCron true 且剥壳', () => {
    expect(classifyUserPrompt('x', true)).toEqual({ text: 'x', isCron: true })
    expect(
      classifyUserPrompt('<system-reminder>\nThis is a scheduled task execution.\n</system-reminder>\n\ndo it'),
    ).toEqual({ text: 'do it', isCron: true })
  })

  it('隐藏内容 → null', () => {
    expect(classifyUserPrompt('<monitor-event x>')).toBeNull()
  })
})

describe('normalizeUserPromptText / userPromptTextsMatch', () => {
  it('剥 user_query 包裹并修整换行', () => {
    expect(normalizeUserPromptText('<user_query>\nhello\n</user_query>')).toBe('hello')
    expect(normalizeUserPromptText('hello')).toBe('hello')
  })

  it('匹配忽略包裹差异', () => {
    expect(userPromptTextsMatch('<user_query>hi</user_query>', 'hi')).toBe(true)
    expect(userPromptTextsMatch('a', 'b')).toBe(false)
  })
})

describe('findOptimisticUserAbsorbIndex', () => {
  const entries: ScrollEntry[] = [
    { id: 'u1', kind: 'user', text: 'first' },
    { id: 'th1', kind: 'thought', text: 'x' },
    { id: 'u2', kind: 'user', text: 'second' },
  ]

  it('优先匹配 pendingId', () => {
    expect(findOptimisticUserAbsorbIndex(entries, 'u1', 'first')).toBe(0)
    expect(findOptimisticUserAbsorbIndex(entries, 'missing', 'second')).toBe(2)
  })

  it('无 pendingId → 忽略末尾 thought 找匹配 user；text 不匹配 → -1', () => {
    expect(findOptimisticUserAbsorbIndex(entries, undefined, 'second')).toBe(2)
    expect(findOptimisticUserAbsorbIndex(entries, undefined, 'nope')).toBe(-1)
  })

  it('越过回合收口 chrome（Worked for / status / error）仍命中最后一条 user', () => {
    const withMarker: ScrollEntry[] = [
      { id: 'u2', kind: 'user', text: 'second' },
      { id: 'm', kind: 'session_event', text: 'Worked for 1.0s' },
    ]
    expect(findOptimisticUserAbsorbIndex(withMarker, undefined, 'second')).toBe(0)
    expect(
      findOptimisticUserAbsorbIndex(
        [
          { id: 'u2', kind: 'user', text: 'second' },
          { id: 'a', kind: 'assistant', text: 'reply' },
          { id: 'm', kind: 'session_event', text: 'Worked for 1.0s' },
        ],
        undefined,
        'second',
      ),
    ).toBe(-1)
  })
})

describe('eventAgentTimestampMs', () => {
  it('顶层 / params._meta / update._meta', () => {
    expect(eventAgentTimestampMs({ type: 'chunk', agentTimestampMs: 9 })).toBe(9)
    expect(
      eventAgentTimestampMs({
        type: 'chunk',
        params: { _meta: { agentTimestampMs: 11 } },
      }),
    ).toBe(11)
    expect(
      eventAgentTimestampMs({
        type: 'session_notification',
        params: { update: { _meta: { agentTimestampMs: 13 } } },
      }),
    ).toBe(13)
    expect(eventAgentTimestampMs({ type: 'chunk', text: 'x' })).toBeUndefined()
  })
})

describe('turnCompletedEvent / completionEndMs', () => {
  it('解析 stop_reason / agent_result / endMs / meta', () => {
    const ev = turnCompletedEvent(
      { stop_reason: 'cancelled', agent_result: 'UserCancelled' },
      1234,
      { source: 'replay' },
    )
    expect(ev).toMatchObject({
      type: 'turn_completed',
      stopReason: 'cancelled',
      agentResult: 'UserCancelled',
      endMs: 1234,
      meta: { source: 'replay' },
    })
  })

  it('update.elapsed_ms → 事件携带 elapsedMs（camelCase 兜底）', () => {
    const snake = turnCompletedEvent({ stop_reason: 'end_turn', elapsed_ms: 4321 }, 9)
    expect((snake as { elapsedMs?: number }).elapsedMs).toBe(4321)
    const camel = turnCompletedEvent({ stop_reason: 'end_turn', elapsedMs: 4321 }, 9)
    expect((camel as { elapsedMs?: number }).elapsedMs).toBe(4321)
    // 旧信封没有该键 → 不携带（replay 回落 turnStart/endMs 推导）
    const absent = turnCompletedEvent({ stop_reason: 'end_turn' }, 9)
    expect((absent as { elapsedMs?: number }).elapsedMs).toBeUndefined()
  })

  it('meta 非对象不携带', () => {
    const ev = turnCompletedEvent({}, 1, 'str')
    expect((ev as { meta?: unknown }).meta).toBeUndefined()
  })
})

describe('envelopeToEvents', () => {
  it('非 session/update → 空数组', () => {
    expect(envelopeToEvents({ method: 'other' })).toEqual([])
    expect(envelopeToEvents(env('session/update', undefined))).toEqual([])
  })

  it('agent_message_chunk：文本 + 图片 block', () => {
    const evs = envelopeToEvents(
      env('session/update', {
        sessionUpdate: 'agent_message_chunk',
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'image', data: 'abc', mimeType: 'image/png' },
        ],
      }),
    )
    expect(evs).toHaveLength(2)
    expect(evs[0]).toMatchObject({ type: 'chunk', text: 'hello ' })
    expect(evs[1]).toMatchObject({ type: 'image', data: 'abc', mimeType: 'image/png', role: 'assistant' })
  })

  it('agent_thought_chunk：elapsedMs 从 agentTimestampMs - streamStartMs', () => {
    const evs = envelopeToEvents(
      env('session/update', {
        sessionUpdate: 'agent_thought_chunk',
        content: 'thinking…',
        _meta: { agentTimestampMs: 5000, streamStartMs: 4000, turnStartMs: 3000 },
      }),
    )
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({
      type: 'thought',
      text: 'thinking…',
      elapsedMs: 1000,
      turnStartMs: 3000,
      streamStartMs: 4000,
      agentTimestampMs: 5000,
    })
  })

  it('user_message_chunk：剥壳 + displayAsCron + hideFromScrollback', () => {
    const evs = envelopeToEvents(
      env('session/update', {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'normal q' },
      }),
    )
    expect(evs[0]).toMatchObject({ type: 'user_message', text: 'normal q' })

    const hidden = envelopeToEvents(
      env('session/update', {
        sessionUpdate: 'user_message_chunk',
        content: [{ type: 'text', text: 'x' }],
        _meta: { hideFromScrollback: true },
      }),
    )
    expect(hidden).toEqual([])
  })

  it('tool_call / plan / usage_update → 事件', () => {
    const tool = envelopeToEvents(env('session/update', { sessionUpdate: 'tool_call', id: 'tc1' }))
    expect(tool[0]).toMatchObject({ type: 'tool_call' })

    const plan = envelopeToEvents(env('session/update', { sessionUpdate: 'plan', entries: [1, 2] }))
    expect(plan[0]).toMatchObject({ type: 'plan', entries: [1, 2] })

    const usage = envelopeToEvents(env('session/update', { sessionUpdate: 'usage_update', used: 100, size: 200, cost: 3 }))
    expect(usage[0]).toMatchObject({ type: 'usage', used: 100, size: 200, cost: 3 })
  })

  it('turn_completed → turn_completed 事件', () => {
    const evs = envelopeToEvents(env('session/update', { sessionUpdate: 'turn_completed' }))
    expect(evs[0]).toMatchObject({ type: 'turn_completed' })
  })

  it('未知 sessionUpdate → session_notification；_x.ai/session/update 直通', () => {
    const evs = envelopeToEvents(env('session/update', { sessionUpdate: 'mystery_event', a: 1 }))
    expect(evs[0]).toMatchObject({ type: 'session_notification' })

    const xai = envelopeToEvents(env('_x.ai/session/update', { sessionUpdate: 'whatever' }))
    expect(xai[0]).toMatchObject({ type: 'session_notification', method: '_x.ai/session/update' })
  })

  it('task_backgrounded / task_completed → task_lifecycle', () => {
    const bg = envelopeToEvents(
      env('session/update', { sessionUpdate: 'task_backgrounded', task_id: 't1', command: 'npm run dev' }),
    )
    expect(bg[0]).toMatchObject({ type: 'task_lifecycle', kind: 'started', taskId: 't1', command: 'npm run dev' })

    const done = envelopeToEvents(
      env('session/update', {
        sessionUpdate: 'task_completed',
        task_snapshot: { task_id: 't1', description: 'dev server', exit_code: 0 },
      }),
    )
    expect(done[0]).toMatchObject({ type: 'task_lifecycle', kind: 'completed', taskId: 't1' })
  })
})

describe('envelopeToEvents：信封顶层 msgSeq 线程进派生事件', () => {
  it('带 msgSeq 的信封：所有派生事件携带同一 msgSeq', () => {
    const env = {
      msgSeq: 7,
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: [
            { type: 'text', text: 'hi ' },
            { type: 'image', data: 'abc', mimeType: 'image/png' },
          ],
        },
      },
    }
    const evs = envelopeToEvents(env)
    expect(evs[0]).toMatchObject({ type: 'chunk', text: 'hi ', msgSeq: 7 })
    expect(evs[1]).toMatchObject({ type: 'image', msgSeq: 7 })
  })

  it('无 msgSeq（旧 host / 回退透传）→ 事件不带该字段', () => {
    const evs = envelopeToEvents(
      env('session/update', { sessionUpdate: 'agent_message_chunk', content: 'x' }),
    )
    expect(evs).toHaveLength(1)
    expect('msgSeq' in evs[0]!).toBe(false)
  })

  it('envelopeMsgSeq / envelopeEventId / eventEventId', () => {
    expect(envelopeMsgSeq({ msgSeq: 3 })).toBe(3)
    expect(envelopeMsgSeq({})).toBeUndefined()
    expect(envelopeMsgSeq({ msgSeq: 'x' })).toBeUndefined()
    expect(envelopeEventId({ params: { _meta: { eventId: 's1-5' } } })).toBe('s1-5')
    expect(envelopeEventId({ params: {} })).toBeUndefined()
    // live：顶层优先，嵌套 params._meta / update._meta 兜底。
    expect(eventEventId({ eventId: 's1-5' })).toBe('s1-5')
    expect(eventEventId({ params: { _meta: { eventId: 's1-6' } } })).toBe('s1-6')
    expect(eventEventId({ update: { _meta: { eventId: 's1-7' } } })).toBe('s1-7')
    expect(eventEventId({})).toBeUndefined()
  })
})

describe('envelopeToEvent / replayEventKeys / replayEnvelopeKeys', () => {
  it('envelopeToEvent 取首个事件', () => {
    expect(envelopeToEvent({ method: 'x' })).toBeNull()
    const ev = envelopeToEvent(
      env('session/update', { sessionUpdate: 'plan', entries: [1] }),
    )
    expect(ev?.type).toBe('plan')
  })

  it('replayEventKeys：chunk 带 agentTimestampMs；user 走 classify', () => {
    const chunk: AcpEvent = { type: 'chunk', text: 'hi', agentTimestampMs: 9 }
    // 实现按 key 排序稳定序列化
    expect(replayEventKeys(chunk)).toEqual([`chunk:${JSON.stringify({ agentTimestampMs: 9, text: 'hi' })}`])

    const userEv: AcpEvent = { type: 'user_message', text: 'q', isCron: true }
    expect(replayEventKeys(userEv)).toEqual([`user:${JSON.stringify({ isCron: true, text: 'q' })}`])

    const toolEv: AcpEvent = { type: 'tool_call', toolCall: { id: 'x' } as never }
    expect(replayEventKeys(toolEv)[0]).toContain('tool_call:')
  })

  it('replayEnvelopeKeys：session_notification → update keys', () => {
    const keys = replayEnvelopeKeys(
      env('session/update', { sessionUpdate: 'agent_message_chunk', content: 'a' }),
    )
    expect(keys).toHaveLength(1)
    expect(keys[0]).toContain('chunk:')
  })
})