import type { McpServerInfo } from '../store/chat'
import type { McpToolInfo } from '../api/client'

/** Merged display row: event stream + agent-list supplement. */
export type McpRow = McpServerInfo & {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  type?: string
  headers?: Record<string, string>
  enabled?: boolean
  displayName?: string
  sourceLabel?: string
  authRequired?: boolean
  setupRequired?: boolean
  toolCount?: number
  tools?: McpToolInfo[]
  fromList: boolean
}

/** Status for display: the event stream wins; the session flags explain a
 *  list-only row that never reported a status. Undefined → 未连接/unknown. */
export function rowStatus(row: McpRow): string | undefined {
  if (row.status) return row.status
  if (row.setupRequired) return 'setup_required'
  if (row.authRequired) return 'needs_auth'
  return undefined
}

/** Source for display: `sourceLabel` (e.g. "plugin: foo") over wire `source`. */
export function rowSource(row: McpRow): string | undefined {
  return row.sourceLabel ?? row.source
}

/** Tool count of a row: the list when present, else the agent's count. */
export function toolCountOf(row: McpRow): number | undefined {
  return row.tools ? row.tools.length : row.toolCount
}

/** 工具名 / 展示名命中搜索词（`query` 已小写）。 */
export function toolMatchesQuery(tool: McpToolInfo, query: string): boolean {
  return (
    tool.name.toLowerCase().includes(query) ||
    (tool.displayName?.toLowerCase().includes(query) ?? false)
  )
}

/** 行的搜索命中：服务器字段或任一工具名。 */
export function rowMatchesQuery(row: McpRow, query: string): boolean {
  return (
    row.name.toLowerCase().includes(query) ||
    (row.displayName?.toLowerCase().includes(query) ?? false) ||
    (row.command?.toLowerCase().includes(query) ?? false) ||
    (row.url?.toLowerCase().includes(query) ?? false) ||
    (row.tools?.some((t) => toolMatchesQuery(t, query)) ?? false)
  )
}

export function actionLabel(action: 'toggle' | 'remove' | 'auth'): string {
  switch (action) {
    case 'toggle':
      return '启停'
    case 'remove':
      return '删除'
    case 'auth':
      return '认证'
  }
}

/**
 * args input: space-separated words OR a JSON array of strings.
 * Returns the parsed array, undefined for empty input, or an error string.
 */
export function parseArgsInput(raw: string): string[] | undefined | string {
  const t = raw.trim()
  if (!t) return undefined
  try {
    const parsed = JSON.parse(t) as unknown
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed
    }
  } catch {
    /* not JSON — fall through to whitespace split */
  }
  const parts = t.split(/\s+/).filter(Boolean)
  return parts.length > 0 ? parts : undefined
}

/**
 * env input: one KEY=value per line. Returns the map, {} for empty input,
 * or an error string for a malformed line.
 */
export function parseEnvInput(raw: string): Record<string, string> | string {
  const t = raw.trim()
  if (!t) return {}
  const env: Record<string, string> = {}
  for (const line of t.split('\n')) {
    const l = line.trim()
    if (!l) continue
    const eq = l.indexOf('=')
    if (eq <= 0) return `环境变量行格式错误: ${l}（应为 KEY=value）`
    env[l.slice(0, eq).trim()] = l.slice(eq + 1).trim()
  }
  return env
}

/**
 * headers input: one `Name: value` per line. Returns the map, undefined for
 * empty input, or an error string for a malformed line.
 */
export function parseHeadersInput(raw: string): Record<string, string> | undefined | string {
  const t = raw.trim()
  if (!t) return undefined
  const headers: Record<string, string> = {}
  for (const line of t.split('\n')) {
    const l = line.trim()
    if (!l) continue
    const colon = l.indexOf(':')
    if (colon <= 0) return `请求头行格式错误: ${l}（应为 Name: value）`
    const key = l.slice(0, colon).trim()
    if (!key) return `请求头行格式错误: ${l}（Name 不能为空）`
    headers[key] = l.slice(colon + 1).trim()
  }
  return headers
}

/** MCP call/read result → display text（JSON 缩进；超长截断）。 */
export const MCP_RESULT_MAX_CHARS = 6000
export function formatResult(result: unknown): string {
  if (result === undefined) return '（空结果）'
  let text: string
  try {
    text =
      typeof result === 'string'
        ? result
        : JSON.stringify(result, null, 2) ?? String(result)
  } catch {
    text = String(result)
  }
  if (text.length > MCP_RESULT_MAX_CHARS) {
    text = `${text.slice(0, MCP_RESULT_MAX_CHARS)}\n…（截断，共 ${text.length} 字符）`
  }
  return text
}
