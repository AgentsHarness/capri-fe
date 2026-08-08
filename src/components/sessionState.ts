import { useEffect, useState } from 'react'
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from '../theme/glyphs'
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
