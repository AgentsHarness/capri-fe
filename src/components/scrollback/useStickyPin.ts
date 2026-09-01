import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from 'react'
import type { ScrollEntry } from '../../api/types'
import { fallbackStickyBandH, pickStickyPin } from '../../scrollback/stickyPin'

/**
 * Sticky pin — overlay adaptation of TUI sticky.rs.
 *
 * Geometry (box viewport Y):
 *   workspace bar  [0, barBottom)
 *   sticky band    [barBottom, barBottom + stickyH)
 *
 * pinLine (document Y) = scrollTop + barBottom.
 *
 * Scroll rule (`pickStickyPin`):
 * - Pin the last user whose bottom ≤ pinLine (fully under the bar).
 * - Next user entering the band pushes that pin up, then yield — do not
 *   switch identity onto the in-flow prompt.
 *
 * Jumps (directory rail / clicking the band) only align the target to the
 * bar — they never override this rule. `scrollTop` assignment clamps at
 * maxScrollTop, so a target whose trailing content is shorter than the
 * viewport stays in flow below the bar; pinning it there would paint the
 * same prompt twice (band + in-flow).
 */
export function useStickyPin(
  boxRef: RefObject<HTMLDivElement | null>,
  lastScrollTopRef: MutableRefObject<number>,
  followRef: MutableRefObject<boolean>,
  wsBarElRef: MutableRefObject<HTMLDivElement | null>,
  wsBarH: number,
  userById: Map<string, ScrollEntry>,
) {
  const userEls = useRef<Map<string, HTMLElement>>(new Map())
  // 当前 sticky 钉选：entry 为渲染内容。
  const [pinned, setPinned] = useState<{ entry: ScrollEntry; store: boolean } | null>(null)
  // 目录 rail active tick — 独立于 sticky 阈值（可读区顶 = bar 下沿）。
  const [navActiveId, setNavActiveId] = useState<string | null>(null)
  /** Rendered sticky band (live height + push translate). */
  const stickyBandElRef = useRef<HTMLDivElement | null>(null)
  const lastPushYRef = useRef(0)

  const applyStickyPushY = (y: number) => {
    if (lastPushYRef.current === y) {
      const el = stickyBandElRef.current
      if (el && y !== 0 && !el.style.transform) {
        el.style.transform = `translateY(${y}px)`
      }
      return
    }
    lastPushYRef.current = y
    const el = stickyBandElRef.current
    if (el) el.style.transform = y ? `translateY(${y}px)` : ''
  }

  const updatePinned = useCallback(() => {
    const box = boxRef.current
    const els = userEls.current
    if (!box || els.size === 0) {
      applyStickyPushY(0)
      setPinned((prev) => (prev == null ? prev : null))
      return
    }
    const scrollTop = box.scrollTop
    // TUI: scroll_offset == 0 → no pin.
    if (scrollTop <= 0) {
      applyStickyPushY(0)
      setPinned((prev) => (prev == null ? prev : null))
      return
    }
    const boxTop = box.getBoundingClientRect().top
    // Live bar bottom in box viewport Y (includes tasks-bar growth).
    const barBottom = wsBarElRef.current
      ? wsBarElRef.current.getBoundingClientRect().bottom - boxTop
      : wsBarH
    const pinLine = scrollTop + barBottom
    const stickyH =
      stickyBandElRef.current?.offsetHeight || fallbackStickyBandH()

    type UserPos = { id: string; top: number; bottom: number }
    const measure = (id: string, el: HTMLElement): UserPos => {
      const rect = el.getBoundingClientRect()
      // margin-top is outside the border box but is part of the visual
      // section start (user rows use mt-2).
      const mt = parseFloat(getComputedStyle(el).marginTop) || 0
      const top = rect.top - boxTop + scrollTop - mt
      return { id, top, bottom: top + mt + el.offsetHeight }
    }

    const list: UserPos[] = []
    for (const [id, el] of els) {
      list.push(measure(id, el))
    }

    const pick = pickStickyPin(list, pinLine, stickyH)
    applyStickyPushY(pick.pushY)
    const entry = pick.id != null ? userById.get(pick.id) : undefined
    const next = entry != null ? { entry, store: false as const } : null
    setPinned((prev) =>
      prev?.entry?.id === next?.entry?.id && prev?.store === next?.store ? prev : next,
    )
  }, [boxRef, userById, wsBarElRef, wsBarH])

  /**
   * 目录 active：视口可读顶（workspace bar 下沿）附近最近 user。
   * 与 sticky 同用 bar 下沿作参考线，但 active 语义是「附近最近」而非钉选。
   */
  const updateNavActive = useCallback(() => {
    const box = boxRef.current
    const els = userEls.current
    if (!box || els.size === 0) {
      setNavActiveId((prev) => (prev == null ? prev : null))
      return
    }
    const scrollTop = box.scrollTop
    const boxTop = box.getBoundingClientRect().top
    const barH =
      wsBarElRef.current?.getBoundingClientRect().height ?? wsBarH
    const line = scrollTop + barH
    let lastAtOrAbove: string | null = null
    let firstId: string | null = null
    let lastId: string | null = null
    for (const [id, el] of els) {
      if (firstId == null) firstId = id
      lastId = id
      const top = el.getBoundingClientRect().top - boxTop + scrollTop
      if (top <= line) lastAtOrAbove = id
    }
    const dist = box.scrollHeight - box.scrollTop - box.clientHeight
    const next = dist < 4 ? lastId : (lastAtOrAbove ?? firstId)
    setNavActiveId((prev) => (prev === next ? prev : next))
  }, [boxRef, wsBarElRef, wsBarH])

  useEffect(() => {
    const onResize = () => {
      updatePinned()
      updateNavActive()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [updatePinned, updateNavActive])

  // rAF-throttled pinned-header recompute: onScroll fires per frame during
  // streaming, and getBoundingClientRect per user entry forces layout.
  // Directory active reuses the same rAF; sticky threshold stays in updatePinned.
  const pinnedRaf = useRef<number | null>(null)
  const scheduleUpdatePinned = useCallback(() => {
    if (pinnedRaf.current != null) return
    pinnedRaf.current = requestAnimationFrame(() => {
      pinnedRaf.current = null
      updatePinned()
      updateNavActive()
    })
  }, [updatePinned, updateNavActive])

  useEffect(
    () => () => {
      if (pinnedRaf.current != null) {
        cancelAnimationFrame(pinnedRaf.current)
        pinnedRaf.current = null
      }
    },
    [],
  )

  /**
   * 点击 sticky 钉住的 user：滚到该条消息开头（顶对齐 workspace bar 下沿），
   * 从这条 prompt 起重新阅读。未挂载时先扩 render 窗口再滚。
   * 目录 rail 跳转复用同一路径；jump 已对齐时跳过 selectedId→scrollIntoView。
   */
  const jumpToUserEntry = useCallback(
    (id: string) => {
      const box = boxRef.current
      if (!box) return
      followRef.current = false
      const align = (el: HTMLElement) => {
        const boxTop = box.getBoundingClientRect().top
        const barH =
          wsBarElRef.current?.getBoundingClientRect().height ?? wsBarH
        box.scrollTop +=
          el.getBoundingClientRect().top - boxTop - barH
        lastScrollTopRef.current = box.scrollTop
      }
      const el = box.querySelector(`[data-entry-id="${id}"]`)
      if (el instanceof HTMLElement) {
        align(el)
        updatePinned()
        updateNavActive()
        return
      }
      // 全量 DOM 后仍找不到则等下一帧（刚 prepend 的极短窗口）。
      setScrollToEntryId(id)
    },
    [boxRef, followRef, lastScrollTopRef, updateNavActive, updatePinned, wsBarElRef, wsBarH],
  )

  const [scrollToEntryId, setScrollToEntryId] = useState<string | null>(null)
  useLayoutEffect(() => {
    if (!scrollToEntryId) return
    const box = boxRef.current
    const el = box?.querySelector(`[data-entry-id="${scrollToEntryId}"]`)
    if (box && el instanceof HTMLElement) {
      const boxTop = box.getBoundingClientRect().top
      const barH =
        wsBarElRef.current?.getBoundingClientRect().height ?? wsBarH
      box.scrollTop +=
        el.getBoundingClientRect().top - boxTop - barH
      lastScrollTopRef.current = box.scrollTop
    }
    setScrollToEntryId(null)
    updatePinned()
    updateNavActive()
  }, [boxRef, lastScrollTopRef, scrollToEntryId, updateNavActive, updatePinned, wsBarElRef, wsBarH])

  return {
    userEls,
    pinned,
    navActiveId,
    stickyBandElRef,
    lastPushYRef,
    updatePinned,
    updateNavActive,
    scheduleUpdatePinned,
    jumpToUserEntry,
  }
}
