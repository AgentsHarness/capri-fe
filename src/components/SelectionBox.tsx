/**
 * TUI SelectionBox port (scrollback/selection.rs + agent::render_entry_hover).
 *
 * Left/right rails wrap the entry (选区) at full entry height, drawn with
 * pure CSS 1px borders — deterministic on every platform (no box-drawing
 * font glyphs, no ink measurement):
 *
 *   ┌                    ┐
 *   │                    │
 *   └                    ┘
 *
 * Corner horizontal strokes sit exactly on the entry top/bottom edges; the
 * side line spans the full height under the corners, so sides always meet.
 * `topClipped` / `bottomClipped` replace the corner with a short dashed
 * segment (the selection continues past the entry — the TUI ┆ corner).
 */

import type { CSSProperties } from 'react'

export type SelectionVariant = 'selected' | 'hover'

type Props = {
  variant?: SelectionVariant
  topClipped?: boolean
  bottomClipped?: boolean
  /** @deprecated kept for call-site compat */
  compact?: boolean
}

/** Rail width (slim frame). */
const RAIL_W_PX = 5

/** Corner arm length in px. */
const CORNER_PX = 5

/** Horizontal wrap past entry (TUI +1 col into outer pad). */
const OUTSET_X_PX = 12

/** Clipped-corner dash: 2px dash / 2px gap. */
const DASH_BG = (color: string) =>
  `repeating-linear-gradient(to bottom, ${color} 0 2px, transparent 2px 4px)`

const COLOR_SELECTED =
  'color-mix(in srgb, var(--color-gn-selection) 55%, var(--color-gn-bg-base))'

const COLOR_HOVER = 'var(--color-gn-hover-border)'

export function SelectionBox({
  variant = 'selected',
  topClipped,
  bottomClipped,
}: Props) {
  const color = variant === 'hover' ? COLOR_HOVER : COLOR_SELECTED

  return (
    <div
      // 移动端不显示选中框：选中是桌面键盘导航（j/k）的视觉指示，触屏
      // 上没有该交互；隐藏后条目选中态仍由底色/accent 体现（sm: = 桌面）。
      className="pointer-events-none absolute z-[1] hidden select-none sm:block"
      style={{
        left: -OUTSET_X_PX,
        right: -OUTSET_X_PX,
        top: 0,
        bottom: 0,
        color,
      }}
      aria-hidden
    >
      <Rail side="left" color={color} topClipped={topClipped} bottomClipped={bottomClipped} />
      <Rail side="right" color={color} topClipped={topClipped} bottomClipped={bottomClipped} />
    </div>
  )
}

function Rail({
  side,
  color,
  topClipped,
  bottomClipped,
}: {
  side: 'left' | 'right'
  color: string
  topClipped?: boolean
  bottomClipped?: boolean
}) {
  // Side line + corner legs sit on the frame edge; corners extend inward.
  const edgeStyle = { [side]: 0 } as CSSProperties
  const legBorder = side === 'left' ? 'borderLeft' : 'borderRight'
  return (
    <div
      className="absolute top-0 bottom-0"
      style={{ ...edgeStyle, width: RAIL_W_PX }}
      aria-hidden
    >
      {/* Continuous side line on the frame edge (under the corners). */}
      <div
        className="absolute top-0 bottom-0 w-px"
        style={{ ...edgeStyle, background: color }}
      />

      {/* Top corner: horizontal stroke lands exactly on the frame top. */}
      {topClipped ? (
        <div
          className="absolute top-0 h-[6px] w-px"
          style={{ ...edgeStyle, background: DASH_BG(color) }}
        />
      ) : (
        <div
          className="absolute top-0"
          style={{
            ...edgeStyle,
            height: CORNER_PX,
            width: CORNER_PX,
            [legBorder]: '1px solid',
            borderTop: '1px solid',
            borderColor: color,
          }}
        />
      )}

      {/* Bottom corner: horizontal stroke lands exactly on the frame bottom. */}
      {bottomClipped ? (
        <div
          className="absolute bottom-0 h-[6px] w-px"
          style={{ ...edgeStyle, background: DASH_BG(color) }}
        />
      ) : (
        <div
          className="absolute bottom-0"
          style={{
            ...edgeStyle,
            height: CORNER_PX,
            width: CORNER_PX,
            [legBorder]: '1px solid',
            borderBottom: '1px solid',
            borderColor: color,
          }}
        />
      )}
    </div>
  )
}
