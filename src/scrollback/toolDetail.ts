/**
 * Parse ACP ToolCall rawInput / rawOutput / content into TUI-aligned expanded
 * detail fields (xai-grok-pager tracker + tool blocks).
 *
 * Wire shapes vary (Rust ToolOutput enum tagging, content blocks, plain text).
 * Extractors are defensive and try several common layouts.
 */

import type { ToolCall } from '../api/types'

/** Truncation windows matching TUI defaults. */
export const READ_FIRST = 5
export const READ_LAST = 3
export const EXEC_FIRST = 2
export const EXEC_LAST = 3
export const INLINE_MAX = 10

export type DiffLine = {
  kind: 'equal' | 'insert' | 'delete' | 'header' | 'gap'
  oldNo?: number
  newNo?: number
  text: string
}

export type SearchMatch = {
  lineNumber: number
  content: string
}

export type SearchFile = {
  path: string
  matches: SearchMatch[]
}

export type KvPair = { key: string; value: string }

export type ToolDetail =
  | {
      kind: 'read'
      path: string
      lineStart?: number
      lineEnd?: number
      totalLines?: number
      content?: string
      error?: string
      empty?: boolean
      media?: 'image' | 'pdf'
    }
  | {
      kind: 'execute'
      command: string
      description?: string
      output?: string
      exitCode?: number
      signal?: string
      error?: string
    }
  | {
      kind: 'edit'
      path: string
      /** Creating / write tool */
      creating?: boolean
      lines: DiffLine[]
      insertions: number
      deletions: number
      error?: string
    }
  | {
      kind: 'search'
      pattern: string
      path?: string
      glob?: string
      outputMode: 'content' | 'files' | 'count'
      caseInsensitive?: boolean
      fileType?: string
      multiline?: boolean
      matchCount: number
      fileMatches: SearchFile[]
      filePaths: string[]
      error?: string
    }
  | {
      kind: 'list_dir'
      path: string
      output?: string
      entryCount: number
      error?: string
    }
  | {
      kind: 'fetch'
      url: string
      statusCode?: number
      contentType?: string
      bytes?: number
      output?: string
      error?: string
    }
  | {
      kind: 'web_search'
      query: string
      content?: string
      citations: string[]
      error?: string
      label?: string
    }
  | {
      kind: 'use_tool'
      toolName: string
      args: KvPair[]
      output?: string
      error?: string
    }
  | {
      kind: 'generic'
      name: string
      summary?: string
      output?: string
      error?: string
      /** Flattened rawInput fields when nothing better is available. */
      inputArgs: KvPair[]
    }

// ── helpers ──────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function asStr(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

function rawField(ri: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!ri) return undefined
  for (const k of keys) {
    const v = ri[k]
    const s = asStr(v)
    if (s != null && s !== '') return s
    // nested sometimes
    if (isObj(v)) {
      const t = asStr(v.text) ?? asStr(v.value)
      if (t) return t
    }
  }
  return undefined
}

function rawBool(ri: Record<string, unknown> | undefined, ...keys: string[]): boolean {
  if (!ri) return false
  for (const k of keys) {
    const v = ri[k]
    if (typeof v === 'boolean') return v
    if (v === 'true' || v === 1) return true
  }
  return false
}

/** Unwrap one level of Rust externally-tagged enum: { "Bash": {...} }. */
function unwrapTagged(raw: unknown): { tag: string; body: unknown } | null {
  if (!isObj(raw)) return null
  const keys = Object.keys(raw)
  if (keys.length === 1) {
    return { tag: keys[0], body: raw[keys[0]] }
  }
  // Internally tagged or flat
  if (typeof raw.type === 'string') return { tag: String(raw.type), body: raw }
  if (typeof raw.variant === 'string') return { tag: String(raw.variant), body: raw }
  return null
}

/** Recursively dig for a string field under common names. */
function digString(v: unknown, ...names: string[]): string | undefined {
  if (!v) return undefined
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    // byte array → utf8
    if (v.every((x) => typeof x === 'number' && x >= 0 && x <= 255)) {
      try {
        return new TextDecoder().decode(Uint8Array.from(v as number[]))
      } catch {
        return undefined
      }
    }
    return undefined
  }
  if (!isObj(v)) return undefined
  for (const n of names) {
    if (n in v) {
      const got = digString(v[n], ...names)
      if (got != null) return got
      const s = asStr(v[n])
      if (s != null) return s
    }
  }
  // one-level unwrap
  const u = unwrapTagged(v)
  if (u) return digString(u.body, ...names)
  return undefined
}

/** Extract text from ACP tool call content blocks. */
export function contentText(tc: ToolCall): string {
  const c = tc.content
  if (!c) return ''
  if (typeof c === 'string') return c
  const blocks = Array.isArray(c) ? c : [c]
  const parts: string[] = []
  for (const b of blocks) {
    if (!b) continue
    if (typeof b === 'string') {
      parts.push(b)
      continue
    }
    if (!isObj(b)) continue
    // ToolCallContent::Content { content: ContentBlock::Text }
    if (b.type === 'content' || b.type === 'text' || !b.type) {
      const inner = b.content ?? b
      if (typeof inner === 'string') parts.push(inner)
      else if (isObj(inner)) {
        if (typeof inner.text === 'string') parts.push(inner.text)
        else if (isObj(inner.content) && typeof inner.content.text === 'string') {
          parts.push(inner.content.text)
        } else if (typeof (inner as { text?: string }).text === 'string') {
          parts.push(String((inner as { text: string }).text))
        }
      }
    }
  }
  return parts.join('\n')
}

function contentDiffs(tc: ToolCall): Array<{
  path?: string
  oldText: string
  newText: string
  newLine?: number
}> {
  const c = tc.content
  if (!c) return []
  const blocks = Array.isArray(c) ? c : [c]
  const out: Array<{ path?: string; oldText: string; newText: string; newLine?: number }> = []
  for (const b of blocks) {
    if (!isObj(b)) continue
    const type = String(b.type || '').toLowerCase()
    const isDiff =
      type === 'diff' ||
      'oldText' in b ||
      'old_text' in b ||
      'newText' in b ||
      'new_text' in b
    if (!isDiff) continue
    const oldText = asStr(b.oldText) ?? asStr(b.old_text) ?? ''
    const newText = asStr(b.newText) ?? asStr(b.new_text) ?? ''
    const path = asStr(b.path) ?? asStr(b.filePath) ?? asStr(b.file_path)
    const meta = isObj(b.meta) ? b.meta : undefined
    const newLine =
      (meta && (asStr(meta.new_line) || asStr(meta.newLine))) ||
      asStr(b.new_line) ||
      asStr(b.newLine)
    out.push({
      path,
      oldText,
      newText,
      newLine: newLine != null ? Number(newLine) || 1 : undefined,
    })
  }
  return out
}

function bytesToText(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
    try {
      return new TextDecoder().decode(Uint8Array.from(v as number[]))
    } catch {
      return undefined
    }
  }
  return undefined
}

function flattenArgs(obj: Record<string, unknown> | undefined, skip: Set<string> = new Set()): KvPair[] {
  if (!obj) return []
  const out: KvPair[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (skip.has(k)) continue
    if (v == null) continue
    let display: string
    if (typeof v === 'string') display = v
    else if (typeof v === 'number' || typeof v === 'boolean') display = String(v)
    else {
      try {
        display = JSON.stringify(v)
      } catch {
        display = String(v)
      }
    }
    // Skip huge blobs in arg list
    if (display.length > 4000) display = display.slice(0, 4000) + '…'
    out.push({ key: k, value: display })
  }
  return out
}

function kindOf(tc: ToolCall, kindName?: string): string {
  return (kindName || tc.kind || 'other').toLowerCase()
}

function failed(tc: ToolCall): boolean {
  const s = (tc.status || '').toLowerCase()
  return s === 'failed' || s === 'error'
}

// ── bash / execute ───────────────────────────────────────────────────

function extractBash(raw: unknown): {
  output?: string
  exitCode?: number
  signal?: string
} | null {
  if (!raw) return null
  // { Bash: { output, exit_code, signal } }
  const tagged = unwrapTagged(raw)
  const body =
    tagged && /bash|execute|shell|command/i.test(tagged.tag) ? tagged.body : isObj(raw) ? raw : null
  if (!body || !isObj(body)) {
    // ToolOutput sometimes nests further
    if (tagged) {
      const inner = unwrapTagged(tagged.body)
      if (inner && isObj(inner.body)) {
        return extractBash({ [inner.tag]: inner.body })
      }
    }
    return null
  }
  // Detect bash-like shape
  const output =
    bytesToText(body.output) ??
    bytesToText(body.stdout) ??
    asStr(body.output) ??
    asStr(body.stdout)
  const exitCode =
    typeof body.exit_code === 'number'
      ? body.exit_code
      : typeof body.exitCode === 'number'
        ? body.exitCode
        : undefined
  const signal = asStr(body.signal)
  if (output == null && exitCode == null && !signal) {
    // Not bash — maybe flat ToolOutput without tag
    if ('output' in body || 'exit_code' in body || 'exitCode' in body) {
      return { output: output ?? undefined, exitCode, signal }
    }
    return null
  }
  return { output: output ?? undefined, exitCode, signal }
}

// ── read ─────────────────────────────────────────────────────────────

function extractReadFile(raw: unknown): {
  content?: string
  totalLines?: number
  offset?: number
  limit?: number
  error?: string
  media?: 'image' | 'pdf'
} | null {
  if (!raw) return null
  const tagged = unwrapTagged(raw)
  let body: unknown = raw
  if (tagged && /read/i.test(tagged.tag)) body = tagged.body
  // Nested FileContent / error variants
  const nested = unwrapTagged(body)
  if (nested) {
    const tag = nested.tag
    if (/ImageContent|image/i.test(tag)) return { media: 'image' }
    if (/Pdf/i.test(tag)) return { media: 'pdf' }
    // NOTE: ImageContent 必须先于 FileContent/content 判定——后者含
    // "content" 子串，先判会吞掉图片标签（media 永远为空）。
    if (/FileContent|content/i.test(tag) && isObj(nested.body)) {
      const b = nested.body
      return {
        content:
          asStr(b.raw_output) ??
          asStr(b.rawOutput) ??
          asStr(b.content) ??
          asStr(b.text),
        totalLines:
          typeof b.total_lines === 'number'
            ? b.total_lines
            : typeof b.totalLines === 'number'
              ? b.totalLines
              : undefined,
        offset: typeof b.offset === 'number' ? b.offset : undefined,
        limit: typeof b.limit === 'number' ? b.limit : undefined,
      }
    }
    if (
      /NotFound|Directory|Permission|TooLarge|Error|Denied/i.test(tag) &&
      (typeof nested.body === 'string' || isObj(nested.body))
    ) {
      const msg =
        typeof nested.body === 'string'
          ? nested.body
          : asStr((nested.body as Record<string, unknown>).message) ??
            digString(nested.body, 'message', 'error') ??
            tag
      return { error: msg }
    }
  }
  if (isObj(body)) {
    const content =
      asStr(body.raw_output) ??
      asStr(body.rawOutput) ??
      asStr(body.content) ??
      asStr(body.text)
    if (content != null) {
      return {
        content,
        totalLines:
          typeof body.total_lines === 'number'
            ? body.total_lines
            : typeof body.totalLines === 'number'
              ? body.totalLines
              : undefined,
        offset: typeof body.offset === 'number' ? body.offset : undefined,
        limit: typeof body.limit === 'number' ? body.limit : undefined,
      }
    }
  }
  return null
}

// ── search / grep ────────────────────────────────────────────────────

function extractGrep(raw: unknown): {
  matchCount: number
  fileMatches: SearchFile[]
  filePaths: string[]
} | null {
  if (!raw) return null
  const tagged = unwrapTagged(raw)
  let body: unknown = raw
  if (tagged && /grep|search/i.test(tagged.tag)) body = tagged.body
  if (!isObj(body)) return null
  if (!('match_count' in body || 'matchCount' in body || 'file_matches' in body || 'fileMatches' in body)) {
    // try nested once
    const n = unwrapTagged(body)
    if (n && isObj(n.body)) body = n.body
    else return null
  }
  if (!isObj(body)) return null
  const matchCount =
    typeof body.match_count === 'number'
      ? body.match_count
      : typeof body.matchCount === 'number'
        ? body.matchCount
        : 0
  const fmRaw = (body.file_matches ?? body.fileMatches) as unknown
  const fileMatches: SearchFile[] = []
  if (Array.isArray(fmRaw)) {
    for (const fm of fmRaw) {
      if (!isObj(fm)) continue
      const path = asStr(fm.path) ?? ''
      const matches: SearchMatch[] = []
      const ms = fm.matches
      if (Array.isArray(ms)) {
        for (const m of ms) {
          if (!isObj(m)) continue
          matches.push({
            lineNumber:
              typeof m.line_number === 'number'
                ? m.line_number
                : typeof m.lineNumber === 'number'
                  ? m.lineNumber
                  : 0,
            content: asStr(m.content) ?? asStr(m.text) ?? '',
          })
        }
      }
      fileMatches.push({ path, matches })
    }
  }
  let filePaths: string[] = []
  if (Array.isArray(body.file_paths)) {
    filePaths = body.file_paths.map(String)
  } else if (Array.isArray(body.filePaths)) {
    filePaths = body.filePaths.map(String)
  } else if (fileMatches.length === 0 && matchCount > 0) {
    const stdout = bytesToText(body.stdout) ?? asStr(body.stdout) ?? ''
    filePaths = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('<') && !l.startsWith('Found '))
  }
  return { matchCount, fileMatches, filePaths }
}

// ── list dir ─────────────────────────────────────────────────────────

function extractListDir(raw: unknown): string | null {
  if (!raw) return null
  const tagged = unwrapTagged(raw)
  let body: unknown = raw
  if (tagged && /list|dir/i.test(tagged.tag)) body = tagged.body
  const nested = unwrapTagged(body)
  if (nested && isObj(nested.body)) {
    const c = asStr(nested.body.content) ?? asStr(nested.body.output)
    if (c != null) return c
  }
  if (isObj(body)) {
    return asStr(body.content) ?? asStr(body.output) ?? null
  }
  if (typeof body === 'string') return body
  return null
}

// ── edit / diff ──────────────────────────────────────────────────────

function simpleDiffLines(oldText: string, newText: string, startLine = 1): DiffLine[] {
  const oldLines = oldText.replace(/\n$/, '').split('\n')
  const newLines = newText.replace(/\n$/, '').split('\n')
  // Empty old → pure insert; empty new → pure delete
  if (!oldText && newText) {
    return newLines.map((text, i) => ({
      kind: 'insert' as const,
      newNo: startLine + i,
      text,
    }))
  }
  if (oldText && !newText) {
    return oldLines.map((text, i) => ({
      kind: 'delete' as const,
      oldNo: startLine + i,
      text,
    }))
  }
  // LCS-lite: if identical length line-by-line, pairwise; else dump both
  const out: DiffLine[] = []
  out.push({ kind: 'header', text: `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@` })
  // Myers-lite for small hunks
  if (oldLines.length + newLines.length <= 400) {
    const ops = diffLines(oldLines, newLines)
    let o = startLine
    let n = startLine
    for (const op of ops) {
      if (op.type === 'equal') {
        out.push({ kind: 'equal', oldNo: o, newNo: n, text: op.line })
        o++
        n++
      } else if (op.type === 'delete') {
        out.push({ kind: 'delete', oldNo: o, text: op.line })
        o++
      } else {
        out.push({ kind: 'insert', newNo: n, text: op.line })
        n++
      }
    }
    return out
  }
  for (const text of oldLines) {
    out.push({ kind: 'delete', oldNo: startLine++, text })
  }
  let n = startLine - oldLines.length
  for (const text of newLines) {
    out.push({ kind: 'insert', newNo: n++, text })
  }
  return out
}

type DiffOp = { type: 'equal' | 'insert' | 'delete'; line: string }

/** Simple LCS-based line diff (small inputs). */
function diffLines(a: string[], b: string[]): DiffOp[] {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', line: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'delete', line: a[i] })
      i++
    } else {
      ops.push({ type: 'insert', line: b[j] })
      j++
    }
  }
  while (i < m) ops.push({ type: 'delete', line: a[i++] })
  while (j < n) ops.push({ type: 'insert', line: b[j++] })
  return ops
}

function extractEditHunks(tc: ToolCall): { lines: DiffLine[]; ins: number; del: number } {
  // Strategy 1: structured edits in rawOutput SearchReplace EditsApplied
  const raw = tc.rawOutput
  if (raw) {
    const tagged = unwrapTagged(raw)
    let body: unknown = tagged && /search|replace|edit/i.test(tagged.tag) ? tagged.body : raw
    const nested = unwrapTagged(body)
    if (nested && /EditsApplied|applied/i.test(nested.tag)) {
      body = nested.body
    }
    if (isObj(body)) {
      const edits = isObj(body.edits) ? body.edits : body
      const details = (isObj(edits) ? edits.details : undefined) ?? (body as { details?: unknown }).details
      if (Array.isArray(details)) {
        const lines: DiffLine[] = []
        let ins = 0
        let del = 0
        for (const d of details) {
          if (!isObj(d)) continue
          const oldT = asStr(d.old_string) ?? asStr(d.oldString) ?? asStr(d.old_text) ?? ''
          const newT = asStr(d.new_string) ?? asStr(d.newString) ?? asStr(d.new_text) ?? ''
          const start =
            typeof d.start_line === 'number'
              ? d.start_line
              : typeof d.line === 'number'
                ? d.line
                : typeof d.new_line === 'number'
                  ? d.new_line
                  : 1
          if (lines.length) lines.push({ kind: 'gap', text: '…' })
          const hunk = simpleDiffLines(oldT, newT, start)
          for (const hl of hunk) {
            if (hl.kind === 'insert') ins++
            if (hl.kind === 'delete') del++
            lines.push(hl)
          }
        }
        if (lines.length) return { lines, ins, del }
      }
    }
  }

  // Strategy 2/3: content Diff blocks
  const diffs = contentDiffs(tc)
  if (diffs.length) {
    const lines: DiffLine[] = []
    let ins = 0
    let del = 0
    diffs.forEach((d, i) => {
      if (i > 0) lines.push({ kind: 'gap', text: '…' })
      const hunk = simpleDiffLines(d.oldText, d.newText, d.newLine ?? 1)
      for (const hl of hunk) {
        if (hl.kind === 'insert') ins++
        if (hl.kind === 'delete') del++
        lines.push(hl)
      }
    })
    return { lines, ins, del }
  }

  return { lines: [], ins: 0, del: 0 }
}

// ── use tool ─────────────────────────────────────────────────────────

function extractUseToolArgs(ri: Record<string, unknown> | undefined): KvPair[] {
  if (!ri) return []
  const ti = ri.tool_input ?? ri.toolInput ?? ri.input
  if (isObj(ti)) return flattenArgs(ti)
  // whole rawInput as args, skip meta keys
  return flattenArgs(ri, new Set(['variant', 'tool_name', 'toolName', 'name']))
}

function extractUseToolOutput(raw: unknown): string | undefined {
  if (!raw) return undefined
  if (typeof raw === 'string') return maybePretty(raw)
  const tagged = unwrapTagged(raw)
  if (tagged) {
    if (/MCP|mcp/i.test(tagged.tag)) {
      const b = tagged.body
      if (typeof b === 'string') return maybePretty(b)
      if (isObj(b)) {
        // OkayOutput / Error variants
        const n = unwrapTagged(b)
        if (n && typeof n.body === 'string') return maybePretty(n.body)
        return (
          digString(b, 'output', 'text', 'content', 'message', 'result') ??
          maybePretty(JSON.stringify(b, null, 2))
        )
      }
    }
    if (/Text/i.test(tagged.tag) && isObj(tagged.body)) {
      return asStr(tagged.body.text) ?? digString(tagged.body, 'text')
    }
    if (/Dynamic/i.test(tagged.tag)) {
      try {
        return JSON.stringify(tagged.body, null, 2)
      } catch {
        return String(tagged.body)
      }
    }
  }
  if (isObj(raw)) {
    return (
      digString(raw, 'output', 'text', 'content', 'result', 'message') ??
      maybePretty(JSON.stringify(raw, null, 2))
    )
  }
  return undefined
}

function maybePretty(s: string): string {
  try {
    const v = JSON.parse(s)
    return JSON.stringify(v, null, 2)
  } catch {
    return s
  }
}

// ── public API ───────────────────────────────────────────────────────

/**
 * Build expanded detail for a tool call, aligned with TUI tool blocks.
 */
export function extractToolDetail(tc: ToolCall, kindName?: string): ToolDetail {
  const kind = kindOf(tc, kindName)
  const ri = isObj(tc.rawInput) ? tc.rawInput : undefined
  const raw = tc.rawOutput
  const title = tc.title || ''
  const isFail = failed(tc)
  const variant = rawField(ri, 'variant')

  // ── execute / bash / shell ──
  if (
    kind === 'execute' ||
    kind === 'bash' ||
    kind === 'shell' ||
    kind === 'run' ||
    kind === 'command'
  ) {
    const command =
      rawField(ri, 'command', 'cmd') ||
      (title.startsWith('$') ? title.slice(1).trim() : title) ||
      ''
    const description = rawField(ri, 'description')
    const bash = extractBash(raw)
    let error: string | undefined
    if (bash) {
      if (bash.signal) error = bash.signal
      else if (bash.exitCode != null && bash.exitCode !== 0) error = `exit code ${bash.exitCode}`
      else if (isFail) error = 'Command failed'
    } else if (isFail) {
      error = contentText(tc) || 'Command failed'
    }
    // Live streaming may put text in content before rawOutput settles
    const output = bash?.output ?? (contentText(tc) || undefined)
    return {
      kind: 'execute',
      command,
      description: description && description !== command ? description : undefined,
      output,
      exitCode: bash?.exitCode,
      signal: bash?.signal,
      error,
    }
  }

  // ── read ──
  if (kind === 'read' || kind === 'file') {
    const path =
      rawField(ri, 'file_path', 'target_file', 'path', 'filePath', 'targetFile') || title
    const rf = extractReadFile(raw)
    let lineStart: number | undefined
    let lineEnd: number | undefined
    if (rf?.offset != null || rf?.limit != null) {
      const off = rf.offset ?? 0
      lineStart = off + 1
      lineEnd = rf.limit != null ? off + rf.limit : rf.totalLines
      if (rf.totalLines != null && lineEnd != null) lineEnd = Math.min(lineEnd, rf.totalLines)
    }
    // rawInput offset/limit
    if (lineStart == null) {
      const off = ri && typeof ri.offset === 'number' ? ri.offset : undefined
      const lim = ri && typeof ri.limit === 'number' ? ri.limit : undefined
      if (off != null || lim != null) {
        const o = off ?? 0
        lineStart = o + 1
        if (lim != null) lineEnd = o + lim
      }
    }
    const content = rf?.content
    const error = rf?.error ?? (isFail ? contentText(tc) || 'Read failed' : undefined)
    return {
      kind: 'read',
      path,
      lineStart,
      lineEnd,
      totalLines: rf?.totalLines,
      content,
      error,
      empty: content === '',
      media: rf?.media,
    }
  }

  // ── edit / write / create ──
  if (kind === 'edit' || kind === 'write' || kind === 'create' || kind === 'delete' || kind === 'move') {
    const path =
      rawField(ri, 'file_path', 'filePath', 'target_file', 'path') || title
    const creating =
      kind === 'write' ||
      kind === 'create' ||
      /creat|write|new file/i.test(title)
    if (isFail) {
      return {
        kind: 'edit',
        path,
        creating,
        lines: [],
        insertions: 0,
        deletions: 0,
        error: contentText(tc) || 'Edit failed',
      }
    }
    const { lines, ins, del } = extractEditHunks(tc)
    return {
      kind: 'edit',
      path,
      creating,
      lines,
      insertions: ins,
      deletions: del,
    }
  }

  // ── search / grep / glob ──
  if (kind === 'search' || kind === 'grep' || kind === 'glob') {
    // Web / X search variant
    if (
      variant === 'WebSearch' ||
      variant === 'XSearch' ||
      title.startsWith('Web search:') ||
      title.startsWith('X search:')
    ) {
      const query =
        rawField(ri, 'query') ||
        title.replace(/^Web search:\s*/i, '').replace(/^X search:\s*/i, '').replace(/^"|"$/g, '') ||
        ''
      let content: string | undefined
      let citations: string[] = []
      if (raw) {
        const tagged = unwrapTagged(raw)
        const body = tagged && /web|search/i.test(tagged.tag) ? tagged.body : raw
        if (isObj(body)) {
          content = asStr(body.content)
          if (Array.isArray(body.citations)) {
            citations = body.citations.map(String)
          }
        }
      }
      if (!content) {
        const t = contentText(tc)
        if (t) content = t
      }
      return {
        kind: 'web_search',
        query,
        content,
        citations,
        error: isFail ? 'Web search failed' : undefined,
        label: variant === 'XSearch' ? 'X Search' : undefined,
      }
    }

    const pattern = rawField(ri, 'pattern', 'glob_pattern', 'globPattern', 'query') || title
    const grep = extractGrep(raw)
    const outputModeStr = rawField(ri, 'output_mode', 'outputMode')
    const outputMode =
      outputModeStr === 'files_with_matches'
        ? 'files'
        : outputModeStr === 'count'
          ? 'count'
          : 'content'
    return {
      kind: 'search',
      pattern,
      path: rawField(ri, 'path', 'target_directory'),
      glob: rawField(ri, 'glob'),
      outputMode,
      caseInsensitive: rawBool(ri, '-i', 'case_insensitive', 'caseInsensitive'),
      fileType: rawField(ri, 'type', 'file_type'),
      multiline: rawBool(ri, 'multiline'),
      matchCount: grep?.matchCount ?? 0,
      fileMatches: grep?.fileMatches ?? [],
      filePaths: grep?.filePaths ?? [],
      error: isFail ? 'Search failed' : undefined,
    }
  }

  // ── list_dir ──
  if (
    kind === 'list_dir' ||
    kind === 'listdir' ||
    kind === 'ls' ||
    rawField(ri, 'target_directory') != null
  ) {
    const path =
      rawField(ri, 'target_directory', 'path', 'directory') || title
    const output = extractListDir(raw) ?? (contentText(tc) || undefined)
    const entryCount = output
      ? output.split('\n').filter((l) => l.trim()).length
      : 0
    return {
      kind: 'list_dir',
      path,
      output,
      entryCount,
      error: isFail ? 'List directory failed' : undefined,
    }
  }

  // ── fetch ──
  if (kind === 'fetch' || kind === 'webfetch') {
    const url = rawField(ri, 'url') || title.replace(/^Fetch:\s*/i, '')
    let statusCode: number | undefined
    let contentType: string | undefined
    let bytes: number | undefined
    if (raw) {
      const tagged = unwrapTagged(raw)
      let body: unknown = tagged && /fetch|web/i.test(tagged.tag) ? tagged.body : raw
      const n = unwrapTagged(body)
      if (n) body = n.body
      if (isObj(body)) {
        statusCode =
          typeof body.status_code === 'number'
            ? body.status_code
            : typeof body.statusCode === 'number'
              ? body.statusCode
              : undefined
        contentType = asStr(body.content_type) ?? asStr(body.contentType)
        bytes = typeof body.bytes === 'number' ? body.bytes : undefined
      }
    }
    return {
      kind: 'fetch',
      url,
      statusCode,
      contentType,
      bytes,
      output: contentText(tc) || undefined,
      error: isFail ? 'Fetch failed' : undefined,
    }
  }

  // ── use_tool / mcp ──
  if (kind === 'mcp' || kind === 'use_tool' || variant === 'UseTool') {
    const toolName =
      rawField(ri, 'tool_name', 'toolName', 'name') || title
    const args = extractUseToolArgs(ri)
    const output =
      contentText(tc) || extractUseToolOutput(raw) || undefined
    return {
      kind: 'use_tool',
      toolName,
      args,
      output,
      error: isFail ? 'Tool failed' : undefined,
    }
  }

  // ── generic fallback ──
  const output =
    contentText(tc) ||
    extractUseToolOutput(raw) ||
    (typeof raw === 'string' ? raw : raw != null ? safeJson(raw) : undefined)
  return {
    kind: 'generic',
    name: title || kind,
    summary: title,
    output,
    error: isFail ? contentText(tc) || 'Failed' : undefined,
    inputArgs: flattenArgs(ri, new Set(['variant'])),
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/**
 * Truncate lines: first N + ellipsis + last M (TUI execute/read truncated mode).
 */
export function truncateLines(
  lines: string[],
  first: number,
  last: number,
): { lines: string[]; hidden: number } {
  const total = lines.length
  const threshold = first + last
  if (total <= threshold) return { lines, hidden: 0 }
  const head = lines.slice(0, first)
  const tail = lines.slice(total - last)
  const hidden = total - threshold
  return {
    lines: [...head, `… +${hidden} lines`, ...tail],
    hidden,
  }
}
