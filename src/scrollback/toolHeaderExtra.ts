/**
 * Tool header extras — the TUI `collapsed_line` / `header_line` port for every
 * tool block: which text becomes the row target, which noun labels it, and
 * which suffix rides behind it.
 *
 * Two things are painted here, exactly as the TUI does:
 *  - the noun (`verb`): skill reads say "Skill", workflow scripts say
 *    "Editing workflow", MCP calls lead with the server name, subagent
 *    messages drop the noun entirely (`bare`);
 *  - the path (`target` / `head`): Read and Edit paths follow
 *    `ToolPathSurface` (collapsed = basename, expanded = cwd-relative,
 *    fullscreen = normalized absolute); everything else keeps the stored path
 *    and splits into `head` + `target` so CSS ellipsizes the directory and
 *    never the file name.
 *
 * `surface` defaults to 'raw' so transcript export keeps the stored path and
 * drops the collapsed-only suffixes — matching TUI `tool_summary`.
 */
import type { ToolCall } from '../api/types'
import { extractToolDetail } from './toolDetail'
import { pathForSurface, splitPathHeadTail, type ToolPathPaint } from './toolPaths'

export type ToolHeaderExtra = {
  /** Row target — omitted only for `bare` sentence rows. */
  target?: string
  suffix?: string
  /** Noun override — TUI blocks that rename the verb for this row
   *  ("Skill", "Creating", "Editing workflow", MCP server, "X Search"). */
  verb?: string
  /** Shrinkable directory prefix of `target` (the TUI fit-to-width rules keep
   *  the tail; in the browser CSS ellipsizes this span instead). */
  head?: string
  /** Whole-line bold sentence header (TUI SentMessagePresentation) — the row
   *  has no noun/target split at all. */
  bare?: string
  /** Muted ghost between noun and target — TUI's `Run (user) ` marker for
   *  direct-bash executes (`_meta.bash_mode`). */
  marker?: string
}

export type ToolHeaderPaint = {
  /** Which surface the row is painted for. Default 'raw' (export parity). */
  surface?: ToolPathPaint
  /** Session cwd — enables the expanded surface's relative path. */
  cwd?: string
  /** Home dir — enables `~` expansion (unknown to the browser by default). */
  home?: string
  /** Row status (`pending` / `in_progress` / `completed` / `failed`) — the
   *  TUI derives some headers from block state, not from the wire payload. */
  status?: string
}

/**
 * TUI `SentMessagePresentation::title` — the whole header is one sentence that
 * follows delivery state. The wire only ever stamps "Sending …", so the FE
 * re-titles it from the row status (the TUI does the same on completion). The
 * TUI's fourth state (`Message delivery unconfirmed`) needs a delivery receipt
 * the wire never carries, so an unknown status keeps the wire title.
 */
function subagentMessageSentence(
  status: string | undefined,
  failed: boolean,
): string | undefined {
  const s = (status || '').toLowerCase()
  if (failed || s === 'failed' || s === 'error') return 'Failed to send message to subagent'
  if (s === 'completed') return 'Sent message to subagent'
  if (s === 'pending' || s === 'in_progress') return 'Sending message to subagent'
  return undefined
}

/**
 * TUI `strip_leading_run_word`: the row already leads with the "Run" noun, so
 * a description that starts with "Run"/"Running" loses that word instead of
 * rendering "Running Run the tests".
 */
function stripLeadingRunWord(s: string): string {
  const lower = s.toLowerCase()
  const prefix = lower.startsWith('running') ? 'running' : lower.startsWith('run') ? 'run' : ''
  if (!prefix) return s
  const rest = lower.slice(prefix.length)
  if (rest === '') return ''
  if (!/^\s/.test(rest)) return s
  return s.slice(prefix.length).trimStart()
}

/** TUI `description_display`: trimmed, newlines collapsed to one logical line. */
function descriptionDisplay(desc: string | undefined): string | undefined {
  if (!desc) return undefined
  const trimmed = desc.trim()
  if (!trimmed) return undefined
  return stripLeadingRunWord(trimmed.replace(/\n/g, ' ')) || undefined
}

export function toolHeaderExtra(
  raw: ToolCall,
  kindName: string | undefined,
  failed: boolean,
  mergedRaws?: ToolCall[],
  paint: ToolHeaderPaint = {},
): ToolHeaderExtra | null {
  const surface: ToolPathPaint = paint.surface ?? 'raw'
  /** Paint a stored path for the current surface. */
  const paintPath = (path: string): string =>
    pathForSurface(path, surface, { cwd: paint.cwd, home: paint.home })
  /** Directory/filename split so narrow rows never lose the file name.
   *  'collapsed' is already a bare name; 'raw' (export) stays one string. */
  const split = (path: string) =>
    surface === 'collapsed' || surface === 'raw'
      ? { head: '', tail: path }
      : splitPathHeadTail(path)
  /** Target + head for a painted path. */
  const pathTarget = (path: string) => {
    const painted = paintPath(path)
    const { head, tail } = split(painted)
    return { target: tail || painted, head: head || undefined }
  }

  try {
    const d = extractToolDetail(raw, kindName)
    switch (d.kind) {
      case 'read': {
        // TUI ReadToolCallBlock: SKILL.md reads render as "Skill {name}" —
        // no Read verb, no path, no range suffix.
        if (d.skill) return { verb: 'Skill', target: d.skill }
        let suffix = ''
        if (d.lineStart != null && d.lineEnd != null) {
          if (d.totalLines != null && d.totalLines > d.lineEnd - d.lineStart + 1) {
            suffix = ` (${d.lineStart}-${d.lineEnd} of ${d.totalLines})`
          } else {
            suffix = ` (${d.lineStart}-${d.lineEnd})`
          }
        }
        if (d.empty) suffix += ' (empty)'
        if (d.media === 'image') suffix += ' (image)'
        if (d.media === 'pdf') {
          suffix += d.pages != null ? ` (${d.pages} pages)` : ' (pdf)'
        }
        return { ...pathTarget(d.path), suffix: suffix || undefined }
      }
      case 'execute': {
        const desc = descriptionDisplay(d.description)
        // TUI: a direct-bash execute (`_meta.bash_mode`) leads with a ghosted
        // "(user)" after the Run noun.
        const meta = (raw._meta ?? (raw as { meta?: unknown }).meta) as
          | { bash_mode?: unknown }
          | undefined
        const bashMode = meta?.bash_mode === true
        return {
          target: desc || d.command || raw.title || '',
          suffix: d.error && failed ? ` (${d.error})` : undefined,
          ...(bashMode ? { marker: '(user)' } : {}),
        }
      }
      case 'edit': {
        // Merged same-file edits (collapsed_edit_blocks): sum the stats and
        // count the contributing edit calls (TUI `edit_count`).
        let ins = d.insertions
        let del = d.deletions
        let editCalls = 1
        for (const r of mergedRaws ?? []) {
          const x = extractToolDetail(r, kindName)
          // Only real edit payloads count — a command-shaped or pathless entry
          // in mergedRaws must not inflate the stats or the "(N edits)" count.
          if (x.kind === 'edit' && (x.path || x.lines.length)) {
            editCalls += 1
            ins += x.insertions
            del += x.deletions
          }
        }
        // TUI gates both suffix shapes on the collapsed one-liner: expanded
        // and fullscreen headers stay bare because the hunks carry the detail.
        const suffix =
          surface === 'collapsed' || surface === 'raw'
            ? ins || del
              ? ` (+${ins}/−${del})`
              : editCalls > 1
                ? ` (${editCalls} edits)`
                : undefined
            : undefined
        // Workflow scripts display their stem, not the `.rhai` path.
        if (d.workflow) {
          return {
            verb: d.creating ? 'Creating workflow' : 'Editing workflow',
            target: d.workflow,
            suffix,
          }
        }
        return {
          ...pathTarget(d.path),
          suffix,
          ...(d.creating ? { verb: 'Creating' } : {}),
        }
      }
      case 'search': {
        // TUI SearchToolCallBlock header_line, three cases:
        //   trivial pattern + glob → `Search {glob} in {path}`
        //   pattern + glob         → `Search "pat" in {glob} in {path}`
        //   pattern only           → `Search "pat" in {path}`
        const trivial = d.pattern === '' || d.pattern === '.'
        let target = trivial && d.glob ? d.glob : d.pattern ? JSON.stringify(d.pattern) : '""'
        if (!trivial && d.glob) target += ` in ${d.glob}`
        if (d.path) target += ` in ${paintPath(d.path)}`
        // Match summary — TUI match_summary(), per output mode.
        const files = d.fileMatches.length
        let summary: string
        if (d.matchCount === 0) {
          summary = d.outputMode === 'files' ? '(no files)' : '(no matches)'
        } else if (d.outputMode === 'files') {
          summary = d.matchCount === 1 ? '(1 file)' : `(${d.matchCount} files)`
        } else if (d.outputMode === 'count') {
          const fileCount = Math.max(d.filePaths.length, files)
          summary =
            fileCount > 1
              ? `(${d.matchCount} matches across ${fileCount} files)`
              : d.matchCount === 1
                ? '(1 match)'
                : `(${d.matchCount} matches)`
        } else {
          summary =
            files > 1
              ? `(${d.matchCount} matches in ${files} files)`
              : d.matchCount === 1
                ? '(1 match)'
                : `(${d.matchCount} matches)`
        }
        return { target, suffix: ` ${summary}` }
      }
      case 'list_dir': {
        const n = d.entryCount
        const suffix = !failed && n > 0 ? ` (${n} entr${n === 1 ? 'y' : 'ies'})` : undefined
        // TUI stores list_dir paths already cwd-relative (`make_relative_path`)
        // and never basenames them — a directory row shows the directory.
        const painted = pathForSurface(d.path, 'expanded', {
          cwd: paint.cwd,
          home: paint.home,
        })
        const { head, tail } = splitPathHeadTail(painted)
        return { target: tail || painted, head: head || undefined, suffix }
      }
      case 'fetch':
        return {
          target: d.url,
          suffix: d.statusCode != null ? ` (${d.statusCode})` : undefined,
        }
      case 'web_search': {
        // TUI prefix is the label ("X Search ") when set, else "Web Search ";
        // the collapsed suffix counts *deduplicated* domains, not citations.
        const sites = d.sites.length
        return {
          target: d.query,
          suffix: sites > 0 ? ` (${sites} site${sites === 1 ? '' : 's'})` : undefined,
          ...(d.label ? { verb: d.label.trim() } : {}),
        }
      }
      case 'search_tool': {
        // TUI SearchToolCallBlock: the "(N results)" count is part of the
        // width-constrained collapsed header only.
        const suffix =
          surface === 'collapsed' || surface === 'raw'
            ? ` (${d.resultCount} result${d.resultCount === 1 ? '' : 's'})`
            : undefined
        return { target: d.query, suffix }
      }
      case 'use_tool':
        // TUI header_line: bold `Server ` + action in the command colour.
        return d.server ? { verb: d.server, target: d.action } : { target: d.action }
      case 'generic': {
        const k = (kindName || '').toLowerCase()
        const sentence =
          k === 'active_agent_message' || k === 'send_subagent_message'
            ? subagentMessageSentence(paint.status, failed)
            : undefined
        if (sentence) return { bare: sentence }
        // TUI OtherToolCallBlock splits `Label: content` into a bold label and
        // plain content (e.g. "Memory search: \"auth\"").
        if (d.label && d.content) return { verb: d.label, target: d.content }
        return { target: d.name }
      }
      default:
        return null
    }
  } catch {
    return null
  }
}
