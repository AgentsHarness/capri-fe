import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../api/types'
import {
  GROUP_MAX_VISIBLE,
  displayRowKey,
  groupingSignature,
  isDensePackable,
  isDensePackableRow,
  labelKind,
  projectDisplayRows,
  runStep,
  scanGroups,
  spanContaining,
  spanExpanded,
  truncationLabel,
  verbGroupKind,
  verbGroupLabel,
} from './verbGroup'

function tool(over: Partial<Extract<ScrollEntry, { kind: 'tool' }>> = {}): ScrollEntry {
  return {
    id: `t${Math.random().toString(36).slice(2, 8)}`,
    kind: 'tool',
    title: 'tool',
    verb: 'v',
    status: 'completed',
    ...over,
  }
}

function thought(over: Partial<Extract<ScrollEntry, { kind: 'thought' }>> = {}): ScrollEntry {
  return { id: `th${Math.random().toString(36).slice(2, 8)}`, kind: 'thought', text: 'x', ...over }
}

function user(over: Partial<Extract<ScrollEntry, { kind: 'user' }>> = {}): ScrollEntry {
  return { id: `u${Math.random().toString(36).slice(2, 8)}`, kind: 'user', text: 'q', ...over }
}

describe('verbGroupKind / labelKind', () => {
  it('read/search/list_dir 归入 file/search/dir', () => {
    expect(verbGroupKind(tool({ kindName: 'read' }))).toBe('file')
    expect(verbGroupKind(tool({ kindName: 'search' }))).toBe('search')
    expect(verbGroupKind(tool({ kindName: 'list_dir' }))).toBe('dir')
    expect(verbGroupKind(tool({ kindName: 'list' }))).toBe('dir')
  })

  it('web 系 / memory / integration / skill / subagent', () => {
    expect(verbGroupKind(tool({ kindName: 'web_search' }))).toBe('web_search')
    expect(verbGroupKind(tool({ kindName: 'fetch' }))).toBe('web_fetch')
    expect(verbGroupKind(tool({ kindName: 'memory_search' }))).toBe('memory')
    expect(verbGroupKind(tool({ kindName: 'search_tool' }))).toBe('integration')
    expect(verbGroupKind(tool({ kindName: 'skill' }))).toBe('skill')
    expect(verbGroupKind({ id: 's', kind: 'subagent', title: 's', status: 'started' })).toBe('subagent')
  })

  it('execute/edit/mcp/unknown → null（不进 verb 组）', () => {
    expect(verbGroupKind(tool({ kindName: 'execute' }))).toBeNull()
    expect(verbGroupKind(tool({ kindName: 'edit' }))).toBeNull()
    expect(verbGroupKind(tool({ kindName: 'mcp' }))).toBeNull()
    expect(verbGroupKind(tool({ kindName: 'custom' }))).toBeNull()
    expect(verbGroupKind(user())).toBeNull()
  })

  it('labelKind：execute → command、edit → edit、mcp → mcp、其余工具 → other', () => {
    expect(labelKind(tool({ kindName: 'execute' }))).toBe('command')
    expect(labelKind(tool({ kindName: 'edit' }))).toBe('edit')
    expect(labelKind(tool({ kindName: 'mcp' }))).toBe('mcp')
    expect(labelKind(tool({ kindName: 'custom' }))).toBe('other')
    expect(labelKind({ id: 's', kind: 'subagent', title: 's', status: 'started' })).toBe('subagent')
  })
})

describe('runStep', () => {
  it('折叠的工具成员 → member；手动展开 → transparent', () => {
    expect(runStep(tool({ kindName: 'read' }))).toEqual({ kind: 'member', vg: 'file' })
    expect(runStep(tool({ kindName: 'read', expanded: true }))).toEqual({ kind: 'transparent' })
  })

  it('subagent → member（subagent 恒视为折叠成员）', () => {
    expect(runStep({ id: 's', kind: 'subagent', title: 's', status: 'started' })).toEqual({ kind: 'member', vg: 'subagent' })
    expect(runStep({ id: 's', kind: 'subagent', title: 's', status: 'completed', running: false })).toEqual({ kind: 'member', vg: 'subagent' })
  })

  it('thought：showThinking 且折叠非流式有内容 → thought；否则 transparent', () => {
    expect(runStep(thought())).toEqual({ kind: 'thought' })
    expect(runStep(thought({ streaming: true }))).toEqual({ kind: 'transparent' })
    expect(runStep(thought({ text: '' }))).toEqual({ kind: 'transparent' })
    expect(runStep(thought({ displayMode: 'expanded' }))).toEqual({ kind: 'transparent' })
    expect(runStep(thought(), false)).toEqual({ kind: 'transparent' })
  })

  it('user/assistant → break', () => {
    expect(runStep(user())).toEqual({ kind: 'break' })
    expect(runStep({ id: 'a', kind: 'assistant', text: 'x' })).toEqual({ kind: 'break' })
  })
})

describe('spanExpanded', () => {
  it('默认折叠：集合里有 anchor → 展开', () => {
    expect(spanExpanded('a', new Set(['a']), false)).toBe(true)
    expect(spanExpanded('a', new Set(), false)).toBe(false)
  })

  it('默认展开：集合里有 anchor → 收起', () => {
    expect(spanExpanded('a', new Set(['a']), true)).toBe(false)
    expect(spanExpanded('a', new Set(), true)).toBe(true)
  })
})

describe('scanGroups — verb runs', () => {
  it('连续折叠工具合成一个 verb 组，span 记录 members', () => {
    const entries = [
      tool({ kindName: 'read' }),
      tool({ kindName: 'read' }),
      tool({ kindName: 'search' }),
      user(),
    ]
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({
      range: { start: 0, end: 3 },
      kind: { type: 'verb', members: 3 },
      expanded: false,
      anchorId: entries[0].id,
    })
  })

  it('手动展开的 verb 成员不断组（transparent），成员数不含透明行', () => {
    const entries = [
      tool({ kindName: 'read' }),
      tool({ kindName: 'read', expanded: true }),
      tool({ kindName: 'read', status: 'in_progress' }),
    ]
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0].range).toEqual({ start: 0, end: 3 })
    expect(spans[0].kind).toEqual({ type: 'verb', members: 2 })
  })

  it('execute 工具中断 verb 组', () => {
    const entries = [tool({ kindName: 'read' }), tool({ kindName: 'execute' }), tool({ kindName: 'read' })]
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(2)
    expect(spans[0].range.start).toBe(0)
    expect(spans[1].range.start).toBe(2)
  })

  it('groupToolVerbs=false 时不做 verb 分组', () => {
    const spans = scanGroups([tool({ kindName: 'read' }), tool({ kindName: 'read' })], new Set(), {
      groupToolVerbs: false,
    })
    expect(spans).toHaveLength(0)
  })

  it('手动展开的组（expandedGroups）反映到 span', () => {
    const entries = [tool({ kindName: 'read' }), tool({ kindName: 'read' })]
    const spans = scanGroups(entries, new Set([entries[0].id]))
    expect(spans[0].expanded).toBe(true)
  })
})

describe('scanGroups — truncation', () => {
  it('超过 maxVisible 的密集折叠工具 → truncation 组（hidden = 超量）', () => {
    const entries = Array.from({ length: 13 }, () => tool({ kindName: 'execute' }))
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({
      kind: { type: 'truncation', participants: 13, hidden: 3 },
      range: { start: 0, end: 13 },
    })
  })

  it('自定义 maxVisible', () => {
    const entries = Array.from({ length: 6 }, () => tool({ kindName: 'execute' }))
    const spans = scanGroups(entries, new Set(), { maxVisible: 4 })
    expect(spans[0].kind).toEqual({ type: 'truncation', participants: 6, hidden: 2 })
  })

  it('不足 maxVisible+1 → 不截断', () => {
    const entries = Array.from({ length: GROUP_MAX_VISIBLE }, () => tool({ kindName: 'execute' }))
    expect(scanGroups(entries, new Set())).toHaveLength(0)
  })

  it('maxVisible=0 关闭截断', () => {
    const entries = Array.from({ length: 20 }, () => tool({ kindName: 'execute' }))
    expect(scanGroups(entries, new Set(), { maxVisible: 0 })).toHaveLength(0)
  })

  it('verb 组占用成员不再进 truncation（execute 足够多时并存）', () => {
    const entries = [
      ...Array.from({ length: 12 }, () => tool({ kindName: 'read' })),
      ...Array.from({ length: 13 }, () => tool({ kindName: 'execute' })),
    ]
    const spans = scanGroups(entries, new Set())
    const kinds = spans.map((s) => s.kind.type)
    expect(kinds).toContain('verb')
    expect(kinds).toContain('truncation')
    // execute 组不含任何 read 成员
    const trunc = spans.find((s) => s.kind.type === 'truncation')!
    expect(trunc.range.start).toBe(12)
  })
})

describe('verbGroupLabel / truncationLabel', () => {
  it('按 bucket 汇总动词+名词，running 统一进行时', () => {
    const entries = [tool({ kindName: 'read' }), tool({ kindName: 'read' }), tool({ kindName: 'search' })]
    const span = scanGroups(entries, new Set())[0]
    expect(verbGroupLabel(entries, span)).toEqual({
      text: 'Read 2 files, Searched 1 pattern',
      running: false,
      failed: false,
    })
  })

  it('running → 进行时；有失败 → 追加 · N failed', () => {
    const entries = [
      tool({ kindName: 'read', status: 'in_progress' }),
      tool({ kindName: 'read', status: 'failed' }),
      tool({ kindName: 'search' }),
    ]
    const span = scanGroups(entries, new Set())[0]
    expect(verbGroupLabel(entries, span)).toEqual({
      text: 'Reading 2 files, Searching 1 pattern · 1 failed',
      running: true,
      failed: true,
    })
  })

  it('truncationLabel 只统计 hidden 数量前缀', () => {
    const entries = Array.from({ length: 13 }, () => tool({ kindName: 'execute' }))
    const span = scanGroups(entries, new Set())[0]
    const label = truncationLabel(entries, span)
    // hidden=3 → 只盘点前 3 个参与成员
    expect(label).toEqual({ text: 'Ran 3 commands', running: false, failed: false })
  })

  it('空 span / 非 truncation → null', () => {
    expect(truncationLabel([], { range: { start: 0, end: 0 }, kind: { type: 'verb', members: 0 }, expanded: false, anchorId: 'a' })).toBeNull()
  })
})

describe('projectDisplayRows', () => {
  it('折叠 verb 组 → 只剩 header 行', () => {
    const entries = [tool({ kindName: 'read' }), tool({ kindName: 'read' }), user()]
    const spans = scanGroups(entries, new Set())
    const rows = projectDisplayRows(entries, spans)
    expect(rows).toHaveLength(2)
    if (rows[0].type !== 'group_header') throw new Error('expected group header')
    expect(rows[0]).toMatchObject({ id: `gh_${entries[0].id}` })
    expect(rows[0].label.text).toBe('Read 2 files')
    expect(rows[1]).toMatchObject({ type: 'entry', index: 2 })
  })

  it('展开 verb 组 → header + 全部成员', () => {
    const entries = [tool({ kindName: 'read' }), tool({ kindName: 'read' })]
    const spans = scanGroups(entries, new Set([entries[0].id]))
    const rows = projectDisplayRows(entries, spans)
    expect(rows).toHaveLength(3)
    expect(rows[0].type).toBe('group_header')
    expect(rows.slice(1).map((r) => r.type)).toEqual(['entry', 'entry'])
  })

  it('截断组 → header + 可见尾部，隐藏最老成员', () => {
    const entries = Array.from({ length: 13 }, () => tool({ kindName: 'execute', title: 'cmd' }))
    const spans = scanGroups(entries, new Set())
    const rows = projectDisplayRows(entries, spans)
    // 13 参与 - 3 隐藏 + 1 header = 11 行
    expect(rows).toHaveLength(11)
    expect(rows[0].type).toBe('group_header')
    // 隐藏的是最老的 3 个
    expect(rows[1]).toMatchObject({ type: 'entry', index: 3 })
    expect(rows[10]).toMatchObject({ type: 'entry', index: 12 })
  })

  it('展开截断组 → header + 全部参与成员', () => {
    const entries = Array.from({ length: 13 }, () => tool({ kindName: 'execute' }))
    const spans = scanGroups(entries, new Set([entries[0].id]))
    const rows = projectDisplayRows(entries, spans)
    expect(rows).toHaveLength(14)
    expect(rows[0].type).toBe('group_header')
  })

  it('headerCache 命中时复用同一 header 行对象', () => {
    const entries = [tool({ kindName: 'read' }), tool({ kindName: 'read' })]
    const spans = scanGroups(entries, new Set())
    const cache = new Map()
    const rows1 = projectDisplayRows(entries, spans, true, cache)
    const rows2 = projectDisplayRows(entries, spans, true, cache)
    expect(rows1[0]).toBe(rows2[0])
  })
})

describe('spanContaining', () => {
  const mk = (start: number, end: number) => ({
    range: { start, end },
    kind: { type: 'verb' as const, members: end - start },
    expanded: false,
    anchorId: `a${start}`,
  })

  it('命中区间内 / 外 / 空数组', () => {
    const spans = [mk(0, 3), mk(5, 8)]
    expect(spanContaining(spans, 1)?.anchorId).toBe('a0')
    expect(spanContaining(spans, 5)?.anchorId).toBe('a5')
    expect(spanContaining(spans, 4)).toBeUndefined()
    expect(spanContaining(spans, 9)).toBeUndefined()
    expect(spanContaining([], 0)).toBeUndefined()
  })
})

describe('groupingSignature', () => {
  it('文本内容不参与签名；kind/状态变化参与', () => {
    const a = tool({ id: 'same1', kindName: 'read', title: 'aaa' })
    const b = tool({ id: 'same1', kindName: 'read', title: 'bbb' })
    expect(groupingSignature([a])).toBe(groupingSignature([b]))
    expect(groupingSignature([a])).not.toBe(
      groupingSignature([tool({ id: 'same1', kindName: 'read', status: 'in_progress' })]),
    )
  })

  it('id 折叠进签名（长度/首尾/哈希）——增删条目使签名变化', () => {
    const a = tool({})
    const sig1 = groupingSignature([a])
    const sig2 = groupingSignature([])
    expect(sig1).not.toBe(sig2)
  })

  it('thought 的 displayMode/streaming/空文本进入签名', () => {
    expect(groupingSignature([thought()])).not.toBe(
      groupingSignature([thought({ displayMode: 'expanded' })]),
    )
    expect(groupingSignature([thought()])).not.toBe(
      groupingSignature([thought({ text: '' })]),
    )
  })
})

describe('isDensePackable / displayRowKey', () => {
  it('折叠工具/折叠 thought/subagent/group_header 可密排', () => {
    expect(isDensePackable(tool({ kindName: 'execute' }))).toBe(true)
    expect(isDensePackable(tool({ kindName: 'execute', expanded: true }))).toBe(false)
    expect(isDensePackable(thought())).toBe(true)
    expect(isDensePackable(thought({ streaming: true }))).toBe(false)
    expect(isDensePackable({ id: 'g', kind: 'group_header', count: 3 })).toBe(true)
    expect(isDensePackable(user())).toBe(false)
  })

  it('entry 行按 entry.id；group_header 行按 row.id', () => {
    const e = tool({})
    const rows = projectDisplayRows([e], scanGroups([e], new Set()))
    expect(displayRowKey(rows[0])).toBe(e.id)
    const g = { id: 'gh_x', type: 'group_header' as const, span: {} as never, label: {} as never, family: 'verb' as const }
    expect(displayRowKey(g)).toBe('gh_x')
    expect(isDensePackableRow(g)).toBe(true)
  })
})