import { describe, expect, it } from 'vitest'
import { byAnchoredDesc, findGroupEl } from './sessionList'

describe('byAnchoredDesc', () => {
  it('已锚定的会话按锚降序，锚优先于 updatedAt', () => {
    const cmp = byAnchoredDesc({
      old: 1,
      fresh: 2,
    })
    const rows = [
      { sessionId: 'old', updatedAt: new Date().toISOString() },
      { sessionId: 'fresh', updatedAt: '2000-01-01T00:00:00Z' },
    ]
    expect([...rows].sort(cmp).map((r) => r.sessionId)).toEqual(['fresh', 'old'])
  })

  it('无锚时退回活动时间；同分按 sessionId 升序', () => {
    const now = new Date().toISOString()
    const cmp = byAnchoredDesc({})
    const rows = [
      { sessionId: 'b', updatedAt: now },
      { sessionId: 'a', updatedAt: now },
      { sessionId: 'c', updatedAt: '2000-01-01T00:00:00Z' },
    ]
    expect([...rows].sort(cmp).map((r) => r.sessionId)).toEqual(['a', 'b', 'c'])
  })
})

describe('findGroupEl', () => {
  it('按 data-gkey 精确查找，缺失或空根返回 null', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div data-gkey="a"></div><div data-gkey="b"></div>'
    expect(findGroupEl(root, 'b')?.getAttribute('data-gkey')).toBe('b')
    expect(findGroupEl(root, 'c')).toBeNull()
    expect(findGroupEl(null, 'a')).toBeNull()
  })
})
