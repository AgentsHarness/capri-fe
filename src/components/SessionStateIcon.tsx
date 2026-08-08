import { Glyphs, SPINNER_FRAMES } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'

/**
 * Live session state icon, shared by the desktop sidebar and the mobile
 * history dropdown:
 * - active → braille spinner (same frames/cadence as busy), green
 * - awaiting / 待处理 → filled diamond, blue
 * - idle → hollow diamond SVG, muted
 */
export function SessionStateIcon({
  state,
  pending,
  spinnerFrame,
}: {
  state: string
  pending: boolean
  spinnerFrame: number
}) {
  if (state === 'active' && !pending) {
    return (
      <span
        className="inline-flex w-[1.25em] shrink-0 items-center justify-center font-mono text-[12px] leading-none text-gn-green"
        aria-hidden
      >
        {SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}
      </span>
    )
  }
  // Diamonds share the spinner's column width, but use a smaller em so the
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
      className="inline-flex w-[1.25em] shrink-0 items-center justify-center text-gn-muted"
      aria-hidden
    >
      <IconGlyph glyph={Glyphs.diamondHollow} className="!text-[10px]" />
    </span>
  )
}
