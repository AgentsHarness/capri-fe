/**
 * Scrollback public API (stable import path).
 *
 * Implementation lives in `src/components/scrollback/`:
 *   Scrollback.tsx          pane + scroll/sticky/paging glue
 *   EntryView.tsx + kinds/  per-kind row renderers
 *   EntryShell / PromptTime shared chrome
 *   use*.ts                 pane hooks
 *
 * Logic helpers live in `src/scrollback/` (entryState, thoughtText, …).
 */
export { Scrollback } from './scrollback/Scrollback'
export { EntryView } from './scrollback/EntryView'
export type { EntryViewActions } from './scrollback/chrome'
export { GroupHeaderView } from './scrollback/GroupHeaderView'
export { EntryShell, Bullet } from './scrollback/EntryShell'
/** @deprecated Prefer importing ICON_COL_CLASS from theme/layout */
export { ICON_COL_CLASS } from '../theme/layout'
