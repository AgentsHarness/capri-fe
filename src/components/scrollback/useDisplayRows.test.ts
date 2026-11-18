import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import { GROUP_HOLD_DEFAULT_MS } from '../../scrollback/groupHold'
import { applyUiSettings } from '../../store/settings'
import { useDisplayRows } from './useDisplayRows'

const EMPTY = new Set<string>()

function tool(
  id: string,
  finishedAt?: number,
  over: Partial<Extract<ScrollEntry, { kind: 'tool' }>> = {},
): ScrollEntry {
  return {
    id,
    kind: 'tool',
    title: 'Read a.py',
    kindName: 'read',
    status: 'completed',
    expanded: false,
    ...(finishedAt != null ? { finishedAt } : {}),
    ...over,
  } as ScrollEntry
}

function edit(id: string, finishedAt?: number, expanded = true): ScrollEntry {
  return tool(id, finishedAt, { title: 'Edit a.py', kindName: 'edit', expanded })
}

function command(id: string, finishedAt?: number, expanded = true): ScrollEntry {
  return tool(id, finishedAt, {
    title: 'Run npm test',
    kindName: 'execute',
    expanded,
  })
}

const rowIds = (rows: ReturnType<typeof useDisplayRows>['rows']) =>
  rows.map((r) => (r.type === 'entry' ? r.entry.id : r.id))

const ids = (set: ReadonlySet<string>) => [...set].sort()

beforeEach(() => {
  applyUiSettings({ tool_call_density: 'compact-all-grouped' })
})

afterEach(() => {
  vi.useRealTimers()
  applyUiSettings({ tool_call_density: 'compact-all-grouped' })
})

describe('useDisplayRows — 新块预览停留', () => {
  it('刚结束的组内工具预览 1s，到期后才消失', () => {
    vi.useFakeTimers()
    const now = Date.now()
    const entries = [tool('t1', now - 5000), tool('t2', now - 100)]
    const { result } = renderHook(() =>
      useDisplayRows(entries, EMPTY, GROUP_HOLD_DEFAULT_MS),
    )

    expect(result.current.previewEnabled).toBe(true)
    expect(ids(result.current.previewIds)).toEqual(['t2'])
    expect(rowIds(result.current.rows)).toEqual(['gh_t1', 't2'])
    // 聚合头仍按完整成员数（含预览停留中的 t2）显示。
    const header = result.current.rows.find((r) => r.type === 'group_header')
    expect(header?.type === 'group_header' && header.span.kind.members).toBe(2)

    act(() => vi.advanceTimersByTime(GROUP_HOLD_DEFAULT_MS + 100))
    expect(result.current.previewIds.size).toBe(0)
    expect(rowIds(result.current.rows)).toEqual(['gh_t1'])
  })

  it('detailed：探查类仍成组并预览，编辑/命令默认展开不预览', () => {
    vi.useFakeTimers()
    applyUiSettings({ tool_call_density: 'detailed' })
    const now = Date.now()
    const entries = [
      tool('t1', now - 5000),
      tool('t2', now - 100),
      edit('e1', now - 100),
      command('c1', now - 100),
    ]
    const { result } = renderHook(() =>
      useDisplayRows(entries, EMPTY, GROUP_HOLD_DEFAULT_MS),
    )

    expect(result.current.scope).toMatchObject({
      explore: true,
      edits: false,
      commands: false,
    })
    expect(result.current.previewEnabled).toBe(true)
    expect(ids(result.current.previewIds)).toEqual(['t2'])
    expect(rowIds(result.current.rows)).toEqual(['gh_t1', 't2', 'e1', 'c1'])
  })

  it('diff focus：探查类与命令都按停留窗口预览；默认展开的编辑不预览', () => {
    vi.useFakeTimers()
    applyUiSettings({ tool_call_density: 'compact-shells' })
    const now = Date.now()
    const entries = [
      tool('t1', now - 5000),
      tool('t2', now - 100),
      edit('e1', now - 100),
      command('c1', now - 100, false),
    ]
    const { result } = renderHook(() =>
      useDisplayRows(entries, EMPTY, GROUP_HOLD_DEFAULT_MS),
    )

    expect(ids(result.current.previewIds)).toEqual(['c1', 't2'])
    expect(rowIds(result.current.rows)).toEqual(['gh_t1', 't2', 'e1', 'c1'])
  })

  it('balanced：编辑与命令不入组，同样按停留窗口预览后收回', () => {
    vi.useFakeTimers()
    applyUiSettings({ tool_call_density: 'compact-ungrouped' })
    const now = Date.now()
    const entries = [
      tool('t1', now - 5000),
      tool('t2', now - 100),
      edit('e1', now - 100, false),
      command('c1', now - 100, false),
    ]
    const { result } = renderHook(() =>
      useDisplayRows(entries, EMPTY, GROUP_HOLD_DEFAULT_MS),
    )

    expect(ids(result.current.previewIds)).toEqual(['c1', 'e1', 't2'])
    expect(rowIds(result.current.rows)).toEqual(['gh_t1', 't2', 'e1', 'c1'])

    act(() => vi.advanceTimersByTime(GROUP_HOLD_DEFAULT_MS + 100))
    expect(result.current.previewIds.size).toBe(0)
    expect(rowIds(result.current.rows)).toEqual(['gh_t1', 'e1', 'c1'])
  })

  it('grouped：预览只看块自身的时间窗，不跨工具族把旧块拉进来', () => {
    vi.useFakeTimers()
    applyUiSettings({ tool_call_density: 'compact-grouped' })
    const now = Date.now()
    const entries = [
      tool('r1', now - 5000),
      edit('e1', now - 100, false),
      edit('e2', now - 100, false),
    ]
    const { result } = renderHook(() =>
      useDisplayRows(entries, EMPTY, GROUP_HOLD_DEFAULT_MS),
    )

    expect(ids(result.current.previewIds)).toEqual(['e1', 'e2'])
    expect(rowIds(result.current.rows)).toEqual(['r1', 'gh_e1', 'e1', 'e2'])
  })

  it('停留为 0：全部关闭预览，组成员立即隐藏', () => {
    vi.useFakeTimers()
    const now = Date.now()
    const entries = [tool('t1', now - 5000), tool('t2', now - 100)]
    const { result } = renderHook(() => useDisplayRows(entries, EMPTY, 0))

    expect(result.current.previewEnabled).toBe(false)
    expect(result.current.previewIds.size).toBe(0)
    expect(rowIds(result.current.rows)).toEqual(['gh_t1'])
  })

  it('手动收起分组：已有成员立刻隐藏，不被预览停留弹回来', () => {
    const now = Date.now()
    const entries = [tool('t1', now - 100), tool('t2', now - 100)]
    const { result, rerender } = renderHook(
      ({ expanded }: { expanded: ReadonlySet<string> }) =>
        useDisplayRows(entries, expanded, GROUP_HOLD_DEFAULT_MS),
      { initialProps: { expanded: new Set<string>(['t1']) } },
    )
    expect(rowIds(result.current.rows)).toEqual(['gh_t1', 't1', 't2'])

    rerender({ expanded: EMPTY })
    expect(result.current.previewIds.size).toBe(0)
    expect(rowIds(result.current.rows)).toEqual(['gh_t1'])
  })

  it('迷你视图的局部折叠：命中 suppressPreviewIds 的块不预览', () => {
    vi.useFakeTimers()
    const now = Date.now()
    const entries = [tool('t1', now - 100), tool('t2', now - 100)]
    const { result } = renderHook(() =>
      useDisplayRows(entries, EMPTY, GROUP_HOLD_DEFAULT_MS, new Set(['t1'])),
    )

    expect(ids(result.current.previewIds)).toEqual(['t2'])
    expect(rowIds(result.current.rows)).toEqual(['gh_t1', 't2'])
  })
})
