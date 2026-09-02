import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type TouchEvent as ReactTouchEvent,
  type RefObject,
} from 'react'
import type { ScrollEntry } from '../../api/types'
import { useChatStore } from '../../store/chat'
import type { TurnSettleMode } from './useScrollRestore'
import {
  PULL_DWELL_MS,
  PULL_IDLE_MS,
  PULL_TRIGGER_PX,
  TOP_EDGE_PX,
  TOP_PAGE_COOLDOWN_MS,
  TOUCH_UP_SWIPE_PX,
} from './constants'

/** wheel deltaY → 像素（Firefox 按行、按页上报时换算）。 */
function wheelDeltaPx(e: WheelEvent, box: HTMLDivElement) {
  const d = e.deltaY
  if (e.deltaMode === 1) return d * 16
  if (e.deltaMode === 2) return d * (box.clientHeight || 400)
  return d
}

/**
 * 「加载上一轮」触发纪律。
 *
 * 设计目标：只有「已经顶到边界、还在继续往上拉」才算翻页意图。
 * - onScroll **不再**触发任何加载（旧实现只要 scrollTop<80 就翻，短内容
 *   时读一行翻一页）。
 * - 滚轮走累加器：顶到边界（scrollTop ≤ TOP_EDGE_PX）后先停过停留窗口，
 *   再累计上推 PULL_TRIGGER_PX 像素才翻一页，且一次连续手势最多一页。真要
 *   翻页的那一下用非 passive 原生监听 preventDefault 掉——交给浏览器滚的话，
 *   它那条平滑滚动会在 prepend 落地后继续把视口往上拖（实测 41px），刚恢复
 *   好的位置又白恢复一次。
 * - 点击（顶部按钮 / sticky 头）= explicit：绕过冷却，并按 'reveal' 落位。
 */
export function useHistoryPaging(
  boxRef: RefObject<HTMLDivElement | null>,
  entries: ScrollEntry[],
  historyHasMore: boolean,
  historyLoadingMore: boolean,
  historyPrependedAt: number | undefined,
  loadMoreHistory: (anchorId?: string) => void,
  captureScrollPosition: () => void,
  ensureScrollPositionCaptured: () => void,
  cancelScrollSettle: () => void,
) {
  const cooldownUntilRef = useRef(0)
  // 边界上累计的上推像素（同一连续手势内叠加）。
  const pullAccumRef = useRef(0)
  const pullAtRef = useRef(0)
  /**
   * 到边界后多久才允许开始累计。滚到顶的那几下 wheel 与「到顶后还想看更早
   * 的」上拉在数据上无法区分，用停留窗口分开：到顶 → 手势停一下 → 再拉。
   */
  const pullReadyAtRef = useRef(0)
  // 一次连续手势只翻一页，直到手势断流（> PULL_IDLE_MS）或用户滚离边界。
  const burstFiredRef = useRef(false)
  // 本次翻页手势的落位模式，由 historyPrependedAt 的 settle 分支消费。
  const pagingModeRef = useRef<TurnSettleMode>('keep')
  // Touch gesture tracking (swipe down = scroll up toward older history).
  const touchStartYRef = useRef<number | null>(null)
  const touchYRef = useRef<number | null>(null)

  const resetPull = useCallback(() => {
    pullAccumRef.current = 0
    burstFiredRef.current = false
  }, [])

  /**
   * 宿主分页开始（含自动续翻中间页 / sticky 触发）：DOM 仍是旧内容时补拍
   * 一次位置快照，已有锚点则只关跟随。
   */
  const prevLoadingMoreRef = useRef(historyLoadingMore)
  const prependedAtAtStartRef = useRef(historyPrependedAt)
  useLayoutEffect(() => {
    const was = prevLoadingMoreRef.current
    prevLoadingMoreRef.current = historyLoadingMore
    if (!was && historyLoadingMore) {
      prependedAtAtStartRef.current = historyPrependedAt
      // 目录跳转的批量翻页：不捕捉位置锚点（终点是目标轮，锚点恢复会在
      // 跳转滚动落地后把视口拉回原处）。
      if (useChatStore.getState().historyJumpSeq != null) return
      ensureScrollPositionCaptured()
    }
  }, [ensureScrollPositionCaptured, historyLoadingMore, historyPrependedAt])

  /** fetch 结束：成功落地 → 挂冷却不许连锁翻页；失败 / no-op → 立刻可重试。
   *  这一条 transition 只有本 effect 处理（旧实现另有一个 layout 阶段的
   *  markCooldown 和一个无条件 re-arm 的 passive effect，后者总在前者之后
   *  把门重新推开 → prepend 落地 400ms 后一次微小滚动又翻一页）。 */
  const prevLoadingMoreForRetryRef = useRef(historyLoadingMore)
  useEffect(() => {
    const was = prevLoadingMoreForRetryRef.current
    prevLoadingMoreForRetryRef.current = historyLoadingMore
    if (!was || historyLoadingMore) return
    if (historyPrependedAt === prependedAtAtStartRef.current) {
      cooldownUntilRef.current = 0
      resetPull()
    } else {
      cooldownUntilRef.current = Date.now() + TOP_PAGE_COOLDOWN_MS
    }
  }, [historyLoadingMore, historyPrependedAt, resetPull])

  /**
   * @param mode `'keep'` = 滚轮/触摸拉出来的（只保持视口）；
   *             `'reveal'` = 用户点击（短轮顶对齐展示，绕过冷却 + 门闩）。
   */
  const maybeLoadOlderHistory = useCallback(
    (mode: TurnSettleMode = 'keep') => {
      const box = boxRef.current
      if (!box) return
      if (mode !== 'reveal' && Date.now() < cooldownUntilRef.current) return
      // 仅宿主历史分页（DOM 已全量挂载，无本地扩窗）。
      if (!historyHasMore || historyLoadingMore) {
        resetPull()
        return
      }
      pagingModeRef.current = mode
      pullAccumRef.current = 0
      burstFiredRef.current = true
      // 拍位置必须在发请求前：DOM 还是旧内容，锚点才是用户正在读的那一行。
      captureScrollPosition()
      // Anchor = store head before prepend（见 sticky 触发器同款注释）。
      const storeHeadId = entries[0]?.id
      void loadMoreHistory(storeHeadId)
      // loadMoreHistory 同步设 historyLoadingMore，早退（竞态 / 缺 session
      // meta）时没设——别把手势门闩卡在关上。
      if (!useChatStore.getState().historyLoadingMore) {
        burstFiredRef.current = false
      }
    },
    [
      boxRef,
      captureScrollPosition,
      entries,
      historyHasMore,
      historyLoadingMore,
      loadMoreHistory,
      resetPull,
    ],
  )

  const onPagingWheel = useCallback(
    (e: WheelEvent) => {
      // 用户接管方向盘：本次加载的位置保持到此为止。
      cancelScrollSettle()
      const box = boxRef.current
      if (!box) return
      const dy = wheelDeltaPx(e, box)
      if (dy >= 0 || box.scrollTop > TOP_EDGE_PX) {
        // 还在正常阅读（没顶到边界）/ 向下滚 → 什么都不触发。
        pullAccumRef.current = 0
        return
      }
      const now = Date.now()
      // 刚到边界：把「一路滚到顶」的那几下让过去——每一下都续期，所以必须真
      // 停手 PULL_DWELL_MS 才开始累计（连着推就一直不算上拉）。
      if (now < pullReadyAtRef.current) {
        pullAccumRef.current = 0
        pullReadyAtRef.current = now + PULL_DWELL_MS
        return
      }
      if (now - pullAtRef.current > PULL_IDLE_MS) resetPull()
      pullAtRef.current = now
      pullAccumRef.current += -dy
      // 边界上的上推由本组件消费（仅这次真翻页的）。交给浏览器滚的话，它那条
      // 平滑滚动会在 prepend 落地之后继续把视口往上拖（实测 41px），刚恢复好
      // 的位置等于白恢复；没到阈值的手势照常交回浏览器，条目内部的滚动区不会
      // 被误伤。
      const willFire =
        !burstFiredRef.current && pullAccumRef.current >= PULL_TRIGGER_PX
      if (willFire) e.preventDefault()
      if (!willFire) return
      maybeLoadOlderHistory('keep')
    },
    [boxRef, cancelScrollSettle, maybeLoadOlderHistory, resetPull],
  )

  // 原生非 passive 监听：React 把 onWheel 挂成 passive，preventDefault 无效。
  const wheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {})
  useEffect(() => {
    wheelHandlerRef.current = onPagingWheel
  })
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (e: WheelEvent) => wheelHandlerRef.current(e)
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [boxRef])

  /**
   * onScroll 只做边界簿记：离开边界清零累加器、到达边界起算停留窗口。
   * **不**再发起任何加载，也不解一次手势门闩（门闩只由手势断流解开）。
   */
  const onPagingScroll = useCallback(() => {
    const box = boxRef.current
    if (!box) return
    if (box.scrollTop > TOP_EDGE_PX) {
      pullAccumRef.current = 0
      pullReadyAtRef.current = 0
    } else {
      pullReadyAtRef.current = Date.now() + PULL_DWELL_MS
    }
  }, [boxRef])

  const onPagingTouchStart = useCallback(
    (e: ReactTouchEvent<HTMLDivElement>) => {
      cancelScrollSettle()
      const y = e.touches[0]?.clientY ?? null
      touchStartYRef.current = y
      touchYRef.current = y
    },
    [cancelScrollSettle],
  )

  const onPagingTouchMove = useCallback(
    (e: ReactTouchEvent<HTMLDivElement>) => {
      cancelScrollSettle()
      const y = e.touches[0]?.clientY
      if (y == null) return
      touchYRef.current = y
      const box = boxRef.current
      // 只在「已经顶到边界」之后累计位移：中途从内容里拖到顶不算。
      if (box && box.scrollTop > TOP_EDGE_PX) touchStartYRef.current = y
    },
    [boxRef, cancelScrollSettle],
  )

  const onPagingTouchEnd = useCallback(() => {
    const start = touchStartYRef.current
    const end = touchYRef.current
    touchStartYRef.current = null
    touchYRef.current = null
    const box = boxRef.current
    if (!box) return
    // Finger dragged down = scroll up (older history); with no scrollbar
    // this gesture is the only way to page.
    if (
      start != null &&
      end != null &&
      end > start + TOUCH_UP_SWIPE_PX &&
      box.scrollTop <= TOP_EDGE_PX
    ) {
      maybeLoadOlderHistory('keep')
    }
  }, [boxRef, maybeLoadOlderHistory])

  return {
    pagingModeRef,
    onPagingScroll,
    onPagingTouchStart,
    onPagingTouchMove,
    onPagingTouchEnd,
    maybeLoadOlderHistory,
  }
}
