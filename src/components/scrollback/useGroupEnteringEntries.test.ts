import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import { usePins } from '../../store/historyPins'
import { projectDisplayRows, scanGroups } from '../../scrollback/verbGroup'
import { useGroupEnteringEntries } from './useGroupEnteringEntries'

const COLLAPSED = new Set<string>()
const EXPANDED = new Set<string>(['t1'])

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

function useTimeline(
  entries: ScrollEntry[],
  expanded: ReadonlySet<string>,
): ReadonlySet<string> {
  const spans = scanGroups(entries, expanded)
  const rows = projectDisplayRows(entries, spans)
  return useGroupEnteringEntries(entries, rows, spans, expanded)
}

afterEach(() => {
  vi.useRealTimers()
  const prev = usePins.getState().fePrefs
  if (prev.uiMotion === false) {
    usePins.setState({ fePrefs: { ...prev, uiMotion: true } })
  }
})

describe('useGroupEnteringEntries', () => {
  it('展开分组：新露出的成员带入场动画，240ms 后摘掉', () => {
    vi.useFakeTimers()
    const entries = [tool('t1'), tool('t2'), tool('t3')]
    const { result, rerender } = renderHook(
      ({ expanded }: { expanded: ReadonlySet<string> }) =>
        useTimeline(entries, expanded),
      { initialProps: { expanded: COLLAPSED } },
    )
    expect(result.current.size).toBe(0)

    rerender({ expanded: EXPANDED })
    expect([...result.current]).toEqual(['t1', 't2', 't3'])

    act(() => vi.advanceTimersByTime(260))
    expect(result.current.size).toBe(0)
  })

  it('收起分组不产生入场行；再次展开重新播', () => {
    vi.useFakeTimers()
    const entries = [tool('t1'), tool('t2')]
    const { result, rerender } = renderHook(
      ({ expanded }: { expanded: ReadonlySet<string> }) =>
        useTimeline(entries, expanded),
      { initialProps: { expanded: COLLAPSED } },
    )

    rerender({ expanded: EXPANDED })
    expect([...result.current]).toEqual(['t1', 't2'])

    rerender({ expanded: COLLAPSED })
    expect(result.current.size).toBe(0)

    rerender({ expanded: EXPANDED })
    expect([...result.current]).toEqual(['t1', 't2'])
  })

  it('收起态已可见的展开成员不重播', () => {
    vi.useFakeTimers()
    const entries = [
      tool('t1'),
      tool('t2', { displayMode: 'expanded', expanded: true }),
      tool('t3'),
    ]
    const { result, rerender } = renderHook(
      ({ expanded }: { expanded: ReadonlySet<string> }) =>
        useTimeline(entries, expanded),
      { initialProps: { expanded: COLLAPSED } },
    )

    rerender({ expanded: EXPANDED })
    expect([...result.current]).toEqual(['t1', 't3'])
  })

  it('关闭「展开/弹窗动画」时不播', () => {
    const prev = usePins.getState().fePrefs
    usePins.setState({ fePrefs: { ...prev, uiMotion: false } })
    const entries = [tool('t1'), tool('t2')]
    const { result, rerender } = renderHook(
      ({ expanded }: { expanded: ReadonlySet<string> }) =>
        useTimeline(entries, expanded),
      { initialProps: { expanded: COLLAPSED } },
    )

    rerender({ expanded: EXPANDED })
    expect(result.current.size).toBe(0)
  })
})
