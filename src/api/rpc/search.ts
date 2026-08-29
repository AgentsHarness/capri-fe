import type { TransportCore } from '../transport'
import { unwrapExtResult, xaiCall } from './core'

/** 搜索：workspace 内容全文检索与 @ 文件模糊选择器。 */
export const searchRpc = {
  /**
   * POST /api/search/content — workspace file content search (agent
   * `x.ai/search/content`, ripgrep). Body passes through flat: the host
   * forwards verbatim per the agent's ContentSearchRequest flatten
   * convention (camelCase: pattern / caseInsensitive / isRegex /
   * includeGlobs / excludeGlobs / maxMatches / maxFiles …). Result:
   * {files: [{name, path, matches: [{line, content, matchStart?,
   * matchEnd?}]}], totalMatches, totalFiles, truncated}.
   */
  async searchContent(this: TransportCore, opts: {
    pattern: string
    cwd?: string
    sessionId?: string
    caseInsensitive?: boolean
    wholeWord?: boolean
    isRegex?: boolean
    includeGlobs?: string[]
    excludeGlobs?: string[]
    maxMatches?: number
    maxFiles?: number
  }): Promise<unknown> {
    const body: Record<string, unknown> = { pattern: opts.pattern }
    if (opts.cwd) body.cwd = opts.cwd
    if (opts.sessionId) body.sessionId = opts.sessionId
    if (opts.caseInsensitive !== undefined) body.caseInsensitive = opts.caseInsensitive
    if (opts.wholeWord !== undefined) body.wholeWord = opts.wholeWord
    if (opts.isRegex !== undefined) body.isRegex = opts.isRegex
    if (opts.includeGlobs?.length) body.includeGlobs = opts.includeGlobs
    if (opts.excludeGlobs?.length) body.excludeGlobs = opts.excludeGlobs
    if (opts.maxMatches !== undefined) body.maxMatches = opts.maxMatches
    if (opts.maxFiles !== undefined) body.maxFiles = opts.maxFiles
    return unwrapExtResult(await xaiCall(this, '/api/search/content', body))
  },

  /**
   * POST /api/search/fuzzy/{open,change,close} — fuzzy file search
   * (agent `x.ai/search/fuzzy/*`). Results do NOT ride the change
   * response: the workspace streams full match snapshots per generation
   * via the `search_fuzzy_status` SSE event until `done`. change requires
   * a non-empty query (host 400s otherwise).
   */
  async searchFuzzyOpen(
    this: TransportCore,
    opts: { cwd?: string; root?: string } = {},
  ): Promise<{ sessionId?: string; searchId?: string }> {
    const body: Record<string, unknown> = {}
    if (opts.cwd) body.cwd = opts.cwd
    if (opts.root) body.root = opts.root
    return unwrapExtResult(await xaiCall(this, '/api/search/fuzzy/open', body))
  },

  async searchFuzzyChange(this: TransportCore, opts: {
    searchId: string
    query: string
    dirsOnly?: boolean
    limit?: number
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      searchId: opts.searchId,
      query: opts.query,
      dirsOnly: opts.dirsOnly ?? false,
    }
    if (opts.limit !== undefined) body.limit = opts.limit
    return unwrapExtResult(await xaiCall(this, '/api/search/fuzzy/change', body))
  },

  async searchFuzzyClose(this: TransportCore, opts: {
    searchId: string
  }): Promise<{ closed?: boolean } | undefined> {
    return unwrapExtResult(
      await xaiCall(this, '/api/search/fuzzy/close', { searchId: opts.searchId }),
    )
  },
}
