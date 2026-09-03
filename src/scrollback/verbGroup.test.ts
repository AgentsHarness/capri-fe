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

  it('SKILL.md 读取归入 skill（TUI is_skill_read）', () => {
    const skillRead = (over: Partial<Extract<ScrollEntry, { kind: 'tool' }>> = {}) =>
      tool({
        kindName: 'read',
        title: '/x/skills/deploy/SKILL.md',
        raw: { rawInput: { path: '/x/skills/deploy/SKILL.md' } } as never,
        ...over,
      })
    expect(verbGroupKind(skillRead())).toBe('skill')
    // raw 缺失时 title 兜底
    expect(verbGroupKind(tool({ kindName: 'read', title: '/x/skills/deploy/SKILL.md' }))).toBe('skill')
    expect(verbGroupKind(tool({ kindName: 'read', title: '/x/skills/deploy/README.md' }))).toBe('file')
    expect(labelKind(skillRead())).toBe('skill')
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

  it('thought：showThinking 且折叠非流式（含空文本）→ thought；否则 transparent', () => {
    expect(runStep(thought())).toEqual({ kind: 'thought' })
    expect(runStep(thought({ text: '' }))).toEqual({ kind: 'thought' })
    expect(runStep(thought({ streaming: true }))).toEqual({ kind: 'transparent' })
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

  it('空文本收口思考认领进 run：尾部噪音行折叠后不再漏光杆行', () => {
    const entries = [tool({ kindName: 'read' }), tool({ kindName: 'read' }), thought({ text: '' })]
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0].range).toEqual({ start: 0, end: 3 })
    expect(projectDisplayRows(entries, spans)).toHaveLength(1)
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

describe('scanGroups / projectDisplayRows — thought 参与截断密度', () => {
  /** 思考-工具交替 n 轮（2n 个参与者，全部折叠态）。 */
  const alt = (n: number) =>
    Array.from({ length: n }, (_, i) => [
      thought({ text: `t${i}` }),
      tool({ kindName: 'execute' }),
    ]).flat()

  it('交替密集段：thought 计入 participants，超阈值成 truncation 组', () => {
    const entries = alt(12) // 24 participants
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({
      range: { start: 0, end: 24 },
      kind: { type: 'truncation', participants: 24, hidden: 14 },
      anchorId: entries[0].id,
    })
  })

  it('短交替（≤ maxVisible+1）不折叠：思考-工具-思考保持平铺', () => {
    expect(scanGroups(alt(5), new Set())).toHaveLength(0) // 10 participants
  })

  it('流式思考不劈开截断段（实时行保持可见、不计数）', () => {
    const entries = [
      ...Array.from({ length: 12 }, () => tool({ kindName: 'execute' })),
      thought({ text: 'live', streaming: true }),
      tool({ kindName: 'execute' }),
    ]
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0].range).toEqual({ start: 0, end: 14 })
    expect(spans[0].kind).toEqual({ type: 'truncation', participants: 13, hidden: 3 })
  })

  it('手动展开的思考不劈开截断段（且留在参与者集合内）', () => {
    const entries = [
      ...Array.from({ length: 12 }, () => tool({ kindName: 'execute' })),
      thought({ displayMode: 'expanded' }),
      tool({ kindName: 'execute' }),
    ]
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0].range).toEqual({ start: 0, end: 14 })
    // 展开思考仍计入参与者:14 = 13 工具 + 1 思考
    expect(spans[0].kind).toEqual({ type: 'truncation', participants: 14, hidden: 4 })
  })

  it('点开 thought 数字冻结：参与者/隐藏预算/标签全部不动（17 → 16 回归）', () => {
    const entries = [
      ...Array.from({ length: 16 }, () => tool({ kindName: 'execute' })),
      thought({ text: 'mid' }),
      tool({ kindName: 'execute' }),
    ]
    const collapsed = scanGroups(entries, new Set())
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0].kind).toEqual({ type: 'truncation', participants: 18, hidden: 8 })
    expect(truncationLabel(entries, collapsed[0])).toMatchObject({
      // TUI verb_group.rs：思考占名额、永不进词表（无 Thought N times）。
      text: 'Ran 17 commands',
    })

    const openedEntries = entries.map((e) =>
      e.kind === 'thought' ? { ...e, displayMode: 'expanded' as const } : e,
    )
    const opened = scanGroups(openedEntries, new Set())
    expect(opened).toHaveLength(1)
    expect(opened[0].range).toEqual({ start: 0, end: 18 })
    // 参与者集合不变:participants/hidden 与折叠态完全一致 → 尾部不滑行
    expect(opened[0].kind).toEqual({ type: 'truncation', participants: 18, hidden: 8 })
    expect(truncationLabel(openedEntries, opened[0])).toMatchObject({
      text: 'Ran 17 commands',
    })
    // 展开的思考豁免隐藏,原位可见
    const rows = projectDisplayRows(openedEntries, opened)
    expect(
      rows.some(
        (r) =>
          r.type === 'entry' &&
          r.entry.kind === 'thought' &&
          r.entry.displayMode === 'expanded',
      ),
    ).toBe(true)
  })

  it('纯思考段也按全参与者计数折叠（TUI groups.rs group_len 含思考）；标签回落 N more', () => {
    const entries = Array.from({ length: 12 }, () => thought({ text: 't' }))
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0].kind).toEqual({ type: 'truncation', participants: 12, hidden: 2 })
    // 纯思考前缀无可命名参与者 → truncationLabel 返回 null → 回落 "N more"
    expect(truncationLabel(entries, spans[0])).toBeNull()
  })

  it('折叠点按全参与者计数：6 轮交替（12 参与者、6 工具）超阈值折叠', () => {
    const spans = scanGroups(alt(6), new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0].kind).toEqual({ type: 'truncation', participants: 12, hidden: 2 })
  })

  it('折叠头标签只描述 hidden 前缀（TUI truncation_header_label limit）', () => {
    // 18 参与者（16 工具 + 1 思考 + 1 工具），hidden=8：折叠头只数前 8 个
    // 参与者（全是工具）→ Ran 8 commands。
    const entries = [
      ...Array.from({ length: 16 }, () => tool({ kindName: 'execute' })),
      thought({ text: 'mid' }),
      tool({ kindName: 'execute' }),
    ]
    const span = scanGroups(entries, new Set())[0]
    if (span.kind.type !== 'truncation') throw new Error('expected truncation')
    expect(
      truncationLabel(entries, span, true, span.kind.hidden),
    ).toMatchObject({
      text: 'Ran 8 commands',
    })
    // 展开态（无 limit）描述整段。
    expect(truncationLabel(entries, span, true, undefined)).toMatchObject({
      text: 'Ran 17 commands',
    })
  })

  it('词表叫不出的参与者（bg_task）让整个标签回落 N more（TUI decline）', () => {
    const entries = [
      ...Array.from({ length: 12 }, () => tool({ kindName: 'execute' })),
      { id: 'b', kind: 'bg_task', title: 't', command: 'x', status: 'completed' } as never,
    ]
    const span = scanGroups(entries, new Set())[0]
    expect(truncationLabel(entries, span)).toBeNull()
  })

  it('折叠段前的思考一并入组隐藏', () => {
    const entries = [
      thought({ text: 'pre' }),
      ...Array.from({ length: 13 }, () => tool({ kindName: 'execute' })),
    ]
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({
      range: { start: 0, end: 14 },
      kind: { type: 'truncation', participants: 14, hidden: 4 },
    })
    const rows = projectDisplayRows(entries, spans)
    // header + 10 可见尾部（前导 thought 与最旧 3 条 execute 藏进前缀）
    expect(rows).toHaveLength(11)
    expect(rows[0].type).toBe('group_header')
  })

  it('纯思考短段不成组（保持平铺）', () => {
    expect(scanGroups([thought(), thought(), thought()], new Set())).toHaveLength(0)
  })

  it('折叠截断组：thought 随最旧前缀一起隐藏，尾部原序可见', () => {
    const entries = alt(12)
    const rows = projectDisplayRows(entries, scanGroups(entries, new Set()))
    // 24 参与 - 14 隐藏 + 1 header = 11 行
    expect(rows).toHaveLength(11)
    expect(rows[0].type).toBe('group_header')
    const tail = rows.slice(1).map((r) => (r.type === 'entry' ? r.entry.kind : 'header'))
    expect(tail).toEqual(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 'thought' : 'tool')))
    expect(rows[1]).toMatchObject({ type: 'entry', index: 14 })
  })

  it('展开截断组：header + 全部参与者（思考原位，时间线保真）', () => {
    const entries = alt(12)
    const rows = projectDisplayRows(entries, scanGroups(entries, new Set([entries[0].id])))
    expect(rows).toHaveLength(25)
    expect(rows[1]).toMatchObject({ type: 'entry', index: 0 })
    expect(rows[24]).toMatchObject({ type: 'entry', index: 23 })
  })

  it('truncationLabel：思考永不进词表（TUI "NEVER bucketed"），工具段照常', () => {
    const entries = alt(12)
    const span = scanGroups(entries, new Set())[0]
    expect(truncationLabel(entries, span)).toEqual({
      text: 'Ran 12 commands',
      running: false,
      failed: false,
    })
  })
})

describe('scanGroups — subagent（task）与密集段的边界', () => {
  const bash = (n: number) => Array.from({ length: n }, () => tool({ kindName: 'execute' }))
  const subagent = (
    running = false,
    over: Partial<Extract<ScrollEntry, { kind: 'subagent' }>> = {},
  ): ScrollEntry => ({
    id: `sa${Math.random().toString(36).slice(2, 8)}`,
    kind: 'subagent',
    title: 'task',
    status: running ? 'started' : 'completed',
    running,
    ...over,
  })

  it('纯 subagent run 成组（TUI folds=members>=1），截断段在 verb 认领处断开', () => {
    const entries = [...bash(12), subagent(), ...bash(12)]
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(3)
    expect(spans[0]).toMatchObject({
      range: { start: 0, end: 12 },
      kind: { type: 'truncation', participants: 12, hidden: 2 },
    })
    expect(spans[1]).toMatchObject({
      range: { start: 12, end: 13 },
      kind: { type: 'verb', members: 1 },
    })
    expect(spans[2]).toMatchObject({
      range: { start: 13, end: 25 },
      kind: { type: 'truncation', participants: 12, hidden: 2 },
    })
  })

  it('task 把前后 execute 截断段劈开：后段不够阈值则保持平铺', () => {
    const entries = [...bash(12), subagent(), ...bash(5)]
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(2)
    expect(spans[0].kind).toEqual({ type: 'truncation', participants: 12, hidden: 2 })
    expect(spans[1].kind).toEqual({ type: 'verb', members: 1 })
    const rows = projectDisplayRows(entries, spans)
    // 前段 truncation: header + 10 可见尾部；verb 头 1 行；后段 5 条 execute 平铺
    expect(rows).toHaveLength(1 + 10 + 1 + 5)
    expect(rows.filter((r) => r.type === 'entry' && r.entry.kind === 'subagent')).toHaveLength(0)
  })

  it('孤立 task 折成 1 成员 verb 头（TUI：第一条即出 header，避免第二条跳变）', () => {
    const entries = [subagent()]
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0].kind).toEqual({ type: 'verb', members: 1 })
    const rows = projectDisplayRows(entries, spans)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'group_header' })
    if (rows[0].type !== 'group_header') throw new Error('expected group header')
    expect(rows[0].label.text).toBe('Ran 1 subagent')
  })

  it('夹在 Read run 中的 task 并入同一 verb 组', () => {
    const entries = [
      ...Array.from({ length: 5 }, () => tool({ kindName: 'read' })),
      subagent(true),
      ...Array.from({ length: 5 }, () => tool({ kindName: 'read' })),
    ]
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0].kind).toEqual({ type: 'verb', members: 11 })
    expect(verbGroupLabel(entries, spans[0])).toMatchObject({
      text: 'Reading 10 files, Running 1 subagent',
    })
  })

  it('折叠 thought 认领进纯 subagent run：组内隐藏，展开后与 Agent 同组', () => {
    const entries = [
      subagent(true, { title: 'review:a' }),
      subagent(true, { title: 'review:b' }),
      subagent(true, { title: 'review:c' }),
      subagent(true, { title: 'review:d' }),
      thought({ text: 'launched' }),
      { id: 'a1', kind: 'assistant', text: 'ok' } as ScrollEntry,
    ]
    const collapsed = scanGroups(entries, new Set())
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]).toMatchObject({
      range: { start: 0, end: 5 },
      kind: { type: 'verb', members: 4 },
    })
    expect(verbGroupLabel(entries, collapsed[0])).toMatchObject({
      text: 'Running 4 subagents',
    })
    const folded = projectDisplayRows(entries, collapsed)
    expect(folded).toHaveLength(2)
    expect(folded[0].type).toBe('group_header')
    expect(folded[1]).toMatchObject({ type: 'entry', index: 5 })

    const opened = scanGroups(entries, new Set([entries[0].id]))
    const rows = projectDisplayRows(entries, opened)
    expect(rows.map((r) => (r.type === 'entry' ? r.entry.kind : 'header'))).toEqual([
      'header',
      'subagent',
      'subagent',
      'subagent',
      'subagent',
      'thought',
      'assistant',
    ])
  })

  it('尾部流式 thought 不认领（TUI trailing transparent 在 run 外），收口后才折进去', () => {
    const agents = [
      subagent(true, { title: 'a' }),
      subagent(true, { title: 'b' }),
    ]
    const live = [...agents, thought({ text: 'live', streaming: true })]
    const liveSpans = scanGroups(live, new Set())
    expect(liveSpans).toHaveLength(1)
    expect(liveSpans[0].range).toEqual({ start: 0, end: 2 })
    const liveRows = projectDisplayRows(live, liveSpans)
    expect(liveRows.map((r) => (r.type === 'entry' ? r.entry.kind : 'header'))).toEqual([
      'header',
      'thought',
    ])

    const sealed = [...agents, thought({ text: 'done' })]
    const sealedSpans = scanGroups(sealed, new Set())
    expect(sealedSpans[0].range).toEqual({ start: 0, end: 3 })
    expect(projectDisplayRows(sealed, sealedSpans)).toHaveLength(1)
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

  it('SKILL.md 读取连续命中 → "Read 2 skills"（区别于文件）', () => {
    const skillRead = (title: string) =>
      tool({ kindName: 'read', title, raw: { rawInput: { path: title } } as never })
    const entries = [
      skillRead('/x/.grok/skills/deploy/SKILL.md'),
      skillRead('/x/.grok/skills/commit/SKILL.md'),
      tool({ kindName: 'read', title: '/x/src/main.ts', raw: { rawInput: { path: '/x/src/main.ts' } } as never }),
    ]
    const span = scanGroups(entries, new Set())[0]
    expect(verbGroupLabel(entries, span)).toEqual({
      text: 'Read 2 skills, Read 1 file',
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

  it('成员带 hook runs → 组头聚合 labeled 计数；hook failed 也标 failed', () => {
    const entries = [
      tool({
        kindName: 'read',
        hooks: {
          pre: [{ name: 'h', status: { type: 'failed', error: 'x' } }],
        },
      }),
      tool({
        kindName: 'read',
        hooks: { post: [{ name: 'h2', status: { type: 'success' } }] },
      }),
    ]
    const span = scanGroups(entries, new Set())[0]
    expect(verbGroupLabel(entries, span)).toEqual({
      text: 'Read 2 files',
      running: false,
      failed: true,
      hookCounts: { success: 1, blocked: 0, failed: 1 },
    })
  })

  it('truncationLabel 盘点整组（全组计数，不再只数 hidden 前缀）', () => {
    const entries = Array.from({ length: 13 }, () => tool({ kindName: 'execute' }))
    const span = scanGroups(entries, new Set())[0]
    expect(truncationLabel(entries, span)).toEqual({
      text: 'Ran 13 commands',
      running: false,
      failed: false,
    })
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

  it('kindName 变化进入签名（tool_call_update 后到的分类要重扫分组）', () => {
    // 同一行、expanded/status 都没变，只有分类变了
    expect(groupingSignature([tool({ id: 'same1', kindName: 'other' })])).not.toBe(
      groupingSignature([tool({ id: 'same1', kindName: 'read' })]),
    )
    // 与 status / expanded 互不遮蔽（无分隔符时 'a'+'b' 与 'ab'+'' 会撞签名）
    expect(groupingSignature([tool({ id: 's', status: 'completed', kindName: 'read' })])).not.toBe(
      groupingSignature([tool({ id: 's', status: 'completedX', kindName: '' })]),
    )
    // 非字符串 kindName（被污染的 wire）不得让签名抛
    expect(() =>
      groupingSignature([tool({ id: 's', kindName: 42 as unknown as string })]),
    ).not.toThrow()
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