import { describe, expect, it, vi } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import {
  adoptLiveTurnStart,
  busyPlausibleForView,
  cancellationContextText,
  eventPromptId,
  isTurnEndLine,
  liveTurnStartMs,
  promptIdMismatch,
  selectableRowIds,
  tailHasCancellationDetail,
  turnEndMarkerText,
  turnIsLive,
  turnMarker,
  wireElapsedMs,
} from './turnStatus'

function tool(id: string, over: Partial<Extract<ScrollEntry, { kind: 'tool' }>> = {}): ScrollEntry {
  return { id, kind: 'tool', title: 't', verb: 'v', status: 'completed', ...over }
}

describe('selectableRowIds', () => {
  it('包含折叠组成员头 + 可见条目', () => {
    const entries = [tool('r1', { kindName: 'read' }), tool('r2', { kindName: 'read' }), tool('ex1', { kindName: 'execute' })]
    const ids = selectableRowIds(entries, new Set())
    expect(ids).toContain('gh_r1')
    expect(ids).toContain('ex1')
  })
})

describe('turnIsLive', () => {
  it('turnStartedAt / conn busy / openThoughtId 任一即 live', () => {
    expect(turnIsLive({ turnStartedAt: 1 } as never)).toBe(true)
    expect(turnIsLive({ conn: 'busy' } as never)).toBe(true)
    expect(turnIsLive({ openThoughtId: 'x' } as never)).toBe(true)
    expect(turnIsLive({} as never)).toBe(false)
  })
})

describe('busyPlausibleForView', () => {
  it('本地 turn / 挂起乐观行 / roster 佐证', () => {
    expect(busyPlausibleForView({ turnStartedAt: 1 } as never)).toBe(true)
    expect(busyPlausibleForView({ pendingOptimisticUserId: 'u' } as never)).toBe(true)
    expect(
      busyPlausibleForView({
        sessionId: 's1',
        sessions: [{ sessionId: 's1', status: { busy: true } }],
      } as never),
    ).toBe(true)
    expect(
      busyPlausibleForView({ sessionId: 's1', sessions: [{ sessionId: 's1', status: {} }] } as never),
    ).toBe(false)
  })
})

describe('liveTurnStartMs / adoptLiveTurnStart', () => {
  it('顶层 / meta / fullUpdate._meta / update._meta 提取；字符串解析', () => {
    expect(liveTurnStartMs({ type: 'chunk', text: 'x', turnStartMs: 1000 })).toBe(1000)
    expect(liveTurnStartMs({ type: 'chunk', text: 'x', meta: { turnStartMs: 2000 } } as never)).toBe(2000)
    expect(liveTurnStartMs({ type: 'chunk', text: 'x', fullUpdate: { _meta: { turn_start_ms: '2024-01-01T00:00:00Z' } } } as never)).toBe(Date.parse('2024-01-01T00:00:00Z'))
    expect(liveTurnStartMs({ type: 'chunk', text: 'x', update: { _meta: { turnStartMs: 3000 } } } as never)).toBe(3000)
    expect(liveTurnStartMs({ type: 'chunk', text: 'x' })).toBeUndefined()
  })

  it('adoptLiveTurnStart 仅在回合已锚定时修正', () => {
    const set = vi.fn()
    const get = vi.fn(() => ({ turnStartedAt: 100 }))
    adoptLiveTurnStart(set as never, get as never, { type: 'chunk', text: 'x', turnStartMs: 5000 } as never)
    expect(set).toHaveBeenCalledWith({ turnStartedAt: 5000 })

    set.mockClear()
    get.mockReturnValue({ turnStartedAt: null as never })
    adoptLiveTurnStart(set as never, get as never, { type: 'chunk', text: 'x', turnStartMs: 5000 } as never)
    expect(set).not.toHaveBeenCalled()
  })
})

describe('eventPromptId / promptIdMismatch', () => {
  it('顶层 / _meta / meta 提取', () => {
    expect(eventPromptId({ promptId: 'p1' })).toBe('p1')
    expect(eventPromptId({ prompt_id: 'p2' })).toBe('p2')
    expect(eventPromptId({ _meta: { promptId: 'p3' } })).toBe('p3')
    expect(eventPromptId({ meta: { prompt_id: 'p4' } })).toBe('p4')
    expect(eventPromptId({})).toBeUndefined()
  })

  it('pid 不匹配 → true；任一缺失 → false', () => {
    expect(promptIdMismatch({ promptId: 'a' }, 'b')).toBe(true)
    expect(promptIdMismatch({ promptId: 'a' }, 'a')).toBe(false)
    expect(promptIdMismatch({}, 'a')).toBe(false)
    expect(promptIdMismatch({ promptId: 'a' }, undefined)).toBe(false)
  })
})

describe('wireElapsedMs', () => {
  it('update.elapsed_ms 提取（camelCase 兜底）', () => {
    expect(wireElapsedMs({ elapsed_ms: 4321 })).toBe(4321)
    expect(wireElapsedMs({ elapsedMs: 4321 })).toBe(4321)
    expect(wireElapsedMs({ elapsed_ms: 0 })).toBe(0)
    expect(wireElapsedMs({ elapsed_ms: -1 })).toBeUndefined()
    expect(wireElapsedMs({ elapsed_ms: 'x' })).toBeUndefined()
    expect(wireElapsedMs({})).toBeUndefined()
    expect(wireElapsedMs(null)).toBeUndefined()
    expect(wireElapsedMs(undefined)).toBeUndefined()
  })
})

describe('cancellationContextText', () => {
  it('hook + tool + reason 全量', () => {
    expect(
      cancellationContextText({
        cancellationContext: {
          tool_name: 'Bash',
          hook_name: 'pre_tool_use',
          reason: 'dangerous command',
          trigger: 'hook',
        },
      }),
    ).toBe('Cancelled by hook "pre_tool_use" while running "Bash": dangerous command')
  })

  it('_meta / meta 载体；camelCase 字段兜底', () => {
    expect(
      cancellationContextText({ _meta: { cancellationContext: { toolName: 'Edit', reason: 'no' } } }),
    ).toBe('Cancelled while running "Edit": no')
    expect(
      cancellationContextText({ meta: { cancellation_context: { hookName: 'stop', reason: 'blocked' } } }),
    ).toBe('Cancelled by hook "stop": blocked')
  })

  it('仅 trigger / 无 reason', () => {
    expect(cancellationContextText({ cancellationContext: { trigger: 'user' } })).toBe(
      'Cancelled by trigger "user"',
    )
    expect(cancellationContextText({ cancellationContext: {} })).toBeUndefined()
  })

  it('无该键 → undefined（旧 agent / 用户取消）', () => {
    expect(cancellationContextText({})).toBeUndefined()
    expect(cancellationContextText(undefined)).toBeUndefined()
    expect(
      cancellationContextText({ cancellationContext: 'garbage' }),
    ).toBeUndefined()
  })
})

describe('tailHasCancellationDetail', () => {
  const detail = 'Cancelled by hook "pre_tool_use": no'
  const marker: ScrollEntry = { id: 'm', kind: 'session_event', text: 'Turn cancelled.' }
  const detailRow: ScrollEntry = { id: 'd', kind: 'session_event', text: detail }

  it('尾部已有同文本详情行 → true（prompt_complete / turn_completed 双 rail 去重）', () => {
    expect(tailHasCancellationDetail([marker, detailRow], detail)).toBe(true)
    expect(tailHasCancellationDetail([detailRow], detail)).toBe(true)
  })

  it('只有收口标记 → false（详情尚未渲染）', () => {
    expect(tailHasCancellationDetail([marker], detail)).toBe(false)
  })

  it('详情行之后有内容条目 → false（属于别的回合）', () => {
    expect(
      tailHasCancellationDetail([detailRow, { id: 'u', kind: 'user', text: 'next' } as ScrollEntry], detail),
    ).toBe(false)
  })

  it('越过 status/error 行；非收口 session_event 止步', () => {
    expect(
      tailHasCancellationDetail([detailRow, { id: 's', kind: 'status', text: 'x' } as ScrollEntry], detail),
    ).toBe(true)
    expect(
      tailHasCancellationDetail([{ id: 'o', kind: 'session_event', text: '其他事件' } as ScrollEntry], detail),
    ).toBe(false)
    expect(tailHasCancellationDetail([], detail)).toBe(false)
  })
})

describe('turnMarker / turnEndMarkerText / isTurnEndLine', () => {
  it('turnMarker：无时长 → Turn completed.', () => {
    expect(turnMarker(undefined)).toMatchObject({ kind: 'session_event', text: 'Turn completed.' })
    expect(turnMarker(5000)).toMatchObject({ text: 'Worked for 5.0s' })
  })

  it('error/rate_limit → 失败+warning；cancelled → 取消', () => {
    expect(turnEndMarkerText('error', 'boom', undefined)).toEqual({ text: 'Turn failed: boom', warning: true })
    expect(turnEndMarkerText('error', undefined, 1000)).toEqual({ text: 'Turn failed in 1.0s: unknown error', warning: true })
    expect(turnEndMarkerText('rate_limit', undefined, undefined)).toEqual({ text: 'Turn failed: rate limited', warning: true })
    expect(turnEndMarkerText('cancelled', undefined, 2000)).toEqual({ text: 'Turn cancelled by user in 2.0s.' })
    expect(turnEndMarkerText('cancelled', undefined, undefined)).toEqual({ text: 'Turn cancelled.' })
    expect(turnEndMarkerText('completed', undefined, 9000)).toEqual({ text: 'Worked for 9.0s' })
    expect(turnEndMarkerText(undefined, undefined, undefined)).toEqual({ text: 'Turn completed.' })
  })

  it('isTurnEndLine 识别各类收口行', () => {
    expect(isTurnEndLine({ id: 'e', kind: 'session_event', text: 'Turn completed.' })).toBe(true)
    expect(isTurnEndLine({ id: 'e', kind: 'session_event', text: 'Turn cancelled by user in 2.0s.' })).toBe(true)
    expect(isTurnEndLine({ id: 'e', kind: 'session_event', text: 'Turn failed: boom' })).toBe(true)
    expect(isTurnEndLine({ id: 'e', kind: 'session_event', text: 'Worked for 5.0s' })).toBe(true)
    expect(isTurnEndLine({ id: 'e', kind: 'session_event', text: '2 commands still running' })).toBe(true)
    expect(isTurnEndLine({ id: 'e', kind: 'session_event', text: 'recap' })).toBe(false)
    expect(isTurnEndLine({ id: 'e', kind: 'user', text: 'Turn completed.' })).toBe(false)
  })
})