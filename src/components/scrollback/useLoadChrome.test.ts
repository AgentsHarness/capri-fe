import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SPINNER_FRAMES } from '../../theme/glyphs'
import { useLoadChrome } from './useLoadChrome'

afterEach(() => {
  vi.useRealTimers()
})

const hook = (o: {
  historyLoading?: boolean
  historyLoadingMore?: boolean
  historyLoadError?: string | null
  historyLoadedAt?: number | null
  entryCount?: number
}) =>
  renderHook(() =>
    useLoadChrome(
      o.historyLoading ?? false,
      o.historyLoadingMore ?? false,
      o.historyLoadError ?? null,
      o.historyLoadedAt ?? null,
      o.entryCount ?? 0,
    ),
  )

describe('useLoadChrome', () => {
  it('加载中 + 空列表 → loadingVisible；有内容 → 不显示覆盖层', () => {
    const h1 = hook({ historyLoading: true, entryCount: 0 })
    expect(h1.result.current.loadingVisible).toBe(true)
    expect(h1.result.current.loadFailedVisible).toBe(false)
    const h2 = hook({ historyLoading: true, entryCount: 3 })
    expect(h2.result.current.loadingVisible).toBe(false)
  })

  it('加载失败（空列表）→ loadFailedVisible', () => {
    const h = hook({ historyLoading: false, historyLoadError: 'boom', entryCount: 0 })
    expect(h.result.current.loadFailedVisible).toBe(true)
    expect(h.result.current.loadingVisible).toBe(false)
    // 有内容时不覆盖内容
    const h2 = hook({ historyLoading: false, historyLoadError: 'boom', entryCount: 2 })
    expect(h2.result.current.loadFailedVisible).toBe(false)
  })

  it('spinner：加载中 / 加载更多时按 SPINNER_INTERVAL_MS 转帧；停止后停住', () => {
    vi.useFakeTimers()
    const h = hook({ historyLoading: true, entryCount: 0 })
    expect(h.result.current.spinnerFrame).toBe(0)
    act(() => vi.advanceTimersByTime(133 * 3))
    expect(h.result.current.spinnerFrame).toBe(3)
    act(() => vi.advanceTimersByTime(133 * (SPINNER_FRAMES.length + 2)))
    expect(h.result.current.spinnerFrame).toBe(
      (3 + (SPINNER_FRAMES.length + 2)) % SPINNER_FRAMES.length,
    )
    // 停止加载 → 定时器清理，帧不再走
    const stopped = hook({ historyLoading: false, entryCount: 0 })
    const frame = stopped.result.current.spinnerFrame
    act(() => vi.advanceTimersByTime(133 * 3))
    expect(stopped.result.current.spinnerFrame).toBe(frame)
  })

  it('historyLoadedAt 变化 → contentVisible 先 false 再经 rAF 恢复 true', () => {
    vi.useFakeTimers()
    const h = hook({ historyLoading: false, historyLoadedAt: null })
    expect(h.result.current.contentVisible).toBe(true)
    // 换一个 historyLoadedAt 值触发 layout effect
    const h2 = hook({ historyLoading: false, historyLoadedAt: 100 })
    expect(h2.result.current.contentVisible).toBe(false)
    act(() => vi.advanceTimersByTime(20))
    expect(h2.result.current.contentVisible).toBe(true)
  })

  it('historyLoadingMore 单独激活 spinner（列表非空时）', () => {
    vi.useFakeTimers()
    const h = hook({ historyLoadingMore: true, entryCount: 5 })
    expect(h.result.current.spinnerFrame).toBe(0)
    act(() => vi.advanceTimersByTime(133))
    expect(h.result.current.spinnerFrame).toBe(1)
  })
})