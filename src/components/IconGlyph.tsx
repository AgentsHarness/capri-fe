/**
 * Shared 1-col icon (TUI bullet / prompt prefix / execute "$").
 * Fixed 1.25em box at 13px so ◆ ◇ ◈ › ⌄ ❯ $ ✗ share one vertical axis.
 *
 * Icons are inline SVG (ICON_PATHS) — deterministic on every platform, no
 * font fallback, no per-glyph nudge. The glyph fills the inner 1em box and
 * is centered by the flex column, so its optical center is exactly the box
 * center; unknown strings fall back to plain text rendering.
 */
import { Glyphs } from '../theme/glyphs'
import { ICON_PATHS } from '../theme/glyphPaths'
import { ICON_COL_CLASS } from '../theme/layout'

export function IconGlyph({
  glyph = Glyphs.diamondFilled,
  color,
  animated,
  className = '',
}: {
  glyph?: string
  color?: string
  animated?: boolean
  className?: string
}) {
  const icon = ICON_PATHS[glyph]
  return (
    <span
      className={`${ICON_COL_CLASS} ${animated ? 'animate-pulse' : ''} ${className}`}
      style={color ? { color } : undefined}
      aria-hidden
    >
      {icon ? (
        <svg
          viewBox="0 0 1 1"
          className="block h-[1em] w-[1em]"
          style={
            icon.fill
              ? { fill: 'currentColor' }
              : {
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: icon.sw,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                }
          }
        >
          <path d={icon.d} />
        </svg>
      ) : (
        <span className="block leading-none">{glyph}</span>
      )}
    </span>
  )
}
