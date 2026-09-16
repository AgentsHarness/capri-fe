import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { useTouchUi } from '../hooks/useTouchUi'

/**
 * User-message directory rail (TUI timeline sidebar).
 *
 * Desktop: the collapsed tick rail is pinned visible; pointing at it expands
 * the message list, moving the pointer off collapses it. Click a row → jump.
 * Touch: reveal on scroll, tap to expand, idle 2s → fade out.
 *
 * Port of xai-grok-pager `views/timeline.rs` for the FE surface.
 */

/** Minimum user messages before the rail appears (TUI MIN_TURNS). */
const MIN_TURNS = 2
/** Max visible ticks when collapsed (overflow windows around active). */
const MAX_COLLAPSED_TICKS = 28
/** After scroll stops, keep the rail visible this long then fade out. */
const SCROLL_IDLE_HIDE_MS = 2000

export type UserMessageNavItem = {
  id: string
  /**
   * 该轮首条信封的 msgSeq（host promptStarts 起点，append-only 稳定）。
   * 全量目录（未加载轮）用它做跳转目标；已加载轮也有。
   */
  seq?: number
  /** First non-empty line, char-capped. */
  preview: string
  /** 0-based turn ordinal among visible user messages. */
  turnIdx: number
  /** 该轮已在滚动区中；false = 点击会先加载该轮及之后全部内容再跳。 */
  loaded: boolean
}

export type UserMessageNavProps = {
  items: UserMessageNavItem[]
  /** User entry currently at/above the viewport top (sticky pin / active). */
  activeId: string | null
  onJump: (item: UserMessageNavItem) => void
  /**
   * Scrollback viewport element. Preferred over sibling querySelector so the
   * scroll listener binds even when this rail mounts after the first paint
   * (e.g. history load crosses MIN_TURNS).
   */
  scrollParentRef?: RefObject<HTMLElement | null>
}

export function UserMessageNav({
  items,
  activeId,
  onJump,
  scrollParentRef,
}: UserMessageNavProps) {
  const isTouch = useTouchUi()
  /** Touch: tap rail → expand. Desktop expands on pointer-over instead. */
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  /**
   * Touch-only chrome: fade the rail in while scrolling, hold 2s after idle,
   * then fade out. The desktop rail is pinned visible and ignores this.
   */
  const [scrollVisible, setScrollVisible] = useState(false)
  /** Desktop: pointer is over the rail itself (hover = expand). */
  const [areaHover, setAreaHover] = useState(false)
  const hideTimerRef = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  /** Stable callback so parent onScroll can bump without re-binding. */
  const bumpScrollVisibleRef = useRef<() => void>(() => {})

  const open = directoryOpen
  /** Desktop rail is always shown; touch reveals it on scroll / tap. */
  const visible = !isTouch || open || scrollVisible
  /** Desktop expands while the pointer rests on the rail; touch expands on tap. */
  const expanded = open || (!isTouch && areaHover)
  const enabled = items.length >= MIN_TURNS

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])

  /** Show rail and (re)start the post-scroll 2s fade-out timer (touch). */
  const bumpScrollVisible = useCallback(() => {
    setScrollVisible(true)
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      setScrollVisible(false)
    }, SCROLL_IDLE_HIDE_MS)
  }, [clearHideTimer])
  bumpScrollVisibleRef.current = bumpScrollVisible

  // Bind scroll → reveal. Re-run when the rail becomes eligible (history
  // load crossing MIN_TURNS) so we never miss the listener after a null
  // first paint. Prefer the explicit scrollParentRef from Scrollback.
  // Desktop keeps the rail pinned, so this chrome stays touch-only.
  useEffect(() => {
    if (!enabled || !isTouch) return
    const resolveBox = (): HTMLElement | null => {
      const fromProp = scrollParentRef?.current
      if (fromProp instanceof HTMLElement) return fromProp
      const root = rootRef.current
      const sibling = root?.parentElement?.querySelector('[data-scrollback-box]')
      return sibling instanceof HTMLElement ? sibling : null
    }
    let box = resolveBox()
    // Sibling may not be queryable until after layout if we only had the
    // early-return null shell before — one rAF covers that edge.
    let raf = 0
    let onScroll: (() => void) | null = null
    const attach = (el: HTMLElement) => {
      onScroll = () => bumpScrollVisibleRef.current()
      el.addEventListener('scroll', onScroll, { passive: true })
      box = el
    }
    if (box) {
      attach(box)
    } else {
      raf = requestAnimationFrame(() => {
        const el = resolveBox()
        if (el) attach(el)
      })
    }
    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (box && onScroll) box.removeEventListener('scroll', onScroll)
      clearHideTimer()
    }
  }, [enabled, isTouch, scrollParentRef, clearHideTimer])

  // While the directory is open, cancel the idle hide. On close (not initial
  // mount), hold 2s then fade — same cadence as the post-scroll idle (touch).
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true
      clearHideTimer()
      setScrollVisible(true)
      return
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false
      // Desktop stays visible regardless; touch fades unless still on the rail.
      if (!areaHover) bumpScrollVisible()
    }
  }, [open, areaHover, clearHideTimer, bumpScrollVisible])

  // Close directory when tapping/clicking outside.
  useEffect(() => {
    if (!directoryOpen) return
    const onDoc = (ev: MouseEvent | TouchEvent) => {
      const el = rootRef.current
      if (!el) return
      const t = ev.target
      if (t instanceof Node && el.contains(t)) return
      setDirectoryOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('touchstart', onDoc, { passive: true })
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('touchstart', onDoc)
    }
  }, [directoryOpen])

  const activeIdx = useMemo(() => {
    if (!activeId) return items.length > 0 ? items.length - 1 : -1
    const i = items.findIndex((it) => it.id === activeId)
    return i >= 0 ? i : items.length - 1
  }, [items, activeId])

  // Window ticks around active when there are more than MAX_COLLAPSED_TICKS.
  const windowed = useMemo(() => {
    if (items.length <= MAX_COLLAPSED_TICKS) {
      return { start: 0, slice: items }
    }
    const half = Math.floor(MAX_COLLAPSED_TICKS / 2)
    let start = Math.max(0, activeIdx - half)
    if (start + MAX_COLLAPSED_TICKS > items.length) {
      start = items.length - MAX_COLLAPSED_TICKS
    }
    return { start, slice: items.slice(start, start + MAX_COLLAPSED_TICKS) }
  }, [items, activeIdx])

  const handleJump = useCallback(
    (item: UserMessageNavItem) => {
      onJump(item)
      setDirectoryOpen(false)
      setHoveredId(null)
    },
    [onJump],
  )

  /** Touch tap on the collapsed rail → expand list (never jumps). */
  const openDirectory = useCallback(() => {
    setDirectoryOpen(true)
    clearHideTimer()
    setScrollVisible(true)
  }, [clearHideTimer])

  /** Forward wheel to the scrollback box so the collapsed rail never eats paging. */
  const forwardWheel = useCallback(
    (ev: ReactWheelEvent) => {
      const box = scrollParentRef?.current
      if (!(box instanceof HTMLElement)) return
      const prev = box.scrollTop
      box.scrollTop += ev.deltaY
      // Already at top/bottom: scrollTop clamps and no `scroll` fires.
      // Re-dispatch a wheel on the box so Scrollback's onWheel can still
      // run maybeLoadOlderHistory when deltaY < 0 near the top.
      if (box.scrollTop === prev && ev.deltaY !== 0) {
        box.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: ev.deltaY,
            deltaX: ev.deltaX,
            bubbles: true,
            cancelable: true,
          }),
        )
      }
    },
    [scrollParentRef],
  )

  if (items.length < MIN_TURNS) return null

  // Only the rail itself (ticks, or the expanded list) is hit-testable: the
  // shell and the wrapper keep pointer-events-none, so the transcript under
  // the right strip stays selectable and does not lose wheel/trackpad paging
  // beyond the rail's own footprint.
  const railInteractive = visible || expanded

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-y-0 right-0 z-20 flex items-center pr-1 sm:pr-2.5"
      aria-label="用户消息目录"
    >
      <div
        data-user-nav-zone=""
        className="relative flex h-full min-w-[28px] items-center justify-end pl-2 sm:min-w-[36px]"
        onMouseEnter={() => {
          if (isTouch) return
          setAreaHover(true)
          clearHideTimer()
        }}
        onMouseLeave={() => {
          if (isTouch) return
          setAreaHover(false)
          setHoveredId(null)
        }}
        // Collapsed ticks cover the transcript: forward the wheel so pointing
        // near the right edge never eats scrollback paging. The expanded list
        // scrolls itself, so forwarding there would drag the transcript with it.
        onWheel={expanded ? undefined : forwardWheel}
      >
        <nav
          className={`flex flex-col items-end select-none transition-[width,opacity] duration-300 ease-out ${
 visible ? 'opacity-100' : 'opacity-0'
          } ${
 railInteractive ? 'pointer-events-auto' : 'pointer-events-none'
          }`}
          aria-hidden={!visible}
        >
          {expanded ? (
            <ExpandedList
              items={items}
              activeId={activeId}
              activeIdx={activeIdx}
              hoveredId={hoveredId}
              onHover={setHoveredId}
              onJump={handleJump}
              touchUi={isTouch}
            />
          ) : (
            <CollapsedRail
              items={windowed.slice}
              activeId={activeId}
              onOpen={openDirectory}
              touchUi={isTouch}
            />
          )}
        </nav>
      </div>
    </div>
  )
}

/**
 * Collapsed tick stack: whole control is one hit target.
 * Opening the directory never jumps from a tick — desktop expands it on
 * pointer-over, touch on click.
 */
function CollapsedRail({
  items,
  activeId,
  onOpen,
  touchUi,
}: {
  items: UserMessageNavItem[]
  activeId: string | null
  onOpen: () => void
  touchUi: boolean
}) {
  return (
    <button
      type="button"
      onClick={(ev) => {
        ev.stopPropagation()
        onOpen()
      }}
      className={`flex flex-col items-end justify-center gap-[3px] pr-1 active:opacity-80 ${ touchUi ? 'min-h-[44px] min-w-[44px] py-3 pl-4' : 'min-h-[28px] min-w-[28px] py-2 pl-3 hover:opacity-90' }`}
      aria-label="打开用户消息目录"
      title={touchUi ? '打开消息目录' : '悬停展开消息目录'}
    >
      {items.map((it) => {
        const isActive = it.id === activeId
        const tick = isActive ? '━━' : '─'
        return (
          <span
            key={it.id}
            aria-hidden
            className={`block min-h-[12px] leading-none tracking-tight ${
 isActive ? 'text-gn-fg' : 'text-gn-gray-dim'
            }`}
            style={{ fontSize: 11 }}
          >
            <span className="inline-block w-[2ch] text-right font-mono">{tick}</span>
          </span>
        )
      })}
    </button>
  )
}

function ExpandedList({
  items,
  activeId,
  activeIdx,
  hoveredId,
  onHover,
  onJump,
  touchUi,
}: {
  items: UserMessageNavItem[]
  activeId: string | null
  activeIdx: number
  hoveredId: string | null
  onHover: (id: string | null) => void
  onJump: (item: UserMessageNavItem) => void
  touchUi: boolean
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const ordWidth = String(items.length).length

  // Keep the active row in view inside THIS list only — never
  // scrollIntoView (that walks ancestors and can yank the scrollback).
  useEffect(() => {
    const root = listRef.current
    if (!root || activeIdx < 0) return
    const id = items[activeIdx]?.id
    if (!id) return
    const row = root.querySelector(`[data-nav-id="${CSS.escape(id)}"]`)
    if (!(row instanceof HTMLElement)) return
    const rowTop = row.offsetTop
    const rowBottom = rowTop + row.offsetHeight
    const viewTop = root.scrollTop
    const viewBottom = viewTop + root.clientHeight
    if (rowTop < viewTop) root.scrollTop = rowTop
    else if (rowBottom > viewBottom) root.scrollTop = rowBottom - root.clientHeight
  }, [activeIdx, items])

  return (
    <div
      className={`gn-menu ${
 touchUi
          ? 'w-[min(78vw,300px)]'
          : 'w-[min(42vw,240px)] sm:w-[min(36vw,280px)]'
      }`}
      role="list"
      aria-label="用户消息目录"
    >
      {/* 滚动必须放在内层：gn-menu 的 overflow:hidden 是未分层样式，会压过
          同一元素上的 overflow-y-auto（Tailwind utility 在 @layer utilities
          里，未分层优先）。relative 给上面 offsetTop 计算提供基准。 */}
      <div
        ref={listRef}
        className="relative gn-no-scrollbar max-h-[50vh] overflow-y-auto touch-pan-y overscroll-contain"
      >
        {items.map((it) => {
          const isActive = it.id === activeId
          const isHover = it.id === hoveredId
          const preview = it.preview || '(无预览)'
          return (
            <button
              key={it.id}
              type="button"
              role="listitem"
              data-nav-id={it.id}
              title={
                it.loaded
                  ? preview
                  : `${preview}（点击将加载该轮及之后全部内容）`
              }
              aria-label={`跳转到消息 ${it.turnIdx + 1}：${preview}`}
              aria-current={isActive ? 'true' : undefined}
              className={`flex w-full items-baseline gap-1.5 px-2 py-[5px] text-left font-ui text-[12px] leading-[1.35] transition-colors ${ isActive ? 'bg-gn-bg-highlight text-gn-fg font-semibold' : isHover ? 'bg-gn-bg-hover text-gn-fg' : it.loaded ? 'text-gn-fg2 hover:bg-gn-bg-hover hover:text-gn-fg active:bg-gn-bg-hover' : 'text-gn-gray hover:bg-gn-bg-hover hover:text-gn-fg active:bg-gn-bg-hover' }`}
              onMouseEnter={() => onHover(it.id)}
              onMouseLeave={() => onHover(null)}
              onClick={(ev) => {
                ev.stopPropagation()
                onJump(it)
              }}
            >
              <span
                className="shrink-0 tabular-nums text-gn-gray"
                style={{ width: `${ordWidth + 1}ch` }}
              >
                {it.turnIdx + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">{preview}</span>
              {!it.loaded && (
                <span className="shrink-0 text-[10px] text-gn-gray-dim">未加载</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
