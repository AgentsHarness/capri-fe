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
  className = '',
}: {
  label: ReactNode
  title?: string
  onRun: () => void
  tone?: keyof typeof TONE_CLASS
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(ev: MouseEvent) => {
        ev.stopPropagation()
        onRun()
      }}
      title={title}
      className={`shrink-0 cursor-pointer whitespace-nowrap rounded px-0.5 font-mono text-[12px] min-h-6 sm:min-h-0 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${TONE_CLASS[tone]} ${className}`}
    >
      [{label}]
    </button>
  )
}
