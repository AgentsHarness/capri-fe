import { loadStr } from '../../lib/storage'
import { KEY } from '../../lib/keys'
// ── cancel-turn preference (TUI cancel_subagents_on_turn_cancel) ────
// Saved by the cancel panel's "Always stop" / "Always continue" options.
// Once saved, Esc / [stop] act directly and the panel never opens.
export const CANCEL_SUBAGENTS_PREF_KEY = KEY.cancelSubagentsOnTurnCancel

export function loadCancelSubagentsPref(): boolean | null {
  const raw = loadStr(CANCEL_SUBAGENTS_PREF_KEY)
  if (raw == null) return null
  return raw === 'true'
}
