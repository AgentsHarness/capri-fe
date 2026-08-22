import { describe, expect, it, vi } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import {
  adoptLiveTurnStart,
  busyPlausibleForView,
  eventPromptId,
  isTurnEndLine,
  liveTurnStartMs,
  promptIdMismatch,
  selectableRowIds,
  turnEndMarkerText,
  turnIsLive,
  turnMarker,
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