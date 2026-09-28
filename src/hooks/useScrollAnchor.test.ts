import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { scrollAncestor, useScrollAnchor, SCROLL_ANCHOR_ATTR } from './useScrollAnchor'

describe('scrollAncestor', () => {
  it('查找最近的 overflow-y 为 auto/scroll 的祖先容器', () => {
    const root = document.createElement('div')
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    const child = document.createElement('div')
    const target = document.createElement('div')

    root.appendChild(scroller)
    scroller.appendChild(child)
    child.appendChild(target)
    document.body.appendChild(root)

    expect(scrollAncestor(target)).toBe(scroller)
    document.body.removeChild(root)
  })

  it('无滚动祖先时返回 null', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    expect(scrollAncestor(el)).toBeNull()
    document.body.removeChild(el)
  })
})

describe('useScrollAnchor', () => {
  /** jsdom 不做布局，锚点偏移全靠这个桩喂给 offsets()。 */
  const rectAt = (top: number) =>
    ({ top, bottom: top, left: 0, right: 0, x: 0, y: top, width: 0, height: 0 }) as unknown as DOMRect

  /** 双行列表 + 可整体平移的行偏移（模拟重排后锚点行的新位置）。 */
  function mountList() {
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    const root = document.createElement('div')
    const row1 = document.createElement('div')
    row1.setAttribute(SCROLL_ANCHOR_ATTR, 'r1')
    const row2 = document.createElement('div')
    row2.setAttribute(SCROLL_ANCHOR_ATTR, 'r2')
    root.append(row1, row2)
    scroller.appendChild(root)
    document.body.appendChild(scroller)

    let top1 = 100
    let top2 = 200
    scroller.getBoundingClientRect = () => rectAt(0)
    row1.getBoundingClientRect = () => rectAt(top1)
    row2.getBoundingClientRect = () => rectAt(top2)
    return {
      scroller,
      root,
      slide(delta: number) {
        top1 += delta
        top2 += delta
      },
    }
  }

  it('锚点行位移时按 delta 补偿 scrollTop，把该行钉回原偏移', () => {
    const { scroller, root, slide } = mountList()
    const rootRef = { current: root }
    let version = 'v1'
    const { rerender } = renderHook(() => useScrollAnchor(rootRef, version))

    // 首轮只记锚点（r1 @ 100），不改 scrollTop
    expect(scroller.scrollTop).toBe(0)

    slide(50)
    version = 'v2'
    act(() => {
      rerender()
    })
    expect(scroller.scrollTop).toBe(50)

    document.body.removeChild(scroller)
  })

  it('skipRef 为 true 时跳过 delta 补偿，重置标志并把补偿基线挪到当前视口', () => {
    const { scroller, root, slide } = mountList()
    const rootRef = { current: root }
    const skipRef = { current: false }
    let version = 'v1'
    const { rerender } = renderHook(() => useScrollAnchor(rootRef, version, skipRef))
    scroller.scrollTop = 120

    skipRef.current = true
    slide(50)
    version = 'v2'
    act(() => {
      rerender()
    })

    // 用户主动发起的重排：scrollTop 原地不动，标志消费掉
    expect(scroller.scrollTop).toBe(120)
    expect(skipRef.current).toBe(false)

    // 基线已换成当前视口那一行：之后的重排按新基线补偿
    slide(10)
    version = 'v3'
    act(() => {
      rerender()
    })
    expect(scroller.scrollTop).toBe(130)

    document.body.removeChild(scroller)
  })

  it('指纹没变时未消费的 skip 标志就地清掉，不吃掉下一次真实重排的补偿', () => {
    const { scroller, root, slide } = mountList()
    const rootRef = { current: root }
    const skipRef = { current: false }
    let version = 'v1'
    const { rerender } = renderHook(() => useScrollAnchor(rootRef, version, skipRef))

    // 取消待办这类操作：指纹按组形状算，多数时候没变化
    skipRef.current = true
    act(() => {
      rerender()
    })
    expect(skipRef.current).toBe(false)

    // 下一次真实重排照常补偿
    slide(30)
    version = 'v2'
    act(() => {
      rerender()
    })
    expect(scroller.scrollTop).toBe(30)

    document.body.removeChild(scroller)
  })
})
