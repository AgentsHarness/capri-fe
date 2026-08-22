import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import { FINISH_FLASH_MS } from '../../theme/wave'
import { useFinishFlash } from './useFinishFlash'

afterEach(() => {
  vi.useRealTimers()
})

const tool = (id: string, finishedAt?: number): ScrollEntry => ({
  id,
  kind: 'tool',
  title: 'read',
  verb: 'read',
  status: 'completed',
  expanded: false,
  finishedAt,
})

describe('useFinishFlash', () => {
  it('无任何条目 / 无 flash 窗口 → now 恒定', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const { result } = renderHook(() => useFinishFlash([]))
    const before = result.current
    act(() => vi.advanceTimersByTime(5000))
    expect(result.current).toBe(before)

    const stale = renderHook(() =>
      useFinishFlash([tool('t1', 10_000 - FINISH_FLASH_MS - 100)]),
    )
    const before2 = stale.result.current
    act(() => vi.advanceTimersByTime(1000))
    expect(stale.result.current).toBe(before2)
  })

  it('窗口内 finishedAt → 最早到期时 now 前跳一次', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const entries = [tool('t1', 10_000 - 100), tool('t2', 10_000 - 200)]
    const { result } = renderHook(() => useFinishFlash(entries))
    expect(result.current).toBe(10_000)
    // t2 先到期：10000 - 200 + 400 = 10200 → +1ms 容差
    act(() => vi.advanceTimersByTime(202))
    expect(result.current).toBeGreaterThan(10_000)
    // 到期后不再更新
    const after = result.current
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current).toBe(after)
  })

  it('非 tool/thought 的 finishedAt 不触发', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const assistant = {
      id: 'a1',
      kind: 'assistant' as const,
      text: 'x',
      finishedAt: 10_000 - 50,
    }
    const { result } = renderHook(() => useFinishFlash([assistant]))
    const before = result.current
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current).toBe(before)
  })
})