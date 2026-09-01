import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { useStickToBottom } from './useStickToBottom'

type Box = {
  el: HTMLDivElement
  content: HTMLDivElement
  size: { scrollHeight: number; clientHeight: number }
}

function makeBox(scrollHeight: number, clientHeight: number): Box {
  const el = document.createElement('div')
  const content = document.createElement('div')
  el.appendChild(content)
  const size = { scrollHeight, clientHeight }
  for (const key of ['scrollHeight', 'clientHeight'] as const) {
    Object.defineProperty(el, key, { configurable: true, get: () => size[key] })
  }
  return { el, content, size }
}

type RO = { cb: ResizeObserverCallback; trigger: () => void }
let observers: RO[] = []

beforeEach(() => {
  observers = []
  class MockResizeObserver {
    cb: ResizeObserverCallback
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb
      observers.push({
        cb,
        trigger: () => cb([], this as unknown as ResizeObserver),
      })
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function setup(box: Box, opts: Parameters<typeof useStickToBottom>[1]) {
  return renderHook(() => {
    const ref = useRef<HTMLElement | null>(box.el)
    return useStickToBottom(ref, opts)
  })
}

describe('useStickToBottom', () => {
  it('opens at the tail when initialFollowing is set (live logs)', () => {
    const box = makeBox(1000, 400)
    setup(box, { initialFollowing: true, resetKey: 'a' })
    expect(box.el.scrollTop).toBe(1000)
  })

  it('opens at the top by default', () => {
    const box = makeBox(1000, 400)
    setup(box, { resetKey: 'a' })
    expect(box.el.scrollTop).toBe(0)
  })

  it('re-pins the tail on content growth while at the bottom', () => {
    const box = makeBox(1000, 400)
    const { result } = setup(box, { initialFollowing: true, resetKey: 'a' })
    // content grows by 600px while the user stays at the tail
    box.size.scrollHeight = 1600
    act(() => observers[0].trigger())
    expect(box.el.scrollTop).toBe(1600)
    expect(result.current).toBeTruthy()
  })

  it('stops following once the user scrolls up, and stays put on growth', () => {
    const box = makeBox(1000, 400)
    const { result } = setup(box, { initialFollowing: true, resetKey: 'a' })
    box.el.scrollTop = 100 // user scrolls up (distance 500 > threshold)
    act(() => result.current.onScroll())
    box.size.scrollHeight = 2000
    act(() => observers[0].trigger())
    expect(box.el.scrollTop).toBe(100)
  })

  it('resumes following when the user scrolls back into the tail zone', () => {
    const box = makeBox(1000, 400)
    const { result } = setup(box, { initialFollowing: true, resetKey: 'a' })
    box.el.scrollTop = 100
    act(() => result.current.onScroll())
    box.size.scrollHeight = 1200
    box.el.scrollTop = 1200 - 400 - 20 // 20px from the bottom, inside the zone
    act(() => result.current.onScroll())
    box.size.scrollHeight = 1800
    act(() => observers[0].trigger())
    expect(box.el.scrollTop).toBe(1800)
  })

  it('does not arm follow just because a short block has no scrollbar', () => {
    const box = makeBox(400, 400) // fits the viewport exactly
    const { result } = setup(box, { resetKey: 'a' })
    act(() => result.current.onScroll())
    // later it grows past the viewport — the reader at the top must not be yanked
    box.size.scrollHeight = 3000
    act(() => observers[0].trigger())
    expect(box.el.scrollTop).toBe(0)
  })

  it('stays inert when disabled (a nested scroller owns the behaviour)', () => {
    const box = makeBox(1000, 400)
    const { result } = setup(box, {
      enabled: false,
      initialFollowing: true,
      resetKey: 'a',
    })
    expect(box.el.scrollTop).toBe(0)
    expect(observers).toHaveLength(0)
    box.el.scrollTop = 50
    act(() => result.current.onScroll())
    expect(box.el.scrollTop).toBe(50)
  })

  it('re-observes when the single content wrapper is replaced', () => {
    // empty-state div → populated list div: the old node is detached, so an
    // observer still pointing at it would silently stop following.
    const box = makeBox(1000, 400)
    const { rerender } = setup(box, { initialFollowing: true, resetKey: 'a' })
    expect(observers).toHaveLength(1)

    box.el.removeChild(box.content)
    const next = document.createElement('div')
    box.el.appendChild(next)
    rerender()

    expect(observers.length).toBe(2)
    box.size.scrollHeight = 2400
    act(() => observers[observers.length - 1].trigger())
    expect(box.el.scrollTop).toBe(2400)
  })

  it('re-seeds follow state when the viewed item changes', () => {
    const box = makeBox(1000, 400)
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => {
        const ref = useRef<HTMLElement | null>(box.el)
        return useStickToBottom(ref, { initialFollowing: true, resetKey: key })
      },
      { initialProps: { key: 'a' } },
    )
    box.el.scrollTop = 120 // user scrolled up on item A
    act(() => result.current.onScroll())
    rerender({ key: 'b' }) // opening item B
    expect(box.el.scrollTop).toBe(1000)
  })
})
