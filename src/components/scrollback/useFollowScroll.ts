import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from 'react'
import type { ScrollEntry } from '../../api/types'
import { useChatStore } from '../../store/chat'
import { uiBool } from '../../store/settings'
import { cancelSmoothScroll, smoothScrollTop } from '../../lib/smoothScroll'
import {
  PIN_RELEASE_EVENT,
  pinReserveConsumed,
  pinReservePad,
  pinScrollTarget,
} from '../../scrollback/pinReserve'

export function useFollowScroll(
  boxRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  followRef: MutableRefObject<boolean>,
  lastScrollTopRef: MutableRefObject<number>,
  streamBodyRef: MutableRefObject<HTMLDivElement | null>,
  scheduleUpdatePinned: () => void,
  /** 历史翻页锚点看门狗：内容变高时把视口拉回正在读的那一行。 */
  settleScrollAnchor: () => void,
  entries: ScrollEntry[],
  displayRowCount: number,
  /** page-flip 的底部留白宿主（TUI `pin_reserve` 的 DOM 对应物）。 */
  pinPadRef: RefObject<HTMLDivElement | null>,
  /** workspace bar：可读区顶 = bar 下沿（page-flip 与 sticky 共用这条线）。 */
  wsBarElRef: MutableRefObject<HTMLDivElement | null>,
  wsBarH: number,
) {
  // Auto-follow only when near bottom (every mounted row is at real
  // height — full entry list mounted, no content-visibility
  // placeholders — so a direct scrollTop write lands exactly at the tail).
  //
  // Prefer `box.scrollTop = scrollHeight` over scrollIntoView: the latter
  // can race nested sticky headers / incomplete layout and is noisier with
  // intermediate scroll events. Sync lastScrollTopRef so onScroll does not
  // treat a programmatic jump as a user gesture.
  //
  // Entries / row-count changes re-run via React effect. liveStream text
  // growth must NOT re-render Scrollback — subscribe outside React and
  // pin the bottom / thought body from refs only. Async height growth
  // (sticky pin mount, mermaid, images, long markdown layout) is covered
  // by the content ResizeObserver below while follow is armed.
  //
  // Always schedule sticky recompute after programmatic scroll: browsers
  // often suppress the `scroll` event when scrollTop is written from a
  // ResizeObserver / layout-effect path. After history replay the last
  // assistant can grow for several frames (markdown / images / mermaid);
  // stick-to-bottom would re-pin the tail while sticky still thought the
  // user prompt was on-screen (first-frame short height → no pin).
  const barHeight = useCallback(
    () => wsBarElRef.current?.getBoundingClientRect().height ?? wsBarH,
    [wsBarElRef, wsBarH],
  )

  const setPadHeight = useCallback(
    (px: number) => {
      const el = pinPadRef.current
      if (!el) return
      const next = `${Math.max(0, Math.round(px))}px`
      if (el.style.height !== next) el.style.height = next
    },
    [pinPadRef],
  )

  /** 已钉到可读区顶的 prompt 行 id；null = 没有留白。 */
  const pinIdRef = useRef<string | null>(null)

  const releasePin = useCallback(() => {
    pinIdRef.current = null
    setPadHeight(0)
  }, [setPadHeight])

  /**
   * 重算 page-flip 留白，返回 prompt 的顶对齐 scrollTop（未钉住 = null）。
   *
   * 留白 = 钉位 + 视口高 − 内容高，让「prompt 顶 == 滚动底」成立。TUI
   * page_flip_to_entry 靠 pin_reserve 底垫把顶对齐撑成真正的滚动底；没有
   * 这段留白，刚发完消息时 prompt 就是末条，顶对齐写入必被浏览器钳到底，
   * 于是「发送后翻页」看起来完全没生效。回答长高时留白同步收缩；写满
   * 一页（内容已越过钉位）即解除，回到贴底跟随。
   *
   * 内容高取留白块的 `offsetTop`（它紧跟转录，且自己的高度不影响该值）：
   * 转录比视口短时 `scrollHeight` 会被撑到视口高，用它算会把留白算多。
   */
  const syncPinPad = useCallback((): number | null => {
    const box = boxRef.current
    const id = pinIdRef.current
    const padEl = pinPadRef.current
    if (!box || !id) return null
    const el = box.querySelector(
      `[data-entry-id="${id}"]`,
    ) as HTMLElement | null
    if (!el || !padEl) {
      // 行已不在（会话切换 / 回放替换）：留白没有落点。
      releasePin()
      return null
    }
    const target = pinScrollTarget(
      box.scrollTop,
      el.getBoundingClientRect().top,
      box.getBoundingClientRect().top,
      barHeight(),
    )
    const contentH = padEl.offsetTop
    if (pinReserveConsumed(target, box.clientHeight, contentH)) {
      releasePin()
      return null
    }
    setPadHeight(pinReservePad(target, box.clientHeight, contentH))
    return target
  }, [barHeight, boxRef, pinPadRef, releasePin, setPadHeight])

  /** liveStream 挂着的这段时间里，换行撑高走逐帧缓动；其余滚动照旧瞬时。 */
  const smoothFollowRef = useRef(false)
  useEffect(
    () => () => {
      cancelSmoothScroll(boxRef.current)
      cancelSmoothScroll(streamBodyRef.current)
    },
    [boxRef, streamBodyRef],
  )

  const scrollToBottom = useCallback(
    (force = false, smooth = false) => {
      const box = boxRef.current
      if (!box) return
      if (!force && !followRef.current) return
      // 钉住期间「滚动底」就是 prompt 顶：留白先同步，再写落点。
      const pinTarget = syncPinPad()
      const target = pinTarget ?? Math.max(0, box.scrollHeight - box.clientHeight)
      // 小步增长（换行撑高）逐帧滑过去；其余（切会话 / 翻页 / 恢复）
      // 仍瞬时落位，避免把本来要一次到位的历史恢复拖成慢动画。
      if (smooth && Math.abs(target - box.scrollTop) <= 160) {
        smoothScrollTop(box, target, {
          isActive: () => followRef.current,
        })
      } else {
        cancelSmoothScroll(box)
        box.scrollTop = target
      }
      lastScrollTopRef.current = box.scrollTop
      scheduleUpdatePinned()
    },
    [
      boxRef,
      followRef,
      lastScrollTopRef,
      scheduleUpdatePinned,
      syncPinPad,
    ],
  )
  const pinStreamScroll = useCallback(
    (smooth = false) => {
      scrollToBottom(false, smooth)
      const bodyEl = streamBodyRef.current
      if (bodyEl && smooth) {
        // 思考预览体自己有一个 ResizeObserver 在提交后钉底；这里只在
        // liveStream 增长时补一次平滑目标，不能再 write scrollTop，否则
        // 会和正文实际提交的时序打架，造成跳变。
        const target = Math.max(0, bodyEl.scrollHeight - bodyEl.clientHeight)
        smoothScrollTop(bodyEl, target, { isActive: () => followRef.current })
      }
    },
    [followRef, scrollToBottom, streamBodyRef],
  )
  // Content height changes:
  // - while following → re-pin bottom (session-switch after historyLoadedAt,
  //   late markdown/mermaid/image paint, streaming growth without entry churn)
  // - always → recompute sticky pin (RO scrollTop writes may not fire onScroll;
  //   late growth past the user row must flip pinned without a user gesture)
  // Sticky overlay is out-of-flow so it does not feed this observer
  // (no pin↔height loop). The page-flip pad lives OUTSIDE this wrapper so
  // resizing it never re-enters here.
  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (followRef.current) scrollToBottom(true, smoothFollowRef.current)
      else {
        // 阅读历史时留白也要跟着内容高走：滚回底部才落得回同一页。
        syncPinPad()
        // prepend 后晚到的撑高（图片解码 / mermaid / 长 markdown）会二次挪
        // 动视口；看门狗窗口内按同一行锚点拉回，窗口外什么都不做。
        settleScrollAnchor()
        scheduleUpdatePinned()
      }
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [
    contentRef,
    followRef,
    scheduleUpdatePinned,
    scrollToBottom,
    settleScrollAnchor,
    syncPinPad,
  ])
  // 视口尺寸变化（窗口 / 移动端键盘 / composer 长高）会改可读区高度，
  // 钉住的落点随之变化：重算留白并落回 prompt 顶。
  useEffect(() => {
    const onResize = () => {
      if (pinIdRef.current == null) return
      if (followRef.current) scrollToBottom(true)
      else syncPinPad()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [followRef, scrollToBottom, syncPinPad])
  // 显式回底手势（G）：TUI goto_bottom 先释放 pin_reserve 再落真实尾部，
  // 否则「回底」只会回到钉住的那一页。
  useEffect(() => {
    const onRelease = () => releasePin()
    window.addEventListener(PIN_RELEASE_EVENT, onRelease)
    return () => window.removeEventListener(PIN_RELEASE_EVENT, onRelease)
  }, [releasePin])
  // 发送消息（新的 user 行落到末尾，含 `!` 直执行）→ 视口跳回最新位置。
  // TUI [ui] page_flip_on_send（默认 true）：把刚发的 prompt 钉到可读区
  // 顶部（workspace bar 下沿），响应从新的一页开始；false 时直接回到底部。
  // 只看 id 变化，历史 prepend / 流式 flush 不触发；回放追加的 user 行
  // （id ≠ lastSentPromptId）走普通回底。`!` 直执行在 TUI 里是 synthetic
  // 回合（follow_new_turn 不带 prompt），只回底、不翻页。
  //
  // layout effect：留白必须在首帧前就位，否则顶对齐先被钳到底、下一帧
  // 再跳回顶部，视觉上就是一次闪烁。
  const lastSentPromptId = useChatStore((s) => s.lastSentPromptId)
  const lastUserEntryIdRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    // 钉住的行被移除（会话切换 / 回放替换）→ 留白没有落点。
    if (
      pinIdRef.current != null &&
      !entries.some((e) => e.id === pinIdRef.current)
    ) {
      releasePin()
    }
    const last = entries[entries.length - 1]
    if (last?.kind !== 'user') return
    if (lastUserEntryIdRef.current === last.id) return
    lastUserEntryIdRef.current = last.id
    const flip =
      !last.isShell &&
      last.id === lastSentPromptId &&
      uiBool('page_flip_on_send', true)
    const box = boxRef.current
    if (flip && box) {
      const el = box.querySelector(
        `[data-entry-id="${last.id}"]`,
      ) as HTMLElement | null
      if (el) {
        pinIdRef.current = last.id
        followRef.current = true
        scrollToBottom(true)
        return
      }
    }
    releasePin()
    followRef.current = true
    scrollToBottom(true)
  }, [boxRef, entries, followRef, lastSentPromptId, releasePin, scrollToBottom])
  // 条目增长（工具行落地 / 分组重排）→ 同步落点：跟随时仍停在这一页
  // （钉住）或尾部；阅读历史时只重算留白，视口不动。
  useLayoutEffect(() => {
    if (pinIdRef.current != null && !entries.some((e) => e.id === pinIdRef.current)) {
      releasePin()
    }
    pinStreamScroll()
    if (pinIdRef.current != null && !followRef.current) syncPinPad()
  }, [
    entries,
    displayRowCount,
    followRef,
    pinStreamScroll,
    releasePin,
    syncPinPad,
  ])
  // 流式正文增长（不新增条目）→ 同一套跟随/留白收口。
  useEffect(() => {
    return useChatStore.subscribe((s, prev) => {
      if (s.liveStream === prev.liveStream) return
      smoothFollowRef.current = s.liveStream != null
      if (s.liveStream?.text === prev.liveStream?.text) {
        if (s.liveStream == null) pinStreamScroll(false)
        return
      }
      pinStreamScroll(s.liveStream != null)
    })
  }, [pinStreamScroll])

  return { scrollToBottom, pinStreamScroll }
}
