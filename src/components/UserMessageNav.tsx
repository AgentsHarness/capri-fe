import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from 'react'

/**
 * User-message directory rail (TUI timeline sidebar).
 *
 * Reveal (scroll / desktop hover zone) → collapsed ticks only.
 * Click the rail → expand message list; click a row → jump.
 * Idle 2s after scroll/leave → fade out.
 *
 * Port of xai-grok-pager `views/timeline.rs` for the FE surface.
 */

/** Minimum user messages before the rail appears (TUI MIN_TURNS). */
const MIN_TURNS = 2
/** Stored preview char cap (TUI PREVIEW_MAX_CHARS). */
const PREVIEW_MAX_CHARS = 80
/** Max visible ticks when collapsed (overflow windows around active). */
const MAX_COLLAPSED_TICKS = 28
/** After scroll stops, keep the rail visible this long then fade out. */
const SCROLL_IDLE_HIDE_MS = 2000

export type UserMessageNavItem = {
  id: string
  /** First non-empty line, char-capped. */
  preview: string
  /** 0-based turn ordinal among user messages. */
  turnIdx: number
}

export type UserMessageNavProps = {
  items: UserMessageNavItem[]
  /** User entry currently at/above the viewport top (sticky pin / active). */
  activeId: string | null
  onJump: (id: string) => void
  /**
   * Scrollback viewport element. Preferred over sibling querySelector so the
   * scroll listener binds even when this rail mounts after the first paint
   * (e.g. history load crosses MIN_TURNS).
   */
  scrollParentRef?: RefObject<HTMLElement | null>
}

/** First non-empty line, char-capped with … (TUI prompt_preview). */
export function userMessagePreview(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  if (line.length <= PREVIEW_MAX_CHARS) return line
  return line.slice(0, PREVIEW_MAX_CHARS - 1) + '…'
}

/** Coarse pointer / no-hover — treat as mobile touch UI. */
function useIsTouchUi() {
  const [touch, setTouch] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(hover: none), (pointer: coarse)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(hover: none), (pointer: coarse)')
    const apply = () => setTouch(mq.matches)
    apply()
    mq.addEventListener?.('change', apply)
    return () => mq.removeEventListener?.('change', apply)
  }, [])
  return touch
}

export function UserMessageNav({
  items,
  activeId,
  onJump,
  scrollParentRef,
}: UserMessageNavProps) {
  const isTouch = useIsTouchUi()
  /** Click rail → expand list (desktop + mobile). Hover never expands. */
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  /**
   * Scroll activity chrome: fade in while scrolling, hold 2s after idle,
   * then fade out. Directory open / desktop zone hover also force visible.
   */
  const [scrollVisible, setScrollVisible] = useState(false)
  /** Desktop: pointer is over the right-edge rail zone (works even when faded). */
  const [areaHover, setAreaHover] = useState(false)
  const hideTimerRef = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  /** Stable callback so parent onScroll can bump without re-binding. */
  const bumpScrollVisibleRef = useRef<() => void>(() => {})

  const open = directoryOpen
  const visible = scrollVisible || open || areaHover
  const enabled = items.length >= MIN_TURNS

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])

  /** Show rail and (re)start the post-scroll 2s fade-out timer. */
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
  useEffect(() => {
    if (!enabled) return
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
  }, [enabled, scrollParentRef, clearHideTimer])

  // While the directory is open, cancel the idle hide. On close (not
  // initial mount), hold 2s then fade — same cadence as post-scroll idle.
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
      // Still hovering the zone → stay visible via areaHover; else 2s fade.
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
    (id: string) => {
      onJump(id)
      setDirectoryOpen(false)
      setHoveredId(null)
    },
    [onJump],
  )

  /** Click collapsed rail → expand list (does not jump). */
  const openDirectory = useCallback(() => {
    setDirectoryOpen(true)
    clearHideTimer()
    setScrollVisible(true)
  }, [clearHideTimer])

  /** Forward wheel to the scrollback box so edge chrome never eats paging. */
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

  // When the rail is faded, do NOT cover the full right edge with a wide
  // pointer-events hit target — that steals wheel/trackpad from scrollback
  // and breaks near-top "load previous turn". Desktop keeps only a thin
  // hover edge (w-2/w-3) for reveal; the rail itself is interactive only
  // while visible/open.
  const railInteractive = visible || open

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-y-0 right-0 z-20 flex items-center pr-1 sm:pr-2.5"
      aria-label="用户消息目录"
    >
      {/*
        Thin full-height hover edge (desktop only). Wide enough to catch
        "point near the right" without covering the scrollback body.
      */}
      {!isTouch && (
        <div
          className="pointer-events-auto absolute inset-y-0 right-0 w-2 sm:w-3"
          onMouseEnter={() => {
            setAreaHover(true)
            clearHideTimer()
            setScrollVisible(true)
          }}
          onMouseLeave={() => {
            setAreaHover(false)
            setHoveredId(null)
            if (!directoryOpen) bumpScrollVisible()
          }}
          onWheel={forwardWheel}
        />
      )}
      <div
        className={`relative flex h-full min-w-[28px] items-center justify-end pl-2 sm:min-w-[36px] ${
          railInteractive ? 'pointer-events-auto' : 'pointer-events-none'
        }`}
        onMouseEnter={() => {
          if (isTouch) return
          setAreaHover(true)
          clearHideTimer()
          setScrollVisible(true)
        }}
        onMouseLeave={() => {
          if (isTouch) return
          setAreaHover(false)
          setHoveredId(null)
          if (!directoryOpen) bumpScrollVisible()
        }}
        onWheel={railInteractive ? forwardWheel : undefined}
      >
        <nav
          className={`flex flex-col items-end select-none transition-[width,opacity] duration-300 ease-out ${
            visible ? 'opacity-100' : 'opacity-0'
          } ${open ? 'max-h-[min(70vh,520px)]' : ''}`}
          aria-hidden={!visible}
        >
          {open ? (
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
 * Click only opens the directory — never jumps from a tick.
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
      className={`flex flex-col items-end justify-center gap-[3px] pr-1 active:opacity-80 ${
        touchUi
          ? 'min-h-[44px] min-w-[44px] py-3 pl-4'
          : 'min-h-[28px] min-w-[28px] py-2 pl-3 hover:opacity-90'
      }`}
      aria-label="打开用户消息目录"
      title="打开消息目录"
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
  onJump: (id: string) => void
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
      ref={listRef}
      className={`gn-scroll max-h-[min(70vh,520px)] overflow-y-auto overscroll-contain rounded-md border border-gn-prompt-border bg-gn-bg-base/95 py-1 shadow-lg backdrop-blur-sm ${
        touchUi
          ? 'w-[min(78vw,300px)]'
          : 'w-[min(42vw,240px)] sm:w-[min(36vw,280px)]'
      }`}
      role="list"
      aria-label="用户消息目录"
      style={{ scrollbarGutter: 'stable' }}
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
            title={preview}
            aria-label={`跳转到消息 ${it.turnIdx + 1}：${preview}`}
            aria-current={isActive ? 'true' : undefined}
            className={`flex w-full items-baseline gap-1.5 px-2 py-[5px] text-left font-ui text-[12px] leading-[1.35] transition-colors ${
              isActive
                ? 'bg-gn-bg-highlight text-gn-fg font-semibold'
                : isHover
                  ? 'bg-gn-bg-hover text-gn-fg'
                  : 'text-gn-fg2 hover:bg-gn-bg-hover hover:text-gn-fg active:bg-gn-bg-hover'
            }`}
            onMouseEnter={() => onHover(it.id)}
            onMouseLeave={() => onHover(null)}
            onClick={(ev) => {
              ev.stopPropagation()
              onJump(it.id)
            }}
          >
            <span
              className="shrink-0 tabular-nums text-gn-gray"
              style={{ width: `${ordWidth + 1}ch` }}
            >
              {it.turnIdx + 1}
            </span>
            <span className="min-w-0 flex-1 truncate">{preview}</span>
          </button>
        )
      })}
    </div>
  )
}
