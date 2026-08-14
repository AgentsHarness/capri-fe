import { useEffect, useLayoutEffect, useState } from 'react'
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from '../../theme/glyphs'

/** History-switch overlay + content fade-in chrome. */
export function useLoadChrome(
  historyLoading: boolean,
  historyLoadingMore: boolean,
  historyLoadError: string | null | undefined,
  historyLoadedAt: number | null | undefined,
  entryCount: number,
) {
  // History-switch loading indicator: same braille spinner as the
  // composer turn-status line (TUI glyphs.rs), ~7.5fps. The overlay
  // stays mounted permanently (pointer-events-none); opacity is toggled
  // by class so the 300 ms transition plays for BOTH the fade-in and
  // the fade-out — a conditionally mounted element would never paint
  // its starting opacity before the first frame, so the fade would
  // be skipped.
  const loadingVisible = historyLoading && entryCount === 0
  // 加载失败：historyLoading 归 false 但未载入任何内容（continueSession
  // / loadHistory 失败且 timeline 为空）→ 同一覆盖层从"加载会话…"转为
  // "加载失败 + 原因"，点击列表中的会话行即重试（行保持选中态）。
  const loadFailedVisible =
    !historyLoading && historyLoadError != null && entryCount === 0
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  // Spin for the session-load overlay and the top "正在回放…" hint.
  const spinnerActive = loadingVisible || historyLoadingMore
  useEffect(() => {
    if (!spinnerActive) return
    const t = window.setInterval(
      () => setSpinnerFrame((v) => (v + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    )
    return () => window.clearInterval(t)
  }, [spinnerActive])
  // Content fade-in after a history switch: the new entries render in
  // the same commit that bumps historyLoadedAt. A useLayoutEffect drops
  // the column to opacity 0 BEFORE the browser paints (full-opacity
  // content is never shown, so no 100→0 transition flash), then a single
  // rAF restores it and the 300 ms transition plays a real fade-in —
  // cross-fading with the loading overlay's fade-out instead of a pop.
  const [contentVisible, setContentVisible] = useState(true)
  useLayoutEffect(() => {
    if (historyLoadedAt == null) return
    setContentVisible(false)
    const raf = requestAnimationFrame(() => setContentVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [historyLoadedAt])
  return { loadingVisible, loadFailedVisible, spinnerFrame, contentVisible }
}
