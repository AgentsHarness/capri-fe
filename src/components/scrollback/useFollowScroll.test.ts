import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import { useFollowScroll } from './useFollowScroll'

vi.mock('../../store/settings', () => ({ uiBool: () => true }))
vi.mock('../../store/chat', () => ({
  useChatStore: Object.assign(
    () => 'u2',
    { subscribe: () => () => {} },
  ),
}))

type Props = {
  entries: ScrollEntry[]
  displayRowCount: number
}

const USER = { id: 'u2', kind: 'user', text: '刚发出的消息' } as ScrollEntry
const BASE_ENTRIES = [{ id: 'u1', kind: 'user', text: '上一条' } as ScrollEntry, USER]

/** 盒子桩：scrollTop 按 max 钳制（真浏览器的行为），末条 user 行的 rect
 *  top 由 `rowTop` 决定（相对盒子顶）。 */
function makeBox(p: { scrollTop: number; scrollHeight: number; clientHeight: number; rowTop: number }) {
  const el = document.createElement('div')
  let scrollTop = p.scrollTop
  const row = document.createElement('div')
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => p.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => p.clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = Math.max(0, Math.min(v, p.scrollHeight - p.clientHeight))
    },
  })
  el.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
  row.getBoundingClientRect = () => ({ top: p.rowTop }) as DOMRect
  el.querySelector = () => row
  return { el, row, get scrollTop() { return scrollTop } }
}

function setup(p: Parameters<typeof makeBox>[0]) {
  const box = makeBox(p)
  const boxRef = { current: box.el }
  const contentRef = { current: null }
  const followRef = { current: true }
  const lastScrollTopRef = { current: 0 }
  const streamBodyRef = { current: null }
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
      ),
    { initialProps: { entries: BASE_ENTRIES, displayRowCount: BASE_ENTRIES.length } as Props },
  )
  return { ...h, box, followRef, boxRef }
}

describe('useFollowScroll — page-flip 写入被钳到底时继续跟随', () => {
  it('末条 prompt 顶对齐超出可滚动范围（钳到底）→ 保持跟随，视口停在尾部', () => {
    // scrollHeight 1000 / clientHeight 400 → max 600；行顶在 900 → 目标
    // 1000 被钳到 600（尾部），下方没有余地，钉顶不成立。
    const h = setup({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400, rowTop: 900 })

    expect(h.followRef.current).toBe(true)
    expect(h.box.scrollTop).toBe(600)
  })

  it('钉顶成立（下方还有余地）→ 关掉跟随，视口停在 prompt 顶', () => {
    // scrollHeight 2000 / clientHeight 400 → max 1600；行顶 300 →
    // 目标 400 在范围内，写入后下方仍有 1200px。
    const h = setup({ scrollTop: 100, scrollHeight: 2000, clientHeight: 400, rowTop: 300 })

    expect(h.followRef.current).toBe(false)
    expect(h.box.scrollTop).toBe(400)
  })
})
