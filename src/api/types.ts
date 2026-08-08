export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: string; [k: string]: unknown }

export type HostInfo = {
  hostId: string
  hostName: string
  online: boolean
  ready?: boolean
  local?: boolean
  /** Hub registry liveness timestamp (hub mode). */
  lastSeen?: string
}

export type SessionInfo = {
  sessionId: string
  cwd?: string
  title?: string
  updatedAt?: string
  meta?: unknown
  /**
   * Host-side live state (multi-session dashboard): derived by acp-host
   * from in-flight turns (active) + pending client requests (awaiting).
   */
  status?: {
    state: 'active' | 'awaiting' | 'idle'
    busy?: boolean
    awaitingInput?: boolean
    lastActiveAt?: number
  }
  /**
   * [bg] badge census — host scan of the session's persisted updates:
   * hasTasks (any task/scheduled event), bgCount (task_backgrounded
   * events), bgRunning (backgrounded without a completion in the file
   * AND whose output log was written recently — liveness-probed).
   */
  hasTasks?: boolean
  bgCount?: number
  bgRunning?: number
}

/**
 * One session summary row from POST /api/session-summaries/workspace-list
 * (x.ai/session_summaries/workspace_list). The wire is snake_case
 * (info.id / info.cwd / session_summary / updated_at / num_messages /
 * current_model_id) — normalized to camelCase by LocalTransport.
 */
export type WorkspaceSummary = {
  sessionId: string
  cwd: string
  /** Display title (agent-backfilled session_summary; falls back to the id prefix). */
  title?: string
  /** ISO timestamp of the last update. */
  updatedAt?: string
  currentModelId?: string
  numMessages?: number
}

/** One workspace bucket: full cwd path → its session summaries. */
export type WorkspaceGroup = {
  cwd: string
  /** Display label (full cwd from the wire; short name via repoNameFromCwd). */
  label: string
  sessions: WorkspaceSummary[]
}

/**
 * One still-running task event (POST /api/session-running-tasks) — the
 * host scan of updates.jsonl, liveness-probed (task_backgrounded orphans
 * whose output log is held open by a live process). Mirrors the wire
 * update fields so the FE can reuse its live task handler for replay.
 */
export type TaskTimelineEvent = {
  timestamp?: number
  kind: 'task_backgrounded'
  taskId?: string
  command?: string
  description?: string
  monitorDescription?: string
  outputFile?: string
  cwd?: string
  /** Liveness-probed: the process is (very likely) still running. */
  running?: boolean
}

/**
 * One restored running task — the top task strip's state row. Populated
 * at session resume from the host's liveness probe; NOT a scrollback
 * entry (no scrollback pollution), lives only in the top strip and
 * updates via live task events.
 */
export type TopTask = {
  taskId: string
  title: string
  command?: string
  isMonitor?: boolean
  /** Absolute path to the on-disk log (wire output_file). */
  outputFile?: string
  /** Restored from the persisted timeline (host liveness probe). */
  restored?: boolean
}

/**
 * One scheduled task (/loop) — TUI tasks pane "调度任务" section. Fed by
 * scheduled_task_created / fired / deleted (both the session_notification
 * tag carrier and the standalone SSE event path).
 */
export type ScheduledTask = {
  taskId: string
  prompt: string
  /** Loop cadence as displayed (e.g. "1h", "30m", "5s"). */
  interval: string
  /** Next fire time (ISO string or epoch seconds/ms — normalized at render). */
  nextFireAt?: string
}

/** One /rewind candidate (POST /api/rewind-points → points[]). */
export type RewindPoint = {
  index: number
  timestamp?: number | string
  summary?: string
  /** False when this checkpoint has no file snapshots (conversation-only rewind). */
  hasFileChanges?: boolean
}

/**
 * POST /api/session-info response — authoritative live details of the
 * active session, served by the host on demand (TUI /session-info analog).
 */
export type SessionInfoDetail = {
  sessionId: string
  title?: string
  cwd?: string
  updatedAt?: string
  /** Dashboard classification: active / awaiting / idle. */
  state?: 'active' | 'awaiting' | 'idle'
  busy?: boolean
  model?: {
    modelId: string
    name?: string
    reasoningEffort?: string
    /** Model meta.totalContextTokens — context-bar total fallback. */
    contextWindow?: number
  }
  contextUsed?: number
  contextSize?: number
  gitBranch?: string
  gitIsWorktree?: boolean
  gitMainRepo?: string
  hostId: string
  hostName: string
  homeDir?: string
}

/** One effort row from model `_meta.reasoningEfforts` (or built-in fallback). */
export type ReasoningEffortOption = {
  /** Menu id (may remap, e.g. "deep" → wire "xhigh"). */
  id: string
  /** Display label (falls back to id/value). */
  label: string
  /** Canonical wire value sent as `_meta.reasoningEffort`. */
  value: string
  default?: boolean
}

/** One entry of agentInfo._meta.modelState.availableModels. */
export type ModelOption = {
  modelId: string
  name?: string
  description?: string
  agentType?: string
  /** Current/default effort on this model (from meta). */
  reasoningEffort?: string
  /** Whether the model advertises supportsReasoningEffort. */
  supportsReasoningEffort?: boolean
  /** Selectable effort levels (empty when unsupported). */
  reasoningEfforts?: ReasoningEffortOption[]
  /** Model context window tokens (meta.totalContextTokens) — TUI context bar total. */
  contextWindow?: number
}

/**
 * One agent-advertised slash command — ACP `AvailableCommand`
 * (agent-client-protocol-schema, `rename_all = "camelCase"`), forwarded
 * verbatim by acp-host as the `commands_update` SSE event's `commands`
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

export type PendingReq = {
  requestId: string
  method: string
  params?: Record<string, unknown>
}

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
export type GitDiffsData = {
  files: GitFileChange[]
}

/** One file read by x.ai/git/files (rpc/git.rs GitReadFile, camelCase). */
export type GitReadFile = {
  path: string
  version: string
  content: string
  isBinary?: boolean
}

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
export type BillingConfig = {
  /** Included credit usage as a percentage of the allowance (0–100). */
  creditUsagePercent?: number
  /** Remaining prepaid balance in USD cents (positive = bought credits). */
  prepaidBalance?: { val: number }
  /** Deprecated: included monthly credit budget in cents. */
  monthlyLimit?: { val: number }
  /** Deprecated: credits used this period in cents. */
  used?: { val: number }
  currentPeriod?: { start?: string; end?: string }
  [k: string]: unknown
}

/** x.ai/billing top-level response (BillingConfigResponse). */
export type BillingConfigResponse = {
  config?: BillingConfig | null
  onDemandEnabled?: boolean
  subscriptionTier?: string
  [k: string]: unknown
}

/** GET /api/extensions — one hook row. */
export type ExtensionHook = {
  name: string
  command?: string
  event?: string
  enabled?: boolean
}

/** GET /api/extensions — one plugin row. */
export type ExtensionPlugin = {
  name: string
  source?: string
  enabled?: boolean
}

/** GET /api/extensions — one skill row (path = SKILL.md location). */
export type ExtensionSkill = {
  name: string
  scope?: string
  path?: string
  /** Optional enable state — skills without it stay visible under any filter. */
  enabled?: boolean
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
export type McpScopeSelection =
  | { kind: 'tool'; tool_name: string }
  | { kind: 'server'; server: string }

/** Structured "always allow" scope — bash or MCP encoding. */
export type PermissionScope = BashCommandScope | McpScopeSelection

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

export type AcpEvent =
  | {
      type: 'hello'
      ready?: boolean
      busy?: boolean
      sessionId?: string
      /** Active session workspace (host snapshot; empty pre-session). */
      cwd?: string
      text?: string
      error?: string
      hostId?: string
      hostName?: string
      /** Hub-level hello (acp-hub): carries the registry instead of a host snapshot. */
      service?: 'hub'
      hosts?: HostInfo[]
      defaultHostId?: string
      /** User home dir — for "~/…" path shortening (TUI status bar). */
      homeDir?: string
      agentInfo?: unknown
      modes?: unknown
      /** SessionModelState from the active session (currentModelId + catalog). */
      models?: unknown
      configOptions?: unknown
      pendingRequests?: PendingReq[]
      capabilities?: unknown
      /** Agent's initialize-declared capabilities (host Status passthrough). */
      agentCapabilities?: unknown
      /**
       * Host live per-session states (SessionState[] — sessionId/cwd/
       * title/busy/awaitingInput/…; dashboard classification derives from
       * busy + awaitingInput).
       */
      roster?: unknown
      /**
       * Unix ms stamp of the current agent process spawn. The agent's
       * permission mode is in-memory only and resets on restart, so the
       * client compares this across hello events to detect a restart and
       * re-seed its known flags.
       */
      agentStartedAt?: number
    }
  | {
      type: 'ready'
      sessionId?: string
      /** Active session workspace (session/new | session/load). */
      cwd?: string
      hostId?: string
      hostName?: string
      agentInfo?: unknown
      modes?: unknown
      /** SessionModelState from session/new or session/load. */
      models?: unknown
      configOptions?: unknown
      /** session/new|load `_meta` passthrough (host only sends when non-nil). */
      sessionMeta?: unknown
      /** authenticate `_meta` passthrough (host only sends when non-nil). */
      authMeta?: unknown
    }
  | { type: 'chunk'; text: string; messageId?: string; ts?: number }
  | {
      type: 'user_chunk'
      text: string
      /** Forwarded chunk meta (update._meta): system-injected prompts are hidden. */
      hideFromScrollback?: boolean
      /** Forwarded content-block meta (content._meta): display override + cron framing. */
      displayText?: string
      displayAsCron?: boolean
    }
  /**
   * Image content block from agent_message_chunk / user_message_chunk
   * ({type:'image', data, mimeType} content blocks). `data` is a data URI
   * or bare base64; bare base64 is wrapped with `mimeType` at the store.
   */
  | { type: 'image'; sessionId?: string; data: string; mimeType?: string; ts?: number }
  | {
      type: 'task_lifecycle'
      /**
       * Stored task lifecycle event rendered from history replay with the
       * SAME look as live bg_task rows (Task started / completed / failed)
       * — but NOT captured into the task system: no bgTaskIndex entry,
       * never running, no kill button, no ⠋N / running-bar membership.
       */
      kind: 'started' | 'completed'
      taskId?: string
      title: string
      command?: string
      isMonitor?: boolean
      /** task_completed with non-zero exit / signal → failed look. */
      failed?: boolean
      /** Completion snapshot output (block viewer). */
      output?: string
    }
  /**
   * Aggregated user message (history replay or live user_chunk).
   * `isCron` matches TUI UserPromptBlock::cron (scheduled /loop fire).
   */
  | { type: 'user_message'; text: string; ts?: number; isCron?: boolean }
  | {
      type: 'thought'
      text: string
      /**
       * Server-reported original duration (ms) carried by history replay:
       * `_meta.agentTimestampMs - streamStartMs` of the persisted envelope.
       * Without it the replayed thought seals against the replay wall-clock
       * (~0ms) and renders a bogus "Thought for 0.0s" (TUI
       * ThinkingBlock::streaming_replay parity).
       */
      elapsedMs?: number
    }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_call_update'; toolCallUpdate: ToolCall }
  | { type: 'plan'; entries: unknown }
  | {
      type: 'usage'
      used?: number
      size?: number
      cost?: unknown
      /** Standard TurnCompleted/ResponseCompleted usage object (passed
          through untouched by the host). totalTokens is the turn-accumulated
          count; the frontend separates it from the context-window `used`. */
      usage?: {
        totalTokens?: number
        total_tokens?: number
        inputTokens?: number
        outputTokens?: number
        [key: string]: unknown
      }
    }
  | { type: 'busy' }
  | { type: 'done'; stopReason?: string; sessionId?: string }
  | { type: 'cancelled' }
  /** Turn-end marker replayed from stored history (turn_completed). Live
      events carry the owning sessionId — other sessions' completions are
      completion notices, not this session's turn seal. */
  | {
      type: 'turn_completed'
      sessionId?: string
      /** Relayed x.ai update (host shape — stop_reason / agent_result / usage). */
      update?: Record<string, unknown>
      /** Normalized stop_reason (replay derives it from the stored envelope). */
      stopReason?: string
      /** Normalized agent_result (TurnFailed error text on replay). */
      agentResult?: string
      /** Replay: the closed turn's real start (epoch ms), injected by
          replayUpdates from the envelope meta. */
      turnStartedAt?: number
      /** Replay: the turn_completed envelope write time (epoch ms). */
      endMs?: number
    }
  | { type: 'error'; message: string }
  | { type: 'status'; text: string }
  | { type: 'log'; text: string }
  | {
      type: 'client_request'
      requestId: string
      method: string
      params?: Record<string, unknown>
    }
  | { type: 'modes_update'; modes?: unknown }
  | { type: 'config_options_update'; configOptions?: unknown }
  | { type: 'commands_update'; commands?: unknown }
  | { type: 'session_info'; title?: string; updatedAt?: unknown }
  | {
      type: 'model'
      modelId?: string
      modelName?: string
      reasoningEffort?: string
    }
  // ── x.ai/* extension notifications (agent → client) ────────────────
  /** Raw x.ai/session_notification / x.ai/session/update envelope. */
  | {
      type: 'session_notification'
      method?: string
      params?: Record<string, unknown>
    }
  | { type: 'task_backgrounded'; params?: Record<string, unknown> }
  | { type: 'task_completed'; params?: Record<string, unknown> }
  | { type: 'monitor_event'; params?: Record<string, unknown> }
  | {
      type: 'git_head_changed'
      params?: { sessionId?: string; branch?: string | null; isWorktree?: boolean; mainRepo?: string | null }
    }
  | {
      type: 'yolo_mode_changed'
      params?: {
        yoloMode?: boolean
        autoMode?: boolean
        permissionMode?: string
        // Wire spelling (agent sends snake_case — TUI prost-derived).
        yolo_mode?: boolean
        auto_mode?: boolean
        permission_mode?: string
      }
    }
  | {
      type: 'mcp_server_status'
      params?: {
        sessionId?: string
        name?: string
        source?: string
        status?: string
        reason?: string
        detail?: string
      }
    }
  | { type: 'mcp_tools_changed'; params?: Record<string, unknown> }
  | { type: 'mcp_servers_updated'; params?: Record<string, unknown> }
  | {
      type: 'mcp_init_progress'
      /** x.ai/mcp/init_progress forwarded verbatim (shell emits
       *  camelCase {total, connected, sessionId}). */
      params?: { total?: number; connected?: number; sessionId?: string }
    }
  | { type: 'sessions_changed'; params?: Record<string, unknown> }
  /** Hub-level: a host paired / came online / dropped off (acp-hub). */
  | { type: 'hosts_changed'; params?: Record<string, unknown> }
  | { type: 'models_update'; params?: Record<string, unknown> }
  | { type: 'announcements_update'; params?: Record<string, unknown> }
  | {
      type: 'scheduled_task_created'
      sessionId?: string
      /** Host contract shape: { taskId, prompt, interval, nextFireAt }. */
      task?: Record<string, unknown>
      params?: Record<string, unknown>
    }
  | {
      type: 'scheduled_task_deleted'
      sessionId?: string
      taskId?: string
      params?: Record<string, unknown>
    }
  | {
      type: 'scheduled_task_fired'
      sessionId?: string
      taskId?: string
      /** Next fire time after this fire (ISO string / epoch). */
      nextFireAt?: unknown
      params?: Record<string, unknown>
    }
  | { type: 'scheduled_task_inject_prompt'; params?: Record<string, unknown> }
  | { type: 'prompt_complete'; params?: Record<string, unknown> }
  /** Turn-end suggestion chips (host broadcasts x.ai/follow_ups as this
      typed event — bridge.go). Params shape matches what applyFollowUps
      (store/chat.ts) consumes: snake_case response_id (camelCase
      accepted) plus the suggestions list ({label, …} items or strings). */
  | {
      type: 'follow_ups'
      sessionId?: string
      params?: {
        response_id?: string
        responseId?: string
        suggestions?: Array<string | { label?: string; [k: string]: unknown }>
        follow_ups?: Array<string | { label?: string; [k: string]: unknown }>
        [k: string]: unknown
      }
    }
  /** PTY lifecycle push (host broadcasts x.ai/terminal/pty/notification as
      this typed event — bridge.go). TerminalPanel consumes it; fields stay
      optional/loose to match the local PtyEvent shape there. */
  | {
      type: 'pty_notification'
      sessionId?: string
      params?: {
        terminalId?: string
        /** output | exit | process_started | process_ended. */
        type?: string
        /** Base64 raw PTY bytes (output kind). */
        data?: string
        outputOffset?: number
        isReplay?: boolean
        exitCode?: number
        signal?: string
        [k: string]: unknown
      }
    }
  // ── Remaining typed x.ai/* carriers (host bridge.go handleXaiNotification
  //    broadcasts each as {type, params} — pass-through; the store's
  //    default branch discards them silently by design: they are
  //    panel-local status feeds, never scrollback rows). ─────────────
  /** Streamed session-update chunks (session_updates.rs). */
  | { type: 'session_updates_chunk'; sessionId?: string; params?: Record<string, unknown> }
  /** Prompt-queue change (session/prompt_queue.rs). */
  | { type: 'queue_changed'; sessionId?: string; params?: Record<string, unknown> }
  /** Config reload notice (MCP init cancel / leader broadcast). */
  | { type: 'config_changed'; sessionId?: string; params?: Record<string, unknown> }
  /** Settings hot-reload push (mvp_agent). */
  | { type: 'settings_update'; sessionId?: string; params?: Record<string, unknown> }
  /** File-system change (fs_watch.rs). */
  | { type: 'fs_notify'; sessionId?: string; params?: Record<string, unknown> }
  /** Full file index (fs_watch.rs). */
  | { type: 'fs_index'; sessionId?: string; params?: Record<string, unknown> }
  /** Incremental file index (fs_watch.rs). */
  | { type: 'fs_index_delta'; sessionId?: string; params?: Record<string, unknown> }
  /** Fuzzy-search progress (search.rs). */
  | { type: 'search_fuzzy_status'; sessionId?: string; params?: Record<string, unknown> }
  /** Content-search progress (search.rs). */
  | { type: 'search_content_status'; sessionId?: string; params?: Record<string, unknown> }
  /** Worktree creation progress (worktree.rs). */
  | { type: 'git_worktree_status'; sessionId?: string; params?: Record<string, unknown> }
  /** Mid-turn interjection (interjection.rs). */
  | { type: 'session_interjection'; sessionId?: string; params?: Record<string, unknown> }
  /** Leader/client version-mismatch banner (version_mismatch.rs). */
  | { type: 'leader_version_mismatch'; sessionId?: string; params?: Record<string, unknown> }
  /** Leader reconnect signal (params may be empty). */
  | { type: 'leader_reconnected'; sessionId?: string; params?: Record<string, unknown> }
  /** Fallback: any other x.ai/* notification, forwarded verbatim. */
  | { type: 'ext_notification'; method?: string; params?: Record<string, unknown> }

/** One question in an x.ai/ask_user_question request (camelCase wire). */
export type AskQuestion = {
  id?: string
  question: string
  options: Array<{ label: string; description?: string; preview?: string; id?: string }>
  multiSelect?: boolean
}

/** x.ai/ask_user_question ext request params. */
export type AskUserQuestionReq = {
  sessionId?: string
  toolCallId?: string
  mode?: 'default' | 'plan'
  questions: AskQuestion[]
}

/** x.ai/exit_plan_mode ext request params. */
export type ExitPlanModeReq = {
  sessionId?: string
  toolCallId?: string
  planContent?: string
}

/**
 * One `x.ai/follow_ups` turn-end suggestion. Wire shape (TUI
 * FollowUpSuggestionParam, prost-derived snake_case): `{ label, … }` —
 * only the human-facing `label` is consumed; `properties` /
 * `tool_overrides` are ignored.
 */
export type FollowUp = {
  label: string
}

/** One completion toast (ToastStack) — session finished while away. */
export type Toast = {
  id: string
  text: string
}

export type SubagentStatus = 'started' | 'completed' | 'failed' | 'cancelled'
export type WorkflowStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'paused'

/**
 * Scrollback entry kinds — TUI RenderBlock surface + FE plan/status.
 * finishedAt (epoch ms) drives the EntryRenderer finish-flash window.
 */
export type ScrollEntry =
  | {
      id: string
      kind: 'user'
      text: string
      /** Expanded past COLLAPSED_MAX_LINES (TUI DisplayMode::Expanded). */
      expanded?: boolean
      /** Prompt send time (epoch ms) — TUI right-aligned prompt timestamp. */
      ts?: number
      /**
       * Scheduled task (/loop) fire — TUI UserPromptBlock::is_cron.
       * Renders with ↻ prefix; body is the raw prompt (system-reminder stripped).
       */
      isCron?: boolean
      /**
       * Images attached to this prompt (user-sent, echoed back via
       * user_message_chunk image blocks — merged into this row instead of
       * duplicating). `data` is a data URI.
       */
      images?: Array<{ data: string; mimeType?: string }>
    }
  | {
      id: string
      kind: 'assistant'
      text: string
      streaming?: boolean
      /** Response start time (epoch ms) — TUI right-aligned message timestamp. */
      ts?: number
      /** Images embedded in the response (agent_message_chunk image blocks). */
      images?: Array<{ data: string; mimeType?: string }>
    }
  | {
      id: string
      kind: 'image'
      /** Data URI (bare base64 is wrapped with mimeType by the store). */
      data: string
      mimeType?: string
      /** Event time (epoch ms). */
      ts?: number
    }
  | {
      id: string
      kind: 'thought'
      text: string
      /**
       * Legacy fold flag (pre-displayMode entries): `true` meant the body
       * was shown. New code writes `displayMode`; this survives only as a
       * replay-compat input (missing displayMode + open → 'expanded').
       */
      open?: boolean
      /**
       * ThinkingBlock display mode (TUI three-state): 'collapsed' = header
       * only, 'truncated' (default) = header + head/tail preview, 'expanded'
       * = full body. Missing → 'truncated' (replay compat).
       */
      displayMode?: 'collapsed' | 'truncated' | 'expanded'
      streaming?: boolean
      elapsed?: string
      startedAt?: number
      finishedAt?: number
      /**
       * Server-reported original duration (ms) from the persisted envelope
       * `_meta` (agentTimestampMs - streamStartMs) — replay only. Prefer
       * over the local `startedAt` timer when sealing so reloaded history
       * keeps the real "Thought for Xs" instead of ~0s.
       */
      elapsedMs?: number
    }
  | {
      id: string
      kind: 'tool'
      toolCallId?: string
      title: string
      verb: string
      status?: string
      kindName?: string
      detail?: string
      expanded?: boolean
      raw?: ToolCall
      /** Activity start (epoch ms) — stamped on live running tools for
       *  the turn status line's phase timer (TUI tracker started_at);
       *  replay/completed snapshots omit it. */
      startedAt?: number
      finishedAt?: number
    }
  | { id: string; kind: 'error'; text: string }
  | { id: string; kind: 'status'; text: string }
  | { id: string; kind: 'plan'; entries: unknown }
  | {
      id: string
      kind: 'subagent'
      title: string
      status: SubagentStatus
      detail?: string
      running?: boolean
      finishedAt?: number
      /** subagent_id from x.ai/session_notification subagent_spawned. */
      subagentId?: string
      /** Effective model ID used by the subagent (wire `model`). */
      model?: string
      /** Named persona applied to this subagent (wire `persona`). */
      persona?: string
      /** Role that supplied defaults (wire `role`). */
      role?: string
      /** Agent type used for the subagent (wire `subagent_type`). */
      subagentType?: string
      /** Final output text from the subagent (wire `output`, completed). */
      output?: string
      /** Error message if the subagent failed (wire `error`). */
      error?: string
      /** Number of tool calls made by the subagent (wire `tool_calls`). */
      toolCalls?: number
      /** Number of conversation turns taken (wire `turns`). */
      turns?: number
      /** Total tokens consumed by the subagent (wire `tokens_used`). */
      tokensUsed?: number
    }
  | {
      id: string
      kind: 'workflow'
      title: string
      status: WorkflowStatus
      detail?: string
      running?: boolean
      finishedAt?: number
    }
  | {
      id: string
      kind: 'bg_task'
      title: string
      status: 'started' | 'completed' | 'failed'
      detail?: string
      running?: boolean
      finishedAt?: number
      /** task_id from x.ai/task_backgrounded. */
      taskId?: string
      /** Shell command (wire `command`). */
      command?: string
      /** Absolute path to the on-disk log (wire `output_file`). */
      outputFile?: string
      /** True when the task came from a `monitor_description`/`[monitor]` (TUI Watchers group). */
      isMonitor?: boolean
      /**
       * Accumulated stdout for the block viewer (TUI BgTask viewer).
       * Filled from monitor_event, task_completed snapshot, and
       * on-demand x.ai/task/list polls.
       */
      output?: string
    }
  | {
      id: string
      kind: 'session_event'
      text: string
      recap?: boolean
      warning?: boolean
      streaming?: boolean
      open?: boolean
    }  | { id: string; kind: 'credit_limit'; text: string }
  | {
      id: string
      kind: 'group_header'
      count: number
      /** Expanded-group collapse chrome ("▾ N tool calls") vs truncation ("N more"). */
      collapse?: boolean
      label?: string
      /** Verb-run aggregated header — drives running/error accents. */
      verbRun?: { running?: boolean; failed?: boolean; verb?: string }
    }
