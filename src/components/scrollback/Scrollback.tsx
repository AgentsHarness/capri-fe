import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ScrollEntry } from '../../api/types'
import { userMessagePreview } from '../../format'
import { useChatStore } from '../../store/chat'
import { displayRowKey, isDensePackableRow, spanContaining } from '../../scrollback/verbGroup'
import { SPINNER_FRAMES } from '../../theme/glyphs'
import { COLUMN_PAD_X_CLASS, CONTENT_COLUMN_CLASS } from '../../theme/layout'
import { UserMessageNav, type UserMessageNavItem } from '../UserMessageNav'
import { WorkspaceBar } from '../TopBar'
import { EmptyStatePicker } from './EmptyState'
import { EntryView } from './EntryView'
import { GroupHeaderView } from './GroupHeaderView'
import { StickyPrompt } from './StickyPrompt'
import { TOUCH_UP_SWIPE_PX } from './constants'
import { useDisplayRows, useStreamingThoughtId } from './useDisplayRows'
import { useFinishFlash } from './useFinishFlash'
import { useFollowScroll } from './useFollowScroll'
import { useHistoryPaging } from './useHistoryPaging'
import { useLoadChrome } from './useLoadChrome'
import { useScrollRestore } from './useScrollRestore'
import { useStickyPin } from './useStickyPin'
import { useWorkspaceBar } from './useWorkspaceBar'

/**
 * Scrollback — Grok Build TUI block model:
 * selection (j/k), ←/→ collapse/expand, full accent matrix
 * (tool families, finish flash, pending freeze, per-row wave).
 */
export function Scrollback({ onOpenMcp }: { onOpenMcp?: () => void }) {
  const entries = useChatStore((s) => s.entries)
  // No active session (deleted the current one / fresh boot): show the
  // empty-state hint instead of a blank scrollback.
  const sessionId = useChatStore((s) => s.sessionId)
  // liveStream is NOT selected here — text growth must not re-render the
  // whole tree. Streaming EntryView rows subscribe themselves; auto-follow
  // uses useChatStore.subscribe (see effect below).
  const selectedId = useChatStore((s) => s.selectedId)
  const focusMode = useChatStore((s) => s.focusMode)
  const pending = useChatStore((s) => s.pending)
  const expandedGroups = useChatStore((s) => s.expandedGroups)
  const historyLoadedAt = useChatStore((s) => s.historyLoadedAt)
  const historyHasMore = useChatStore((s) => s.historyHasMore)
  const historyLoading = useChatStore((s) => s.historyLoading)
  const historyLoadingMore = useChatStore((s) => s.historyLoadingMore)
  const historyLoadError = useChatStore((s) => s.historyLoadError)
  const historyPrependedAt = useChatStore((s) => s.historyPrependedAt)
  const historyAnchorId = useChatStore((s) => s.historyAnchorId)
  const toggleGroupExpansion = useChatStore((s) => s.toggleGroupExpansion)
  const loadMoreHistory = useChatStore((s) => s.loadMoreHistory)
  const selectEntry = useChatStore((s) => s.selectEntry)

  const bottomRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  /** Fade wrapper around history rows — ResizeObserver target for stick-to-bottom. */
  const contentRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  // Last scrollTop seen, to tell "user scrolled UP" (unfollow, no matter
  // how small the distance — a sub-80px scroll must not keep following)
  // from "scrolled to the bottom" (re-follow).
  const lastScrollTopRef = useRef(0)
  // 流式滚动固定（合并 effect）：流式思考 body 由 EntryView 注册到这里。
  const streamBodyRef = useRef<HTMLDivElement | null>(null)

  const { wsBarH, wsBarElRef, workspaceRef } = useWorkspaceBar()
  const {
    scrollSnapshotRef,
    pendingRevealRef,
    captureScrollSnapshot,
    restoreScrollAfterPrepend,
    settleFitOrKeep,
    revealPrependedTurn,
  } = useScrollRestore(
    boxRef,
    followRef,
    lastScrollTopRef,
    wsBarElRef,
    wsBarH,
    entries,
  )
  const { loadingVisible, loadFailedVisible, spinnerFrame, contentVisible } =
    useLoadChrome(
      historyLoading,
      historyLoadingMore,
      historyLoadError,
      historyLoadedAt,
      entries.length,
    )

  const [expandAnchorId, setExpandAnchorId] = useState<string | null>(null)
  useEffect(() => {
    setExpandAnchorId(null)
  }, [historyLoadedAt])

  const userById = useMemo(() => {
    const m = new Map<string, ScrollEntry>()
    for (const e of entries) if (e.kind === 'user') m.set(e.id, e)
    return m
  }, [entries])

  const {
    userEls,
    pinned,
    navActiveId,
    stickyBandElRef,
    lastPushYRef,
    updatePinned,
    updateNavActive,
    scheduleUpdatePinned,
    jumpToUserEntry,
  } = useStickyPin(
    boxRef,
    lastScrollTopRef,
    followRef,
    wsBarElRef,
    wsBarH,
    userById,
    historyLoadedAt,
  )

  const { rows: displayRows, spans } = useDisplayRows(entries, expandedGroups)
  const streamingThoughtId = useStreamingThoughtId(entries)
  const now = useFinishFlash(entries)
  const pendingFreeze = pending.length > 0

  useFollowScroll(
    boxRef,
    contentRef,
    followRef,
    lastScrollTopRef,
    streamBodyRef,
    scheduleUpdatePinned,
    entries,
    displayRows.length,
  )

  const {
    touchStartYRef,
    touchYRef,
    maybeLoadOlderHistory,
    markCooldown,
    rearmPaging,
  } = useHistoryPaging(
    boxRef,
    followRef,
    entries,
    historyHasMore,
    historyLoadingMore,
    loadMoreHistory,
    captureScrollSnapshot,
    scrollSnapshotRef,
  )

  // Cache user entry elements (rebuilt on entry changes; positions shift on
  // history prepend / expand-collapse / resize, so recompute the pin then).
  // useLayoutEffect: settle scroll FIRST so pin measurement sees the final
  // viewport.
  //
  // Host path (historyPrependedAt): 扩窗 + fit-or-keep（短轮展示 / 长轮不跳）。
  // Local path (expandAnchorId): 强制 height-delta（本地溢出分支）。
  // pendingRevealRef: 扩窗后 DOM 齐了再 settleFitOrKeep。
  // historyLoadedAt: 贴底后立刻量钉选（与 scroll 同帧，避免 rAF 读到旧 scrollTop）。
  const handledPrependedAtRef = useRef(0)
  const handledLoadedAtRef = useRef(0)
  useLayoutEffect(() => {
    let settled = false
    if (
      historyPrependedAt &&
      handledPrependedAtRef.current !== historyPrependedAt
    ) {
      handledPrependedAtRef.current = historyPrependedAt
      settled = true
      revealPrependedTurn(historyAnchorId)
    } else if (expandAnchorId) {
      settled = true
      restoreScrollAfterPrepend(expandAnchorId)
      setExpandAnchorId(null)
    } else if (pendingRevealRef.current) {
      const box = boxRef.current
      const pending = pendingRevealRef.current
      const el = box?.querySelector(`[data-entry-id="${pending.targetId}"]`)
      if (box && el instanceof HTMLElement) {
        pendingRevealRef.current = null
        settleFitOrKeep(box, el, pending.anchorId)
        settled = true
      }
    }
    // Session/history switch: pin to bottom BEFORE measuring sticky so the
    // first paint already has the correct pin (long last-turn markdown).
    if (historyLoadedAt && handledLoadedAtRef.current !== historyLoadedAt) {
      handledLoadedAtRef.current = historyLoadedAt
      followRef.current = true
      const box = boxRef.current
      if (box) {
        box.scrollTop = box.scrollHeight
        lastScrollTopRef.current = box.scrollTop
      }
    }
    if (settled) {
      // Gate paging before updatePinned: reveal lands near the top and
      // would otherwise immediately re-fire maybeLoadOlderHistory.
      markCooldown()
    }
    const box = boxRef.current
    const map = new Map<string, HTMLElement>()
    if (box) {
      for (const id of userById.keys()) {
        const el = box.querySelector(`[data-entry-id="${id}"]`)
        if (el instanceof HTMLElement) map.set(id, el)
      }
    }
    userEls.current = map
    updatePinned()
    updateNavActive()
  }, [
    userById,
    updatePinned,
    updateNavActive,
    historyPrependedAt,
    historyAnchorId,
    historyLoadedAt,
    expandAnchorId,
    restoreScrollAfterPrepend,
    revealPrependedTurn,
    settleFitOrKeep,
    markCooldown,
    pendingRevealRef,
    userEls,
  ])

  // store 为 true：未挂载，文案来自 store（工具空隙回退）；false：已挂载行。
  const pinnedUser = pinned?.entry ?? null
  const pinnedStore = pinned?.store ?? false

  /** 目录 jump 已对齐过视口：跳过随后的 selectedId→scrollIntoView。 */
  const skipSelectScrollRef = useRef(false)

  // Scroll selected into view — only when selection / focus changes.
  // Do NOT depend on displayRows: prepend would re-yank to a stale
  // selectedId while the user is paging older turns.
  useEffect(() => {
    if (!selectedId || focusMode !== 'scrollback') return
    if (skipSelectScrollRef.current) {
      skipSelectScrollRef.current = false
      return
    }
    const el = boxRef.current?.querySelector(`[data-entry-id="${selectedId}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId, focusMode])

  // User-message directory rail (TUI timeline). Active tick is independent
  // of sticky pin (updateNavActive): nearest user at the readable top.
  const userNavItems = useMemo((): UserMessageNavItem[] => {
    const out: UserMessageNavItem[] = []
    let turnIdx = 0
    for (const e of entries) {
      if (e.kind !== 'user') continue
      out.push({
        id: e.id,
        preview: userMessagePreview(e.text),
        turnIdx: turnIdx++,
      })
    }
    return out
  }, [entries])
  const onUserNavJump = useCallback(
    (id: string) => {
      // jump already aligns under the bar; skip the selection scroll effect.
      skipSelectScrollRef.current = true
      selectEntry(id)
      jumpToUserEntry(id)
    },
    [selectEntry, jumpToUserEntry],
  )

  return (
    // Outer relative shell so the user-message rail can float on the right
    // without scrolling with content. Inner box keeps HEAD sticky / paging.
    <div className="relative flex min-h-0 flex-1 flex-col">
    {/* Reserve the scrollbar gutter even when nothing overflows, so the
        centered content column stays pixel-aligned with the fixed bottom
        prompt area (App reserves the same gutter there). */}
    <div
      ref={boxRef}
      className="gn-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none"
      data-scrollback-box=""
      // overflow-anchor: none — browser scroll anchoring fights our manual
      // height-delta restore on prepend (double-apply → viewport jump).
      style={{ scrollbarGutter: 'stable', overflowAnchor: 'none' }}
      tabIndex={0}
      role="listbox"
      aria-label="Scrollback"
      data-focus={focusMode === 'scrollback' ? 'scrollback' : 'prompt'}
      onScroll={(e) => {
        const t = e.currentTarget
        const dist = t.scrollHeight - t.scrollTop - t.clientHeight
        // 用户滑动优先：scrollTop 变小且已离开底部 → 暂停跟随（哪怕只
        // 滚 1px）。关键：切换会话时内容变矮，浏览器会把 scrollTop 钳到
        // 新 max——也会出现 scrollTop 变小，但此时 dist≈0，不能当作用户
        // 上滑，否则 follow 被误关，historyLoadedAt 钉底 effect 之后的
        // 流式/高度增长就不再贴底。滚回真正底部（dist<4）才恢复跟随。
        const prevTop = lastScrollTopRef.current
        lastScrollTopRef.current = t.scrollTop
        if (t.scrollTop < prevTop && dist >= 4) {
          followRef.current = false
        } else if (dist < 4) {
          followRef.current = true
        }
        scheduleUpdatePinned()
        // Near the top of a loaded history: fetch the next older page.
        // Re-arm when the user scrolls away from the top region so one
        // visit to the top loads exactly one page (no cascade).
        if (t.scrollTop < 80) {
          maybeLoadOlderHistory()
        } else {
          rearmPaging()
        }
      }}
      onWheel={(e) => {
        // Wheel-up near top: page older history. Also when scrollTop===0
        // (no overflow → no scroll events) so a trackpad flick still loads.
        // Use the same 80px top band as onScroll — collapsed tool runs
        // often leave only a few px of headroom; requiring scrollTop<=0
        // missed those.
        if (e.deltaY < 0) {
          const top = boxRef.current?.scrollTop ?? 0
          if (top < 80) maybeLoadOlderHistory()
        }
      }}
      onTouchStart={(e) => {
        const y = e.touches[0]?.clientY ?? null
        touchStartYRef.current = y
        touchYRef.current = y
      }}
      onTouchMove={(e) => {
        const y = e.touches[0]?.clientY
        if (y != null) touchYRef.current = y
      }}
      onTouchEnd={() => {
        const start = touchStartYRef.current
        const end = touchYRef.current
        touchStartYRef.current = null
        touchYRef.current = null
        // Finger dragged down = scroll up (older history); with no
        // scrollbar this gesture is the only way to page.
        if (
          start != null &&
          end != null &&
          end > start + TOUCH_UP_SWIPE_PX &&
          boxRef.current &&
          boxRef.current.scrollTop <= 0
        ) {
          maybeLoadOlderHistory()
        }
      }}
    >
      {/* Workspace + git status bar — sticky header of the scrollback. Sits
          outside the fade-in wrapper so it's always present while history
          content cross-fades in; the scrollback body scrolls under it.
          会话切换加载中（historyLoading）只有栏内内容（branch/cwd/状态
          芯片）淡出，栏本身保持常驻可见：旧会话数据不属于新会话，但
          背景条不消失（与加载覆盖层同节奏：加载开始内容同步淡出、
          加载完毕与内容区一起淡入）。栏常驻还让 ResizeObserver 全程
          连续测量 wsBarH，钉住的用户提示头始终与栏底齐平。 */}
      <WorkspaceBar
        onOpenMcp={onOpenMcp}
        topRef={workspaceRef}
        fadeHidden={historyLoading}
      />
      {/* Fade-in wrapper for freshly loaded history content — see the
          contentVisible layout effect above. transition-opacity is applied
          ONLY in the visible state: dropping to opacity-0 must be instant
          (no 100→0 transition), so the hidden frame actually recalc+paint
          and the restore then plays a real 0→100 fade. */}
      <div
        ref={contentRef}
        className={`${
          contentVisible ? 'transition-opacity duration-300 opacity-100' : 'opacity-0'
        }`}
      >
      {(historyHasMore || historyLoadingMore) && entries.length > 0 && (
        // Clickable fallback: when content doesn't overflow there is no
        // scrollbar, so scroll-to-top never fires. Tapping the hint loads
        // the next older host page the same way the near-top scroll path does.
        <button
          type="button"
          disabled={historyLoadingMore}
          onClick={(ev) => {
            ev.stopPropagation()
            // Explicit click: never swallowed by the prepend cooldown.
            maybeLoadOlderHistory(true)
          }}
          className="mx-auto block w-full py-1.5 text-center text-[11px] text-gn-gutter select-none transition-colors hover:text-gn-muted disabled:cursor-default disabled:hover:text-gn-gutter"
          title={
            historyLoadingMore
              ? undefined
              : historyLoadError
                ? historyLoadError
                : '点击或向上滚动加载更早历史'
          }
        >
          {historyLoadingMore ? (
            <span className="inline-flex items-center justify-center gap-1">
              <span className="leading-none">
                {SPINNER_FRAMES[spinnerFrame]}
              </span>
              <span>正在回放…</span>
            </span>
          ) : historyLoadError ? (
            <span className="text-gn-red">{historyLoadError} · 点击重试</span>
          ) : (
            '↑ 点击或向上滚动加载上一轮'
          )}
        </button>
      )}
      <div
        aria-hidden={!loadingVisible && !loadFailedVisible}
        className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 select-none transition-opacity duration-300 ${
          loadingVisible || loadFailedVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {loadFailedVisible ? (
          <>
            <span className="shrink-0 text-[12.5px] font-semibold text-gn-red">
              加载失败
            </span>
            <span
              className="min-w-0 max-w-[65%] truncate text-[12.5px] text-gn-muted"
              title={historyLoadError ?? undefined}
            >
              {historyLoadError}
            </span>
          </>
        ) : (
          <>
            <span className="text-[15px] leading-none text-gn-muted">
              {SPINNER_FRAMES[spinnerFrame]}
            </span>
            <span className="text-[12.5px] text-gn-muted">加载会话…</span>
          </>
        )}
      </div>
      <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} py-3`}>
        {/* TUI sticky prompt header (sticky.rs): last fully-past user
            prompt, collapsed to 3 lines. Next user pushes it off, then
            yield. Zero-height sticky shell + absolute band = no layout
            shift when the pin mounts/unmounts.
            */}
        <StickyPrompt
          pinnedUser={pinnedUser}
          pinnedStore={pinnedStore}
          wsBarH={wsBarH}
          stickyBandElRef={stickyBandElRef}
          lastPushYRef={lastPushYRef}
          onJump={jumpToUserEntry}
        />
        {entries.length === 0 && !sessionId && !historyLoading && (
          // Empty state — current session was deleted (or nothing active):
          // a plain blank scrollback reads as a hang, so show the workspace
          // picker instead.
          <EmptyStatePicker />
        )}
        {displayRows.map((row, i) => {
          const dense = isDensePackableRow(row)
          const densePrev = i > 0 && isDensePackableRow(displayRows[i - 1])
          const denseNext =
            i < displayRows.length - 1 && isDensePackableRow(displayRows[i + 1])
          if (row.type === 'group_header') {
            return (
              <GroupHeaderView
                key={displayRowKey(row)}
                row={row}
                selected={row.id === selectedId && focusMode === 'scrollback'}
                pendingFreeze={pendingFreeze}
                now={now}
                onToggle={() => toggleGroupExpansion(row.span.anchorId)}
                dense={dense}
                densePrev={densePrev}
                denseNext={denseNext}
              />
            )
          }
          return (
            <EntryView
              key={displayRowKey(row)}
              e={row.entry}
              selected={row.entry.id === selectedId && focusMode === 'scrollback'}
              pendingFreeze={pendingFreeze}
              now={now}
              inGroup={spanContaining(spans, row.index) != null}
              dense={dense}
              densePrev={densePrev}
              denseNext={denseNext}
              streamBodyRef={
                row.entry.kind === 'thought' && row.entry.id === streamingThoughtId
                  ? streamBodyRef
                  : undefined
              }
            />
          )
        })}
        </div>
      </div>
      <div ref={bottomRef} />
    </div>
    <UserMessageNav
      items={userNavItems}
      activeId={navActiveId}
      onJump={onUserNavJump}
      scrollParentRef={boxRef}
    />
    </div>
  )
}
