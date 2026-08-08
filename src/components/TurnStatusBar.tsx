import { useEffect, useState } from 'react'
import { formatTurnDuration, useChatStore } from '../store/chat'
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS, toolHeader } from '../theme/glyphs'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../theme/layout'
import { fmtTok } from './StatusChips'
import { Accents } from './AccentRail'
import type { ScrollEntry } from '../api/types'

/**
 * Turn status line — TUI xai-grok-pager views/turn_status.rs.
 *
 * Layout: `⠧ Run command 0.2s              1m20s ⇣12k [stop]`
 *
 * - Left: braille spinner + activity label (colored per activity type) +
 *   phase timer `Xs` (muted).
 * - Right: turn timer `Xm Ys` + token count `⇣Nk` + `[stop]` cancel button
 *   (red on hover).
 *
 * Hidden when idle (0 height). Appears between scrollback and the
 * approval strip / composer — in normal flow, so it never overlaps them.
 */

/** Current activity: newest running entry — tool or thinking — else null. */
function currentActivity(
  entries: ScrollEntry[],
): { label: string; color: string; startedAt?: number } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'thought' && e.streaming) {
      return { label: 'Thinking', color: Accents.thinkingDefault, startedAt: e.startedAt }
    }
    if (e.kind === 'tool' && (e.status === 'pending' || e.status === 'in_progress')) {
      const verb = toolHeader(e.kindName, false).verb
      const target = (e.title || e.kindName || '').trim()
      return { label: `${verb} ${target}`.trim(), color: Accents.success }
    }
  }
  return null
}

export function TurnStatusBar() {
  const conn = useChatStore((s) => s.conn)
  const entries = useChatStore((s) => s.entries)
  const turnStartedAt = useChatStore((s) => s.turnStartedAt)
  const turnTokens = useChatStore((s) => s.usage?.turnTokens)
  const requestCancelTurn = useChatStore((s) => s.requestCancelTurn)

  // Spinner frames + timer refresh share one cadence (~7.5fps, TUI
  // SPINNER_DIVISOR=4 at ~30fps); the timers re-derive from Date.now() on
  // every tick.
  const [frame, setFrame] = useState(0)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (conn !== 'busy') return
    const t = window.setInterval(() => {
      setFrame((v) => (v + 1) % SPINNER_FRAMES.length)
      setTick((v) => v + 1)
    }, SPINNER_INTERVAL_MS)
    return () => window.clearInterval(t)
  }, [conn])

  if (conn !== 'busy') return null

  const activity = currentActivity(entries)
  const now = Date.now()
  const label = activity?.label ?? 'Working'
  const color = activity?.color ?? Accents.gray
  // Phase timer: the activity's own start; fall back to the turn start
  // (tools don't carry startedAt — the turn start is the closest proxy).
  const phaseStart = activity?.startedAt ?? turnStartedAt
  const phaseTimer = phaseStart != null ? formatTurnDuration(now - phaseStart) : null
  const turnTimer = turnStartedAt != null ? formatTurnDuration(now - turnStartedAt) : null

  return (
    <div className={`${CONTENT_COLUMN_CLASS} h-5 shrink-0 select-none`}>
      <div
        className={`${COLUMN_PAD_X_CLASS} flex h-full items-center justify-between gap-2 text-[12px] leading-none text-gn-muted`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-mono leading-none" style={{ color }} aria-hidden>
            {SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}
          </span>
          <span className="truncate" style={{ color }}>
            {label}
          </span>
          {phaseTimer != null && <span className="shrink-0">{phaseTimer}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {turnTimer != null && <span>{turnTimer}</span>}
          {turnTokens != null && turnTokens > 0 && (
            <span className="text-gn-gutter">⇣{fmtTok(turnTokens)}</span>
          )}
          <button
            type="button"
            onClick={() => void requestCancelTurn()}
            className="text-gn-muted transition-colors hover:text-gn-red"
          >
            [stop]
          </button>
        </span>
      </div>
    </div>
  )
}
