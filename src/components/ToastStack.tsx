import { useEffect, useRef } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { inferToastType, useToastStore } from '../store/toast'
import type { ToastType } from '../api/types'

/** In-page toast auto-dismiss window. */
const TOAST_TTL_MS = 3000

const TOAST_CONFIG: Record<
  ToastType,
  {
    icon: typeof CheckCircle2
    iconClass: string
    borderClass: string
    progressClass: string
  }
> = {
  success: {
    icon: CheckCircle2,
    iconClass: 'text-gn-green',
    borderClass: 'border-l-gn-green',
    progressClass: 'bg-gn-green/60',
  },
  error: {
    icon: AlertCircle,
    iconClass: 'text-gn-red',
    borderClass: 'border-l-gn-red',
    progressClass: 'bg-gn-red/60',
  },
  warning: {
    icon: AlertTriangle,
    iconClass: 'text-gn-yellow',
    borderClass: 'border-l-gn-yellow',
    progressClass: 'bg-gn-yellow/60',
  },
  info: {
    icon: Info,
    iconClass: 'text-gn-blue',
    borderClass: 'border-l-gn-blue',
    progressClass: 'bg-gn-blue/60',
  },
}

/**
 * Completion / notification toasts — responsive stack:
 * - Mobile: centered at top with smooth drop-in spring animation.
 * - Desktop: top-right stack (below TopBar) with slide-in from right.
 * Auto-dismisses after TOAST_TTL_MS with a countdown bar and manual ✕.
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
    <div
      className="pointer-events-none fixed top-3 left-1/2 -translate-x-1/2 z-50 flex w-[calc(100vw-1.5rem)] max-w-[380px] flex-col gap-2.5 sm:top-14 sm:right-6 sm:left-auto sm:translate-x-0 sm:w-88 sm:max-w-sm"
      role="region"
      aria-live="polite"
      aria-label="系统通知"
    >
      {toasts.map((t) => {
        const type = t.type ?? inferToastType(t.text)
        const cfg = TOAST_CONFIG[type]
        const Icon = cfg.icon
        const cleanText = t.text.replace(/^🔔\s*/, '')

        return (
          <div
            key={t.id}
            className={`gn-toast-card group pointer-events-auto relative flex items-center gap-2.5 overflow-hidden rounded-md border border-gn-prompt-border border-l-[3px] ${cfg.borderClass} bg-gn-bg-base px-3.5 py-2.5`}
          >
            <Icon className={`h-4 w-4 shrink-0 ${cfg.iconClass}`} aria-hidden="true" />
            <span
              className="min-w-0 flex-1 break-words text-[12.5px] leading-snug text-gn-fg select-text"
              title={t.text}
            >
              {cleanText}
            </span>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg active:scale-90"
              aria-label="关闭提醒"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <div
              className={`gn-toast-progress absolute bottom-0 left-0 right-0 h-[1.5px] ${cfg.progressClass}`}
            />
          </div>
        )
      })}
    </div>
  )
}
