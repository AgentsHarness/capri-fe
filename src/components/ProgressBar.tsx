/**
 * 进度条 —— 取代原来用 `████░░` 字符拼的条（上下文 chip、目标预算、
 * 子代理 gauge、工作流进度）。
 *
 * 宽度按字符列数给（`Nch`）：等宽字体下 1ch 就等于原字符条一列的宽度，
 * 所以换掉字符条后占位宽度不变，行不会跳。填充段按百分比撑开。
 *
 * 颜色：`tone` 传 text-* 类（填充用 bg-current 继承它）；不传则继承父级
 * 的 currentColor——ContextChip / 子代理 gauge 的动态紧迫色走这条。
 * 数值由旁边的百分比文字或父元素的 aria-label 承担，条本身 aria-hidden。
 */
export function ProgressBar({
  pct,
  cols,
  tone,
  height = 6,
  className = '',
}: {
  /** 0–100，越界与 NaN 自动夹取。 */
  pct: number
  /** 条宽，单位是字符列（沿用原字符条列数）。 */
  cols: number
  /** 填充色：text-* 类；省略则用 currentColor。 */
  tone?: string
  /** 条高（px）。 */
  height?: number
  className?: string
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 overflow-hidden rounded-sm bg-gn-gray-dim/40 ${className}`}
      style={{ width: `${cols}ch`, height }}
    >
      <span
        className={`block h-full rounded-sm bg-current ${tone ?? ''}`}
        style={{ width: `${clamped}%` }}
      />
    </span>
  )
}
