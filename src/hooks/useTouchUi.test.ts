import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { isTouchUi, useTouchUi } from './useTouchUi'

describe('useTouchUi', () => {
  const originalMatchMedia = window.matchMedia

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it('返回桌面端非触控模式（pointer: coarse 不匹配）', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))

    expect(isTouchUi()).toBe(false)
    const { result } = renderHook(() => useTouchUi())
    expect(result.current).toBe(false)
  })

  it('返回触控模式（pointer: coarse 匹配）并在媒体查询变更时更新', () => {
    let listener: (() => void) | undefined
    const mq = {
      matches: true,
      media: '(hover: none), (pointer: coarse)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((event, cb) => {
        if (event === 'change') listener = cb
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }
    window.matchMedia = vi.fn().mockReturnValue(mq)

    expect(isTouchUi()).toBe(true)
    const { result } = renderHook(() => useTouchUi())
    expect(result.current).toBe(true)

    // 模拟媒体查询结果变更
    mq.matches = false
    act(() => {
      listener?.()
    })
    expect(result.current).toBe(false)
  })
})
