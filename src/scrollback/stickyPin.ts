/**
 * Overlay adaptation of TUI `scrollback/sticky.rs`.
 *
 * TUI pins in-flow (gradual collapse + clip-push). FE paints an absolute
 * band, so identity is overlay-safe:
 *   - pin the last user fully above `pinLine` (no self-overlap)
 *   - when the next user enters the sticky band, push the pin up
 *   - once the next user reaches `pinLine`, yield — in-flow is the title
 *   - the next user is not pinned until it is itself fully past
 */
import { USER_COLLAPSED_MAX_LINES } from './userText'

export type StickyUserPos = { id: string; top: number; bottom: number }

export type StickyPick = {
  id: string | null
  /** `translateY` while the next user pushes the pin off. */
  pushY: number
}

/** Collapsed sticky ≈ vertical padding + N lines. */
export function fallbackStickyBandH(
  padY = 11,
  fontSize = 13.5,
  lineHeight = 1.35,
  lines = USER_COLLAPSED_MAX_LINES,
): number {
  return padY * 2 + Math.ceil(fontSize * lineHeight * lines)
}

export function pickStickyPin(
  users: StickyUserPos[],
  pinLine: number,
  stickyH: number,
): StickyPick {
  if (users.length === 0 || stickyH <= 0) return { id: null, pushY: 0 }

  let idx = -1
  for (let i = 0; i < users.length; i++) {
    if (users[i].bottom <= pinLine) idx = i
    else break
  }
  if (idx < 0) return { id: null, pushY: 0 }

  const next = users[idx + 1]
  if (!next) return { id: users[idx].id, pushY: 0 }

  const bandBottom = pinLine + stickyH
  if (next.top >= bandBottom) return { id: users[idx].id, pushY: 0 }

  const overlap = bandBottom - next.top
  if (overlap >= stickyH) return { id: null, pushY: 0 }
  return { id: users[idx].id, pushY: -overlap }
}
