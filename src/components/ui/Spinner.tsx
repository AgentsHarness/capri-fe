import { LoaderCircle } from 'lucide-react'

/**
 * 按钮内的等待转圈（请求已发出、等回执）。
 *
 * 统一用 CSS 自转的 `LoaderCircle`：与仓库其它「在飞」提示（状态芯片、
 * 目录选择器）同一形状；按钮宽度由父级 `min-w` / 固定文案撑住，图标
 * 不改变行高。纯文本动作（`InlineAction`）走字符帧，那里见方的方括号
 * 里放 SVG 会撑破基线。
 */
export function Spinner({
  size = 12,
  className = '',
}: {
  size?: number
  className?: string
}) {
  return (
    <LoaderCircle
      size={size}
      strokeWidth={2.5}
      aria-hidden
      className={`shrink-0 animate-spin ${className}`}
    />
  )
}
