import { useEffect, useRef, useState } from 'react'

/**
 * TUI Esc ladder (prompt.rs try_handle_esc_policy, idle side) — hook 形态。
 * First idle Esc ARMS: a non-empty draft shows "press again to clear"
 * (second Esc within the TTL clears the buffer); an empty draft arms the
 * rewind picker (second Esc opens /rewind, first press stays silent
 * apart from the hint). Any other key disarms. Busy Esc never reaches
 * this — the cancel flow owns it.
 *
 * escArmAtRef 由调用方的键盘路由直接读（armed 判定走 800ms TTL 比对），
 * 所以连 ref 一起返回。
 */
export function useEscLadder() {
  const escArmAtRef = useRef(0)
  const [escHint, setEscHint] = useState<'clear' | 'rewind' | null>(null)
  const escHintTimerRef = useRef<number | null>(null)
  const disarmEsc = () => {
    if (escArmAtRef.current === 0 && escHint == null) return
    escArmAtRef.current = 0
    setEscHint(null)
  }
  const armEsc = (hint: 'clear' | 'rewind') => {
    escArmAtRef.current = Date.now()
    setEscHint(hint)
    if (escHintTimerRef.current != null) {
      window.clearTimeout(escHintTimerRef.current)
    }
    escHintTimerRef.current = window.setTimeout(() => {
      escArmAtRef.current = 0
      setEscHint(null)
    }, 800)
  }
  useEffect(() => {
    return () => {
      if (escHintTimerRef.current != null) {
        window.clearTimeout(escHintTimerRef.current)
      }
    }
  }, [])
  return { escArmAtRef, escHint, disarmEsc, armEsc }
}
