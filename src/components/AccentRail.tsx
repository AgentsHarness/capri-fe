import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Glyphs } from '../theme/glyphs'
import { Accents, type AccentPaint } from '../theme/accents'
import { DIM_ACCENT, WAVE_ROWS, WAVE_SPEED, blendColor, waveBrightness } from '../theme/wave'
// ── Rail component ─────────────────────────────────────────────────────

type Props = {
  paint: AccentPaint
  /** Drive wave tick from parent when multiple rails share a clock (optional). */
  tick?: number
}

/**
 * Left accent rail — glyphs.accent_bar (`┃`) / collapsed (`❙`) with
 * per-row wave_brightness animation (TUI EntryRenderer port).
 *
 * Height / alignment:
 * - Track is always the entry column (≤ SelectionBox content band).
 * - Visual bar is **vertically centered** in the selection region (entry
 *   is already centered in the frame via equal OUTSET_Y on SelectionBox).
 * - Collapsed: short tick (❙) centered in the track.
 * - Expanded / running: rail height matches content, still column-centered.
 * - Hover / selected: color only — never change height.
 */
export function AccentRail({ paint, tick: tickProp }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [rows, setRows] = useState(1)
  const [tickLocal, setTickLocal] = useState(0)
  const tick = tickProp ?? tickLocal

  // Full-height rails only need row count for the wave (not collapsed ticks).
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el || !paint.show || paint.collapsedGlyph) return
    const measure = () => {
      const h = el.clientHeight
      // ~1 terminal cell ≈ 1.15 * 11px chrome; keep segments fine for wave.
      const rowH = 11
      setRows(Math.max(1, Math.ceil(h / rowH)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [paint.show, paint.collapsedGlyph])

  // prefers-reduced-motion → treat animated as frozen solid
  const [reduceMotion, setReduceMotion] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => setReduceMotion(mq.matches)
    apply()
    mq.addEventListener?.('change', apply)
    return () => mq.removeEventListener?.('change', apply)
  }, [])

  // ~30fps tick while animated and not frozen
  const frozen = paint.frozen || reduceMotion
  const needsTick = paint.show && paint.animated && !frozen && tickProp == null
  useEffect(() => {
    if (!needsTick) return
    let raf = 0
    let last = performance.now()
    let t = 0
    const frame = (now: number) => {
      // advance ~1 tick per 33ms (≈30fps)
      if (now - last >= 33) {
        t += 1
        setTickLocal(t)
        last = now
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [needsTick])

  if (!paint.show) {
    return <div className="w-0 shrink-0" aria-hidden />
  }

  const baseColor = paint.color
  const interaction = paint.interaction ?? 'idle'
  // Color ladder: idle (dim) < hover (mid) < selected (full)
  let paintColor = baseColor
  let paintOpacity = 0.9
  if (interaction === 'selected') {
    paintColor = baseColor
    paintOpacity = 1
  } else if (interaction === 'hover') {
    paintColor = blendColor(Accents.bg, baseColor, 0.72)
    paintOpacity = 0.95
  } else if (paint.dim) {
    paintColor = blendColor(Accents.bg, baseColor, DIM_ACCENT)
    paintOpacity = 0.9
  }
  const live = paint.animated && !frozen

  // Column track: stretch with the entry (same band SelectionBox wraps).
  // Visual paint is always vertically centered inside the track.
  const trackClass =
    'relative flex w-[3px] shrink-0 select-none self-stretch items-center justify-center overflow-hidden'

  // ── Collapsed content mode: short tick (❙), centered in 选区 ────────
  if (paint.collapsedGlyph && !live) {
    return (
      <div className={trackClass} aria-hidden>
        <span
          className="block w-full rounded-[0.5px]"
          style={{
            // Slightly longer than a pure ❙ so dense rows still read as a
            // mark without merging into a full ┃ rail.
            height: '0.75em',
            minHeight: 11,
            maxHeight: 14,
            backgroundColor: paintColor,
            opacity: paintOpacity,
          }}
          title={Glyphs.collapsedAccent}
        />
      </div>
    )
  }

  // ── Full rail: fill track height (entry = content of selection frame) ─
  // Track is vertically centered in SelectionBox via equal OUTSET_Y.
  return (
    <div
      ref={wrapRef}
      className={trackClass}
      style={{ ['--gn-bar' as string]: baseColor }}
      aria-hidden
    >
      <div className="relative h-full min-h-0 w-full self-stretch">
        {live ? (
          <div className="absolute inset-0 flex flex-col">
            {Array.from({ length: rows }).map((_, row) => {
              const b = waveBrightness(tick, row, WAVE_ROWS, WAVE_SPEED)
              const c = blendColor(Accents.bg, baseColor, b)
              return (
                <div
                  key={row}
                  className="min-h-0 flex-1"
                  style={{ backgroundColor: c }}
                />
              )
            })}
          </div>
        ) : (
          <div
            className="absolute inset-0"
            style={{ backgroundColor: paintColor, opacity: paintOpacity }}
          />
        )}

        <div
          className="pointer-events-none absolute inset-0 overflow-hidden"
          style={{
            // ┃ cell-bar texture — CSS gradient, no font glyphs.
            backgroundImage:
              'repeating-linear-gradient(to bottom, currentColor 0 1.5px, transparent 1.5px 11px)',
            color: live ? baseColor : paintColor,
            opacity: live ? 0.25 : 0.35,
          }}
        />
      </div>
    </div>
  )
}
