/**
 * Tool-header path painting — port of xai-grok-pager-render
 * `src/render/tool_paths.rs`.
 *
 * The TUI never prints a raw absolute path in a collapsed tool row: the same
 * path is painted three ways depending on where it is shown
 * (`ToolPathSurface`), and width-driven rules shorten it fish-style instead of
 * cutting off the interesting tail. This module mirrors those rules so the FE
 * row / inline expansion / fullscreen viewer match the TUI surfaces 1:1.
 */

/** TUI ToolPathSurface: where a tool-path is being painted. */
export type ToolPathSurface = 'collapsed' | 'expanded' | 'fullscreen'

/**
 * FE-only extra: the raw stored path. Used by transcript export, which mirrors
 * TUI `tool_summary` (`Read: {path}`) rather than the on-screen paint.
 */
export type ToolPathPaint = ToolPathSurface | 'raw'

/**
 * Display width of one code point — an approximation of `unicode_width`
 * (zero for combining marks, two for East Asian Wide/Fullwidth blocks).
 * Paths are mostly ASCII, so this only affects width-budget rounding.
 */
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0)
  if (cp == null) return 0
  // C0/C1 controls and zero-width format characters.
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) return 0
  // Combining marks (Mn/Me blocks commonly seen in paths and names).
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20f0) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0
  }
  // East Asian Wide + Fullwidth blocks.
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

/** Display width of a string (TUI `UnicodeWidthStr::width`). */
export function strWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

/**
 * Truncate to `maxWidth` display columns, appending `…` when cut
 * (TUI `truncate_str` / `truncate_to_width`).
 */
export function truncateToWidth(s: string, maxWidth: number): string {
  if (strWidth(s) <= maxWidth) return s
  if (maxWidth <= 0) return ''
  let w = 0
  let out = ''
  for (const ch of s) {
    const cw = charWidth(ch)
    if (w + cw > maxWidth - 1) break
    out += ch
    w += cw
  }
  return `${out}\u2026`
}

/** Path separator set (native `/` plus tolerated `\`, like TUI `path_basename`). */
const SEP_RE = /[\\/]/

function splitComponents(path: string): string[] {
  return path.split(SEP_RE)
}

/** Absolute path (POSIX root or Windows drive prefix). */
function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path)
}

/**
 * Lexical normalization: drop `.`, collapse `..` against a normal segment,
 * absorb `..` at the root, keep leading `..` on relative paths. Empty → `.`
 * (TUI `xai_grok_paths::normalize_lexically`).
 */
export function normalizeLexically(path: string): string {
  const absolute = isAbsolute(path)
  const root = path.startsWith('/') ? '/' : /^[A-Za-z]:[/\\]/.test(path) ? path.slice(0, 2) : ''
  const out: string[] = []
  for (const comp of splitComponents(path)) {
    if (comp === '' || comp === '.') continue
    if (comp === '..') {
      const last = out[out.length - 1]
      if (last != null && last !== '..') {
        out.pop()
      } else if (!absolute) {
        out.push('..')
      }
      // absolute + no normal segment to pop → absorbed at the root
      continue
    }
    out.push(comp)
  }
  if (out.length === 0) return root || '.'
  return root ? `${root.replace(/[/\\]$/, '')}/${out.join('/')}` : out.join('/')
}

/**
 * `~`-expansion + cwd join; undefined when `~` has no home to expand to.
 * Deliberately NOT normalized — the TUI keeps `link/../target.rs` intact for
 * filesystem targets so symlink semantics survive (only the display path is
 * normalized, in `pathForSurface`).
 */
export function resolveToolPathTarget(
  path: string,
  cwd?: string,
  home?: string,
): string | undefined {
  const parts = splitComponents(path)
  if (parts[0] === '~') {
    if (!home) return undefined
    const rest = parts.slice(1).filter((p) => p !== '')
    return [home.replace(/[/\\]+$/, ''), ...rest].join('/')
  }
  if (isAbsolute(path)) return path
  return cwd ? `${cwd.replace(/[/\\]+$/, '')}/${path}` : path
}

/** Basename with an optional column budget (TUI `path_basename`). */
export function pathBasename(path: string, budget = Number.POSITIVE_INFINITY): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = splitComponents(trimmed).filter((p) => p !== '')
  const name = parts.length ? parts[parts.length - 1] : path
  if (!Number.isFinite(budget)) return name
  return truncateToWidth(name || path, budget)
}

/**
 * Fish-style path shortening: leading components collapse to their first
 * letter, then a `…/tail` suffix, then a hard truncate (TUI `shorten_path`).
 * Keeps the last component readable — the whole point of the rule.
 */
export function shortenPath(path: string, budget: number): string {
  if (budget <= 0) return ''
  if (strWidth(path) <= budget) return path
  const parts = path.split('/')
  if (parts.length <= 1) return truncateToWidth(path, budget)

  const shortened = [...parts]
  const lastIdx = shortened.length - 1
  for (let i = 0; i < lastIdx; i++) {
    const used =
      shortened.reduce((sum, s) => sum + strWidth(s), 0) + shortened.length - 1
    if (used <= budget) break
    const first = parts[i].charAt(0)
    if (first) shortened[i] = first
  }
  const joined = shortened.join('/')
  if (strWidth(joined) <= budget) return joined

  // Tail fallback: `…/` + a suffix starting at a separator boundary.
  for (let i = 1; i < path.length; i++) {
    if (path[i - 1] !== '/') continue
    const candidate = `\u2026${path.slice(i - 1)}`
    if (strWidth(candidate) <= budget) return candidate
  }
  return truncateToWidth(path, budget)
}

/**
 * Path text for a tool-header surface (TUI `path_for_tool_surface`).
 * `collapsed` basenames the raw string; the other two surfaces resolve
 * (`~`, cwd join) and lexically normalize first.
 */
export function pathForSurface(
  path: string,
  surface: ToolPathPaint,
  opts: { cwd?: string; home?: string; width?: number; reserved?: number } = {},
): string {
  if (!path) return path
  if (surface === 'raw') return path
  if (surface === 'collapsed') {
    const budget = Number.isFinite(opts.width)
      ? Math.max(0, (opts.width as number) - (opts.reserved ?? 0))
      : Number.POSITIVE_INFINITY
    return pathBasename(path, budget)
  }
  const target = resolveToolPathTarget(path, opts.cwd, opts.home)
  const displayPath = target != null ? normalizeLexically(target) : path
  if (surface === 'fullscreen') return displayPath
  // expanded: cwd-relative when lexically contained, else the normalized path
  if (target != null && opts.cwd) {
    const relParts = splitComponents(displayPath).filter((p) => p !== '')
    const cwdParts = splitComponents(normalizeLexically(opts.cwd)).filter((p) => p !== '')
    if (cwdParts.length > 0 && relParts.length > cwdParts.length) {
      const contained = cwdParts.every((seg, i) => seg === relParts[i])
      if (contained) return relParts.slice(cwdParts.length).join('/')
    }
  }
  return displayPath
}

/** Convenience: paint according to the chosen surface, no-op on empty. */
export function paintToolPath(
  path: string,
  paint: ToolPathPaint,
  opts: { cwd?: string; home?: string } = {},
): string {
  return pathForSurface(path, paint, opts)
}

/**
 * Split a painted path so CSS can ellipsize the *directory* head while the
 * last component stays pinned — the browser equivalent of the TUI's
 * fit-to-width rules (which never cut the tail). Returns an empty head when
 * there is nothing to shrink.
 */
export function splitPathHeadTail(path: string): { head: string; tail: string } {
  if (!path) return { head: '', tail: path }
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (idx < 0) return { head: '', tail: path }
  return { head: path.slice(0, idx + 1), tail: path.slice(idx + 1) }
}

/**
 * Workflow script name (TUI `workflow_script_name`): a `.rhai` file whose
 * ancestors include a `workflows` directory displays as that stem, not a path.
 */
export function workflowScriptName(path: string): string | undefined {
  if (!path) return undefined
  const parts = splitComponents(path).filter((p) => p !== '')
  const file = parts[parts.length - 1] ?? ''
  const dot = file.lastIndexOf('.')
  const ext = dot >= 0 ? file.slice(dot + 1) : ''
  if (ext.toLowerCase() !== 'rhai') return undefined
  const stem = dot > 0 ? file.slice(0, dot) : ''
  if (!stem) return undefined
  // ancestors() .skip(1) — the file's own directory does not count.
  const dirs = parts.slice(0, parts.length - 1)
  if (!dirs.includes('workflows')) return undefined
  return stem
}

/**
 * MCP qualified-name split + titleize (TUI `UseToolCallBlock::split_name` with
 * `mcp_titleize_segment`): `linear__save_issue` → `Linear` + `Save Issue`.
 */
export function mcpTitleizeSegment(name: string): string {
  return name
    .split('_')
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : ''))
    .join(' ')
}

export function splitMcpToolName(toolName: string): { server: string; action: string } {
  const idx = toolName.indexOf('__')
  if (idx <= 0) return { server: '', action: mcpTitleizeSegment(toolName) }
  return {
    server: mcpTitleizeSegment(toolName.slice(0, idx)),
    action: mcpTitleizeSegment(toolName.slice(idx + 2)),
  }
}

/** Host of a citation URL, verbatim (TUI `extract_domain` — no `www.` strip). */
export function extractDomain(url: string): string | undefined {
  try {
    const u = new URL(url)
    return u.hostname || undefined
  } catch {
    return undefined
  }
}

/** Deduplicated citation domains, first-seen order (TUI `unique_domains`). */
export function uniqueDomains(citations: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const url of citations) {
    const d = extractDomain(url)
    if (d && !seen.has(d)) {
      seen.add(d)
      out.push(d)
    }
  }
  return out
}
