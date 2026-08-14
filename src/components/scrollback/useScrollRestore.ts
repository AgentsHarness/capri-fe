import { useCallback, useRef, type MutableRefObject, type RefObject } from 'react'
import type { ScrollEntry } from '../../api/types'

export type ScrollSnapshot = {
  scrollHeight: number
  scrollTop: number
}

export function useScrollRestore(
  boxRef: RefObject<HTMLDivElement | null>,
  followRef: MutableRefObject<boolean>,
  lastScrollTopRef: MutableRefObject<number>,
  wsBarElRef: MutableRefObject<HTMLDivElement | null>,
  wsBarH: number,
  entries: ScrollEntry[],
) {
  /**
   * Prepend / 扩窗前的滚动快照。先 height-delta 稳住视口，再按新一轮
   * 是否装得进视口决定要不要对齐到新 user（见 settleFitOrKeep）。
   */
  const scrollSnapshotRef = useRef<ScrollSnapshot | null>(null)
  /**
   * 扩窗后待处理的「新一轮」user。anchorId = 旧内容起点（新一轮终点），
   * 用于量高判断是否装进视口。
   */
  const pendingRevealRef = useRef<{
    targetId: string
    anchorId?: string | null
  } | null>(null)

  /** 拍摄 prepend 前快照，并关掉 stick-to-bottom（避免 pinStreamScroll /
   *  ResizeObserver 在 entries 增长后把视口拽回底部）。 */
  const captureScrollSnapshot = useCallback(() => {
    const box = boxRef.current
    if (!box) return
    followRef.current = false
    scrollSnapshotRef.current = {
      scrollHeight: box.scrollHeight,
      scrollTop: box.scrollTop,
    }
  }, [boxRef, followRef])

  /** 把条目顶对齐到 workspace bar 下沿（阅读起点）。 */
  const alignEntryUnderBar = useCallback(
    (box: HTMLElement, el: HTMLElement) => {
      const boxTop = box.getBoundingClientRect().top
      const barH = wsBarElRef.current?.getBoundingClientRect().height ?? 0
      box.scrollTop += el.getBoundingClientRect().top - boxTop - barH
      lastScrollTopRef.current = box.scrollTop
    },
    [wsBarElRef, lastScrollTopRef],
  )

  /**
   * height-delta 保持视口（新内容在上方时不跳）。快照缺失时尝试
   * anchor 顶对齐。
   */
  const restoreScrollAfterPrepend = useCallback(
    (anchorId?: string | null) => {
      const box = boxRef.current
      if (!box) return false
      followRef.current = false
      const snap = scrollSnapshotRef.current
      scrollSnapshotRef.current = null
      if (snap) {
        box.scrollTop = snap.scrollTop + (box.scrollHeight - snap.scrollHeight)
        lastScrollTopRef.current = box.scrollTop
        return true
      }
      if (anchorId) {
        const anchor = box.querySelector(`[data-entry-id="${anchorId}"]`)
        if (anchor instanceof HTMLElement) {
          const boxTop = box.getBoundingClientRect().top
          box.scrollTop += anchor.getBoundingClientRect().top - boxTop
          lastScrollTopRef.current = box.scrollTop
          return true
        }
      }
      return false
    },
    [boxRef, followRef, lastScrollTopRef],
  )

  /**
   * 新一轮装进视口 → 顶对齐完整展示；超出视口 → 只 height-delta，不滚动不跳。
   * 必须在目标 DOM 已挂载后调用。
   */
  const settleFitOrKeep = useCallback(
    (
      box: HTMLElement,
      targetEl: HTMLElement,
      anchorId?: string | null,
    ): 'revealed' | 'kept' => {
      followRef.current = false
      // 先 height-delta 到「无跳跃」基线，再量高（量高依赖稳定后的布局）。
      const snap = scrollSnapshotRef.current
      scrollSnapshotRef.current = null
      if (snap) {
        box.scrollTop = snap.scrollTop + (box.scrollHeight - snap.scrollHeight)
        lastScrollTopRef.current = box.scrollTop
      }

      const barH =
        wsBarElRef.current?.getBoundingClientRect().height ?? wsBarH
      const available = Math.max(0, box.clientHeight - barH)
      const boxTop = box.getBoundingClientRect().top
      const yOf = (el: HTMLElement) =>
        el.getBoundingClientRect().top - boxTop + box.scrollTop
      const startY = yOf(targetEl)
      let endY = startY + targetEl.getBoundingClientRect().height
      if (anchorId) {
        const endEl = box.querySelector(`[data-entry-id="${anchorId}"]`)
        if (endEl instanceof HTMLElement) endY = yOf(endEl)
      }
      const turnHeight = Math.max(0, endY - startY)
      // 1px 容差：亚像素/边框不致误判为溢出。
      if (turnHeight <= available + 1) {
        alignEntryUnderBar(box, targetEl)
        return 'revealed'
      }
      // 超出：保持 height-delta 后的位置，视口不跳。
      return 'kept'
    },
    [alignEntryUnderBar, followRef, lastScrollTopRef, wsBarElRef, wsBarH],
  )

  /**
   * 宿主加载上一轮：新内容 prepend 到 anchor 之前。
   *
   * - 目标 = prepend 段**第一条** user（新一轮开头；勿用 last-before-anchor）
   * - 新一轮高度 ≤ 视口 → 顶对齐完整展示
   * - 超出视口 → 只 height-delta，不滚动不跳
   * - 纯工具续翻页（无 user）→ 只 height-delta
   */
  const revealPrependedTurn = useCallback(
    (anchorId?: string | null): 'revealed' | 'pending' | 'kept' | 'noop' => {
      const box = boxRef.current
      if (!box) return 'noop'
      followRef.current = false

      // prepend 段 = entries[0, anchorIdx)；新一轮 user = 该段第一条 user。
      let targetId: string | null = null
      if (anchorId) {
        const anchorIdx = entries.findIndex((e) => e.id === anchorId)
        const end = anchorIdx >= 0 ? anchorIdx : entries.length
        for (let i = 0; i < end; i++) {
          if (entries[i].kind === 'user') {
            targetId = entries[i].id
            break
          }
        }
        // 本页无 user（工具流续翻）：只 height-delta。
        if (!targetId) {
          restoreScrollAfterPrepend(anchorId)
          pendingRevealRef.current = null
          return 'kept'
        }
      } else {
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].kind === 'user') {
            targetId = entries[i].id
            break
          }
        }
        targetId = targetId ?? entries[0]?.id ?? null
      }

      if (!targetId) {
        restoreScrollAfterPrepend(anchorId)
        return 'kept'
      }

      const el = box.querySelector(`[data-entry-id="${targetId}"]`)
      if (el instanceof HTMLElement) {
        pendingRevealRef.current = null
        return settleFitOrKeep(box, el, anchorId)
      }
      // DOM 未齐：保留 snap，下一帧再 settle。
      pendingRevealRef.current = { targetId, anchorId }
      return 'pending'
    },
    [boxRef, entries, followRef, restoreScrollAfterPrepend, settleFitOrKeep],
  )

  return {
    scrollSnapshotRef,
    pendingRevealRef,
    captureScrollSnapshot,
    alignEntryUnderBar,
    restoreScrollAfterPrepend,
    settleFitOrKeep,
    revealPrependedTurn,
  }
}
