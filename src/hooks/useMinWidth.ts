import { useEffect, useState } from 'react'

/**
 * 视口宽度是否 ≥ px（响应 resize / 旋屏）。
 * jsdom 等没有 matchMedia 的环境按 false 处理，由调用方决定降级行为。
 */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`
  const read = () =>
    typeof window !== 'undefined' &&
    !!window.matchMedia &&
    window.matchMedia(query).matches

  const [matches, setMatches] = useState(read)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia(query)
    const apply = () => setMatches(mq.matches)
    apply()
    mq.addEventListener?.('change', apply)
    return () => mq.removeEventListener?.('change', apply)
  }, [query])

  return matches
}
