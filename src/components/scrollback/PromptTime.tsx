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
  inline = false,
}: {
  ts?: number
  className?: string
  shiftRight?: boolean
  /** Sit in a flex cluster (e.g. next to the 引导 badge) instead of overlay. */
  inline?: boolean
}) {
  // /timestamps toggle (TUI scrollback_pane show_timestamps) — one gate
  // here covers every PromptTime call site.
  const showTimestamps = useChatStore((s) => s.showTimestamps)
  if (!showTimestamps || ts == null) return null
  return (
    <span
      aria-hidden
      className={
        inline
          ? `gn-pt pointer-events-auto relative inline-block text-right text-[11px] leading-none text-gn-gray ${className}`
          : `gn-pt absolute w-[17ch] text-right text-[11px] leading-none text-gn-gray ${className}`
      }
      style={inline ? undefined : { right: shiftRight ? 20 : 8 }}
    >
      <span className="gn-pt-short">{formatPromptTime(ts)}</span>
      <span className="gn-pt-full">{formatPromptTimeFull(ts)}</span>
    </span>
  )
}

/** 用户消息右上：引导徽标贴在时间左边。时间关闭时徽标仍靠右。 */
export function UserSteerTime({
  ts,
  steer,
  className = '',
}: {
  ts?: number
  steer?: boolean
  className?: string
}) {
  if (!steer) {
    return <PromptTime ts={ts} className={className} />
  }
  // 与用户消息第一行同高（13.5px × 1.35），顶对齐 py-[11px]；
  // 引导 / 时间在这一格里垂直居中。时间自己 pointer-events-auto，hover 才扩得开。
  return (
    <div
      className="pointer-events-none absolute right-2 top-[11px] z-[1] flex h-[1.35em] items-center gap-1"
    >
      <span
        className="inline-block rounded px-1 py-[2px] text-[11px] font-medium leading-none select-none"
        style={{
          backgroundColor: 'color-mix(in srgb, var(--color-gn-warning) 18%, transparent)',
          color: 'var(--color-gn-warning)',
        }}
      >
        引导
      </span>
      <PromptTime ts={ts} inline />
    </div>
  )
}
