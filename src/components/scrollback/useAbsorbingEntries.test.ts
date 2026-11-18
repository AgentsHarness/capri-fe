import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import { usePins } from '../../store/historyPins'
import { projectDisplayRows, scanGroups } from '../../scrollback/verbGroup'
import { useAbsorbingEntries } from './useAbsorbingEntries'

const COLLAPSED_GROUPS = new Set<string>()
const EXPANDED_GROUPS = new Set<string>(['t1'])
const PREVIEW_TOOLS = new Set(['t1', 't2'])

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

function thought(id: string, streaming: boolean): ScrollEntry {
  return {
    id,
    kind: 'thought',
    text: 'hmm',
    displayMode: streaming ? 'expanded' : 'collapsed',
    streaming,
  } as ScrollEntry
}

function useTimeline(
  entries: ScrollEntry[],
  expanded: ReadonlySet<string>,
  previewIds: ReadonlySet<string> = new Set(),
) {
  const spans = scanGroups(entries, expanded)
  const rows = projectDisplayRows(entries, spans)
  return useAbsorbingEntries(entries, rows, spans, 'e1', previewIds)
}

afterEach(() => {
  vi.useRealTimers()
  const prev = usePins.getState().fePrefs
  if (prev.uiMotion === false) {
    usePins.setState({ fePrefs: { ...prev, uiMotion: true } })
  }
})

describe('useAbsorbingEntries', () => {
  it('思考收口进组：生成流式快照，动画窗口结束自动移除', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({
        entries,
        expanded,
      }: {
        entries: ScrollEntry[]
        expanded: ReadonlySet<string>
      }) => useTimeline(entries, expanded),
      {
        initialProps: {
          entries: [tool('t1'), tool('t2'), thought('th', true)],
          expanded: COLLAPSED_GROUPS,
        },
      },
    )
    expect(result.current).toEqual([])

    rerender({
      entries: [tool('t1'), tool('t2'), thought('th', false)],
      expanded: COLLAPSED_GROUPS,
    })
    expect(result.current).toHaveLength(1)
    expect(result.current[0]).toMatchObject({
      entry: { id: 'th' },
      afterKey: 'gh_t1',
      patch: { streaming: true },
      waitForFade: true,
    })

    act(() => vi.advanceTimersByTime(1900))
    expect(result.current).toEqual([])
  })

  it('两个工具并入新组：各生成一条展开预览快照，朝下收', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({
        entries,
        expanded,
      }: {
        entries: ScrollEntry[]
        expanded: ReadonlySet<string>
      }) => useTimeline(entries, expanded, PREVIEW_TOOLS),
      {
        initialProps: {
          entries: [tool('t1'), runningTool('t2')],
          expanded: COLLAPSED_GROUPS,
        },
      },
    )

    rerender({
      entries: [tool('t1'), tool('t2')],
      expanded: COLLAPSED_GROUPS,
    })
    expect(result.current).toHaveLength(2)
    expect(result.current.map((g) => g.entry.id)).toEqual(['t1', 't2'])
    for (const g of result.current) {
      expect(g).toMatchObject({
        afterKey: null,
        patch: { displayMode: 'truncated', expanded: true },
        waitForFade: false,
      })
    }
  })

  it('低密度档关闭默认展开：退出行按原折叠态收', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ entries }: { entries: ScrollEntry[] }) => {
        const spans = scanGroups(entries, COLLAPSED_GROUPS)
        const rows = projectDisplayRows(entries, spans)
        return useAbsorbingEntries(
          entries,
          rows,
          spans,
          'e1',
          new Set(),
        )
      },
      {
        initialProps: {
          entries: [tool('t1'), runningTool('t2')],
        },
      },
    )

    rerender({ entries: [tool('t1'), tool('t2')] })
    expect(result.current).toHaveLength(2)
    for (const g of result.current) expect(g.patch).toBeUndefined()
  })

  it('从未进入预览的工具：退出行按折叠态收，不闪正文', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ entries }: { entries: ScrollEntry[] }) =>
        useTimeline(entries, COLLAPSED_GROUPS),
      { initialProps: { entries: [tool('t1'), runningTool('t2')] } },
    )

    rerender({ entries: [tool('t1'), tool('t2')] })
    expect(result.current).toHaveLength(2)
    for (const g of result.current) expect(g.patch).toBeUndefined()
  })

  it('重新可见（展开分组）时立即摘掉退出行', () => {
    vi.useFakeTimers()
    const entries = [tool('t1'), tool('t2'), thought('th', false)]
    const { result, rerender } = renderHook(
      ({
        entries,
        expanded,
      }: {
        entries: ScrollEntry[]
        expanded: ReadonlySet<string>
      }) => useTimeline(entries, expanded),
      {
        initialProps: {
          entries: [tool('t1'), tool('t2'), thought('th', true)],
          expanded: COLLAPSED_GROUPS,
        },
      },
    )
    rerender({
      entries,
      expanded: COLLAPSED_GROUPS,
    })
    expect(result.current).toHaveLength(1)

    rerender({ entries, expanded: EXPANDED_GROUPS })
    expect(result.current).toEqual([])
  })

  it('手动收起分组：成员生成退出行，兜底窗口后清理', () => {
    vi.useFakeTimers()
    const entries = [tool('t1'), tool('t2'), thought('th', false)]
    const { result, rerender } = renderHook(
      ({
        expanded,
      }: {
        expanded: ReadonlySet<string>
      }) => {
        const spans = scanGroups(entries, expanded)
        const rows = projectDisplayRows(entries, spans)
        return useAbsorbingEntries(entries, rows, spans, 'e1')
      },
      { initialProps: { expanded: EXPANDED_GROUPS } },
    )
    expect(result.current).toEqual([])

    rerender({ expanded: COLLAPSED_GROUPS })
    expect(result.current.map((g) => g.entry.id)).toEqual(['t1', 't2', 'th'])
    for (const g of result.current) expect(g.afterKey).toBe('gh_t1')

    act(() => vi.advanceTimersByTime(1900))
    expect(result.current).toEqual([])
  })

  it('关闭展开/弹窗动画时不生成退出行', () => {
    const prev = usePins.getState().fePrefs
    usePins.setState({ fePrefs: { ...prev, uiMotion: false } })
    const { result, rerender } = renderHook(
      ({
        entries,
      }: {
        entries: ScrollEntry[]
      }) => useTimeline(entries, COLLAPSED_GROUPS),
      { initialProps: { entries: [tool('t1'), tool('t2'), thought('th', true)] } },
    )

    rerender({ entries: [tool('t1'), tool('t2'), thought('th', false)] })
    expect(result.current).toEqual([])
  })
})
