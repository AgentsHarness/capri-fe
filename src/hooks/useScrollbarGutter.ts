import { useEffect, useState } from 'react'

/**
 * Measured scrollbar gutter width (px) of a scroll container that reserves it
 * via `scrollbar-gutter: stable`.
 *
 * A column that sits BESIDE the scroller (the composer under the scrollback /
 * subagent timeline) must reserve the same width on its right, or its bordered
 * box lands a few px off the column above it. `scrollbar-gutter` only applies
 * to scroll containers and the composer deliberately is not one (an
 * `overflow-y: auto` wrapper clipped the floating menus), so the width is
 * measured with a hidden probe instead.
 */
export function useScrollbarGutter(): number {
  const [gutterPx, setGutterPx] = useState(0)
  useEffect(() => {
    const measure = () => {
      const probe = document.createElement('div')
      probe.style.cssText =
        'position:fixed;visibility:hidden;top:0;left:0;width:100px;height:50px;overflow-y:auto;scrollbar-gutter:stable'
      document.body.appendChild(probe)
      const w = probe.clientWidth
      probe.remove()
      setGutterPx(100 - w)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  return gutterPx
}
