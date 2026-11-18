import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../api/types'
import { projectDisplayRows, scanGroups } from './verbGroup'
import {
  newlyExpandedEntryIds,
  visibleEntryIds,
  type GroupEnterSnapshot,
} from './groupEnter'

function tool(
  id: string,
  over: Partial<Extract<ScrollEntry, { kind: 'tool' }>> = {},
): ScrollEntry {
  return {
    id,
    kind: 'tool',
    title: 'Read a.py',
    kindName: 'read',
    status: 'completed',
    expanded: false,
    ...over,
  } as ScrollEntry
}

const EMPTY = new Set<string>()

function frame(entries: ScrollEntry[], expanded: ReadonlySet<string>) {
  const spans = scanGroups(entries, expanded)
  const rows = projectDisplayRows(entries, spans)
  return { spans, rows }
}

function snapshot(
  entries: ScrollEntry[],
  expanded: ReadonlySet<string>,
): GroupEnterSnapshot {
  const { rows } = frame(entries, expanded)
  return { expanded, visible: visibleEntryIds(rows) }
}

describe('newlyExpandedEntryIds', () => {
  it('展开分组：只返回这一帧新露出的成员，按 entries 顺序', () => {
    const entries = [tool('t1'), tool('t2'), tool('t3')]
    const prev = snapshot(entries, EMPTY)
    const next = frame(entries, new Set(['t1']))

    expect(
      newlyExpandedEntryIds(
        entries,
        next.spans,
        prev,
        new Set(['t1']),
        visibleEntryIds(next.rows),
      ),
    ).toEqual(['t1', 't2', 't3'])
  })

  it('收起分组不产生入场行（退出动画另走退出快照）', () => {
    const entries = [tool('t1'), tool('t2')]
    const prev = snapshot(entries, new Set(['t1']))
    const next = frame(entries, EMPTY)
    expect(
      newlyExpandedEntryIds(entries, next.spans, prev, EMPTY, visibleEntryIds(next.rows)),
    ).toEqual([])
  })

  it('收起态本来就可见的展开成员不重播淡入', () => {
    const entries = [
      tool('t1'),
      tool('t2', { displayMode: 'expanded', expanded: true }),
      tool('t3'),
    ]
    const prev = snapshot(entries, EMPTY)
    expect(prev.visible.has('t2')).toBe(true)

    const next = frame(entries, new Set(['t1']))
    expect(
      newlyExpandedEntryIds(
        entries,
        next.spans,
        prev,
        new Set(['t1']),
        visibleEntryIds(next.rows),
      ),
    ).toEqual(['t1', 't3'])
  })

  it('首帧（没有上一帧快照）不播', () => {
    const entries = [tool('t1'), tool('t2')]
    const next = frame(entries, new Set(['t1']))
    expect(
      newlyExpandedEntryIds(
        entries,
        next.spans,
        null,
        new Set(['t1']),
        visibleEntryIds(next.rows),
      ),
    ).toEqual([])
  })

  it('展开集换引用但没新增锚点：不播', () => {
    const entries = [tool('t1'), tool('t2')]
    const expanded = new Set(['t1'])
    const prev = snapshot(entries, expanded)
    const next = frame(entries, expanded)
    expect(
      newlyExpandedEntryIds(
        entries,
        next.spans,
        prev,
        new Set(['t1']),
        visibleEntryIds(next.rows),
      ),
    ).toEqual([])
  })
})
