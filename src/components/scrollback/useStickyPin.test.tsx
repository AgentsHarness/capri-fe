import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import { useStickyPin } from './useStickyPin'

const U1 = { id: 'u1', kind: 'user', text: '第一轮' } as ScrollEntry
const U2 = { id: 'u2', kind: 'user', text: '第二轮' } as ScrollEntry

const BAR_H = 37
const ROW_H = 40

function makeBox(scrollTop = 0) {
  const box = document.createElement('div')
  let top = scrollTop
  Object.defineProperty(box, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v
    },
  })
  Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 2000 })
  Object.defineProperty(box, 'clientHeight', { configurable: true, value: 400 })
  box.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
  return { box, setScrollTop: (v: number) => (top = v) }
}

function makeRow(top: number) {
  const el = document.createElement('div')
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: ROW_H })
  el.getBoundingClientRect = () => ({ top }) as DOMRect
  return el
}

function setup(rows: Array<[ScrollEntry, HTMLElement]>) {
  const { box, setScrollTop } = makeBox(1200)
  const userById = new Map(rows.map(([e]) => [e.id, e]))
  const { result } = renderHook(() =>
    useStickyPin(
      { current: box },
      { current: 1200 },
      { current: true },
      { current: null },
      BAR_H,
      userById,
    ),
  )
  act(() => {
    for (const [e, el] of rows) result.current.userEls.current.set(e.id, el)
    result.current.updatePinned()
  })
  return { result, setScrollTop }
}

describe('useStickyPin directory active', () => {
  it('滚到顶后目录高亮第一轮，而不是上一轮', () => {
    // 文档坐标：u1 在 200，u2 在 1000。
    const { result, setScrollTop } = setup([
      [U1, makeRow(200)],
      [U2, makeRow(1000)],
    ])
    act(() => {
      setScrollTop(0)
      result.current.updatePinned()
    })
    expect(result.current.navActiveId).toBe('u1')
  })

  it('用户行全部卸载后目录高亮清空', () => {
    const { result } = setup([
      [U1, makeRow(200)],
      [U2, makeRow(1000)],
    ])
    act(() => {
      result.current.userEls.current.clear()
      result.current.updatePinned()
    })
    expect(result.current.navActiveId).toBeNull()
  })
})
