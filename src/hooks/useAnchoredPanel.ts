import { useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import { placePanel } from '../lib/menuPlacement'

export type AnchoredPanelPosition = { left: number; top: number; width: number }

/**
 * Place a viewport-pinned panel under its trigger and keep both edges inside
 * the viewport. The width is `min(maxWidth, viewportWidth * vwFraction)`.
 *
 * A plain `absolute right-0` assumes the trigger sits at the right edge. On a
 * narrow phone the top-bar controls wrap, so the trigger can land at the left;
 * measuring the trigger and clamping is what keeps the whole panel visible.
 * Re-place on resize and scroll (including inner scrollers) because the anchor
 * and the visual viewport can move while the panel is open.
 */
export function useAnchoredPanel({
  open,
  anchorRef,
  maxWidth,
  vwFraction = 1,
  gap = 4,
  pad = 8,
}: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  maxWidth: number
  vwFraction?: number
  gap?: number
  pad?: number
}): AnchoredPanelPosition | null {
  const [pos, setPos] = useState<AnchoredPanelPosition | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const vw = window.innerWidth
      const width = Math.min(maxWidth, Math.round(vw * vwFraction))
      const next = placePanel(rect.right, width, vw, pad)
      const top = rect.bottom + gap
      setPos((prev) =>
        prev && prev.left === next.left && prev.top === top && prev.width === next.width
          ? prev
          : { left: next.left, top, width: next.width },
      )
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
    }
  }, [open, anchorRef, maxWidth, vwFraction, gap, pad])

  return pos
}
