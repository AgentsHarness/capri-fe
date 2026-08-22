import { describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { SPINNER_FRAMES } from '../theme/glyphs'
import { stateLabel, useSessionSpinner } from './sessionState'

describe('stateLabel', () => {
  it('各分组键的中文标签', () => {
    expect(stateLabel('active')).toBe('处理中 (active)')
    expect(stateLabel('bg')).toBe('后台任务运行中 (bg)')
    expect(stateLabel('awaiting')).toBe('待处理 (未读)')
    expect(stateLabel('idle')).toBe('空闲 (idle)')
  })
})

describe('useSessionSpinner', () => {
  it('无 active → 恒 0', () => {
    const { result } = renderHook(() => useSessionSpinner(false))
    expect(result.current).toBe(0)
  })

  it('active → 按 SPINNER_INTERVAL_MS 轮转帧', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useSessionSpinner(true))
    expect(result.current).toBe(0)

    act(() => {
      vi.advanceTimersByTime(SPINNER_FRAMES.length * 133)
    })
    expect(result.current).toBe(0) // 回到第 0 帧

    act(() => {
      vi.advanceTimersByTime(133)
    })
    expect(result.current).toBe(1)
    vi.useRealTimers()
  })

  it('active → false 时停止轮转（interval 清理）', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ on }) => useSessionSpinner(on), {
      initialProps: { on: true },
    })
    act(() => {
      vi.advanceTimersByTime(133)
    })
    expect(result.current).toBe(1)

    rerender({ on: false })
    act(() => {
      vi.advanceTimersByTime(SPINNER_FRAMES.length * 133)
    })
    // 停止后帧号不再变化
    expect(result.current).toBe(1)
    vi.useRealTimers()
  })

  it('卸载时清理 interval', () => {
    vi.useFakeTimers()
    const { unmount } = renderHook(() => useSessionSpinner(true))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})