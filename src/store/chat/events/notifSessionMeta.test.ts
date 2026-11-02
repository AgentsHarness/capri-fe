import { describe, expect, it, vi } from 'vitest'
import type { ChatState, SetState } from '../types'
import type { WireEvent } from './wire'
import { applySessionInfoTitle, handleNotifSessionMeta } from './notifSessionMeta'

function makeStore(initial: Partial<ChatState> = {}) {
  let state = { entries: [], sessionId: 's1', ...initial } as unknown as ChatState
  const set = vi.fn(
    (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    },
  )
  return { set: set as unknown as SetState, get: () => state, state: () => state }
}

const generic = (tag: string, extra: Record<string, unknown> = {}, sid?: string) =>
  ({
    type: 'session_notification',
    ...(sid ? { sessionId: sid } : {}),
    params: { sessionUpdate: tag, ...extra },
  }) as unknown as WireEvent

const rows = () => [
  { sessionId: 's1', title: '本会话' },
  { sessionId: 'other', title: '别的会话' },
]

/**
 * 标题 / 副行摘要都写 `sessions` 里该会话自己的行（sidebar 的单一 live
 * 事实源）；别的会话生成时也要生效，不能只改当前视图的 sessionTitle。
 */
describe('handleNotifSessionMeta', () => {
  it('session_summary_generated（外来会话）写那一行标题，不碰当前标题', () => {
    const { set, get, state } = makeStore({ sessionTitle: '本会话', sessions: rows() })
    const fields = { session_summary: ' 别的会话的新标题 ' }
    expect(
      handleNotifSessionMeta(
        set,
        get,
        generic('session_summary_generated', fields, 'other'),
        'session_summary_generated',
        fields,
      ),
    ).toBe(true)
    expect(state().sessions[1].title).toBe('别的会话的新标题')
    expect(state().sessions[0].title).toBe('本会话')
    expect(state().sessionTitle).toBe('本会话')
  })

  it('session_summary_generated 写当前会话：行标题与 sessionTitle 同步', () => {
    const { set, get, state } = makeStore({ sessionTitle: '旧标题', sessions: rows() })
    const fields = { session_summary: '自动生成的新标题' }
    handleNotifSessionMeta(
      set,
      get,
      generic('session_summary_generated', fields, 's1'),
      'session_summary_generated',
      fields,
    )
    expect(state().sessions[0].title).toBe('自动生成的新标题')
    expect(state().sessionTitle).toBe('自动生成的新标题')
  })

  it('last_turn_summary 写对应行的副行摘要，不进滚动区', () => {
    const { set, get, state } = makeStore({ sessions: rows() })
    const fields = { summary: '修好了登录页', prompt_id: 'p1' }
    expect(
      handleNotifSessionMeta(
        set,
        get,
        generic('last_turn_summary', fields, 'other'),
        'last_turn_summary',
        fields,
      ),
    ).toBe(true)
    expect(state().sessions[1].lastTurnSummary).toBe('修好了登录页')
    expect(state().sessions[0].lastTurnSummary).toBeUndefined()
    expect(state().entries).toHaveLength(0)
  })

  it('last_turn_summary 兼容 last_turn_summary 字段名', () => {
    const { set, get, state } = makeStore({ sessions: rows() })
    const fields = { last_turn_summary: '旧字段名' }
    handleNotifSessionMeta(
      set,
      get,
      generic('last_turn_summary', fields, 'other'),
      'last_turn_summary',
      fields,
    )
    expect(state().sessions[1].lastTurnSummary).toBe('旧字段名')
  })

  it('空白摘要按缺失处理，不覆盖上一轮', () => {
    const { set, get, state } = makeStore({
      sessions: [
        { sessionId: 's1', lastTurnSummary: '上一轮' },
        { sessionId: 'other' },
      ],
    })
    const fields = { summary: '  ' }
    handleNotifSessionMeta(
      set,
      get,
      generic('last_turn_summary', fields, 's1'),
      'last_turn_summary',
      fields,
    )
    expect(state().sessions[0].lastTurnSummary).toBe('上一轮')
  })

  it('不带 sessionId 时写给当前会话的行', () => {
    const { set, get, state } = makeStore({ sessions: rows() })
    const fields = { summary: '当前会话这一轮' }
    handleNotifSessionMeta(
      set,
      get,
      generic('last_turn_summary', fields),
      'last_turn_summary',
      fields,
    )
    expect(state().sessions[0].lastTurnSummary).toBe('当前会话这一轮')
  })

  it('其它 tag 不认领（由后续 handler / 未消费告警决定）', () => {
    const { set, get } = makeStore()
    expect(handleNotifSessionMeta(set, get, generic('memory_files', {}, 's1'), 'memory_files', {})).toBe(
      false,
    )
  })
})

/**
 * typed `session_info`（session_info_update 的归一形态）同样只经由
 * sessionIdentity.applySessionTitle，手动改名事件不改写本端标题。
 */
describe('applySessionInfoTitle', () => {
  it('外来会话写那一行标题，不碰当前标题', () => {
    const { set, get, state } = makeStore({ sessionTitle: '本会话', sessions: rows() })
    applySessionInfoTitle(set, get, { sessionId: 'other', title: '那边的新标题' })
    expect(state().sessions[1].title).toBe('那边的新标题')
    expect(state().sessions[0].title).toBe('本会话')
    expect(state().sessionTitle).toBe('本会话')
  })

  it('当前会话同步 sessionTitle', () => {
    const { set, get, state } = makeStore({ sessionTitle: '旧标题', sessions: rows() })
    applySessionInfoTitle(set, get, { sessionId: 's1', title: '新标题' })
    expect(state().sessions[0].title).toBe('新标题')
    expect(state().sessionTitle).toBe('新标题')
  })

  it('titleIsManual → 不改写本端标题', () => {
    const { set, get, state } = makeStore({ sessionTitle: '本会话', sessions: rows() })
    applySessionInfoTitle(set, get, {
      sessionId: 's1',
      title: '另一端的手动改名',
      titleIsManual: true,
    })
    expect(state().sessionTitle).toBe('本会话')
    expect(state().sessions[0].title).toBe('本会话')
  })
})
