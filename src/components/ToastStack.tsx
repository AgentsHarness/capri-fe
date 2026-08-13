import { useEffect, useRef } from 'react'
import { useToastStore } from '../store/toast'

/** In-page toast auto-dismiss window. */
const TOAST_TTL_MS = 6000

/**
 * Completion toasts — top-right stack (below the TopBar), shown when a
 * session finished while the user was elsewhere and system notifications
 * are not granted. Each toast auto-dismisses after TOAST_TTL_MS and has
 * a manual ✕.
 */
export function ToastStack() {
  const toasts = useToastStore((s) => s.toasts)
  const dismissToast = useToastStore((s) => s.dismissToast)

  // One auto-dismiss timer per toast id, armed on first appearance only.
  // Re-arming from the whole `toasts` array on every change would let a
  // manual ✕ on one toast extend the lifetime of all the others.
  const timers = useRef(new Map<string, number>())
  useEffect(() => {
    const alive = new Set<string>()
    for (const t of toasts) {
      alive.add(t.id)
      if (timers.current.has(t.id)) continue
      const timer = window.setTimeout(() => {
        timers.current.delete(t.id)
        dismissToast(t.id)
      }, TOAST_TTL_MS)
      timers.current.set(t.id, timer)
    }
    // Drop timers for toasts already dismissed manually (✕).
    for (const [id, timer] of timers.current) {
      if (!alive.has(id)) {
        window.clearTimeout(timer)
        timers.current.delete(id)
      }
    }
  }, [toasts, dismissToast])

  // Unmount safety: don't leave timers firing against a stale store.
  useEffect(() => {
    const current = timers.current
    return () => {
      current.forEach((t) => window.clearTimeout(t))
      current.clear()
    }
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed right-4 top-14 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-start gap-2 rounded border border-gn-prompt-border bg-gn-bg-dark px-3 py-2 shadow-lg"
        >
          <span className="mt-px shrink-0 text-[11px] leading-none text-gn-green">✓</span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-gn-fg" title={t.text}>
            {t.text}
          </span>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            className="shrink-0 rounded px-0.5 text-[11px] leading-none text-gn-gutter hover:text-gn-fg"
            aria-label="关闭提醒"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
