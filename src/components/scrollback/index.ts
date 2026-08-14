/**
 * Scrollback public API.
 *
 * Implementation lives in this folder (pane + entry kinds + hooks).
 * Existing imports (`from './components/Scrollback'`) stay stable via
 * the thin barrel at `src/components/Scrollback.tsx`.
 */
export { Scrollback } from './Scrollback'
export { EntryView } from './EntryView'
export type { EntryViewActions } from './chrome'
export { GroupHeaderView } from './GroupHeaderView'
export { EntryShell, Bullet } from './EntryShell'
