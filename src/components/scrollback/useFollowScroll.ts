import {
  useCallback,
  useEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from 'react'
import type { ScrollEntry } from '../../api/types'
import { useChatStore } from '../../store/chat'
import { uiBool } from '../../store/settings'

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
  const scrollToBottom = useCallback(
    (force = false) => {
      const box = boxRef.current
      if (!box) return
      if (!force && !followRef.current) return
      box.scrollTop = box.scrollHeight
      lastScrollTopRef.current = box.scrollTop
      scheduleUpdatePinned()
    },
    [boxRef, followRef, lastScrollTopRef, scheduleUpdatePinned],
  )
  const pinStreamScroll = useCallback(() => {
    scrollToBottom(false)
    const bodyEl = streamBodyRef.current
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight
  }, [scrollToBottom, streamBodyRef])
  // Content height changes:
  // - while following → re-pin bottom (session-switch after historyLoadedAt,
  //   late markdown/mermaid/image paint, streaming growth without entry churn)
  // - always → recompute sticky pin (RO scrollTop writes may not fire onScroll;
  //   late growth past the user row must flip pinned without a user gesture)
  // Sticky overlay is out-of-flow so it does not feed this observer
  // (no pin↔height loop).
  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (followRef.current) scrollToBottom(true)
      else {
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
  ])
  // 发送消息（新的 user 行落到末尾，含 `!` 直执行）→ 视口跳回最新位置。
  // TUI [ui] page_flip_on_send（默认 true）：把刚发的 prompt 钉到视口
  // 顶部，响应从新的一页开始；false 时直接回到底部。只看 id 变化，历史
  // prepend / 流式 flush 不触发；回放追加的 user 行（id ≠ lastSentPromptId）
  // 走普通回底。
  //
  // page-flip 后 follow **不**立即 re-arm（TUI pin_reserve 语义）：保持
  // 顶对齐位置，等首个流式内容真正到达（entries 增长 / liveStream 增长）
  // 才重新跟随回底——否则响应一 stream 就被拽回底部，page-flip 形同虚设。
  const lastSentPromptId = useChatStore((s) => s.lastSentPromptId)
  const lastUserEntryIdRef = useRef<string | null>(null)
  // pin_reserve：>=0 表示 page-flip 已钉顶、等待首个流式内容。值 = flip
  // 时刻的 entries.length（发送那次 commit 里 entries effect 也会跑——
  // 只认「条目数超过 flip 基线」的增长，避免自己把自己解除）。
  const flipBaseRef = useRef(-1)
  useEffect(() => {
    const last = entries[entries.length - 1]
    if (last?.kind !== 'user') return
    if (lastUserEntryIdRef.current === last.id) return
    lastUserEntryIdRef.current = last.id
    if (last.id === lastSentPromptId && uiBool('page_flip_on_send', true)) {
      const box = boxRef.current
      const el = box?.querySelector(
        `[data-entry-id="${last.id}"]`,
      ) as HTMLElement | null
      if (box && el) {
        // Prompt top aligns with the viewport top; hold here until the
        // first stream content arrives (flipBase release below).
        followRef.current = false
        flipBaseRef.current = entries.length
        box.scrollTop +=
          el.getBoundingClientRect().top - box.getBoundingClientRect().top
        lastScrollTopRef.current = box.scrollTop
        return
      }
    }
    flipBaseRef.current = -1
    followRef.current = true
    scrollToBottom(true)
  }, [boxRef, entries, followRef, lastScrollTopRef, lastSentPromptId, scrollToBottom])
  // Entries 增长（首个回答/工具行落地）→ 解除 pin_reserve，恢复跟随；
  // 条目缩水（会话切换清场）同样解除。
  useEffect(() => {
    if (flipBaseRef.current >= 0 && entries.length !== flipBaseRef.current) {
      flipBaseRef.current = -1
      followRef.current = true
    }
    pinStreamScroll()
  }, [entries, displayRowCount, followRef, pinStreamScroll])
  useEffect(() => {
    return useChatStore.subscribe((s, prev) => {
      if (s.liveStream?.text === prev.liveStream?.text) return
      if (flipBaseRef.current >= 0) {
        flipBaseRef.current = -1
        followRef.current = true
      }
      pinStreamScroll()
    })
  }, [followRef, pinStreamScroll])

  return { scrollToBottom, pinStreamScroll }
}
