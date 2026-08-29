import { useEffect, type RefObject } from 'react'

/** Distance from the tail (px) still counted as "at the bottom" — the same
 *  4px band onScroll uses to (re)arm follow-to-bottom. */
const AT_TAIL_PX = 4

/**
 * Dissolve band over the scrollback's bottom edge (the composer junction).
 *
 * Armed only while rows keep going BELOW the fold: mid-transcript the tail
 * melts into the base surface instead of being sliced mid-glyph; at the
 * tail the band lifts so the newest row is never dimmed.
 *
 * The on/off flag lives on the band element (`data-dissolve`) rather than
 * in React state — a scroll-position flip must not re-render the mounted
 * entry tree. `right` mirrors the scroll box's scrollbar gutter so the band
 * never veils the scrollbar thumb.
 */
export function useJunctionDissolve(
  boxRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  bandRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    const box = boxRef.current
    const band = bandRef.current
    if (!box || !band) return

    const sync = () => {
      const below = box.scrollHeight - box.scrollTop - box.clientHeight
      const overflows = box.scrollHeight - box.clientHeight > 1
      const next = overflows && below > AT_TAIL_PX ? '1' : '0'
      if (band.dataset.dissolve !== next) band.dataset.dissolve = next
      const gutter = box.offsetWidth - box.clientWidth
      const right = gutter > 0 ? `${gutter}px` : ''
      if (band.style.right !== right) band.style.right = right
    }

    // rAF-coalesced: scroll fires far more often than layout settles, and
    // sync reads scrollHeight (forced layout while anything is dirty).
    let raf = 0
    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        sync()
      })
    }
    sync()

    box.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    // Content growth (streaming, late markdown/mermaid paint), viewport
    // shrink (the textarea grows toward half the viewport) and history
    // prepend all move `below` without a user scroll event.
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(schedule)
      ro.observe(box)
      if (contentRef.current) ro.observe(contentRef.current)
    }

    return () => {
      if (raf) cancelAnimationFrame(raf)
      box.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      ro?.disconnect()
    }
  }, [boxRef, contentRef, bandRef])
}
