import { describe, expect, it, vi } from 'vitest'
import type { ChatState, SetState } from './types'
import type { SessionInfo } from '../../api/types'
import { applyRosterPatch, parseRosterPatch } from './rosterPatch'

function stateWith(sessions: SessionInfo[]): ChatState {
  return { sessions } as unknown as ChatState
}

function bind(state: ChatState): SetState {
  return (partial) => {
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  }
}

const live = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 's1',
  cwd: '/w',
  title: 'older title',
  status: { state: 'active', busy: true, awaitingInput: false, lastActiveAt: 10 },
  hasTasks: true,
  bgCount: 3,
  bgRunning: 2,
  ...over,
})

describe('parseRosterPatch', () => {
  it('空 params / 非数组 → null（调用方必须整表重拉）', () => {
    expect(parseRosterPatch(undefined)).toBeNull()
    expect(parseRosterPatch({})).toBeNull()
    expect(parseRosterPatch({ upserted: 'x' })).toBeNull()
  })

  it('接受 camelCase 与 snake_case 的 sessionId，跳过无 id 的行', () => {
    const p = parseRosterPatch({
      upserted: [{ sessionId: 'a' }, { session_id: 'b' }, { title: 'no id' }],
      removed: ['c', { sessionId: 'd' }],
    })
    expect(p?.upserted.map((r) => r.sessionId)).toEqual(['a', 'b'])
    expect(p?.removed).toEqual(['c', 'd'])
  })
})

describe('applyRosterPatch', () => {
  it('只改行里出现的字段：census 三兄弟缺失时保留旧值', () => {
    const state = stateWith([live()])
    const set = bind(state)
    const { changed } = applyRosterPatch(set, () => state, {
      upserted: [
        {
          sessionId: 's1',
          status: { state: 'idle', busy: false, awaitingInput: false },
        } as SessionInfo,
      ],
      removed: [],
    })
    expect(changed).toBe(true)
    const row = state.sessions[0]
    expect(row.status?.busy).toBe(false)
    // 行里没有这些字段——不能因为缺失就把徽章清零
    expect(row.hasTasks).toBe(true)
    expect(row.bgCount).toBe(3)
    expect(row.bgRunning).toBe(2)
    expect(row.title).toBe('older title')
  })

  it('名册里没有的会话不凭空插入，并回报 unknown 让调用方整表拉', () => {
    const state = stateWith([live()])
    const set = bind(state)
    const { changed, unknown } = applyRosterPatch(set, () => state, {
      upserted: [{ sessionId: 'new-one', cwd: '/other' } as SessionInfo],
      removed: [],
    })
    expect(changed).toBe(false)
    expect(unknown).toBe(1)
    expect(state.sessions.map((s) => s.sessionId)).toEqual(['s1'])
  })

  it('removed 里的会话从名册剔除', () => {
    const state = stateWith([live(), live({ sessionId: 's2' })])
    const set = bind(state)
    const { changed } = applyRosterPatch(set, () => state, { upserted: [], removed: ['s2'] })
    expect(changed).toBe(true)
    expect(state.sessions.map((s) => s.sessionId)).toEqual(['s1'])
  })

  it('行内容没变时不写 store（避免无意义的 re-render）', () => {
    const state = stateWith([live()])
    const set = vi.fn(bind(state))
    const { changed } = applyRosterPatch(set, () => state, {
      upserted: [live()],
      removed: [],
    })
    expect(changed).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })

  it('补丁携带旧白名单之外的字段时也算变化并写回', () => {
    const state = stateWith([live()])
    const set = vi.fn(bind(state))
    const { changed } = applyRosterPatch(set, () => state, {
      upserted: [{ sessionId: 's1', meta: { model: 'grok-5' } } as SessionInfo],
      removed: [],
    })
    expect(changed).toBe(true)
    expect(set).toHaveBeenCalledTimes(1)
    expect(state.sessions[0].meta).toEqual({ model: 'grok-5' })
    // 未携带的字段仍然保留。
    expect(state.sessions[0].title).toBe('older title')
    expect(state.sessions[0].bgRunning).toBe(2)
  })
})
