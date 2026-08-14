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
import { TOP_PAGE_COOLDOWN_MS } from './constants'

export function useHistoryPaging(
  boxRef: RefObject<HTMLDivElement | null>,
  followRef: MutableRefObject<boolean>,
  entries: ScrollEntry[],
  historyHasMore: boolean,
  historyLoadingMore: boolean,
  loadMoreHistory: (anchorId?: string) => void,
  captureScrollSnapshot: () => void,
  scrollSnapshotRef: MutableRefObject<{ scrollHeight: number; scrollTop: number } | null>,
) {
  // ── Scroll-up paging gates (see maybeLoadOlderHistory) ──────────
  const topPageArmedRef = useRef(true)
  const topPageCooldownRef = useRef(0)
  // Touch gesture tracking (swipe down = scroll up toward older history).
  const touchStartYRef = useRef<number | null>(null)
  const touchYRef = useRef<number | null>(null)

  // 宿主分页开始（含自动续翻中间页）：DOM 仍是旧内容时再拍一次快照。
  // 覆盖 sticky / 按钮 / 滚轮 漏拍，以及 loadMoreHistory 链式续翻
  // （中间页没有 maybeLoadOlderHistory 入口）。
  const prevLoadingMoreForSnapRef = useRef(historyLoadingMore)
  useLayoutEffect(() => {
    const was = prevLoadingMoreForSnapRef.current
    prevLoadingMoreForSnapRef.current = historyLoadingMore
    if (!was && historyLoadingMore) {
      // Only capture when we don't already have a gesture-time snapshot
      // (prefer the earlier, pre-any-loading-UI measurement).
      if (!scrollSnapshotRef.current) captureScrollSnapshot()
      else followRef.current = false
    }
  }, [captureScrollSnapshot, followRef, historyLoadingMore, scrollSnapshotRef])

  // Re-arm after ANY paging attempt finishes (success or failure): a
  // failed fetch can be retried with the next gesture; a successful one
  // is gated by the prepend cooldown above.
  const prevLoadingMoreRef = useRef(historyLoadingMore)
  useEffect(() => {
    if (prevLoadingMoreRef.current && !historyLoadingMore) {
      topPageArmedRef.current = true
    }
    prevLoadingMoreRef.current = historyLoadingMore
  }, [historyLoadingMore])

  /**
   * Scroll-up paging gate: one page per visit to the top region.
   *
   * Gesture path (`explicit=false`): armed once per visit to the top;
   * re-armed when the user scrolls away (scrollTop≥80) or a host fetch
   * finishes. Cooldown blocks the post-prepend restore scroll from
   * chaining pages.
   *
   * Explicit path (`explicit=true`, button / sticky click): bypasses both
   * armed + cooldown. Critical when many tools are verb-collapsed and the
   * list barely (or doesn't) overflow — a prior gesture can leave
   * topPageArmed=false with no way to re-arm via scrollTop≥80, so click
   * and further wheel-up would silently no-op.
   *
   * Only disarm while a real host fetch is in flight. No-op returns
   * (nothing to load / already loading) keep or restore armed so the
   * next gesture still works.
   */
  const maybeLoadOlderHistory = useCallback((explicit = false) => {
    const box = boxRef.current
    if (!box) return
    if (!explicit) {
      if (!topPageArmedRef.current) return
      if (Date.now() < topPageCooldownRef.current) return
    }
    // 仅宿主历史分页（DOM 已全量挂载，无本地扩窗）。
    if (!historyHasMore || historyLoadingMore) {
      // Nothing started — do not leave the gate latched shut (especially
      // when content fits the viewport and scrollTop never reaches 80).
      topPageArmedRef.current = true
      return
    }
    // Host fetch: disarm only while a real request is in flight.
    // loadMoreHistory sets historyLoadingMore synchronously before its
    // first await; if it early-returns (race / missing session meta),
    // re-arm immediately — otherwise collapsed short lists (scrollTop
    // never reaches 80) stay permanently unable to page.
    topPageArmedRef.current = false
    captureScrollSnapshot()
    // Anchor = store head before prepend（见 sticky 触发器同款注释）。
    const storeHeadId = entries[0]?.id
    void loadMoreHistory(storeHeadId)
    if (!useChatStore.getState().historyLoadingMore) {
      topPageArmedRef.current = true
    }
  }, [
    boxRef,
    captureScrollSnapshot,
    entries,
    historyHasMore,
    historyLoadingMore,
    loadMoreHistory,
  ])

  const markCooldown = useCallback(() => {
    topPageCooldownRef.current = Date.now() + TOP_PAGE_COOLDOWN_MS
    topPageArmedRef.current = false
  }, [])

  const rearmPaging = useCallback(() => {
    topPageArmedRef.current = true
  }, [])

  return {
    topPageArmedRef,
    topPageCooldownRef,
    touchStartYRef,
    touchYRef,
    maybeLoadOlderHistory,
    markCooldown,
    rearmPaging,
  }
}
