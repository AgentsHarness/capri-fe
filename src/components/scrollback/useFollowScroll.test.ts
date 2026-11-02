import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import { PIN_RELEASE_EVENT } from '../../scrollback/pinReserve'
import { useFollowScroll } from './useFollowScroll'

/** page_flip_on_send 开关 + 最近一次发送的 user 行 id，逐测试可改。 */
const ui = vi.hoisted(() => ({ pageFlip: true, lastSent: 'u2' as string | undefined }))

vi.mock('../../store/settings', () => ({
  uiBool: () => ui.pageFlip,
}))
vi.mock('../../store/chat', () => ({
  useChatStore: Object.assign(
    (sel: (s: { lastSentPromptId?: string }) => unknown) =>
      sel({ lastSentPromptId: ui.lastSent }),
    { subscribe: () => () => {} },
  ),
}))

type Props = {
  entries: ScrollEntry[]
  displayRowCount: number
}

const USER = { id: 'u2', kind: 'user', text: '刚发出的消息' } as ScrollEntry
const BASE_ENTRIES = [{ id: 'u1', kind: 'user', text: '上一条' } as ScrollEntry, USER]

const BAR_H = 37
const PIN = 300 // 钉住行的文档坐标（盒子内容原点）

/**
 * 盒子桩：scrollHeight = 转录内容高 + page-flip 留白，scrollTop 按 max
 * 钳制（真浏览器的行为）。钉住行的 rect.top 随滚动变化（文档坐标 300），
 * 是可读区顶对齐的唯一判据。
 */
function makeBox(p: {
  scrollTop: number
  /** 转录内容高（不含留白）。 */
  contentHeight: number
  clientHeight: number
}) {
  const el = document.createElement('div')
  const pad = document.createElement('div')
  Object.defineProperty(pad, 'offsetHeight', {
    configurable: true,
    get: () => parseFloat(pad.style.height) || 0,
  })
  // 贴纸块紧跟转录 → offsetTop 就是转录内容高（自身高度不影响它）。
  Object.defineProperty(pad, 'offsetTop', {
    configurable: true,
    get: () => p.contentHeight,
  })
  const row = document.createElement('div')
  let scrollTop = p.scrollTop
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => p.contentHeight + pad.offsetHeight,
  })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => p.clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = Math.max(0, Math.min(v, el.scrollHeight - p.clientHeight))
    },
  })
  el.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
  row.getBoundingClientRect = () => ({ top: PIN - scrollTop }) as DOMRect
  el.querySelector = () => row
  return {
    el,
    pad,
    p,
    get scrollTop() {
      return el.scrollTop
    },
    get padHeight() {
      return pad.offsetHeight
    },
  }
}

function setup(p: Parameters<typeof makeBox>[0]) {
  const box = makeBox(p)
  const boxRef = { current: box.el }
  const contentRef = { current: null }
  const followRef = { current: true }
  const lastScrollTopRef = { current: 0 }
  const streamBodyRef = { current: null }
  const pinPadRef = { current: box.pad }
  const wsBarElRef = {
    current: {
      getBoundingClientRect: () => ({ height: BAR_H }) as DOMRect,
    } as unknown as HTMLDivElement,
  }
  const scheduleUpdatePinned = vi.fn()
  const settleScrollAnchor = vi.fn()
  const h = renderHook(
    (pp: Props) =>
      useFollowScroll(
        boxRef as never,
        contentRef as never,
        followRef,
        lastScrollTopRef,
        streamBodyRef,
        scheduleUpdatePinned,
        settleScrollAnchor,
        pp.entries,
        pp.displayRowCount,
        pinPadRef as never,
        wsBarElRef,
        BAR_H,
      ),
    { initialProps: { entries: BASE_ENTRIES, displayRowCount: BASE_ENTRIES.length } as Props },
  )
  return { ...h, box, followRef, boxRef, pinPadRef }
}

describe('useFollowScroll — page-flip（[ui] page_flip_on_send）', () => {
  it('发出 prompt → 留白把 prompt 顶撑成真正的滚动底', () => {
    // 短转录（300）比视口（400）还矮：没有留白时顶对齐写入会被钳到底，
    // 这就是「选项没生效」的表象。
    const h = setup({ scrollTop: 0, contentHeight: 300, clientHeight: 400 })

    expect(h.box.padHeight).toBeGreaterThan(0)
    expect(h.box.scrollTop).toBe(PIN - BAR_H)
    expect(h.followRef.current).toBe(true)
  })

  it('回答写满一页 → 解除留白，落回尾部', () => {
    const h = setup({ scrollTop: 0, contentHeight: 300, clientHeight: 400 })
    expect(h.box.padHeight).toBeGreaterThan(0)

    // 首个回答长高：内容越过钉位 + 视口高。
    h.box.p.contentHeight = PIN - BAR_H + 400 + 1
    act(() =>
      h.rerender({ entries: [...BASE_ENTRIES, { id: 'a1', kind: 'assistant', text: '答' } as ScrollEntry], displayRowCount: 3 }),
    )

    expect(h.box.padHeight).toBe(0)
    expect(h.box.scrollTop).toBe(h.box.el.scrollHeight - 400)
  })

  it('G（释放留白）→ 留白清零，可滚到真实尾部', () => {
    const h = setup({ scrollTop: 0, contentHeight: 300, clientHeight: 400 })
    expect(h.box.padHeight).toBeGreaterThan(0)

    act(() => {
      window.dispatchEvent(new Event(PIN_RELEASE_EVENT))
    })

    expect(h.box.padHeight).toBe(0)
    h.box.el.scrollTop = h.box.el.scrollHeight
    expect(h.box.scrollTop).toBe(0)
  })

  it('关闭 page_flip_on_send → 不留白，直接回底', () => {
    ui.pageFlip = false
    try {
      const h = setup({ scrollTop: 0, contentHeight: 300, clientHeight: 400 })
      expect(h.box.padHeight).toBe(0)
      expect(h.followRef.current).toBe(true)
    } finally {
      ui.pageFlip = true
    }
  })

  it('回放 / 排队的 user 行（id ≠ lastSentPromptId）→ 不留白，回底', () => {
    ui.lastSent = 'u1'
    try {
      const h = setup({ scrollTop: 0, contentHeight: 300, clientHeight: 400 })
      expect(h.box.padHeight).toBe(0)
      expect(h.followRef.current).toBe(true)
    } finally {
      ui.lastSent = 'u2'
    }
  })
})
