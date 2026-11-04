import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import { useEnteringEntries } from './useEnteringEntries'

const a = (id: string): ScrollEntry => ({ id, kind: 'assistant', text: '' })

const opts = {
  enabled: true,
  historyLoadedAt: 100,
  historyLoading: false,
  historyLoadingMore: false,
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useEnteringEntries', () => {
  it('首帧不播；后续 append 播一次，动画结束后摘掉', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ entries }: { entries: ScrollEntry[] }) => useEnteringEntries(entries, opts),
      { initialProps: { entries: [a('a1')] } },
    )
    expect(result.current.size).toBe(0)

    rerender({ entries: [a('a1'), a('a2')] })
    expect([...result.current]).toEqual(['a2'])

    act(() => vi.advanceTimersByTime(300))
    expect(result.current.size).toBe(0)
  })

  it('关闭开关时不播', () => {
    const { result, rerender } = renderHook(
      ({ entries, enabled }: { entries: ScrollEntry[]; enabled: boolean }) =>
        useEnteringEntries(entries, { ...opts, enabled }),
      { initialProps: { entries: [a('a1')], enabled: false } },
    )
    rerender({ entries: [a('a1'), a('a2')], enabled: false })
    expect(result.current.size).toBe(0)
  })

  it('历史批次变化时不把整批新条目当实时块', () => {
    const { result, rerender } = renderHook(
      ({
        entries,
        historyLoadedAt,
      }: {
        entries: ScrollEntry[]
        historyLoadedAt: number
      }) => useEnteringEntries(entries, { ...opts, historyLoadedAt }),
      { initialProps: { entries: [a('a1')], historyLoadedAt: 100 } },
    )
    rerender({ entries: [a('a1'), a('a2')], historyLoadedAt: 200 })
    expect(result.current.size).toBe(0)
  })
})
