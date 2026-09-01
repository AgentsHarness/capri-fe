import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import type { ScrollEntry } from '../../api/types'
import {
  ANCHOR_DRIFT_TOLERANCE_PX,
  ANCHOR_MOMENTUM_MS,
  ANCHOR_SETTLE_MS,
} from './constants'

export type ScrollSnapshot = {
  scrollHeight: number
  scrollTop: number
}

/** 行锚点：prepend 前后必须是同一条条目、同一个视口偏移。 */
type ScrollAnchor = {
  /** `[data-entry-id]` 值（EntryShell 挂在条目外层 div 上） */
  id: string
  /** 条目顶边相对可读区顶（workspace bar 下沿）的偏移，可为负（单条比视口高） */
  dy: number
}

/**
 * 锚点候选条数。prepend 会把页尾的半截 assistant 与旧区首条缝合（条目 id
 * 换成新页那条），也会收口空 thought —— 只看一条会在这一刻失效并退回
 * height-delta，读到的是被无关高度污染过的位置。多留两条就没那么脆弱。
 */
const ANCHOR_CANDIDATES = 3

/**
 * prepend 后如何落位：
 * - `keep`   —— 滚轮 / 触摸「拉」出来的加载：只保持视口不动，绝不跳。
 * - `reveal` —— 用户点顶部按钮 / 点 sticky 头：短轮顶对齐完整展示，长轮不跳。
 */
export type TurnSettleMode = 'keep' | 'reveal'

export function useScrollRestore(
  boxRef: RefObject<HTMLDivElement | null>,
  followRef: MutableRefObject<boolean>,
  lastScrollTopRef: MutableRefObject<number>,
  wsBarElRef: MutableRefObject<HTMLDivElement | null>,
  wsBarH: number,
  entries: ScrollEntry[],
) {
  /** height-delta 兜底快照（拿不到行锚点时用）。 */
  const scrollSnapshotRef = useRef<ScrollSnapshot | null>(null)
  /** 主恢复手段：可读区里最靠上的几条条目做锚点候选（顶的那条可能被合并掉）。 */
  const anchorsRef = useRef<ScrollAnchor[]>([])
  /** 我们自己写过的 scrollTop，用来认出「这次 scroll 事件是自己写的」。 */
  const lastWrittenTopRef = useRef<number>(Number.NaN)
  /** 内容变高补正的存活截止时刻（Date.now() 域）。 */
  const settleUntilRef = useRef(0)
  /** 逐帧钉回锚点的截止时刻：覆盖触发翻页那一下滚轮的剩余动量。 */
  const momentumUntilRef = useRef(0)
  const settleRafRef = useRef<number | null>(null)
  /**
   * 扩窗后待处理的「新一轮」user。anchorId = 旧内容起点（新一轮终点），
   * 用于量高判断是否装进视口。
   */
  const pendingRevealRef = useRef<{
    targetId: string
    anchorId?: string | null
    mode: TurnSettleMode
  } | null>(null)

  useEffect(
    () => () => {
      if (settleRafRef.current != null) cancelAnimationFrame(settleRafRef.current)
    },
    [],
  )

  /** 可读区顶（workspace bar 下沿）在视口坐标系的 Y。 */
  const readLineTop = useCallback(
    (box: HTMLElement) => {
      const barH =
        wsBarElRef.current?.getBoundingClientRect().height ?? wsBarH
      return box.getBoundingClientRect().top + barH
    },
    [wsBarElRef, wsBarH],
  )

  const writeScrollTop = useCallback(
    (box: HTMLElement, v: number) => {
      box.scrollTop = v
      lastScrollTopRef.current = box.scrollTop
      lastWrittenTopRef.current = box.scrollTop
    },
    [lastScrollTopRef],
  )

  /** 这次 scroll 事件是否由本 hook 自己写 scrollTop 引发。
   *  动量窗口内一律算自己的：触发翻页的那一下滚轮会在我们写完之后再拖
   *  几十毫秒（见 ANCHOR_MOMENTUM_MS），那些中间帧不是用户接管。 */
  const isProgrammaticScroll = useCallback(
    (box: HTMLElement) => {
      if (Date.now() < momentumUntilRef.current) return true
      const written = lastWrittenTopRef.current
      return (
        Number.isFinite(written) &&
        Math.abs(box.scrollTop - written) <= ANCHOR_DRIFT_TOLERANCE_PX
      )
    },
    [],
  )

  /** 可读区里最靠上的若干条条目 → 锚点候选（顶边偏移记为 dy）。 */
  const collectAnchors = useCallback(
    (box: HTMLElement) => {
      const lineTop = readLineTop(box)
      const rows = box.querySelectorAll<HTMLElement>('[data-entry-id]')
      const out: ScrollAnchor[] = []
      for (let i = 0; i < rows.length && out.length < ANCHOR_CANDIDATES; i++) {
        const el = rows[i]
        const id = el.dataset.entryId
        if (!id) continue
        const r = el.getBoundingClientRect()
        if (r.bottom <= lineTop + 1) continue
        out.push({ id, dy: r.top - lineTop })
      }
      return out
    },
    [readLineTop],
  )

  /**
   * 拍摄 prepend 前位置：行锚点（首选）+ height-delta 快照（兜底），并关掉
   * stick-to-bottom（避免 pinStreamScroll / ResizeObserver 把视口拽回底部）。
   */
  const captureScrollPosition = useCallback(() => {
    const box = boxRef.current
    if (!box) return
    followRef.current = false
    pendingRevealRef.current = null
    scrollSnapshotRef.current = {
      scrollHeight: box.scrollHeight,
      scrollTop: box.scrollTop,
    }
    // 视口里一条都没有（内容比视口短）时只剩 height-delta 兜底。
    anchorsRef.current = collectAnchors(box)
  }, [boxRef, collectAnchors, followRef])

  /** 宿主分页开始时的补拍：已有锚点就不重拍（手势时刻那次更早、更干净）。 */
  const ensureScrollPositionCaptured = useCallback(() => {
    if (anchorsRef.current.length || scrollSnapshotRef.current) {
      followRef.current = false
      return
    }
    captureScrollPosition()
  }, [captureScrollPosition, followRef])

  /** 放弃保持位置：用户接管方向盘 / 切会话。 */
  const cancelScrollSettle = useCallback(() => {
    settleUntilRef.current = 0
    momentumUntilRef.current = 0
    anchorsRef.current = []
    pendingRevealRef.current = null
    if (settleRafRef.current != null) {
      cancelAnimationFrame(settleRafRef.current)
      settleRafRef.current = null
    }
  }, [])

  /** 条目顶边相对可读区顶的当前偏移；条目不在 DOM 里返回 null。 */
  const anchorOffsetY = useCallback(
    (box: HTMLElement, id: string) => {
      const el = box.querySelector(`[data-entry-id="${id}"]`)
      if (!(el instanceof HTMLElement)) return null
      return el.getBoundingClientRect().top - readLineTop(box)
    },
    [readLineTop],
  )

  /**
   * 把锚点条目放回原视口偏移。只读候选条目的 rect，与 scrollHeight 无关
   * —— 顶部加载按钮换文案 / 卸载、workspace bar 涨高都污染不了它。
   * 最上面那条已被合并 / 删除时顺位退到下一条，并按当前视口重建候选。
   */
  const restoreScrollToAnchor = useCallback(
    (force = false) => {
      const box = boxRef.current
      const list = anchorsRef.current
      if (!box || !list.length) return false
      let drift: number | null = null
      for (const a of list) {
        const cur = anchorOffsetY(box, a.id)
        if (cur == null) continue
        drift = cur - a.dy
        break
      }
      if (drift == null) {
        anchorsRef.current = []
        return false
      }
      // 锚点接管了这次恢复，height-delta 快照作废（避免后续兜底重复补偿）。
      scrollSnapshotRef.current = null
      if (
        drift !== 0 &&
        (force || Math.abs(drift) >= ANCHOR_DRIFT_TOLERANCE_PX)
      ) {
        writeScrollTop(box, box.scrollTop + drift)
      }
      anchorsRef.current = collectAnchors(box)
      return true
    },
    [anchorOffsetY, boxRef, collectAnchors, writeScrollTop],
  )

  /**
   * 打开恢复窗口：前 ANCHOR_MOMENTUM_MS 逐帧钉回（那一下滚轮的剩余动量会在
   * 我们写完 scrollTop 之后继续拖动视口几十毫秒，必须在每帧 paint 前抹掉），
   * 之后靠内容 ResizeObserver 在 ANCHOR_SETTLE_MS 内补晚到的撑高。
   */
  const openSettleWindow = useCallback(() => {
    const now = Date.now()
    settleUntilRef.current = now + ANCHOR_SETTLE_MS
    momentumUntilRef.current = now + ANCHOR_MOMENTUM_MS
    if (settleRafRef.current != null) return
    const step = () => {
      settleRafRef.current = null
      if (!anchorsRef.current.length) return
      if (Date.now() > settleUntilRef.current) {
        anchorsRef.current = []
        return
      }
      restoreScrollToAnchor()
      if (Date.now() < momentumUntilRef.current && anchorsRef.current.length) {
        settleRafRef.current = requestAnimationFrame(step)
      }
    }
    settleRafRef.current = requestAnimationFrame(step)
  }, [restoreScrollToAnchor])

  /**
   * 看门狗入口：内容变高时（ResizeObserver / rAF）在窗口内按同一锚点重放
   * 恢复。窗口过期即丢弃锚点，之后不再干预。
   */
  const settleScrollAnchor = useCallback(() => {
    if (!anchorsRef.current.length) return
    if (Date.now() > settleUntilRef.current) {
      anchorsRef.current = []
      return
    }
    restoreScrollToAnchor()
  }, [restoreScrollToAnchor])

  /** 把条目顶对齐到 workspace bar 下沿（阅读起点）。 */
  const alignEntryUnderBar = useCallback(
    (box: HTMLElement, el: HTMLElement) => {
      const dy = el.getBoundingClientRect().top - readLineTop(box)
      if (Math.abs(dy) < ANCHOR_DRIFT_TOLERANCE_PX) return
      writeScrollTop(box, box.scrollTop + dy)
    },
    [readLineTop, writeScrollTop],
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
        writeScrollTop(box, snap.scrollTop + (box.scrollHeight - snap.scrollHeight))
        return true
      }
      if (anchorId) {
        const anchor = box.querySelector(`[data-entry-id="${anchorId}"]`)
        if (anchor instanceof HTMLElement) {
          alignEntryUnderBar(box, anchor)
          return true
        }
      }
      return false
    },
    [alignEntryUnderBar, boxRef, followRef, writeScrollTop],
  )

  /**
   * 新一轮装进视口 → 顶对齐完整展示；超出视口 → 只保持位置，不滚动不跳。
   * 必须在目标 DOM 已挂载后调用。
   */
  const settleFitOrKeep = useCallback(
    (
      box: HTMLElement,
      targetEl: HTMLElement,
      anchorId?: string | null,
    ): 'revealed' | 'kept' => {
      followRef.current = false
      // 先把视口放回「无跳跃」基线（行锚点优先，height-delta 兜底），
      // 再量高（量高依赖稳定后的布局）。
      if (!restoreScrollToAnchor(true)) restoreScrollAfterPrepend(anchorId)

      const barH =
        wsBarElRef.current?.getBoundingClientRect().height ?? wsBarH
      const available = Math.max(0, box.clientHeight - barH)
      const lineTop = readLineTop(box)
      const yOf = (el: HTMLElement) =>
        el.getBoundingClientRect().top - lineTop + box.scrollTop
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
        // 顶对齐后按新视口重建锚点候选：晚到的撑高继续把这一轮钉在 bar 下沿。
        anchorsRef.current = collectAnchors(box)
        openSettleWindow()
        return 'revealed'
      }
      // 超出：保持基线位置，视口不跳。
      openSettleWindow()
      return 'kept'
    },
    [
      alignEntryUnderBar,
      collectAnchors,
      followRef,
      openSettleWindow,
      readLineTop,
      restoreScrollAfterPrepend,
      restoreScrollToAnchor,
      wsBarElRef,
      wsBarH,
    ],
  )

  /**
   * 宿主加载上一轮：新内容 prepend 到 anchor 之前。
   *
   * - `mode='keep'`（滚轮/触摸拉出来的）→ 只把视口钉回原处，永不顶对齐
   * - `mode='reveal'`（点击）→ 目标 = prepend 段**第一条** user（新一轮
   *   开头；勿用 last-before-anchor）：
   *   - 新一轮高度 ≤ 视口 → 顶对齐完整展示
   *   - 超出视口 → 只保持位置，不滚动不跳
   *   - 纯工具续翻页（无 user）→ 只保持位置
   */
  const revealPrependedTurn = useCallback(
    (
      anchorId?: string | null,
      mode: TurnSettleMode = 'keep',
    ): 'revealed' | 'pending' | 'kept' | 'noop' => {
      const box = boxRef.current
      if (!box) return 'noop'
      followRef.current = false

      if (mode === 'keep') {
        if (!restoreScrollToAnchor(true)) restoreScrollAfterPrepend(anchorId)
        pendingRevealRef.current = null
        openSettleWindow()
        return 'kept'
      }

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
        // 本页无 user（工具流续翻）：只保持位置。
        if (!targetId) {
          if (!restoreScrollToAnchor(true)) restoreScrollAfterPrepend(anchorId)
          pendingRevealRef.current = null
          openSettleWindow()
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
        if (!restoreScrollToAnchor(true)) restoreScrollAfterPrepend(anchorId)
        return 'kept'
      }

      const el = box.querySelector(`[data-entry-id="${targetId}"]`)
      if (el instanceof HTMLElement) {
        pendingRevealRef.current = null
        return settleFitOrKeep(box, el, anchorId)
      }
      // DOM 未齐：保留锚点，下一帧再 settle。
      pendingRevealRef.current = { targetId, anchorId, mode }
      return 'pending'
    },
    [
      boxRef,
      entries,
      followRef,
      openSettleWindow,
      restoreScrollAfterPrepend,
      restoreScrollToAnchor,
      settleFitOrKeep,
    ],
  )

  return {
    pendingRevealRef,
    captureScrollPosition,
    ensureScrollPositionCaptured,
    cancelScrollSettle,
    isProgrammaticScroll,
    settleScrollAnchor,
    restoreScrollAfterPrepend,
    settleFitOrKeep,
    revealPrependedTurn,
  }
}
