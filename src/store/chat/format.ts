import type { ScrollEntry, SessionInfoDetail, TopTask } from '../../api/types'
import { toolHeader } from '../../theme/glyphs'
import type { TodoCounts, TodoItem } from './types'

/** Extract text from an ACP content value (string | {text} | nested | array). */
export function contentText(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(contentText).join('')
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    return contentText(o.content)
  }
  return ''
}

export function toolVerb(kind?: string, running?: boolean) {
  return toolHeader(kind, !!running).verb
}

export function formatElapsed(ms: number): string {
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const rem = secs - mins * 60
  return `${mins}m${rem.toFixed(0)}s`
}

/**
 * TUI format_duration (xai-grok-pager-render/src/util.rs) — drives the
 * "Worked for Xs" turn-completion marker: <10s "5.2s", <60s "32s",
 * <60m "2m5s", else "1h2m".
 */
export function formatTurnDuration(ms: number): string {
  const totalSecs = Math.floor(ms / 1000)
  if (totalSecs < 10) return `${(ms / 1000).toFixed(1)}s`
  if (totalSecs < 60) return `${totalSecs}s`
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  if (mins < 60) return `${mins}m${secs}s`
  return `${Math.floor(mins / 60)}h${mins % 60}m`
}

/**
 * TUI context_bar fmt_tokens: "500", "5.2K", "49K", "1.2M".
 * <10K 保留一位小数；≥10K 四舍五入到整 K；≥10M 同理到整 M。
 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return n >= 10_000_000 ? `${Math.round(n / 1_000_000)}M` : `${(n / 1_000_000).toFixed(1)}M`
  }
  if (n >= 1_000) {
    return n >= 10_000 ? `${Math.round(n / 1_000)}K` : `${(n / 1_000).toFixed(1)}K`
  }
  return String(n)
}

/**
 * TUI /session-info (format_session_info): the host's SessionInfoDetail
 * rendered as a plain text block (fields on separate lines) that gets
 * pushed into the scrollback — fields render exactly as the host
 * reports them.
 */
export function formatSessionInfo(info: SessionInfoDetail): string {
  const lines: string[] = ['Session info']
  if (info.title) lines.push(`  Title: ${info.title}`)
  if (info.sessionId) lines.push(`  Session ID: ${info.sessionId}`)
  if (info.cwd) lines.push(`  Workspace: ${info.cwd}`)
  if (info.model) {
    const m = info.model
    const label = [m.name || m.modelId, m.reasoningEffort].filter(Boolean).join(' · ')
    lines.push(`  Model: ${label}`)
  }
  const ctxSize = info.contextSize || info.model?.contextWindow || 0
  if (ctxSize > 0) {
    const used = info.contextUsed ?? 0
    // TUI usage_percentage_u8 clamps at 100 — never render >100% even
    // when used transiently exceeds the window (pre-auto-compact).
    const pct = Math.min(100, Math.round((used / ctxSize) * 100))
    lines.push(`  Context: ${fmtTokens(used)} / ${fmtTokens(ctxSize)} tokens (${pct}%)`)
  }
  if (info.gitBranch) {
    const wt =
      info.gitIsWorktree && info.gitMainRepo
        ? ` (worktree of ${info.gitMainRepo})`
        : info.gitIsWorktree
          ? ' (worktree)'
          : ''
    lines.push(`  Git: ${info.gitBranch}${wt}`)
  }
  if (info.hostName || info.hostId) {
    lines.push(`  Host: ${[info.hostName, info.hostId].filter(Boolean).join(' · ')}`)
  }
  return lines.join('\n')
}

/**
 * Map a `plan` event's entry list to todo items + counts (TUI
 * todo_item_from_plan_entry). Cancelled items (completed + meta.cancelled)
 * are excluded from `total`, matching the status-bar badge. Returns
 * undefined counts for empty/unknown lists so the badge stays hidden.
 * Exported so scrollback plan blocks render the same items as the badge.
 */
export function planTodos(entries: unknown): { items: TodoItem[]; counts?: TodoCounts } {
  if (!Array.isArray(entries)) return { items: [] }
  const items: TodoItem[] = []
  let inProgress = 0
  let pending = 0
  let completed = 0
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    const status = typeof r.status === 'string' ? r.status : ''
    let todoStatus: TodoItem['status'] = 'pending'
    if (status === 'completed' || status === 'done') {
      const meta = r.meta as Record<string, unknown> | undefined
      if (meta?.cancelled === true) {
        todoStatus = 'cancelled'
      } else {
        todoStatus = 'completed'
        completed++
      }
    } else if (
      status === 'in_progress' ||
      status === 'inProgress' ||
      status === 'running'
    ) {
      todoStatus = 'in_progress'
      inProgress++
    } else {
      pending++
    }
    items.push({
      id: typeof r.id === 'string' ? r.id : undefined,
      content: contentText(r.content) || String(r.title ?? ''),
      status: todoStatus,
      priority: typeof r.priority === 'string' ? r.priority : undefined,
    })
  }
  const total = inProgress + pending + completed
  return {
    items,
    counts: total === 0 && items.length === 0 ? undefined : { total, inProgress, pending, completed },
  }
}

export function imageSrc(data: string, mimeType?: string): string | undefined {
  const d = typeof data === 'string' ? data.trim() : ''
  if (!d) return undefined
  if (d.startsWith('data:')) return d
  const mime =
    mimeType && /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ? mimeType : 'image/png'
  return `data:${mime};base64,${d}`
}

export function stillRunningCue(
  entries: ScrollEntry[],
  topTasks?: TopTask[],
): string | null {
  let commands = 0
  let monitors = 0
  let subagents = 0
  let workflows = 0
  for (const e of entries) {
    if (e.kind === 'bg_task') {
      if (!e.running) continue
      if (e.isMonitor) monitors++
      else commands++
    } else if (e.kind === 'subagent' && e.running) {
      subagents++
    } else if (e.kind === 'workflow' && e.running) {
      workflows++
    }
  }
  for (const t of topTasks ?? []) {
    if (t.isMonitor) monitors++
    else commands++
  }
  const parts: string[] = []
  const push = (n: number, noun: string) => {
    if (n > 0) parts.push(`${n} ${noun}${n === 1 ? '' : 's'}`)
  }
  push(commands, 'command')
  push(monitors, 'monitor')
  push(subagents, 'subagent')
  push(workflows, 'workflow')
  if (parts.length === 0) return null
  return `${parts.join(' · ')} still running`
}
