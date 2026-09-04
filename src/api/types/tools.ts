
export type ToolCall = {
  toolCallId?: string
  title?: string
  kind?: string
  status?: string
  rawInput?: Record<string, unknown>
  rawOutput?: unknown
  content?: unknown
  locations?: unknown
  [k: string]: unknown
}



/**
 * Structured "always allow" scope sent on a permission response — mirrors
 * TUI `BashCommandSelectedTerms` (xai-grok-workspace permission/prompter.rs):
 * a literal command-prefix word list (`isGlob: false`, the ←/→ word-scope)
 * or a single free-form pattern (`isGlob: true`, the pattern editor).
 * Host contract (parallel): POST /api/permission-response `scope` field,
 * parsed verbatim — field names must match exactly.
 */
export type BashCommandScope = {
  commandParts: string[]
  isGlob: boolean
}

/**
 * TUI `McpScopeSelection` (xai-grok-workspace permission/prompter.rs,
 * serde tag = "kind", snake_case variants) — the response `_meta` the TUI
 * attaches when the user picks "always allow" on an MCP prompt:
 *   {"kind": "tool",   "tool_name": "<server>__<tool>"}  → exact tool
 *   {"kind": "server", "server": "<server>"}             → whole server
 * Sent in the same `scope` field as the bash scope (different request
 * types take different encodings). The current host only relays
 * commandParts/isGlob to the agent (bridge.go RespondPermissionWithMeta);
 * an MCP-shaped scope is dropped there and the agent's no-meta fallback
 * grants exact-tool scope — this wire is forward-compatible with hosts
 * that relay McpScopeSelection.
 */


/**
 * TUI `McpScopeSelection` (xai-grok-workspace permission/prompter.rs,
 * serde tag = "kind", snake_case variants) — the response `_meta` the TUI
 * attaches when the user picks "always allow" on an MCP prompt:
 *   {"kind": "tool",   "tool_name": "<server>__<tool>"}  → exact tool
 *   {"kind": "server", "server": "<server>"}             → whole server
 * Sent in the same `scope` field as the bash scope (different request
 * types take different encodings). The current host only relays
 * commandParts/isGlob to the agent (bridge.go RespondPermissionWithMeta);
 * an MCP-shaped scope is dropped there and the agent's no-meta fallback
 * grants exact-tool scope — this wire is forward-compatible with hosts
 * that relay McpScopeSelection.
 */
export type McpScopeSelection =
  | { kind: 'tool'; tool_name: string }
  | { kind: 'server'; server: string }

/** Structured "always allow" scope — bash or MCP encoding. */


/** Structured "always allow" scope — bash or MCP encoding. */
export type PermissionScope = BashCommandScope | McpScopeSelection



/**
 * One git file change — x.ai/git/* wire shape (xai-grok-workspace-types
 * rpc/git.rs GitFileChange, camelCase). `type` is the lowercase ChangeType
 * serialization: create | edit | delete | rename | copy | typechange |
 * untracked.
 */
export type GitFileChange = {
  path: string
  oldPath?: string
  type:
    | 'create'
    | 'edit'
    | 'delete'
    | 'rename'
    | 'copy'
    | 'typechange'
    | 'untracked'
  /** Whether this change is staged (index vs HEAD); absent for commit diffs. */
  staged?: boolean
  additions: number
  deletions: number
  /** Unified diff text — only when the request asked for patches. */
  patch?: string
  patchBytes?: number
  patchLines?: number
  oldText?: string
  newText?: string
}

/** x.ai/git/status structured data (rpc/git.rs GitStatusData, camelCase). */


/** x.ai/git/status structured data (rpc/git.rs GitStatusData, camelCase). */
export type GitStatusData = {
  root?: string
  mainRoot?: string
  isWorktree?: boolean
  branch?: string
  commit?: string
  upstream?: string
  remoteUrl?: string
  /** Commits ahead of upstream (local commits not pushed). */
  ahead?: number
  /** Commits behind upstream (remote commits not pulled). */
  behind?: number
  /** Index vs HEAD. */
  staged: GitFileChange[]
  /** Worktree vs index (includes untracked when includeUntracked). */
  unstaged: GitFileChange[]
}

/** x.ai/git/diffs response (rpc/git.rs GitDiffsData, camelCase). */


/** x.ai/git/diffs response (rpc/git.rs GitDiffsData, camelCase). */
export type GitDiffsData = {
  files: GitFileChange[]
}

/** One file read by x.ai/git/files (rpc/git.rs GitReadFile, camelCase). */


/** One file read by x.ai/git/files (rpc/git.rs GitReadFile, camelCase). */
export type GitReadFile = {
  path: string
  version: string
  content: string
  isBinary?: boolean
}

/** x.ai/git/files response (rpc/git.rs GitReadFilesData, camelCase). */


/** x.ai/git/files response (rpc/git.rs GitReadFilesData, camelCase). */
export type GitReadFilesData = {
  files: GitReadFile[]
  errors?: unknown[]
}

/**
 * x.ai/billing config (xai-grok-shell extensions/billing.rs BillingConfig,
 * camelCase). Only the fields the credits chip consumes are typed; the
 * rest passes through the wire untouched.
 */


/** One branch row of x.ai/git/branches (rpc/git.rs GitBranch, camelCase). */
export type GitBranch = {
  name: string
  /** Whether this branch is the current HEAD (wire `current`). */
  current?: boolean
  upstream?: string
  commit?: string
}

/** x.ai/git/branches response (rpc/git.rs GitBranchesData, camelCase). */


/** x.ai/git/branches response (rpc/git.rs GitBranchesData, camelCase). */
export type GitBranchesData = {
  branches: GitBranch[]
  /** 仓库根（wire `repoRoot`）——非 git 目录时缺省。 */
  repoRoot?: string
}

/** Git commit log entry (/api/git/log). */
export type GitLogEntry = {
  hash: string
  shortHash: string
  author: string
  email: string
  timestamp: number
  date: string
  message: string
  refs?: string
}

/** Git stash item (/api/git/stash/list). */
export type GitStashItem = {
  index: number
  ref: string
  hash: string
  date: string
  message: string
}

/**
 * One agent skill row from x.ai/skills/list (camelCase; the agent
 * registry carries a live `enabled` state — the host-side
 * GET /api/extensions scan does not). Parsed defensively.
 */


/**
 * One agent-advertised slash command — ACP `AvailableCommand`
 * (agent-client-protocol-schema, `rename_all = "camelCase"`), forwarded
 * verbatim by capri-host as the `commands_update` SSE event's `commands`
 * array. Wire fields: `name`, `description`, `input: { hint }`, `_meta`.
 * The store normalizes it defensively (name required; the rest optional).
 */
export type AgentCommand = {
  name: string
  description?: string
  /** Argument placeholder (wire `input.hint`). */
  argHint?: string
  /** Reserved ACP `_meta` (skill identity etc.) — untouched passthrough. */
  meta?: Record<string, unknown>
}

