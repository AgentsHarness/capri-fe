import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelSmoothScroll, smoothScrollTop } from './smoothScroll'

type FakeEl = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

const frames: FrameRequestCallback[] = []

function flushFrame() {
  const cb = frames.shift()
  cb?.(0)
}

beforeEach(() => {
  frames.length = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('smoothScrollTop', () => {
  it('按帧逼近目标并钳制在最大 scrollTop', () => {
    const el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 } as FakeEl
    smoothScrollTop(el as unknown as HTMLElement, 9999, { factor: 1, maxStep: 100 })
    for (let i = 0; i < 20 && frames.length > 0; i++) flushFrame()
    expect(el.scrollTop).toBe(800)
  })

  it('isActive=false 时停止推进', () => {
    let active = true
    const el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 } as FakeEl
    smoothScrollTop(el as unknown as HTMLElement, 800, {
      factor: 0.5,
      maxStep: 100,
      isActive: () => active,
    })
    flushFrame()
    const afterFirst = el.scrollTop
    expect(afterFirst).toBeGreaterThan(0)
    active = false
    flushFrame()
    expect(el.scrollTop).toBe(afterFirst)
  })

  it('重复调用只更新目标，不叠加多个循环', () => {
    const el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 } as FakeEl
    smoothScrollTop(el as unknown as HTMLElement, 200, { factor: 1, maxStep: 100 })
    smoothScrollTop(el as unknown as HTMLElement, 500, { factor: 1, maxStep: 100 })
    expect(frames).toHaveLength(1)
    flushFrame()
    expect(el.scrollTop).toBe(100)
  })

  it('cancelSmoothScroll 停止循环', () => {
    const el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 } as FakeEl
    smoothScrollTop(el as unknown as HTMLElement, 800)
    cancelSmoothScroll(el as unknown as HTMLElement)
    expect(vi.mocked(cancelAnimationFrame)).toHaveBeenCalled()
  })
})
