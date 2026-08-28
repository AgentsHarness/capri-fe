export type ConnState = 'connecting' | 'ready' | 'busy' | 'error' | 'offline'
export type FocusMode = 'prompt' | 'scrollback'

/** One MCP server row for the MCP panel (x.ai/mcp/server_status). */
export type McpServerInfo = {
  name: string
  source?: string
  status?: string
  reason?: string
  detail?: string
}

/**
 * MCP init progress (x.ai/mcp/init_progress — shell wire {total,
 * connected, sessionId}, camelCase). Aggregate counts, not per-server:
 * the TUI status bar renders the chip `MCP (connected/total)` while
 * `total > 0`, and "Starting session…" for the total==0 startup seed.
 */
export type McpInitProgress = {
  total: number
  connected: number
  /** First-seen epoch ms (for a "connecting since …" hint). */
  startedAt: number
}

/** Extensions modal tabs (TUI /hooks /plugins /skills /marketplace). */
export type ExtensionsTab = 'hooks' | 'plugins' | 'skills' | 'marketplace'

/**
 * TUI TodoCounts — derived from session/update `plan` entries (plan →
 * todo items). `total` excludes cancelled, matching the status-bar badge.
 */
export type TodoCounts = {
  total: number
  inProgress: number
  pending: number
  completed: number
}

/** One plan-derived todo item (TUI TodoItem; clickable badge panel). */
export type TodoItem = {
  id?: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority?: string
}

/**
 * Block-viewer state for a task WITHOUT a scrollback row: top-strip
 * restored tasks and history-replay display rows (never captured into
 * bgTaskIndex). The log is fetched session-scoped from the host
 * (persisted timeline + on-disk log) — history pagination never applies.
 */
export type ViewerTask = {
  taskId: string
  title?: string
  command?: string
  outputFile?: string
  output?: string
  running?: boolean
  completed?: boolean
  failed?: boolean
  /** Session whose timeline backs this view (history replay / resume). */
  sessionId?: string
  cwd?: string
}

/**
 * One workflow run row (TUI /workflows pane). Fed by `workflow_updated`
 * session notifications — the wire guarantees runId/name/status and
 * commonly `current_phase`; progress / script / agent roster / start time
 * are parsed defensively and the UI degrades when absent.
 */
export type WorkflowRun = {
  runId: string
  name: string
  status: string
  phase?: string
  /** Wire snake_case spelling (workflow_updated) — same value as `phase`. */
  current_phase?: string
  /** Progress 0..1 when the event carries it (panel omits the bar otherwise). */
  progress?: number
  /** Script payload from workflow_updated — the "save script" source. */
  script?: string
  /** Workflow objective (wire `objective`). */
  objective?: string
  /** Agent roster labels (TUI shows it per row when the event carries it). */
  agents?: string[]
  /**
   * Structured agent roster (WorkflowAgentInfo wire shape: label / state /
   * tokens_used). Same source as `agents` — plain labels when the wire
   * only ships strings, full objects when it ships the roster.
   */
  agentRoster?: { name: string; status?: string; tokens?: number }[]
  /** Phase rail (WorkflowPhaseInfo wire shape: title / state). */
  phases?: { title: string; state: string }[]
  /** Wire elapsed_ms — elapsed fallback when the wire has no started_at. */
  elapsedMs?: number
  /** Started-at epoch ms from the wire. */
  startedAt?: number
  /** Local first-seen epoch ms — start-time fallback when the wire has none. */
  firstSeenAt: number
  /**
   * Optimistic prompt-path control in flight (pause/resume/stop). The
   * next workflow_updated for this run is authoritative and clears it.
   */
  pendingControl?: 'pause' | 'resume' | 'stop'
}


/** One fuzzy file-search match (x.ai/search/fuzzy/status FuzzyMatch). */
export type FileSearchMatch = {
  /** File path relative to the search root (workspace cwd). */
  path: string
  /** Match score (higher is better) when the wire carries it. */
  score?: number
  /** Indices of matched chars within `path` (for highlight). */
  matchedIndices?: number[]
}

/**
 * Live fuzzy file-search session (Composer @ picker engine state, TUI
 * fuzzy file search). `matches` is the full snapshot of the newest
 * generation — the workspace replaces (not appends) per batch.
 */
export type FileSearchState = {
  searchId: string
  matches: FileSearchMatch[]
  /** True when the engine finished the current query (status done flag). */
  done: boolean
  /** Total engine-side matches when the wire carries it. */
  total?: number
}
