import { describe, expect, it, vi } from 'vitest'
import type { ChatState, SetState } from './types'
import { applySessionLastTurnSummary, applySessionTitle, preserveLiveSessionSummary } from './sessionIdentity'

function makeStore(initial: Partial<ChatState> = {}) {
  let state = {
    sessionId: 'cur',
    sessionTitle: undefined,
    sessions: [
      { sessionId: 'cur', title: '当前会话' },
      { sessionId: 'other', title: '别的会话' },
    ],
    ...initial,
  } as unknown as ChatState
  const set = vi.fn(
    (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    },
  )
  return { set: set as unknown as SetState, get: () => state, state: () => state }
}

describe('applySessionTitle', () => {
  it('无 sessionId：只改当前视图的 sessionTitle', () => {
    const { set, get, state } = makeStore()
    applySessionTitle(set, get, ' 新标题 ')
    expect(state().sessionTitle).toBe('新标题')
    expect(state().sessions.map((s) => s.title)).toEqual(['当前会话', '别的会话'])
  })

  it('sessionId 是当前会话：sessionTitle 与该行 title 一起更新', () => {
    const { set, get, state } = makeStore()
    applySessionTitle(set, get, '改名了', { sessionId: 'cur' })
    expect(state().sessionTitle).toBe('改名了')
    expect(state().sessions[0].title).toBe('改名了')
    expect(state().sessions[1].title).toBe('别的会话')
  })

  it('sessionId 是别的会话：只改那一行，不碰当前标题与其它行', () => {
    const { set, get, state } = makeStore({ sessionTitle: '当前标题' })
    applySessionTitle(set, get, '那边的标题', { sessionId: 'other' })
    expect(state().sessionTitle).toBe('当前标题')
    expect(state().sessions[1].title).toBe('那边的标题')
    expect(state().sessions[0].title).toBe('当前会话')
  })

  it('手动改名（isManual）不改写任何标题', () => {
    const { set, get, state } = makeStore({ sessionTitle: '当前标题' })
    applySessionTitle(set, get, '另一端的手动改名', { isManual: true, sessionId: 'cur' })
    applySessionTitle(set, get, '另一端的手动改名', { isManual: true, sessionId: 'other' })
    expect(set).not.toHaveBeenCalled()
    expect(state().sessionTitle).toBe('当前标题')
    expect(state().sessions.map((s) => s.title)).toEqual(['当前会话', '别的会话'])
  })

  it('空标题 / 纯空白不写', () => {
    const { set, get } = makeStore()
    applySessionTitle(set, get, '   ', { sessionId: 'other' })
    applySessionTitle(set, get, undefined, { sessionId: 'other' })
    expect(set).not.toHaveBeenCalled()
  })

  it('名册里没有该会话：跳过行写入，也不凭空插入', () => {
    const { set, get, state } = makeStore({ sessionTitle: undefined })
    applySessionTitle(set, get, '幽灵会话', { sessionId: 'ghost' })
    expect(set).not.toHaveBeenCalled()
    expect(state().sessions).toHaveLength(2)
    expect(state().sessionTitle).toBeUndefined()
  })

  it('同名标题不重复写', () => {
    const { set, get } = makeStore({ sessionId: 'other', sessionTitle: '别的会话' })
    applySessionTitle(set, get, '别的会话', { sessionId: 'other' })
    expect(set).not.toHaveBeenCalled()
  })
})

describe('applySessionLastTurnSummary', () => {
  it('写对应会话行的 lastTurnSummary（trim），不动标题', () => {
    const { set, get, state } = makeStore()
    applySessionLastTurnSummary(set, get, ' 修好了登录页 ', 'other')
    expect(state().sessions[1].lastTurnSummary).toBe('修好了登录页')
    expect(state().sessions[1].title).toBe('别的会话')
    expect(state().sessions[0].lastTurnSummary).toBeUndefined()
  })

  it('缺 sessionId：写给当前会话的行', () => {
    const { set, get, state } = makeStore()
    applySessionLastTurnSummary(set, get, '刚跑完这一轮')
    expect(state().sessions[0].lastTurnSummary).toBe('刚跑完这一轮')
  })

  it('空白摘要按缺失处理，不覆盖上一轮', () => {
    const { set, get, state } = makeStore({
      sessions: [
        { sessionId: 'cur', lastTurnSummary: '上一轮摘要' },
        { sessionId: 'other' },
      ],
    })
    applySessionLastTurnSummary(set, get, '   ', 'cur')
    expect(set).not.toHaveBeenCalled()
    expect(state().sessions[0].lastTurnSummary).toBe('上一轮摘要')
  })

  it('会话不在名册 / 没有当前会话：不写', () => {
    const { set, get } = makeStore({ sessionId: undefined })
    applySessionLastTurnSummary(set, get, '给幽灵的摘要', 'ghost')
    applySessionLastTurnSummary(set, get, '没有当前会话')
    expect(set).not.toHaveBeenCalled()
  })

  it('同值摘要不重复写', () => {
    const { set, get } = makeStore({
      sessions: [
        { sessionId: 'cur', lastTurnSummary: '同一轮摘要' },
        { sessionId: 'other' },
      ],
    })
    applySessionLastTurnSummary(set, get, '同一轮摘要', 'cur')
    expect(set).not.toHaveBeenCalled()
  })
})

/**
 * `/api/sessions` 全量刷新不带 lastTurnSummary：合并时只保住 live 摘要，
 * 其余字段与行的增删都以新快照为准。
 */
describe('preserveLiveSessionSummary', () => {
  it('新行缺摘要时保留上一份同会话行的 live 摘要', () => {
    const prev = [{ sessionId: 'a', lastTurnSummary: '上一轮修好了登录页' }]
    const next = [{ sessionId: 'a', title: '新标题' }]
    const out = preserveLiveSessionSummary(prev, next)
    expect(out).toEqual([{ sessionId: 'a', title: '新标题', lastTurnSummary: '上一轮修好了登录页' }])
    // 输入不被就地改写。
    expect(next[0]).toEqual({ sessionId: 'a', title: '新标题' })
  })

  it('新行有自己的摘要时以新值为准，不被旧值盖回去', () => {
    const prev = [{ sessionId: 'a', lastTurnSummary: '旧摘要' }]
    const next = [{ sessionId: 'a', lastTurnSummary: '新摘要' }]
    expect(preserveLiveSessionSummary(prev, next)).toEqual([
      { sessionId: 'a', lastTurnSummary: '新摘要' },
    ])
  })

  it('空白的新摘要按缺失处理，仍保留旧值（trim 后写入）', () => {
    const prev = [{ sessionId: 'a', lastTurnSummary: ' 旧摘要 ' }]
    const next = [{ sessionId: 'a', lastTurnSummary: '   ' }]
    expect(preserveLiveSessionSummary(prev, next)[0].lastTurnSummary).toBe('旧摘要')
  })

  it('新出现的会话没有旧摘要可继承', () => {
    const prev = [{ sessionId: 'a', lastTurnSummary: '旧摘要' }]
    const next = [{ sessionId: 'a' }, { sessionId: 'fresh' }]
    const out = preserveLiveSessionSummary(prev, next)
    expect(out.map((s) => s.sessionId)).toEqual(['a', 'fresh'])
    expect(out[1].lastTurnSummary).toBeUndefined()
  })

  it('已删除的会话不复活（新快照里没有的 id 不参与合并）', () => {
    const prev = [
      { sessionId: 'a', lastTurnSummary: '旧摘要' },
      { sessionId: 'gone', lastTurnSummary: '不该复活' },
    ]
    const next = [{ sessionId: 'a' }]
    const out = preserveLiveSessionSummary(prev, next)
    expect(out.map((s) => s.sessionId)).toEqual(['a'])
    expect(out[0].lastTurnSummary).toBe('旧摘要')
  })

  it('其余字段以新快照为准（旧 title/status 不回流）', () => {
    const prev = [
      {
        sessionId: 'a',
        title: '旧标题',
        status: { state: 'active' as const, busy: true },
        lastTurnSummary: '旧摘要',
      },
    ]
    const next = [{ sessionId: 'a', title: '新标题', status: { state: 'idle' as const, busy: false } }]
    const out = preserveLiveSessionSummary(prev, next)[0]
    expect(out.title).toBe('新标题')
    expect(out.status).toEqual({ state: 'idle', busy: false })
    expect(out.lastTurnSummary).toBe('旧摘要')
  })

  it('无需补摘要时返回原数组引用（不制造多余的状态更新）', () => {
    const next = [{ sessionId: 'a' }, { sessionId: 'b', lastTurnSummary: '新摘要' }]
    expect(preserveLiveSessionSummary([{ sessionId: 'a' }], next)).toBe(next)
    expect(preserveLiveSessionSummary([], next)).toBe(next)
    expect(preserveLiveSessionSummary([{ sessionId: 'a', lastTurnSummary: '旧' }], [])).toEqual([])
  })
})
