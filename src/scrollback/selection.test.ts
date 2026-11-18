import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../api/types'
import { projectDisplayRows, scanGroups } from './verbGroup'
import { resolveSelectionId } from './selection'

function tool(id: string): ScrollEntry {
  return {
    id,
    kind: 'tool',
    title: id,
    kindName: 'read',
    status: 'completed',
    expanded: false,
  } as ScrollEntry
}

const user = (id: string): ScrollEntry =>
  ({ id, kind: 'user', text: 'go' }) as ScrollEntry

function view(entries: ScrollEntry[]) {
  const spans = scanGroups(entries, new Set())
  const rows = projectDisplayRows(entries, spans)
  return { spans, rows }
}

describe('resolveSelectionId', () => {
  it('可见的选中项原样保留', () => {
    const entries = [tool('t1')]
    const { spans, rows } = view(entries)
    expect(resolveSelectionId(entries, rows, spans, 't1')).toBe('t1')
  })

  it('成员被折叠组收走 → 落到组头', () => {
    const entries = [tool('t1'), tool('t2')]
    const { spans, rows } = view(entries)
    expect(resolveSelectionId(entries, rows, spans, 't2')).toBe('gh_t1')
  })

  it('组头消失 → 落到最近的前一条可见行', () => {
    const entries = [user('u1'), tool('t1'), tool('t2')]
    const { spans, rows } = view(entries)
    expect(rows).toHaveLength(2)
    // 模拟组解散后组头不再存在：选中 gh_t1 时退回它前面的 u1。
    expect(resolveSelectionId(entries, [rows[0]], spans, 'gh_t1')).toBe('u1')
  })

  it('条目已删除且没有可见行 → null', () => {
    const entries = [tool('t1')]
    expect(resolveSelectionId(entries, [], [], 'gone')).toBeNull()
    expect(resolveSelectionId(entries, [], [], null)).toBeNull()
  })
})
