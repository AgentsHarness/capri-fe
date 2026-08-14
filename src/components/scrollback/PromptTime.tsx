import { useChatStore } from '../../store/chat'

/** TUI prompt timestamp (scrollback_pane show_timestamps): "20:31". */
function formatPromptTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** TUI hover expansion: "08/06 20:31:45". */
function formatPromptTimeFull(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * TUI right-aligned message timestamp overlay (scrollback_pane
 * show_timestamps): short form always, expands to "HH:MM:SS | Mon D" on
 * hover of the time area itself (not the whole entry — hovering the row
 * never expands it). Absolutely positioned so the wider hover form never
 * reflows the message content — it covers it, as in the TUI.
 *
 * Hard-won constraints (verified empirically in Chrome):
 * - The swap is driven by the OUTER span's own :hover via the custom
 *   .gn-pt classes (index.css) — NOT group-hover:, whose :is(:where(.group)
 *   :hover *) matches ANY .group ancestor, so the entry row's group class
 *   would expand the time on any row hover.
 * - The outer span's width is pinned to the FULL form's width
 *   (w-[17ch], text-right): an absolutely-positioned span shrinks to
 *   width 0 when both children are display:none, collapsing the hover
 *   target and the full form's box (flicker/vanish). Fixed width keeps
 *   the box — and the :hover on it — stable across the swap.
 * Parent needs `group relative`; `className` supplies the top offset and
 * `shiftRight` clears a right-edge chevron (12px), keeping the same 8px
 * base margin from the edge in both cases.
 */
export function PromptTime({
  ts,
  className = '',
  shiftRight = false,
}: {
  ts?: number
  className?: string
  shiftRight?: boolean
}) {
  // /timestamps toggle (TUI scrollback_pane show_timestamps) — one gate
  // here covers every PromptTime call site.
  const showTimestamps = useChatStore((s) => s.showTimestamps)
  if (!showTimestamps || ts == null) return null
  return (
    <span
      aria-hidden
      className={`gn-pt absolute w-[17ch] text-right text-[11px] leading-none text-gn-gray ${className}`}
      style={{ right: shiftRight ? 20 : 8 }}
    >
      <span className="gn-pt-short">{formatPromptTime(ts)}</span>
      <span className="gn-pt-full">{formatPromptTimeFull(ts)}</span>
    </span>
  )
}
