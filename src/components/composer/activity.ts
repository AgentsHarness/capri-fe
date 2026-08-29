import { Accents } from '../../theme/accents'
import { toolHeader } from '../../theme/glyphs'
import type { ScrollEntry } from '../../api/types'

/** TUI MAX_ACTIVITY_SUBJECT_CHARS — wait/tool subject clamp in the status line. */
const MAX_ACTIVITY_SUBJECT_CHARS = 40

/**
 * Current activity of a busy turn — TUI turn_status.rs activity arm.
 * Priority mirrors the TUI tracker: blocking waits (WaitingReason) first,
 * then thinking, tools, streaming reply.
 *
 * - WaitingReason::Subagent   → "Waiting on subagent…"  (foreground subagent)
 * - WaitingReason::TaskOutput → "Waiting on <subject>…" / "Waiting on task output…"
 * - WaitingReason::TasksComplete → "Waiting on tasks…"  (multiple awaited tasks)
 * - WaitingReason::Sleep      → "Sleeping…"             (Await / Sleep tools)
 */
export function currentActivity(
  entries: ScrollEntry[],
): { label: string; color: string; startedAt?: number } | null {
  // 1) Blocked on a foreground subagent (TUI tracker registers these when
  //    the task tool is NOT backgrounded). Only reachable while the agent
  //    itself is idle — thinking/tool/reply branches take precedence later.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'subagent' && e.running) {
      return {
        label: 'Waiting on subagent…',
        color: Accents.gray,
        startedAt: e.startedAt,
      }
    }
  }
  // 2) Awaiting background task output(s) (get_command_or_subagent_output /
  //    wait_commands_or_subagents…). One task → subject named (description /
  //    command, clamped like TUI MAX_ACTIVITY_SUBJECT_CHARS=40); several →
  //    "Waiting on tasks…".
  const runningTasks = entries.filter(
    (e): e is Extract<ScrollEntry, { kind: 'bg_task' }> =>
      e.kind === 'bg_task' && e.running === true,
  )
  if (runningTasks.length === 1) {
    const subject = (runningTasks[0].command || runningTasks[0].title || '')
      .trim()
      .slice(0, MAX_ACTIVITY_SUBJECT_CHARS)
    return {
      label: subject
        ? `Waiting on ${subject}…`
        : 'Waiting on task output…',
      color: Accents.gray,
    }
  }
  if (runningTasks.length > 1) {
    return { label: 'Waiting on tasks…', color: Accents.gray }
  }
  // 3) Explicit sleep (TUI blocking_wait_reason: Await / AwaitShell /
  //    "Await:…" / "Sleep …").
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'tool' && (e.status === 'pending' || e.status === 'in_progress')) {
      const title = (e.title || '').trim()
      if (
        title === 'Await' ||
        title === 'AwaitShell' ||
        title.startsWith('Await:') ||
        title.startsWith('Sleep ')
      ) {
        return {
          label: 'Sleeping…',
          color: Accents.gray,
          startedAt: e.startedAt,
        }
      }
      break // newest running tool only
    }
  }
  // 4) Thinking / tool / streaming reply (newest running entry wins).
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'thought' && e.streaming) {
      // TUI turn_status.rs: "Thinking…" (text_secondary).
      return { label: 'Thinking…', color: Accents.thinkingDefault, startedAt: e.startedAt }
    }
    if (e.kind === 'tool' && (e.status === 'pending' || e.status === 'in_progress')) {
      const verb = toolHeader(e.kindName, false).verb
      const target = (e.title || e.kindName || '').trim()
      // TUI turn_status.rs tool style: ask tools ("Ask: …") and tools
      // with a human description render muted (text_secondary); plain
      // invocations keep the green accent.
      const title = (e.title || '').trim()
      const isAsk = title.startsWith('Ask: ') || title.startsWith('Ask ')
      const raw = e.raw
      const rawInput =
        raw && typeof raw === 'object'
          ? ((raw as { rawInput?: unknown }).rawInput ??
            (raw as { raw_input?: unknown }).raw_input)
          : undefined
      const desc =
        rawInput && typeof rawInput === 'object'
          ? (rawInput as Record<string, unknown>).description
          : undefined
      const hasDesc = typeof desc === 'string' && desc.trim() !== ''
      return {
        label: `${verb} ${target}`.trim(),
        color: isAsk || hasDesc ? Accents.gray : Accents.success,
        // The tool's own start stamp (stamped on live running tools) —
        // the phase timer counts this entry's duration, not the whole
        // turn up to now.
        startedAt: e.startedAt,
      }
    }
    // Streaming reply: the assistant row's `ts` is its response start
    // (first chunk), so the phase timer is the reply's own duration —
    // not the whole turn. TUI: current_agent_msg → "Responding…".
    if (e.kind === 'assistant' && e.streaming) {
      return { label: 'Responding…', color: Accents.gray, startedAt: e.ts }
    }
  }
  return null
}
