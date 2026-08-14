import { useCallback, useRef, useState } from 'react'

/**
 * WorkspaceBar (sticky top-0 inside the scroll container) is 37px when
 * idle but grows when the tasks bar is open / rows wrap on mobile.
 * The pinned user-prompt header sticks at `top: wsBarH` so it always
 * lands flush below the bar.
 *
 * Callback ref: attaches the observer on mount (and re-attaches if the
 * element is ever remounted), disconnects on unmount — no effect-timing
 * dependency.
 */
export function useWorkspaceBar() {
  const [wsBarH, setWsBarH] = useState(37)
  const wsBarElRef = useRef<HTMLDivElement | null>(null)
  const wsBarRoRef = useRef<ResizeObserver | null>(null)
  const workspaceRef = useCallback((el: HTMLDivElement | null) => {
    if (wsBarElRef.current === el) return
    wsBarElRef.current = el
    wsBarRoRef.current?.disconnect()
    wsBarRoRef.current = null
    if (!el) return
    const report = (h: number) =>
      setWsBarH((prev) => (Math.abs(prev - h) < 0.5 ? prev : h))
    // Sync first measurement so the very first paint is already correct
    // (e.g. the tasks bar is open when the session loads).
    report(el.getBoundingClientRect().height)
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height
      if (h != null) report(h)
    })
    wsBarRoRef.current = ro
    ro.observe(el)
  }, [])
  return { wsBarH, wsBarElRef, workspaceRef }
}
