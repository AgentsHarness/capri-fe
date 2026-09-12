import { useEffect, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** 参与锚定的行节点标记（值 = sessionId）。 */
export const SCROLL_ANCHOR_ATTR = 'data-hkey'

type Anchor = { key: string; top: number }

/** 各锚点节点相对滚动容器视口顶部的偏移（按文档序插入）。 */
function offsets(scroller: HTMLElement): Map<string, number> {
  const out = new Map<string, number>()
  const base = scroller.getBoundingClientRect().top
  for (const el of scroller.querySelectorAll<HTMLElement>(`[${SCROLL_ANCHOR_ATTR}]`)) {
    const key = el.getAttribute(SCROLL_ANCHOR_ATTR)
    if (key) out.set(key, el.getBoundingClientRect().top - base)
  }
  return out
}

/** 最近的可滚动祖先（桌面侧栏与移动端下拉各有各的容器）。 */
export function scrollAncestor(el: HTMLElement | null): HTMLElement | null {
  let cur: HTMLElement | null = el
  while (cur && cur !== document.body) {
    const oy = getComputedStyle(cur).overflowY
    if (oy === 'auto' || oy === 'scroll') return cur
    cur = cur.parentElement
  }
  return null
}

/** 取第一个还在容器视口内（或尚未滚出上沿）的锚点。 */
function pickAnchor(table: Map<string, number>): Anchor | null {
  let fallback: Anchor | null = null
  for (const [key, top] of table) {
    if (top >= -0.5) return { key, top }
    fallback = { key, top }
  }
  return fallback
}

/**
 * 列表重排/增删后的滚动锚定：把「当前视口第一行」在屏幕上的位置钉住。
 *
 * 浏览器自带的 scroll anchoring 在 React 按 key 重排 DOM 时不可靠（锚点
 * 元素被移动或从原位摘走就失效），侧栏列表恰好就是这两种情况：整组被顶
 * 到前面、组内行数变化。这里在布局阶段自己补一次 scrollTop，
 * 用户就看不到跳动。形态指纹没变时不做任何测量；锚点行本身消失（被删 /
 * 组收起）时不补偿，只重选锚点。
 * 用户主动交互（折叠/展开、加载更多）由上层传 skipRef 避开补偿，避免
 * 将刚展开的组推出视口。
 *
 * @param rootRef 列表根节点（其可滚动祖先才是被操作的容器）
 * @param version 渲染形态指纹：变化时才做一次校正
 * @param skipRef 提供时若为 true 则本次更新跳过 delta 补偿，仅重选锚点
 */
export function useScrollAnchor(
  rootRef: RefObject<HTMLElement | null>,
  version: string,
  skipRef?: RefObject<boolean>,
): { reanchor: () => void } {
  const anchorRef = useRef<Anchor | null>(null)
  const seenRef = useRef<string>('')

  const reanchor = () => {
    const scroller = scrollAncestor(rootRef.current)
    if (!scroller) return
    anchorRef.current = pickAnchor(offsets(scroller))
  }

  useLayoutEffect(() => {
    if (seenRef.current === version) return
    seenRef.current = version
    const scroller = scrollAncestor(rootRef.current)
    if (!scroller) return

    if (skipRef?.current) {
      skipRef.current = false
      anchorRef.current = pickAnchor(offsets(scroller))
      return
    }

    const table = offsets(scroller)
    const prev = anchorRef.current
    if (prev) {
      const at = table.get(prev.key)
      if (at != null) {
        const delta = at - prev.top
        if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
        // 补偿后锚点回到原偏移，记录值保持不动。
        return
      }
    }
    anchorRef.current = pickAnchor(table)
  })

  // 用户自己滚动后必须重选锚点，否则下一次校正会把视口拽回旧行。
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof window === 'undefined') return
    let frame = 0
    const onScroll = (e: Event) => {
      const scroller = scrollAncestor(el)
      if (!scroller || !(e.target instanceof Element) || !scroller.contains(e.target)) {
        return
      }
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        const picked = pickAnchor(offsets(scroller))
        if (picked) anchorRef.current = picked
      })
    }
    window.addEventListener('scroll', onScroll, true)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [rootRef])

  return { reanchor }
}
