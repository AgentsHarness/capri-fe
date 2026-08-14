import { useEffect, useState } from 'react'
import type { ScrollEntry } from '../../api/types'
import { FINISH_FLASH_MS } from '../../theme/wave'

/**
 * Clock for finish-flash window (~50ms) while any entry is flashing.
 * Precise scheduling: one setTimeout at the earliest flash expiry instead
 * of a 50ms interval ticking the whole list — a flash window costs a
 * single re-render, not 20 per second.
 */
export function useFinishFlash(entries: ScrollEntry[]): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = Date.now()
    let next: number | null = null
    for (const e of entries) {
      if (e.kind !== 'tool' && e.kind !== 'thought') continue
      const fa = e.finishedAt
      if (fa != null && t - fa < FINISH_FLASH_MS) {
        const due = fa + FINISH_FLASH_MS
        if (next == null || due < next) next = due
      }
    }
    if (next == null) return
    const id = window.setTimeout(() => {
      setNow(Date.now())
    }, Math.max(1, next - t + 1))
    return () => window.clearTimeout(id)
  }, [entries])
  return now
}
