import {
  useCallback,
  useEffect,
  useRef,
  type RefObject,
} from 'react'

/** Tail zone treated as "the user is at the bottom" (matches the subagent
 *  timeline viewer's follow rule in BlockViewer). */
const BOTTOM_THRESHOLD_PX = 48

/**
 * Stick-to-bottom follow for a scroll box whose content keeps growing.
 *
 * - At the bottom → new content re-pins the tail as it arrives.
 * - Scrolled up   → the box stays exactly where the user put it; following
 *   re-arms once they scroll back within BOTTOM_THRESHOLD_PX of the tail.
 *
 * `following` lives in a ref, never state: the flag is not rendered anywhere
 * and flipping it on every scroll crossing would re-render the whole (often
 * huge) body subtree. Only `onScroll` and the ResizeObserver touch it.
 *
 * A box that does not overflow is left alone rather than counted as
 * "at bottom" — otherwise a short live block that later grows past the
 * viewport would yank the reader down without them ever asking to follow.
 */
export function useStickToBottom(
  boxRef: RefObject<HTMLElement | null>,
  opts: {
    /** Skip all wiring (a nested scroller owns the behaviour instead). */
    enabled?: boolean
    /** Open already following the tail (live logs) instead of at the top. */
    initialFollowing?: boolean
    /** Changing this re-arms the state — pass the viewed item's identity. */
    resetKey?: unknown
  } = {},
) {
  const { enabled = true, initialFollowing = false, resetKey } = opts
  const followingRef = useRef(initialFollowing)
  const roRef = useRef<ResizeObserver | null>(null)
  const observedRef = useRef<Element | null>(null)
  const pinRef = useRef<() => void>(() => {})

  /** Re-read the user's position; call from the box's onScroll. */
  const measure = useCallback(() => {
    if (!enabled) return
    const el = boxRef.current
    if (!el || el.scrollHeight <= el.clientHeight + 1) return
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX
    followingRef.current = atBottom
  }, [boxRef, enabled])

  /** Pin the tail while following; a no-op once the user scrolled up. */
  const pin = useCallback(() => {
    if (!enabled || !followingRef.current) return
    const el = boxRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [boxRef, enabled])
  pinRef.current = pin

  // Open / item switch: seed the follow state, and for live logs land on the
  // tail immediately (the box would otherwise render at scrollTop 0, which is
  // the head of a long log, not its newest line).
  useEffect(() => {
    followingRef.current = enabled && initialFollowing
    if (!followingRef.current) return
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [boxRef, enabled, initialFollowing, resetKey])

  // Content growth is what needs following — observe the content element, not
  // the box (the box is flex-sized and never changes height). Covers async
  // layout too (markdown re-flow, images, mermaid, late stream flushes).
  //
  // No dep array: callers whose single content wrapper is *replaced* between
  // renders (empty-state → populated list) would otherwise leave the observer
  // pinned to a detached node and silently stop following. The identity check
  // keeps the steady-state cost at one comparison per render.
  useEffect(() => {
    const next = enabled ? (boxRef.current?.firstElementChild ?? null) : null
    if (next === observedRef.current) return
    roRef.current?.disconnect()
    roRef.current = null
    observedRef.current = next
    if (!next || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => pinRef.current())
    ro.observe(next)
    roRef.current = ro
  })
  useEffect(() => () => roRef.current?.disconnect(), [])

  return {
    onScroll: measure,
    pin,
    /** Read the follow flag for extra tail-pinning that the box itself does
     *  not cover (e.g. a clipped inner preview that must scroll separately). */
    isFollowing: () => followingRef.current,
  }
}
