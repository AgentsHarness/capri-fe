/**
 * Ports of xai-grok-pager-render theme::wave_brightness
 * and entry_renderer WAVE_SPEED / appearance animation defaults.
 */

/** Radians per tick (~30fps) — entry_renderer WAVE_SPEED. */
export const WAVE_SPEED = 0.15

/** Rows per full wave cycle — appearance.animation.wave_rows default. */
export const WAVE_ROWS = 32

/** Collapsed groupable dim blend ratio — display.dim_accent default. */
export const DIM_ACCENT = 0.5

/** Tool/thinking finish flash window — FINISH_FLASH_DURATION_MS. */
export const FINISH_FLASH_MS = 400

/**
 * Traveling-wave brightness along an accent rail.
 * sin²(t + phase) ∈ [0, 1]; each row has a fixed phase offset.
 */
export function waveBrightness(
  tick: number,
  row: number,
  waveRows: number = WAVE_ROWS,
  speed: number = WAVE_SPEED,
): number {
  const rowsPerWave = Math.max(1, waveRows)
  const phase = (row / rowsPerWave) * 2 * Math.PI
  const t = tick * speed
  const sinVal = Math.sin(t + phase)
  return sinVal * sinVal
}

/**
 * Blend `fg` over `bg` by `t` ∈ [0, 1] via CSS color-mix (matches blend_color intent).
 */
export function blendColor(bg: string, fg: string, t: number): string {
  const pct = Math.round(Math.min(1, Math.max(0, t)) * 100)
  if (pct <= 0) return bg
  if (pct >= 100) return fg
  return `color-mix(in srgb, ${fg} ${pct}%, ${bg})`
}
