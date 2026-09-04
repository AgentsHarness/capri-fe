import type { ScrollEntry } from './api/types'

/**
 * TUI context_bar fmt_tokens: "500", "5.2K", "50K", "1.2M" — one decimal
 * below 10, integer above (the top bar and the composer prompt flags share
 * this so the two surfaces never disagree).
 */
export function fmtTok(n: number): string {
  if (n >= 1_000_000) {
    return n >= 10_000_000 ? `${Math.round(n / 1_000_000)}M` : `${(n / 1_000_000).toFixed(1)}M`
  }
  if (n >= 1_000) {
    return n >= 10_000 ? `${Math.round(n / 1_000)}K` : `${(n / 1_000).toFixed(1)}K`
  }
  return String(n)
}

/**
 * TUI /context fmt_tok_big — rolls over to `1.0m` (one decimal) at one
 * million so a 1M / 2M / 4M context window reads naturally instead of
 * `1000k` (context_info.rs fmt_tok_big).
 */
export function fmtTokBig(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  return fmtTok(n)
}

/**
 * Shorten a workspace path the way the TUI status bar does: a path under
 * the user's home dir renders as "~/…" so it fits without truncation.
 */
export function shortCwd(cwd: string, homeDir?: string): string {
  if (homeDir && homeDir !== '/' && cwd.startsWith(homeDir)) {
    const rest = cwd.slice(homeDir.length)
    return rest === '' ? '~' : `~${rest}`
  }
  return cwd
}

/**
 * Format elapsed milliseconds compactly like the TUI status bar:
 * `5s`, `3m`, `2h` (xai-grok-pager agent_status::format_elapsed_compact).
 */
export function fmtElapsedCompact(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000))
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h`
  if (secs >= 60) return `${Math.floor(secs / 60)}m`
  return `${secs}s`
}

/**
 * Subagent metadata parenthetical — TUI format_subagent_meta parity
 * (xai-grok-pager app/subagent.rs): `(persona · role · model)` with the
 * persona/role deduped when they name the same title, or `''` when
 * nothing is present. When effort is known, the model is formatted as
 * `model(effort)`.
 */
export function subagentMeta(
  persona?: string,
  role?: string,
  model?: string,
  effort?: string,
): string {
  const clean = (v: string | undefined): string | undefined =>
    v && v.trim() ? v.trim() : undefined
  let p = clean(persona)
  let r = clean(role)
  if (p && r && p.toLowerCase() === r.toLowerCase()) r = undefined
  const m = clean(model)
  const eff = clean(effort)
  let formattedModel: string | undefined
  if (m) {
    formattedModel = eff && !m.includes('(') ? `${m}(${eff})` : m
  } else if (eff) {
    formattedModel = eff
  }
  const parts = [p, r, formattedModel].filter((v): v is string => !!v)
  return parts.length ? ` (${parts.join(' · ')})` : ''
}

/** Compact byte size: "512 B", "4.2 KB", "1.5 MB". */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Running subagent / bg_task / workflow entry (shared by chip + strip). */
export type RunningEntry = Extract<
  ScrollEntry,
  { kind: 'subagent' | 'bg_task' | 'workflow' }
>

/**
 * Count of live bg_tasks / subagents / workflows — shared by chip + strip.
 * Restored top-strip tasks are counted separately (topTasks) — the host
 * only surfaces liveness-probed tasks, so they are genuinely running.
 */
export function filterRunningEntries(entries: ScrollEntry[]): RunningEntry[] {
  return entries.filter(
    (e): e is RunningEntry =>
      (e.kind === 'subagent' || e.kind === 'bg_task' || e.kind === 'workflow') &&
      !!e.running,
  )
}

/** Stored preview char cap (TUI PREVIEW_MAX_CHARS). */
const PREVIEW_MAX_CHARS = 80

/** First non-empty line, char-capped with … (TUI prompt_preview). */
export function userMessagePreview(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  if (line.length <= PREVIEW_MAX_CHARS) return line
  return line.slice(0, PREVIEW_MAX_CHARS - 1) + '…'
}
