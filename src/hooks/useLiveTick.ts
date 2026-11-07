import { useEffect, useState } from 'react'

/** Re-render every second while a running subagent is open (live elapsed). */
export function useLiveTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active])
  return now
}
