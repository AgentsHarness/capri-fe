/**
 * Build AccentResolveOpts from a ScrollEntry + interaction state.
 * Shared by EntryShell, EntryView, and GroupHeaderView.
 */
import type { ScrollEntry } from '../api/types'
import type { AccentResolveOpts } from '../theme/accents'
import { entryExpanded, entryFailed, entryRunning } from './entryState'

export function accentOpts(
  e: ScrollEntry,
  selected: boolean,
  pendingFreeze: boolean,
  now: number,
  hovered = false,
  inGroup = false,
): AccentResolveOpts {
  const base: AccentResolveOpts = {
    kind: e.kind,
    running: entryRunning(e),
    failed: entryFailed(e),
    expanded: entryExpanded(e),
    selected,
    hovered,
    pendingFreeze,
    now,
    inGroup,
  }

  if (e.kind === 'tool') {
    return {
      ...base,
      kindName: e.kindName,
      finishedAt: e.finishedAt,
    }
  }
  if (e.kind === 'thought') {
    return { ...base, finishedAt: e.finishedAt }
  }
  if (e.kind === 'subagent') {
    return { ...base, subagentStatus: e.status }
  }
  if (e.kind === 'workflow') {
    return { ...base, workflowStatus: e.status }
  }
  if (e.kind === 'bg_task') {
    return { ...base, bgTaskStatus: e.status }
  }
  if (e.kind === 'session_event') {
    return {
      ...base,
      sessionEvent: { recap: e.recap, warning: e.warning },
    }
  }
  if (e.kind === 'group_header') {
    return {
      ...base,
      groupHeader: e.verbRun
        ? {
            variant: 'verb',
            running: e.verbRun.running,
            failed: e.verbRun.failed,
          }
        : { variant: 'truncation' },
    }
  }
  return base
}
