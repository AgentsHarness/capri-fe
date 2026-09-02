import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ScrollEntry } from '../../api/types'
import { useChatStore } from '../../store/chat'
import {
  displayRowKey,
  isDensePackableRow,
  spanContaining,
  type DisplayRow,
} from '../../scrollback/verbGroup'
import { buildUserNavItems } from '../../scrollback/userNav'
import { SelectionBox } from '../SelectionBox'
import { SPINNER_FRAMES } from '../../theme/glyphs'
import { COLUMN_PAD_X_CLASS, CONTENT_COLUMN_CLASS } from '../../theme/layout'
import { UserMessageNav, type UserMessageNavItem } from '../UserMessageNav'
import { WorkspaceBar } from '../TopBar'
import { EmptyStatePicker } from './EmptyState'
import { EntryView } from './EntryView'
import { GroupHeaderView } from './GroupHeaderView'
import { ImageLightbox, type InlineImage } from './InlineImages'
import { StickyPrompt } from './StickyPrompt'
import { useDisplayRows, useStreamingThoughtId } from './useDisplayRows'
import { useFinishFlash } from './useFinishFlash'
import { useFollowScroll } from './useFollowScroll'
import { useHistoryPaging } from './useHistoryPaging'
import { useLoadChrome } from './useLoadChrome'
import { useJunctionDissolve } from './useJunctionDissolve'
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
  /** Dissolve band over the scrollback's bottom edge (composer junction). */
  const junctionDissolveRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  // Last scrollTop seen, to tell "user scrolled UP" (unfollow, no matter
  // how small the distance — a sub-80px scroll must not keep following)
  // from "scrolled to the bottom" (re-follow).
  const lastScrollTopRef = useRef(0)
  // 流式滚动固定（合并 effect）：流式思考 body 由 EntryView 注册到这里。
  const streamBodyRef = useRef<HTMLDivElement | null>(null)

  const { wsBarH, wsBarElRef, workspaceRef } = useWorkspaceBar()
  const {
    pendingRevealRef,
    captureScrollPosition,
    ensureScrollPositionCaptured,
    cancelScrollSettle,
    isProgrammaticScroll,
    settleScrollAnchor,
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
  )

  const { rows: displayRows, spans } = useDisplayRows(entries, expandedGroups)
  const streamingThoughtId = useStreamingThoughtId(entries)
  const now = useFinishFlash(entries)
  const pendingFreeze = pending.length > 0
  // 图片画廊预览（组级 lightbox）：key 定位打开的组，index 为该组内偏移。
  const [imgPreview, setImgPreview] = useState<{
    key: string
    images: InlineImage[]
    index: number
  } | null>(null)
  // 图片画廊组级 hover 框（跨 scrollback 内容列宽度的 SelectionBox）。
  const [imgHoverKey, setImgHoverKey] = useState<string | null>(null)

  useFollowScroll(
    boxRef,
    contentRef,
    followRef,
    lastScrollTopRef,
    streamBodyRef,
    scheduleUpdatePinned,
    settleScrollAnchor,
    entries,
    displayRows.length,
  )

  // 交界处溶解带（composer junction）——滚动位置翻转只改 band 的
  // data-dissolve，绝不进 React state（否则整棵 entry 树跟着重渲）。
  useJunctionDissolve(boxRef, contentRef, junctionDissolveRef)

  const {
    pagingModeRef,
    onPagingScroll,
    onPagingTouchStart,
    onPagingTouchMove,
    onPagingTouchEnd,
    maybeLoadOlderHistory,
  } = useHistoryPaging(
    boxRef,
    entries,
    historyHasMore,
    historyLoadingMore,
    historyPrependedAt,
    loadMoreHistory,
    captureScrollPosition,
    ensureScrollPositionCaptured,
    cancelScrollSettle,
  )

  // Cache user entry elements (rebuilt on entry changes; positions shift on
  // history prepend / expand-collapse / resize, so recompute the pin then).
  // useLayoutEffect: settle scroll FIRST so pin measurement sees the final
  // viewport.
  //
  // Host path (historyPrependedAt): 按手势来源落位 —— 'keep'（滚轮/触摸拉
  //   出来的）只把视口钉回原行，'reveal'（点击）才短轮顶对齐 / 长轮不跳。
  // Local path (expandAnchorId): 强制 height-delta（本地溢出分支）。
  // pendingRevealRef: DOM 齐了再 settleFitOrKeep。
  // historyLoadedAt: 贴底后立刻量钉选（与 scroll 同帧，避免 rAF 读到旧 scrollTop）。
  const handledPrependedAtRef = useRef(0)
  const handledLoadedAtRef = useRef(0)
  const historyJumpSeq = useChatStore((s) => s.historyJumpSeq)
  useLayoutEffect(() => {
    if (
      historyPrependedAt &&
      handledPrependedAtRef.current !== historyPrependedAt
    ) {
      handledPrependedAtRef.current = historyPrependedAt
      // 目录跳转批量翻页：prepend 不做任何视口恢复/锚定（终点是目标轮，
      // 恢复机制会在跳转滚动落地后把视口拉回原处）。
      if (historyJumpSeq != null) return
      const mode = pagingModeRef.current
      pagingModeRef.current = 'keep'
      revealPrependedTurn(historyAnchorId, mode)
    } else if (expandAnchorId) {
      restoreScrollAfterPrepend(expandAnchorId)
      setExpandAnchorId(null)
    } else if (pendingRevealRef.current) {
      const box = boxRef.current
      const pending = pendingRevealRef.current
      const el = box?.querySelector(`[data-entry-id="${pending.targetId}"]`)
      if (box && el instanceof HTMLElement) {
        pendingRevealRef.current = null
        settleFitOrKeep(box, el, pending.anchorId)
      }
    }
    // Session/history switch: pin to bottom BEFORE measuring sticky so the
    // first paint already has the correct pin (long last-turn markdown).
    if (historyLoadedAt && handledLoadedAtRef.current !== historyLoadedAt) {
      handledLoadedAtRef.current = historyLoadedAt
      // 旧会话的行锚点对新会话没有意义。
      cancelScrollSettle()
      followRef.current = true
      const box = boxRef.current
      if (box) {
        box.scrollTop = box.scrollHeight
        lastScrollTopRef.current = box.scrollTop
      }
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
    cancelScrollSettle,
    pagingModeRef,
    restoreScrollAfterPrepend,
    revealPrependedTurn,
    settleFitOrKeep,
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
  // 全量目录：host 的 promptStarts+promptPreviews 补齐未加载轮（序号与渲染
  // 行一致）；缺省（旧 host / 透传路径）退回只列已加载轮。
  const historyPromptStarts = useChatStore((s) => s.historyPromptStarts)
  const historyPromptPreviews = useChatStore((s) => s.historyPromptPreviews)
  const jumpToPrompt = useChatStore((s) => s.jumpToPrompt)
  const userNavItems = useMemo(
    (): UserMessageNavItem[] =>
      buildUserNavItems(entries, historyPromptStarts, historyPromptPreviews),
    [entries, historyPromptStarts, historyPromptPreviews],
  )
  const onUserNavJump = useCallback(
    async (item: UserMessageNavItem) => {
      const jumpTo = (id: string | null) => {
        if (!id) return
        // jump already aligns under the bar; skip the selection scroll effect.
        skipSelectScrollRef.current = true
        selectEntry(id)
        jumpToUserEntry(id)
      }
      if (item.loaded) {
        jumpTo(item.id)
        return
      }
      // 未加载轮：先循环加载该轮及之后全部内容，加载完成滚到目标。
      if (item.seq == null) return
      jumpTo(await jumpToPrompt(item.seq))
    },
    [selectEntry, jumpToUserEntry, jumpToPrompt],
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
      // overflow-anchor: none — 翻页后的位置恢复由 useScrollRestore 按行锚
      // 点单点确定地完成，不允许浏览器再叠一层原生锚定（double-apply → 视口跳）。
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
        // 我们自己写 scrollTop 引发的那一次不算用户手势：既不放跟随，
        // 也不终止翻页锚点看门狗。
        if (!isProgrammaticScroll(t)) {
          cancelScrollSettle()
          onPagingScroll()
        }
        if (t.scrollTop < prevTop && dist >= 4) {
          followRef.current = false
        } else if (dist < 4) {
          followRef.current = true
        }
        scheduleUpdatePinned()
      }}
      onTouchStart={onPagingTouchStart}
      onTouchMove={onPagingTouchMove}
      onTouchEnd={onPagingTouchEnd}
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
            // Explicit click: never swallowed by the prepend cooldown, and
            // the loaded turn is revealed (顶对齐) instead of just kept.
            maybeLoadOlderHistory('reveal')
          }}
          // 恒定单行高度：三态文案（含整句错误）换行会挪动下方内容，
          // 给翻页恢复注入无关的 scrollHeight 差。
          className="mx-auto block h-7 w-full truncate px-3 text-center font-mono text-[11px] leading-7 text-gn-gutter select-none transition-colors hover:text-gn-muted disabled:cursor-default disabled:hover:text-gn-gutter"
          title={
            historyLoadingMore
              ? undefined
              : historyLoadError
                ? historyLoadError
                : '点击或在顶部继续向上拉动加载更早历史'
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
            '↑ 点击或在顶部上拉加载上一轮'
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
      <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} pb-3`}>
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
        {/* 连续独立 image 行聚合为一个画廊组：等高 flex 行（items-end）、
            点击任意一张打开组级 lightbox（‹ › / ← → 组内切换）。组内每张
            图仍是独立 EntryView（各自 accent/选中/查看器），聚合只做横向
            对齐与预览共享，不改间距语义（image 本就不参与 dense 打包）。 */}
        {(() => {
          const items: Array<
            | { kind: 'row'; row: DisplayRow; i: number }
            | {
                kind: 'imgGroup'
                key: string
                rows: Array<{
                  row: Extract<DisplayRow, { type: 'entry' }>
                  i: number
                }>
                images: InlineImage[]
                onOpenImage: (entryId: string) => void
              }
          > = []
          for (let i = 0; i < displayRows.length; i++) {
            const row = displayRows[i]
            const isImg = row.type === 'entry' && row.entry.kind === 'image'
            const last = items[items.length - 1]
            if (isImg && last && last.kind === 'imgGroup') {
              last.rows.push({
                row: row as Extract<DisplayRow, { type: 'entry' }>,
                i,
              })
              continue
            }
            if (isImg) {
              const first = row as Extract<DisplayRow, { type: 'entry' }>
              const rows = [{ row: first, i }]
              const images = rows.map(({ row: r }) => {
                const e = r.entry as Extract<ScrollEntry, { kind: 'image' }>
                return { data: e.data, mimeType: e.mimeType }
              })
              const key = `ig_${row.entry.id}`
              items.push({
                kind: 'imgGroup',
                key,
                rows,
                images,
                onOpenImage: (entryId: string) => {
                  const idx = rows.findIndex(({ row: r }) => r.entry.id === entryId)
                  if (idx >= 0) setImgPreview({ key, images, index: idx })
                },
              })
              continue
            }
            items.push({ kind: 'row', row, i })
          }
          return items.map((item) => {
            if (item.kind === 'row') {
              const { row, i } = item
              const dense = isDensePackableRow(row)
              const densePrev = i > 0 && isDensePackableRow(displayRows[i - 1])
              const denseNext =
                i < displayRows.length - 1 &&
                isDensePackableRow(displayRows[i + 1])
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
                    row.entry.kind === 'thought' &&
                    row.entry.id === streamingThoughtId
                      ? streamBodyRef
                      : undefined
                  }
                />
              )
            }
            return (
              <Fragment key={item.key}>
                <div
                  className="relative flex flex-wrap items-end gap-1.5"
                  onMouseEnter={() => setImgHoverKey(item.key)}
                  onMouseLeave={() =>
                    setImgHoverKey((k) => (k === item.key ? null : k))
                  }
                >
                  {/* 组级 hover/选中外框：横跨 scrollback 内容列宽度、尺寸恒定
                      （SelectionBox left/right 外扩 12px；组内各行关闭各自窄框
                      via noFrame）。选中优先于 hover。 */}
                  {imgHoverKey === item.key ||
                  item.rows.some(
                    ({ row }) =>
                      row.entry.id === selectedId &&
                      focusMode === 'scrollback',
                  ) ? (
                    <SelectionBox
                      variant={
                        item.rows.some(
                          ({ row }) =>
                            row.entry.id === selectedId &&
                            focusMode === 'scrollback',
                        )
                          ? 'selected'
                          : 'hover'
                      }
                    />
                  ) : null}
                  {item.rows.map(({ row, i }) => {
                    const dense = isDensePackableRow(row)
                    const densePrev = i > 0 && isDensePackableRow(displayRows[i - 1])
                    const denseNext =
                      i < displayRows.length - 1 &&
                      isDensePackableRow(displayRows[i + 1])
                    return (
                      <EntryView
                        key={displayRowKey(row)}
                        e={row.entry}
                        selected={
                          row.entry.id === selectedId && focusMode === 'scrollback'
                        }
                        pendingFreeze={pendingFreeze}
                        now={now}
                        inGroup={spanContaining(spans, row.index) != null}
                        dense={dense}
                        densePrev={densePrev}
                        denseNext={denseNext}
                        onOpenImage={item.onOpenImage}
                        noFrame
                      />
                    )
                  })}
                </div>
                {imgPreview && imgPreview.key === item.key ? (
                  <ImageLightbox
                    images={item.images}
                    index={imgPreview.index}
                    onClose={() => setImgPreview(null)}
                  />
                ) : null}
              </Fragment>
            )
          })
        })()}
        </div>
      </div>
      <div ref={bottomRef} />
    </div>
    {/* 交界处溶解带：视口底缘的转录尾不再被硬切一刀，化进底色。
        武装条件（下方还有内容）与 right 的滚动条槽宽度由
        useJunctionDissolve 直接写在这个元素上。 */}
    <div
      ref={junctionDissolveRef}
      aria-hidden
      className="gn-junction-dissolve pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-7"
    />
    <UserMessageNav
      items={userNavItems}
      activeId={navActiveId}
      onJump={onUserNavJump}
      scrollParentRef={boxRef}
    />
    </div>
  )
}
