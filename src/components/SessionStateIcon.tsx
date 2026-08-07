import { useEffect, useState } from 'react'
import { Glyphs, SPINNER_FRAMES, SPINNER_INTERVAL_MS } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import type { SessionGroupKey } from './historyGroups'

/** Dashboard state label for row tooltips (per history bucket). */
export function stateLabel(key: SessionGroupKey): string {
  switch (key) {
    case 'active':
      return '处理中 (active)'
    case 'bg':
      return '后台任务运行中 (bg)'
    case 'awaiting':
      return '待处理 (未读)'
    case 'idle':
      return '空闲 (idle)'
  }
}

/**
 * Live session state icon, shared by the desktop sidebar and the mobile
 * history dropdown:
 * - active → braille spinner (same frames/cadence as busy), green
 * - awaiting / 待处理 → filled diamond, blue
 * - idle → hollow diamond SVG, muted
 */
export function SessionStateIcon({
  state,
  pending,
  spinnerFrame,
}: {
  state: string
  pending: boolean
  spinnerFrame: number
}) {
  if (state === 'active' && !pending) {
    return (
      <span
        className="inline-flex w-[1.25em] shrink-0 items-center justify-center font-mono text-[12px] leading-none text-gn-green"
        aria-hidden
      >
        {SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}
      </span>
    )
  }
  // Diamonds share the spinner's column width, but use a smaller em so the
  // history list stays lighter than scrollback bullets (13px).
  if (pending) {
    return (
      <span
        className="inline-flex w-[1.25em] shrink-0 items-center justify-center text-gn-blue"
        aria-hidden
      >
        <IconGlyph glyph={Glyphs.diamondFilled} className="!text-[10px]" />
      </span>
    )
  }
  return (
    <span
      className="inline-flex w-[1.25em] shrink-0 items-center justify-center text-gn-muted"
      aria-hidden
    >
      <IconGlyph glyph={Glyphs.diamondHollow} className="!text-[10px]" />
    </span>
  )
}

/**
 * Shared braille spinner state for any "active" rows (same cadence as busy).
 * Returns 0 while nothing is active so the interval only runs when needed.
 */
export function useSessionSpinner(anyActive: boolean): number {
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  useEffect(() => {
    if (!anyActive) return
    const t = window.setInterval(
      () => setSpinnerFrame((v) => (v + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    )
    return () => window.clearInterval(t)
  }, [anyActive])
  return spinnerFrame
}
