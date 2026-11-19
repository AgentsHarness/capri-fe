import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useMinWidth } from './useMinWidth'

function mediaQuery(matches: boolean) {
  let listener: (() => void) | undefined
  const mq = {
    matches,
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((event: string, cb: () => void) => {
      if (event === 'change') listener = cb
    }),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }
  return {
    mq,
    fire(next: boolean) {
      mq.matches = next
      listener?.()
    },
  }
}

describe('useMinWidth', () => {
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it('按当前媒体查询结果初始化', () => {
    window.matchMedia = vi.fn(() => mediaQuery(true).mq)
    const { result } = renderHook(() => useMinWidth(1024))
    expect(result.current).toBe(true)
  })

  it('媒体查询变更时更新，且变化前后都能区分', () => {
    const { mq, fire } = mediaQuery(false)
    window.matchMedia = vi.fn(() => mq)
    const { result } = renderHook(() => useMinWidth(1024))
    expect(result.current).toBe(false)

    act(() => fire(true))
    expect(result.current).toBe(true)

    act(() => fire(false))
    expect(result.current).toBe(false)
  })

  it('环境没有 matchMedia 时按 false', () => {
    // jsdom 默认没有 matchMedia；显式去掉，模拟非浏览器渲染环境。
    // @ts-expect-error 测试环境故意置空
    window.matchMedia = undefined
    const { result } = renderHook(() => useMinWidth(1024))
    expect(result.current).toBe(false)
  })
})
