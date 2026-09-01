import { LoaderCircle } from 'lucide-react'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'

/**
 * Live session state icon, shared by the desktop sidebar and the mobile
 * history dropdown:
 * - active → 旋转加载图标（CSS animate-spin，颜色随行标题的蓝 text-gn-cyan，
 *   尺寸与待办徽标一致 12px）。不再用 braille 字符：字符帧要 JS 每 133ms
 *   轮转，图标自己转就行
 * - awaiting / 待处理 → filled diamond, blue
 * - idle → 不显示图标，只留等宽占位，保证各行标题左边缘对齐
 */
export function SessionStateIcon({
  state,
  pending,
}: {
  state: string
  pending: boolean
}) {
  if (state === 'active' && !pending) {
    return (
      <span
        className="inline-flex w-[1.25em] shrink-0 items-center justify-center text-gn-cyan"
        aria-hidden
      >
        <LoaderCircle size={12} strokeWidth={2.5} className="animate-spin" />
      </span>
    )
  }
  // Diamonds share the loader's column width, but use a smaller em so the
  // history list stays lighter than scrollback bullets (13px).
  if (pending) {
    return (
      <span
        className="inline-flex w-[1.25em] shrink-0 items-center justify-center text-gn-blue"
        aria-hidden
      >
        <IconGlyph glyph={Glyphs.diamondFilled} className="!text-[10px]" />
      </span>
    )
  }
  return (
    <span
      className="inline-flex w-[1.25em] shrink-0 items-center justify-center"
      aria-hidden
    />
  )
}
