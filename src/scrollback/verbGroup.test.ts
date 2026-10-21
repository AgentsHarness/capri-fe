import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../api/types'
import {
  GROUP_MAX_MEMBERS,
  displayRowKey,
  groupScopeForDensity,
  groupingSignature,
  isDensePackable,
  isDensePackableRow,
  labelKind,
  projectDisplayRows,
  runStep,
  scanGroups,
  spanContaining,
  spanExpanded,
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

/** 带 rawInput 的工具行（单值命名要读它）。 */
function toolWithInput(
  kindName: string,
  input: Record<string, unknown>,
  over: Partial<Extract<ScrollEntry, { kind: 'tool' }>> = {},
): ScrollEntry {
  return tool({
    kindName,
    raw: { rawInput: input, _meta: { 'x.ai/tool': { kind: kindName } } } as never,
    ...over,
  })
}

function thought(over: Partial<Extract<ScrollEntry, { kind: 'thought' }>> = {}): ScrollEntry {
  return { id: `th${Math.random().toString(36).slice(2, 8)}`, kind: 'thought', text: 'x', ...over }
}

function user(over: Partial<Extract<ScrollEntry, { kind: 'user' }>> = {}): ScrollEntry {
  return { id: `u${Math.random().toString(36).slice(2, 8)}`, kind: 'user', text: 'q', ...over }
}

const reads = (n: number) =>
  Array.from({ length: n }, (_, i) => toolWithInput('read', { target_file: `/w/f${i}.py` }))
const execs = (n: number) => Array.from({ length: n }, () => tool({ kindName: 'execute' }))

describe('verbGroupKind / labelKind', () => {
  it('read/search/list_dir 归入 file/search/dir，web 与未分类归入 other', () => {
    expect(verbGroupKind(tool({ kindName: 'read' }))).toBe('file')
    expect(verbGroupKind(tool({ kindName: 'search' }))).toBe('search')
    expect(verbGroupKind(tool({ kindName: 'list_dir' }))).toBe('dir')
    expect(verbGroupKind(tool({ kindName: 'list' }))).toBe('dir')
    expect(verbGroupKind(tool({ kindName: 'web_search' }))).toBe('other')
    expect(verbGroupKind(tool({ kindName: 'fetch' }))).toBe('other')
    expect(verbGroupKind(tool({ kindName: 'search_tool' }))).toBe('other')
    expect(verbGroupKind(tool({ kindName: 'custom' }))).toBe('other')
    expect(labelKind(tool({ kindName: 'web_search' }))).toBe('other')
  })

  it('SKILL.md 读取与普通文件同桶（1.0.62：两个 skill 读 → "Explored 2 files"）', () => {
    expect(verbGroupKind(tool({ kindName: 'read', title: '/x/skills/deploy/SKILL.md' }))).toBe(
      'file',
    )
  })

  it('memory_v2_activity 不另开桶（真机仍按原桶计数）', () => {
    expect(
      verbGroupKind(
        tool({ kindName: 'read', raw: { _meta: { memory_v2_activity: true } } as never }),
      ),
    ).toBe('file')
  })

  it('execute/edit 只在分组档参与；er 档返回 null', () => {
    const scope = groupScopeForDensity('compact-all-grouped')
    expect(verbGroupKind(tool({ kindName: 'execute' }), scope)).toBe('command')
    expect(verbGroupKind(tool({ kindName: 'edit' }), scope)).toBe('edit')
    const loose = groupScopeForDensity('detailed')
    expect(verbGroupKind(tool({ kindName: 'execute' }), loose)).toBeNull()
    expect(verbGroupKind(tool({ kindName: 'edit' }), loose)).toBeNull()
  })

  it('subagent 行不参与分组（1.0.62 单独成行）', () => {
    expect(verbGroupKind({ id: 's', kind: 'subagent', title: 's', status: 'started' })).toBeNull()
  })
})

describe('runStep', () => {
  it('折叠的工具成员 → member；手动展开 → open（仍是成员，只是不隐藏）', () => {
    expect(runStep(tool({ kindName: 'read' }))).toEqual({ kind: 'member', vg: 'file' })
    expect(runStep(tool({ kindName: 'read', expanded: true }))).toEqual({ kind: 'open', vg: 'file' })
  })

  it('subagent / bg_task / workflow → break（各自成行）', () => {
    expect(runStep({ id: 's', kind: 'subagent', title: 's', status: 'started' })).toEqual({
      kind: 'break',
    })
    expect(
      runStep({ id: 'b', kind: 'bg_task', title: 't', command: 'x', status: 'running' } as never),
    ).toEqual({ kind: 'break' })
  })

  it('thought：showThinking 且折叠非流式 → thought；否则 transparent', () => {
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
  })
})

describe('scanGroups — 单条与多条的折叠门槛', () => {
  it('单条工具不折，保留自己的行（真机 lone tool call 规则）', () => {
    const entries = [toolWithInput('read', { target_file: '/w/a.py' })]
    expect(scanGroups(entries, new Set())).toHaveLength(0)
    const rows = projectDisplayRows(entries, [])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'entry' })
  })

  it('单条后面跟收口思考 → 仍不成组（组内只有 1 个成员）', () => {
    const entries = [toolWithInput('read', { target_file: '/w/a.py' }), thought()]
    expect(scanGroups(entries, new Set())).toHaveLength(0)
    expect(projectDisplayRows(entries, [])).toHaveLength(2)
  })

  it('单条后面只有流式思考 → 仍不折（思考透明）', () => {
    const entries = [toolWithInput('read', { target_file: '/w/a.py' }), thought({ streaming: true })]
    expect(scanGroups(entries, new Set())).toHaveLength(0)
  })

  it('两条连续工具 → 一段 verb 组', () => {
    const entries = reads(2)
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({
      range: { start: 0, end: 2 },
      kind: { type: 'verb', members: 2 },
      anchorId: entries[0].id,
    })
  })

  it('组内最后一个工具调用还在跑 → 它留在组外，跑完才入组', () => {
    const running = tool({ kindName: 'read', status: 'in_progress' })
    const entries = [tool({ kindName: 'read' }), tool({ kindName: 'read' }), running]
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(1)
    // 只有前两条折进组；正在跑的那条自己占一行
    expect(spans[0].range).toEqual({ start: 0, end: 2 })
    expect(spans[0].kind).toEqual({ type: 'verb', members: 2 })
    const rows = projectDisplayRows(entries, spans)
    expect(rows.map((row) => (row.type === 'entry' ? row.index : 'header'))).toEqual([
      'header',
      2,
    ])

    // 跑完（终态）→ 下一帧并入同一组
    const done = [
      tool({ kindName: 'read' }),
      tool({ kindName: 'read' }),
      tool({ kindName: 'read', status: 'completed' }),
    ]
    const after = scanGroups(done, new Set())
    expect(after).toHaveLength(1)
    expect(after[0].range).toEqual({ start: 0, end: 3 })
    expect(after[0].kind).toEqual({ type: 'verb', members: 3 })
  })

  it('组内靠前的位置有工具在跑 → 不影响后面的成员入组', () => {
    const entries = [
      tool({ kindName: 'read', status: 'in_progress' }),
      tool({ kindName: 'read', status: 'completed' }),
      tool({ kindName: 'read', status: 'completed' }),
    ]
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0].range).toEqual({ start: 0, end: 3 })
  })

  it('手动展开的成员留在 run 里：照常计数，自己保持可见', () => {
    const entries = [
      tool({ kindName: 'read' }),
      tool({ kindName: 'read', expanded: true }),
      tool({ kindName: 'read' }),
    ]
    const spans = scanGroups(entries, new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0].range).toEqual({ start: 0, end: 3 })
    expect(spans[0].kind).toEqual({ type: 'verb', members: 3 })
    // 折叠态：header + 展开的那条（其余两条随组隐藏）
    const rows = projectDisplayRows(entries, spans)
    expect(rows.map((row) => (row.type === 'entry' ? row.index : 'header'))).toEqual([
      'header',
      1,
    ])
    expect(verbGroupLabel(entries, spans[0]).text).toBe('Explored 3 files')
  })

  it('组内展开一条不会让组解散，也不会重排上下成员', () => {
    const base = [tool({ kindName: 'read' }), tool({ kindName: 'read' })]
    const folded = scanGroups(base, new Set())
    const withOpen = scanGroups(
      [base[0], { ...base[1], expanded: true } as ScrollEntry],
      new Set(),
    )
    // 组里 2 条、展开其中 1 条：组仍是同一段 [0,2)，不会因为成员数掉到 1 而消失
    expect(folded.map((s) => s.range)).toEqual([{ start: 0, end: 2 }])
    expect(withOpen.map((s) => s.range)).toEqual([{ start: 0, end: 2 }])
    // 展开的那条排在头后面，仍然可见
    const rows = projectDisplayRows(withOpen.length ? [base[0], { ...base[1], expanded: true } as ScrollEntry] : [], withOpen)
    expect(rows.map((row) => (row.type === 'entry' ? row.index : 'header'))).toEqual([
      'header',
      1,
    ])
  })

  it('非分组档：execute 单条不折，也不参与 run', () => {
    const entries = execs(3)
    const loose = groupScopeForDensity('compact-ungrouped')
    expect(scanGroups(entries, new Set(), { scope: loose })).toHaveLength(0)
  })

  it('分组档：execute 段成组（compact-grouped 起）', () => {
    const entries = execs(2)
    const scope = groupScopeForDensity('compact-grouped')
    const spans = scanGroups(entries, new Set(), { scope })
    expect(spans).toHaveLength(1)
    expect(spans[0].kind).toEqual({ type: 'verb', members: 2 })
  })

  it('edit 段：grouped 起成组；detailed 逐条显示', () => {
    const entries = [tool({ kindName: 'edit' }), tool({ kindName: 'edit' })]
    expect(scanGroups(entries, new Set(), { scope: groupScopeForDensity('compact-all-grouped') })).toHaveLength(1)
    expect(scanGroups(entries, new Set(), { scope: groupScopeForDensity('compact-grouped') })).toHaveLength(1)
    expect(scanGroups(entries, new Set(), { scope: groupScopeForDensity('detailed') })).toHaveLength(0)
  })

  it('grouped 档：编辑段与命令段各自成组，不并在一起', () => {
    const scope = groupScopeForDensity('compact-grouped')
    const entries = [
      toolWithInput('edit', { file_path: '/w/a.py' }),
      toolWithInput('edit', { file_path: '/w/b.py' }),
      toolWithInput('execute', { command: 'pytest -q', description: 'pytest -q' }),
      toolWithInput('execute', { command: 'git diff --stat', description: 'git diff --stat' }),
    ]
    const spans = scanGroups(entries, new Set(), { scope })
    expect(spans.map((s) => s.range)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ])
    // compact 档则合并成一段
    const all = scanGroups(entries, new Set(), {
      scope: groupScopeForDensity('compact-all-grouped'),
    })
    expect(all).toHaveLength(1)
    expect(all[0].range).toEqual({ start: 0, end: 4 })
  })

  it('grouped 档：单条编辑 / 单条命令各自单独显示，不成组', () => {
    const scope = groupScopeForDensity('compact-grouped')
    const entries = [
      toolWithInput('edit', { file_path: '/w/report.py' }),
      toolWithInput('execute', { command: 'pytest -q', description: 'pytest -q' }),
    ]
    expect(scanGroups(entries, new Set(), { scope })).toHaveLength(0)
  })

  it('探查类在所有档位都成组（官方预览：Explored 2 files, 1 search）', () => {
    const entries = [
      toolWithInput('read', { target_file: '/w/a.py' }),
      toolWithInput('read', { target_file: '/w/b.py' }),
      tool({ kindName: 'search' }),
    ]
    for (const d of [
      'detailed',
      'compact-shells',
      'compact-ungrouped',
      'compact-grouped',
      'compact-all-grouped',
    ]) {
      expect(scanGroups(entries, new Set(), { scope: groupScopeForDensity(d) })).toHaveLength(1)
    }
  })

  it('单条编辑在任何档位都不成组，单独显示', () => {
    const entries = [toolWithInput('edit', { file_path: '/w/report.py' })]
    for (const d of [
      'detailed',
      'compact-shells',
      'compact-ungrouped',
      'compact-grouped',
      'compact-all-grouped',
    ]) {
      expect(scanGroups(entries, new Set(), { scope: groupScopeForDensity(d) })).toHaveLength(0)
    }
    // 单条编辑的聚合头文案仍可构造（标签层与门槛无关）。
    const span = {
      range: { start: 0, end: 1 },
      kind: { type: 'verb' as const, members: 1 },
      expanded: false,
      anchorId: entries[0].id,
    }
    expect(verbGroupLabel(entries, span).text).toBe('Edited report.py')
  })

  it('compact 聚合头带段内编辑的 diffstat（+N/-M）', () => {
    const entries = [
      toolWithInput(
        'edit',
        { file_path: '/w/report.py' },
        {
          raw: {
            rawInput: { file_path: '/w/report.py' },
            rawOutput: {
              edits: {
                details: [{ old_string: 'a', new_string: 'b', line: 3 }],
              },
            },
          } as never,
        },
      ),
      toolWithInput('execute', { command: 'pytest -q', description: 'pytest -q' }),
    ]
    const scope = groupScopeForDensity('compact-all-grouped')
    const spans = scanGroups(entries, new Set(), { scope })
    const label = verbGroupLabel(entries, spans[0], true, scope)
    expect(label.text).toBe('Edited report.py, ran 1 command')
    expect(label.diffstat).toEqual({ insertions: 1, deletions: 1 })
  })

  it('段内没有编辑时不给 diffstat', () => {
    const entries = reads(2)
    const spans = scanGroups(entries, new Set())
    expect(verbGroupLabel(entries, spans[0]).diffstat).toBeUndefined()
  })

  it('groupToolVerbs=false 时不做分组', () => {
    expect(scanGroups(reads(3), new Set(), { groupToolVerbs: false })).toHaveLength(0)
  })

  it('手动展开的组（expandedGroups）反映到 span', () => {
    const entries = reads(2)
    const spans = scanGroups(entries, new Set([entries[0].id]))
    expect(spans[0].expanded).toBe(true)
  })
})

describe('scanGroups — 200 条上限', () => {
  it('恰好 200 条 → 一段', () => {
    const spans = scanGroups(execs(GROUP_MAX_MEMBERS), new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0].kind).toEqual({ type: 'verb', members: 200 })
  })

  it('201 条 → 200 折 + 最后一条自己成行', () => {
    const spans = scanGroups(execs(201), new Set())
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ range: { start: 0, end: 200 } })
  })

  it('300 条 → 两段（200 + 100）', () => {
    const spans = scanGroups(execs(300), new Set())
    expect(spans.map((s) => s.kind)).toEqual([
      { type: 'verb', members: 200 },
      { type: 'verb', members: 100 },
    ])
  })
})

describe('verbGroupLabel — 1.0.62 词表', () => {
  // 标签是「给定一段 range」的纯函数，与折组门槛无关：直接构造 span，
  // 才能覆盖单成员命名（`Explored a.py`）。门槛另有 scanGroups 用例。
  const label = (entries: ScrollEntry[], scope = groupScopeForDensity('compact-all-grouped')) => {
    const span = {
      range: { start: 0, end: entries.length },
      kind: { type: 'verb' as const, members: entries.length },
      expanded: false,
      anchorId: entries[0].id,
    }
    return verbGroupLabel(entries, span, true, scope)
  }

  it('单值命名：文件 / 目录 / 命令用成员自己的名字', () => {
    expect(label(reads(2)).text).toBe('Explored 2 files')
    expect(
      label([
        toolWithInput('read', { target_file: '/w/a.py' }),
        toolWithInput('read', { target_file: '/w/b.py' }),
      ]).text,
    ).toBe('Explored 2 files')
    expect(
      label([toolWithInput('read', { target_file: '/w/a.py' }), thought()]).text,
    ).toBe('Explored a.py')
    expect(
      label([
        toolWithInput('list_dir', { target_directory: '/w/work' }),
        toolWithInput('list_dir', { target_directory: '/w/work/sub' }),
      ]).text,
    ).toBe('Explored 2 directories')
    expect(
      label([
        toolWithInput('list_dir', { target_directory: '/w/work' }),
        toolWithInput('read', { target_file: '/w/a.py' }),
      ]).text,
    ).toBe('Explored work, 1 file')
    expect(
      label([
        toolWithInput('execute', { command: 'ls -la', description: 'ls -la' }),
        toolWithInput('execute', { command: 'pwd', description: 'pwd' }),
      ]).text,
    ).toBe('Ran 2 commands')
  })

  it('搜索与"其他工具"永远用数字（无单值命名）', () => {
    expect(label([tool({ kindName: 'search' }), thought()]).text).toBe('Explored 1 search')
    expect(
      label([tool({ kindName: 'web_search' }), tool({ kindName: 'web_fetch' })]).text,
    ).toBe('Called 2 tools')
  })

  it('固定桶序：edits → directories → files → searches → tools → commands', () => {
    const scope = groupScopeForDensity('compact-all-grouped')
    const entries = [
      toolWithInput('execute', { command: 'ls', description: 'ls' }),
      toolWithInput('search_tool', { query: 'q' }),
      tool({ kindName: 'grep', title: 'TODO' }),
      toolWithInput('read', { target_file: '/w/b.py' }),
      toolWithInput('list_dir', { target_directory: '/w/work' }),
      toolWithInput('edit', { file_path: '/w/a.py' }),
    ]
    expect(label(entries, scope).text).toBe(
      'Edited a.py, explored 1 directory, 1 file, 1 search, called 1 tool, ran 1 command',
    )
    // 顺序与出现顺序无关
    expect(label([...entries].reverse(), scope).text).toBe(
      'Edited a.py, explored 1 directory, 1 file, 1 search, called 1 tool, ran 1 command',
    )
  })

  it('只有第一个短语首字母大写，其余小写', () => {
    expect(label(reads(2)).text).toBe('Explored 2 files')
    const entries = [
      toolWithInput('read', { target_file: '/w/a.py' }),
      toolWithInput('execute', { command: 'ls', description: 'ls' }),
    ]
    expect(label(entries).text).toBe('Explored a.py, ran 1 command')
  })

  it('运行中不改时态（1.0.62 聚合头恒过去式）', () => {
    const running = [
      toolWithInput('read', { target_file: '/w/a.py' }, { status: 'in_progress' }),
      thought(),
    ]
    const l = label(running)
    expect(l.text).toBe('Explored a.py')
    expect(l.running).toBe(true)
  })

  it('失败不追加 "· N failed"（1.0.62 聚合头无失败后缀）', () => {
    const entries = [
      toolWithInput('read', { target_file: '/w/a.py' }, { status: 'failed' }),
      thought(),
    ]
    expect(label(entries).text).toBe('Explored a.py')
  })

  it('edit 单值用文件名（路径末段）', () => {
    const scope = groupScopeForDensity('compact-all-grouped')
    const entries = [
      toolWithInput('edit', { file_path: '/w/pkg/a.py' }),
      toolWithInput('edit', { file_path: '/w/pkg/b.py' }),
    ]
    expect(label(entries, scope).text).toBe('Edited 2 files')
    expect(label([entries[0], thought()], scope).text).toBe('Edited a.py')
  })
})

describe('projectDisplayRows', () => {
  it('折叠 verb 组 → 只剩 header 行', () => {
    const entries = [...reads(2), user()]
    const spans = scanGroups(entries, new Set())
    const rows = projectDisplayRows(entries, spans)
    expect(rows).toHaveLength(2)
    if (rows[0].type !== 'group_header') throw new Error('expected group header')
    expect(rows[0]).toMatchObject({ id: `gh_${entries[0].id}` })
    expect(rows[0].label.text).toBe('Explored 2 files')
    expect(rows[1]).toMatchObject({ type: 'entry', index: 2 })
  })

  it('展开 verb 组 → header + 全部成员', () => {
    const entries = reads(2)
    const spans = scanGroups(entries, new Set([entries[0].id]))
    const rows = projectDisplayRows(entries, spans)
    expect(rows).toHaveLength(3)
    expect(rows[0].type).toBe('group_header')
    expect(rows.slice(1).map((r) => r.type)).toEqual(['entry', 'entry'])
  })

  it('收口思考随组隐藏，流式思考保持可见', () => {
    const entries = [...reads(2), thought({ text: 'sealed' }), thought({ text: 'live', streaming: true })]
    const spans = scanGroups(entries, new Set())
    const rows = projectDisplayRows(entries, spans)
    expect(rows.map((r) => (r.type === 'entry' ? r.entry.id : 'header'))).toEqual([
      'header',
      entries[3].id,
    ])
  })

  it('headerCache 命中时复用同一 header 行对象', () => {
    const entries = reads(2)
    const spans = scanGroups(entries, new Set())
    const cache = new Map()
    const rows1 = projectDisplayRows(entries, spans, true, cache)
    const rows2 = projectDisplayRows(entries, spans, true, cache)
    expect(rows1[0]).toBe(rows2[0])
  })
})

describe('groupScopeForDensity', () => {
  it('探查类全档参与；编辑 / 命令 grouped 起参与，且 grouped 分族成组', () => {
    const exploreOnly = {
      explore: true,
      edits: false,
      commands: false,
      separateFamilies: false,
    }
    expect(groupScopeForDensity('detailed')).toEqual(exploreOnly)
    expect(groupScopeForDensity('compact-shells')).toEqual(exploreOnly)
    expect(groupScopeForDensity('compact-ungrouped')).toEqual(exploreOnly)
    expect(groupScopeForDensity('compact-grouped')).toEqual({
      explore: true,
      edits: true,
      commands: true,
      separateFamilies: true,
    })
    expect(groupScopeForDensity('compact-all-grouped')).toEqual({
      explore: true,
      edits: true,
      commands: true,
      separateFamilies: false,
    })
    // 未知值按默认档处理
    expect(groupScopeForDensity('nope')).toEqual(
      groupScopeForDensity('compact-all-grouped'),
    )
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
    expect(groupingSignature([tool({})])).not.toBe(groupingSignature([]))
  })

  it('thought 的 displayMode/streaming/空文本进入签名', () => {
    expect(groupingSignature([thought()])).not.toBe(
      groupingSignature([thought({ displayMode: 'expanded' })]),
    )
    expect(groupingSignature([thought()])).not.toBe(groupingSignature([thought({ text: '' })]))
  })

  it('kindName 变化进入签名（tool_call_update 后到的分类要重扫分组）', () => {
    expect(groupingSignature([tool({ id: 'same1', kindName: 'other' })])).not.toBe(
      groupingSignature([tool({ id: 'same1', kindName: 'read' })]),
    )
    expect(groupingSignature([tool({ id: 's', status: 'completed', kindName: 'read' })])).not.toBe(
      groupingSignature([tool({ id: 's', status: 'completedX', kindName: '' })]),
    )
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
    const g = {
      id: 'gh_x',
      type: 'group_header' as const,
      span: {} as never,
      label: {} as never,
      family: 'verb' as const,
    }
    expect(displayRowKey(g)).toBe('gh_x')
    expect(isDensePackableRow(g)).toBe(true)
  })
})
