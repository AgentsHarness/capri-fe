import { loadJSON, saveJSON } from '../../lib/storage'
import { KEY } from '../../lib/keys'

/** ── Prompt history (TUI: ↑ on empty input recalls) ────────────────── */
const HISTORY_KEY = KEY.promptHistory
export const HISTORY_MAX = 50

export type HistoryItem = { text: string; ts: number; shell?: boolean }

export function loadPromptHistory(): HistoryItem[] {
  const arr = loadJSON<unknown>(HISTORY_KEY, [])
  if (!Array.isArray(arr)) return []
  const out: HistoryItem[] = []
  for (const x of arr) {
    if (x && typeof x.text === 'string' && x.text.trim()) {
      out.push({
        text: x.text,
        ts: typeof x.ts === 'number' ? x.ts : Date.now(),
        shell: x.shell === true,
      })
      if (out.length >= HISTORY_MAX) break
    }
  }
  return out
}

export function savePromptHistory(items: HistoryItem[]): void {
  saveJSON(HISTORY_KEY, items.slice(0, HISTORY_MAX))
}
