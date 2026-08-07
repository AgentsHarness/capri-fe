import { useChatStore } from '../store/chat'

/**
 * Top error banner — the always-visible place for host/agent errors
 * (`error` events, hello bootError). Host connection status (`status`
 * events) lives in the top-left host button instead, so the two never
 * double up. Auto-clears on recovery (ready / a new turn starts) or via
 * the ✕ button.
 */
export function ErrorBanner() {
  const error = useChatStore((s) => s.error)
  const dismissNotice = useChatStore((s) => s.dismissNotice)

  if (!error) return null

  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-gn-red/30 bg-gn-red/10 px-3 py-1.5 text-[12px] leading-snug select-none text-gn-red sm:px-4"
    >
      <span className="mt-px shrink-0" aria-hidden>
        ✕
      </span>
      <span className="min-w-0 flex-1 break-words">{error}</span>
      <button
        type="button"
        onClick={dismissNotice}
        className="shrink-0 rounded px-1.5 leading-[18px] opacity-70 hover:bg-gn-bg-highlight hover:opacity-100"
        title="关闭提示"
        aria-label="关闭提示"
      >
        ✕
      </button>
    </div>
  )
}
