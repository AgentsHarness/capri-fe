import type { MouseEvent, ReactNode } from 'react'

/**
 * 行内纯文本动作（TUI 式的 `[kill]` / `[cancel]`）：方括号即点击区标识，
 * 无外边框；hover 圆角底色与顶栏 / 弹窗按钮同一套。
 * line-height 跟随所在行——桌面端不改变行高，窄屏给 min-h-6 触摸目标
 * （与状态条 `[stop]` 同一约定）。
 */
const TONE_CLASS = {
  danger: 'text-gn-red/80 hover:bg-gn-diff-del-bg hover:text-gn-red',
  neutral: 'text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg',
  plan: 'text-gn-plan hover:bg-gn-bg-highlight hover:text-gn-fg',
} as const

export function InlineAction({
  label,
  title,
  onRun,
  tone = 'danger',
  disabled = false,
  /**
   * 请求在飞：按钮换成转圈、禁止再次点击。
   *
   * 由调用方受控传入，而不是内部自己 await onRun——大量调用点是
   * `void respond(...)` 的一次性触发，内部托管状态会与调用方自己的
   * pending/终态交错（卡片被移除后 setState 落在已卸载组件上）。
   */
  busy = false,
  busyLabel = '',
  className = '',
}: {
  label: ReactNode
  title?: string
  onRun: () => void
  tone?: keyof typeof TONE_CLASS
  disabled?: boolean
  busy?: boolean
  busyLabel?: string
  className?: string
}) {
  const inert = disabled || busy
  return (
    <button
      type="button"
      disabled={inert}
      aria-busy={busy || undefined}
      onClick={(ev: MouseEvent) => {
        ev.stopPropagation()
        if (inert) return
        onRun()
      }}
      title={title}
      className={`shrink-0 cursor-pointer whitespace-nowrap rounded px-0.5 font-mono text-[12px] min-h-6 sm:min-h-0 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${TONE_CLASS[tone]} ${className}`}
    >
      {/* 转圈用 braille 帧里的静止首帧：这里不做逐帧动画——按钮是瞬时
          动作，动画会让同一屏里的多个 spinner 互相打架，静态帧足以表达
          "请求在飞"。 */}
      {busy ? `[⠋${busyLabel}]` : `[${label}]`}
    </button>
  )
}
