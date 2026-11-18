import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../api/types'
import {
  absorbPlacements,
  buildAbsorbSnapshot,
} from './absorbEntries'
import { projectDisplayRows, scanGroups } from './verbGroup'

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

function runningTool(id: string): ScrollEntry {
  return tool(id, { status: 'in_progress', verb: 'Running' })
}

function thought(
  id: string,
  streaming: boolean,
  mode: 'collapsed' | 'expanded' = streaming ? 'expanded' : 'collapsed',
  over: Partial<Extract<ScrollEntry, { kind: 'thought' }>> = {},
): ScrollEntry {
  return {
    id,
    kind: 'thought',
    text: 'hmm',
    displayMode: mode,
    streaming,
    ...over,
  } as ScrollEntry
}

const user = (id: string): ScrollEntry =>
  ({ id, kind: 'user', text: 'go' }) as ScrollEntry

const EMPTY = new Set<string>()

/** 用生产同一条分组管线算出 rows/spans + 快照。 */
function view(entries: ScrollEntry[], expanded = EMPTY, epoch = 'e1') {
  const spans = scanGroups(entries, expanded)
  const rows = projectDisplayRows(entries, spans)
  return {
    spans,
    rows,
    snapshot: buildAbsorbSnapshot(entries, rows, epoch),
  }
}

const rowIds = (rows: ReturnType<typeof view>['rows']) =>
  rows.map((r) => (r.type === 'entry' ? r.entry.id : r.id))

describe('absorbPlacements — 思考', () => {
  it('流式思考收口进已有分组：落在聚合头之后，向上收', () => {
    const prev = view([tool('t1'), tool('t2'), thought('th', true)])
    const next = view([tool('t1'), tool('t2'), thought('th', false)])

    expect(rowIds(prev.rows)).toEqual(['gh_t1', 'th'])
    expect(rowIds(next.rows)).toEqual(['gh_t1'])
    expect(absorbPlacements(prev.snapshot, next.snapshot, next.spans)).toEqual([
      {
        id: 'th',
        kind: 'thought',
        afterKey: 'gh_t1',
        wasStreaming: true,
        foldPinned: false,
      },
    ])
  })

  it('思考在段首、组这一帧才成立：留在聚合头之前，向下收', () => {
    const prev = view([user('u1'), thought('th', true), tool('t1'), tool('t2')])
    const next = view([user('u1'), thought('th', false), tool('t1'), tool('t2')])

    expect(absorbPlacements(prev.snapshot, next.snapshot, next.spans)).toEqual([
      {
        id: 'th',
        kind: 'thought',
        afterKey: 'u1',
        wasStreaming: true,
        foldPinned: false,
      },
    ])
  })

  it('思考是列表首行：退出行从最前开始', () => {
    const prev = view([thought('th', true), tool('t1'), tool('t2')])
    const next = view([thought('th', false), tool('t1'), tool('t2')])

    expect(absorbPlacements(prev.snapshot, next.snapshot, next.spans)).toEqual([
      {
        id: 'th',
        kind: 'thought',
        afterKey: null,
        wasStreaming: true,
        foldPinned: false,
      },
    ])
  })

  it('早已收口、这一帧才被工具补齐的组收进去：工具和思考都播', () => {
    const prev = view([tool('t1'), thought('th', false)])
    const next = view([tool('t1'), thought('th', false), tool('t2')])

    expect(absorbPlacements(prev.snapshot, next.snapshot, next.spans)).toEqual([
      {
        id: 't1',
        kind: 'tool',
        afterKey: null,
        wasStreaming: false,
        foldPinned: false,
      },
      {
        id: 'th',
        kind: 'thought',
        afterKey: null,
        wasStreaming: false,
        foldPinned: false,
      },
    ])
  })

  it('用户把展开的思考折回归档：不算收组，不播', () => {
    const prev = view([tool('t1'), tool('t2'), thought('th', false, 'expanded')])
    const next = view([tool('t1'), tool('t2'), thought('th', false, 'collapsed')])

    expect(rowIds(prev.rows)).toContain('th')
    expect(absorbPlacements(prev.snapshot, next.snapshot, next.spans)).toEqual([])
  })
})

describe('absorbPlacements — 工具', () => {
  it('两个待入组工具同时被收：都放在新组头之前，顺序稳定', () => {
    const prev = view([user('u1'), tool('t1'), runningTool('t2')])
    const next = view([user('u1'), tool('t1'), tool('t2')])

    expect(rowIds(prev.rows)).toEqual(['u1', 't1', 't2'])
    expect(rowIds(next.rows)).toEqual(['u1', 'gh_t1'])
    expect(absorbPlacements(prev.snapshot, next.snapshot, next.spans)).toEqual([
      {
        id: 't1',
        kind: 'tool',
        afterKey: 'u1',
        wasStreaming: false,
        foldPinned: false,
      },
      {
        id: 't2',
        kind: 'tool',
        afterKey: 'u1',
        wasStreaming: false,
        foldPinned: false,
      },
    ])
  })

  it('第三个工具并入已有组：落在组头之后，向上收', () => {
    const prev = view([tool('t1'), tool('t2'), runningTool('t3')])
    const next = view([tool('t1'), tool('t2'), tool('t3')])

    expect(rowIds(prev.rows)).toEqual(['gh_t1', 't3'])
    expect(absorbPlacements(prev.snapshot, next.snapshot, next.spans)).toEqual([
      {
        id: 't3',
        kind: 'tool',
        afterKey: 'gh_t1',
        wasStreaming: false,
        foldPinned: false,
      },
    ])
  })

  it('新组里有手动展开的成员：退出行落在它之后，向上收', () => {
    const prev = view([
      tool('t1', { displayMode: 'expanded', expanded: true }),
      runningTool('t2'),
    ])
    const next = view([
      tool('t1', { displayMode: 'expanded', expanded: true }),
      tool('t2'),
    ])

    expect(rowIds(prev.rows)).toEqual(['t1', 't2'])
    expect(rowIds(next.rows)).toEqual(['gh_t1', 't1'])
    expect(absorbPlacements(prev.snapshot, next.snapshot, next.spans)).toEqual([
      {
        id: 't2',
        kind: 'tool',
        afterKey: 't1',
        wasStreaming: false,
        foldPinned: false,
      },
    ])
  })

  it('用户手动把展开的工具折回：不算入组，不播', () => {
    const prev = view([
      tool('t1'),
      tool('t2'),
      tool('t3', { displayMode: 'expanded', expanded: true }),
    ])
    const next = view([tool('t1'), tool('t2'), tool('t3')])

    expect(rowIds(prev.rows)).toContain('t3')
    expect(absorbPlacements(prev.snapshot, next.snapshot, next.spans)).toEqual([])
  })

  it('被用户钉成折叠态的工具仍按折叠行收，并带上 foldPinned', () => {
    const prev = view([
      user('u1'),
      tool('t1', { foldPinned: true }),
      runningTool('t2'),
    ])
    const next = view([user('u1'), tool('t1', { foldPinned: true }), tool('t2')])

    expect(absorbPlacements(prev.snapshot, next.snapshot, next.spans)).toEqual([
      {
        id: 't1',
        kind: 'tool',
        afterKey: 'u1',
        wasStreaming: false,
        foldPinned: true,
      },
      {
        id: 't2',
        kind: 'tool',
        afterKey: 'u1',
        wasStreaming: false,
        foldPinned: false,
      },
    ])
  })
})

describe('absorbPlacements — 守卫', () => {
  it('手动收起分组：成员都补退出行，锚在聚合头之后', () => {
    const entries = [tool('t1'), tool('t2'), thought('th', false)]
    const prev = view(entries, new Set(['t1']))
    const next = view(entries, new Set())

    expect(rowIds(prev.rows)).toEqual(['gh_t1', 't1', 't2', 'th'])
    expect(rowIds(next.rows)).toEqual(['gh_t1'])
    expect(absorbPlacements(prev.snapshot, next.snapshot, next.spans)).toEqual([
      { id: 't1', kind: 'tool', afterKey: 'gh_t1', wasStreaming: false, foldPinned: false },
      { id: 't2', kind: 'tool', afterKey: 'gh_t1', wasStreaming: false, foldPinned: false },
      { id: 'th', kind: 'thought', afterKey: 'gh_t1', wasStreaming: false, foldPinned: false },
    ])
  })

  it('手动展开分组：成员这一帧才出现，不生成退出行', () => {
    const entries = [tool('t1'), tool('t2'), thought('th', false)]
    const prev = view(entries, new Set())
    const next = view(entries, new Set(['t1']))

    expect(absorbPlacements(prev.snapshot, next.snapshot, next.spans)).toEqual([])
  })

  it('上一帧本来就被组藏着 / 切会话（epoch 变化）不播', () => {
    const entries = [tool('t1'), tool('t2'), thought('th', false)]
    const prev = view(entries)
    const next = view(entries)
    expect(absorbPlacements(prev.snapshot, next.snapshot, next.spans)).toEqual([])

    const switched = view(entries, EMPTY, 'e2')
    expect(
      absorbPlacements(prev.snapshot, switched.snapshot, switched.spans),
    ).toEqual([])
  })
})
