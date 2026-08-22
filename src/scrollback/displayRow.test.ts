import { describe, expect, it } from 'vitest'
import { displayRowToEntry } from './displayRow'
import type { DisplayRow } from './verbGroup'

describe('displayRowToEntry', () => {
  it('entry 行原样返回', () => {
    const entry = { id: 'u1', kind: 'user' as const, text: 'hi' }
    expect(displayRowToEntry({ type: 'entry', entry, index: 2 })).toBe(entry)
  })

  it('verb group_header：count = members，verbRun 透传', () => {
    const row: DisplayRow = {
      type: 'group_header',
      id: 'gh_a',
      family: 'verb',
      span: {
        range: { start: 0, end: 3 },
        kind: { type: 'verb', members: 3 },
        expanded: false,
        anchorId: 'a',
      },
      label: { text: 'Read 3 files', running: false, failed: false },
    }
    const e = displayRowToEntry(row)
    expect(e).toMatchObject({
      id: row.id,
      kind: 'group_header',
      count: 3,
      collapse: false,
      label: 'Read 3 files',
      verbRun: { running: false, failed: false, verb: 'Read 3 files' },
    })
  })

  it('running/failed verb header → verbRun 反映状态', () => {
    const row: DisplayRow = {
      type: 'group_header',
      id: 'gh_b',
      family: 'verb',
      span: {
        range: { start: 0, end: 2 },
        kind: { type: 'verb', members: 2 },
        expanded: true,
        anchorId: 'b',
      },
      label: { text: 'Searching 2 patterns', running: true, failed: false },
    }
    const e = displayRowToEntry(row)
    expect(e).toMatchObject({
      kind: 'group_header',
      count: 2,
      collapse: true,
      verbRun: { running: true, failed: false, verb: 'Searching 2 patterns' },
    })
  })

  it('truncation header：count = hidden，无 verbRun', () => {
    const row: DisplayRow = {
      type: 'group_header',
      id: 'gh_c',
      family: 'truncation',
      span: {
        range: { start: 0, end: 12 },
        kind: { type: 'truncation', participants: 12, hidden: 7 },
        expanded: false,
        anchorId: 'c',
      },
      label: { text: '7 more', running: false, failed: false },
    }
    const e = displayRowToEntry(row)
    expect(e).toMatchObject({
      kind: 'group_header',
      count: 7,
      collapse: false,
      label: '7 more',
    })
    expect('verbRun' in e && (e as { verbRun?: unknown }).verbRun).toBeUndefined()
  })
})