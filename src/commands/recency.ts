/**
 * ── TUI slash MRU port (slash/mru.rs) ─────────────────────────────────
 * Bare-`/` menu ordering input: a flat `command → last_used` map with an
 * exponentially decayed score (half-life 7 days, 0.1 floor — never-used
 * commands score 0 and keep their registry order). The TUI persists to
 * `~/.grok/slash-mru.json`; the web client keeps the same shape in
 * localStorage (`capri-fe.slashRecency`), capped at 256 entries.
 */
import { loadJSON, saveJSON } from '../lib/storage'
import { KEY } from '../lib/keys'

const RECENCY_KEY = KEY.slashRecency
const RECENCY_MAX = 256
/** TUI RECENCY_HALF_LIFE_SECS / RECENCY_FLOOR. */
const HALF_LIFE_MS = 7 * 24 * 3600 * 1000
const FLOOR = 0.1

type RecencyMap = Record<string, number>

let cached: RecencyMap | null = null

function load(): RecencyMap {
  if (cached === null) {
    const v = loadJSON<RecencyMap>(RECENCY_KEY, {})
    cached = v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  }
  return cached
}

/** Record a command execution (menu pick or typed line). */
export function bumpSlashRecency(name: string): void {
  const t = name.trim()
  if (!t) return
  const map = load()
  map[t] = Date.now()
  // Cap at the TUI limit — drop the oldest entries (Map-less object:
  // insertion order is not guaranteed after JSON round-trip, so evict by
  // oldest timestamp instead).
  const keys = Object.keys(map)
  if (keys.length > RECENCY_MAX) {
    keys
      .sort((a, b) => (map[a] ?? 0) - (map[b] ?? 0))
      .slice(0, keys.length - RECENCY_MAX)
      .forEach((k) => delete map[k])
  }
  saveJSON(RECENCY_KEY, map)
}

/**
 * TUI recency_score: `last_used × max(0.5^(age / half_life), floor)` —
 * 0 for commands never used, so they always sort below any used one.
 */
export function slashRecencyScore(name: string, now = Date.now()): number {
  const ts = load()[name]
  if (!ts) return 0
  const age = Math.max(0, now - ts)
  return ts * Math.max(Math.pow(0.5, age / HALF_LIFE_MS), FLOOR)
}
