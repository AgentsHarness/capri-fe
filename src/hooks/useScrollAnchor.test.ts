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
  it('skipRef 为 true 时跳过 delta 补偿，重置 skipRef 标志', () => {
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    const root = document.createElement('div')
    const row1 = document.createElement('div')
    row1.setAttribute(SCROLL_ANCHOR_ATTR, 'r1')
    root.appendChild(row1)
    scroller.appendChild(root)
    document.body.appendChild(scroller)

    const rootRef = { current: root }
    const skipRef = { current: true }

    let version = 'v1'
    const { rerender } = renderHook(() =>
      useScrollAnchor(rootRef, version, skipRef),
    )

    // 首轮跳过补偿且重置 skipRef
    expect(skipRef.current).toBe(false)

    // 再次更新 version 且 skipRef 为 false，正常工作
    version = 'v2'
    act(() => {
      rerender()
    })

    document.body.removeChild(scroller)
  })
})
