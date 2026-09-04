import { useEffect, useState } from 'react'

/** Coarse pointer / no-hover — treat as mobile touch UI. */
export function isTouchUi(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(hover: none), (pointer: coarse)').matches
}

export function useTouchUi(): boolean {
  const [touch, setTouch] = useState(isTouchUi)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(hover: none), (pointer: coarse)')
    const apply = () => setTouch(mq.matches)
    apply()
    mq.addEventListener?.('change', apply)
    return () => mq.removeEventListener?.('change', apply)
  }, [])
  return touch
}
