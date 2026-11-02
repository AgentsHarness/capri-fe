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
import { fallbackStickyBandH, pickStickyPin, type StickyUserPos } from '../../scrollback/stickyPin'

type PinGeometry = {
  box: HTMLElement
  scrollTop: number
  /** 参考线（文档坐标）：sticky 与目录共用的同一条。 */
  line: number
  users: StickyUserPos[]
}

/**
 * 目录 rail 高亮哪一轮。
 *
 * 有钉选时直接取钉选那条：sticky 用「最后一个完全越过参考线的用户」，
 * 而目录若另按「最近」量，用户行恰好横跨参考线时两者会各指一轮，屏幕上
 * 就是「钉着第 3 轮的提问、目录亮第 4 轮」。无钉选（滚到顶 / 内容比视口
 * 短）时才退回「参考线上方最近的那条」。
 */
function resolveNavActiveId(geo: PinGeometry, pinnedId: string | null): string | null {
  const { box, line, users } = geo
  if (pinnedId) return pinnedId
  const dist = box.scrollHeight - box.scrollTop - box.clientHeight
  if (dist < 4) return users[users.length - 1]?.id ?? null
  let lastAtOrAbove: string | null = null
  for (const u of users) if (u.top <= line) lastAtOrAbove = u.id
  return lastAtOrAbove ?? users[0]?.id ?? null
}

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
  const [pinned, setPinned] = useState<ScrollEntry | null>(null)
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

  /**
   * 一次量出 sticky 与目录 active 共用的几何：条目的内容坐标（top/bottom，
   * 扣掉 margin-top 使「段落起点」与视觉起点一致）+ 参考线。
   *
   * 两个消费方的语义不同（sticky = 最后一个完全越过线的；目录 = 最近
   * 的那一个），但**参考线与条目坐标必须同源**：各量各的会出现「钉住的
   * 提示头和目录高亮指向不同轮」。
   */
  const measureGeometry = useCallback(() => {
    const box = boxRef.current
    const els = userEls.current
    if (!box || els.size === 0) return null
    const scrollTop = box.scrollTop
    const boxTop = box.getBoundingClientRect().top
    // Live bar bottom in box viewport Y (includes tasks-bar growth).
    const barBottom = wsBarElRef.current
      ? wsBarElRef.current.getBoundingClientRect().bottom - boxTop
      : wsBarH
    const users: StickyUserPos[] = []
    for (const [id, el] of els) {
      const rect = el.getBoundingClientRect()
      // margin-top is outside the border box but is part of the visual
      // section start (user rows use mt-2).
      const mt = parseFloat(getComputedStyle(el).marginTop) || 0
      const top = rect.top - boxTop + scrollTop - mt
      users.push({ id, top, bottom: top + mt + el.offsetHeight })
    }
    return { box, scrollTop, line: scrollTop + barBottom, users }
  }, [boxRef, wsBarElRef, wsBarH])

  const updatePinned = useCallback(() => {
    const geo = measureGeometry()
    if (!geo) {
      applyStickyPushY(0)
      setPinned((prev) => (prev == null ? prev : null))
      // 用户行全部卸载（切到空/短转录）：目录不能留着旧高亮。
      setNavActiveId((prev) => (prev == null ? prev : null))
      return
    }
    // TUI: scroll_offset == 0 → no pin；目录回到第一轮（或清空）。
    if (geo.scrollTop <= 0) {
      applyStickyPushY(0)
      setPinned((prev) => (prev == null ? prev : null))
      const navFirst = geo.users[0]?.id ?? null
      setNavActiveId((prev) => (prev === navFirst ? prev : navFirst))
      return
    }
    const stickyH =
      stickyBandElRef.current?.offsetHeight || fallbackStickyBandH()

    const pick = pickStickyPin(geo.users, geo.line, stickyH)
    applyStickyPushY(pick.pushY)
    const entry = pick.id != null ? userById.get(pick.id) : undefined
    const next = entry ?? null
    // 目录与 sticky 同一答案：钉住哪一轮，目录就高亮哪一轮。用户行横跨
    // 参考线时「完全越过」与「最近」会各指一轮，屏幕上同时出现两个
    // 「当前轮」——这一处直接让目录跟随钉选。
    const navNext = resolveNavActiveId(geo, pick.id)
    setNavActiveId((prev) => (prev === navNext ? prev : navNext))
    setPinned((prev) => (prev?.id === next?.id ? prev : next))
  }, [measureGeometry, userById])

  useEffect(() => {
    const onResize = () => updatePinned()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [updatePinned])

  // rAF-throttled pinned-header recompute: onScroll fires per frame during
  // streaming, and getBoundingClientRect per user entry forces layout.
  // Directory active reuses the same rAF; sticky threshold stays in updatePinned.
  const pinnedRaf = useRef<number | null>(null)
  const scheduleUpdatePinned = useCallback(() => {
    if (pinnedRaf.current != null) return
    pinnedRaf.current = requestAnimationFrame(() => {
      pinnedRaf.current = null
      updatePinned()
    })
  }, [updatePinned])

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
        return
      }
      // 全量 DOM 后仍找不到则等下一帧（刚 prepend 的极短窗口）。
      setScrollToEntryId(id)
    },
    [boxRef, followRef, lastScrollTopRef, updatePinned, wsBarElRef, wsBarH],
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
  }, [boxRef, lastScrollTopRef, scrollToEntryId, updatePinned, wsBarElRef, wsBarH])

  return {
    userEls,
    pinned,
    navActiveId,
    stickyBandElRef,
    lastPushYRef,
    updatePinned,
    scheduleUpdatePinned,
    jumpToUserEntry,
  }
}
