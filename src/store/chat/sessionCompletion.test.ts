import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '../../api/types'
import { busySnapshot, completedSessionIds } from './sessionCompletion'

const row = (sessionId: string, busy?: boolean): SessionInfo => ({
  sessionId,
  ...(busy === undefined ? {} : { status: { state: busy ? 'active' : 'idle', busy } }),
})

describe('completedSessionIds', () => {
  it('busy true → false 记为完成', () => {
    const prev = [row('a', true), row('b')]
    const next = [row('a', false), row('b')]
    expect(completedSessionIds(prev, next)).toEqual(['a'])
  })

  it('busy true → true（仍在跑）不算完成', () => {
    expect(completedSessionIds([row('a', true)], [row('a', true)])).toEqual([])
  })

  it('idle → busy（刚开跑）不算完成', () => {
    expect(completedSessionIds([row('a', false)], [row('a', true)])).toEqual([])
  })

  it('从名册消失的会话不算完成', () => {
    expect(completedSessionIds([row('a', true)], [row('b', false)])).toEqual([])
  })

  it('新出现的会话不参与比较（没有前一份状态可对比）', () => {
    expect(completedSessionIds([row('a')], [row('a'), row('new', false)])).toEqual([])
  })

  it('首份名册（基线）不误报', () => {
    expect(completedSessionIds([], [row('a', false), row('b')])).toEqual([])
    expect(completedSessionIds([row('a', true)], [])).toEqual([])
  })

  it('只报真正完成的那一个：同时有仍在跑 / 消失 / 完成的会话', () => {
    const prev = [row('done', true), row('busy', true), row('gone', true), row('idle')]
    const next = [row('done', false), row('busy', true), row('idle'), row('fresh', false)]
    expect(completedSessionIds(prev, next)).toEqual(['done'])
  })

  it('下一份缺 status（host 省略空闲状态）按不忙处理', () => {
    expect(completedSessionIds([row('a', true)], [row('a')])).toEqual(['a'])
  })
})

describe('busySnapshot', () => {
  it('按 id 记录 busy，缺 status 视为不忙', () => {
    const snap = busySnapshot([row('a', true), row('b', false), row('c')])
    expect([...snap]).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
    ])
  })
})
