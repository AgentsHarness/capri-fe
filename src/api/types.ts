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

/** Per-session todo status (hub-persisted UI prefs; absence = no record). */
export type TodoStatus = 'todo' | 'completed'

/**
 * The FE's durable UI preferences for host conversations: pinned
 * workspaces (cwd paths), pinned sessions, and per-session todo status.
 * Persisted by the hub (GET/PUT /api/prefs, one shared doc in
 * prefs.json); localStorage mirrors it as the offline cache. Keys are
 * sessionId/cwd only — session ids are host-assigned UUIDs, so a doc is
 * effectively per host conversation without an explicit hostId scope.
 */
export type HubPrefsDoc = {
  pinnedWorkspaces?: string[]
  pinnedSessions?: string[]
  todos?: Record<string, TodoStatus>
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
 * (info.id / info.cwd / session_summary / last_active_at / updated_at /
 * num_messages / current_model_id) — normalized to camelCase by LocalTransport.
 */
export type WorkspaceSummary = {
  sessionId: string
  cwd: string
  /** Display title (agent-backfilled session_summary; absent for untitled
   *  sessions — the list UI shows "New Chat" + a 12-char id prefix). */
  title?: string
  /**
   * ISO activity time for display/sort (TUI: last_active_at ?? updated_at).
   * Not raw summary.updated_at — load/model metadata writes must not look
   * like new conversation activity.
   */
  updatedAt?: string
  currentModelId?: string
  /**
   * Persisted reasoning effort (agent summary `reasoning_effort`). The
   * load response models usually omit it (agent remaps the model id on
   * session/load), so this is the fallback that restores the user's
   * actual effort choice (e.g. max) instead of the mapped model's
   * default (e.g. low).
   */
  reasoningEffort?: string
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
 * One conflicted file reported by x.ai/rewind/execute (agent
 * RewindConflictInfo — snake_case `conflict_type` on the wire):
 *   modified_externally — 磁盘内容 ≠ agent 最后写入的样子（外部改动，回退已覆盖）
 *   deleted_externally  — 磁盘上文件缺失但 agent 留下过内容（外部删除，已从快照恢复）
 *   created_externally  — 磁盘存在文件但 agent 最后状态没有（外部新建，已按快照处理）
 */
export type RewindConflict = {
  path: string
  conflictType: string
}

/**
 * Successful rewind outcome details (agent RewindResponse — snake_case
 * wire: reverted_files / clean_files / conflicts / prompt_text).
 */
export type RewindExecuteResult = {
  /** 回退点原文（Composer 恢复用，见 store.rewindExecute）。 */
  promptText?: string
  /** 实际还原（写回或删除）的文件。 */
  revertedFiles?: string[]
  /** 本就干净、未被动过的文件。 */
  cleanFiles?: string[]
  /** 与外部修改冲突的文件（mode=all 时已被快照覆盖）。 */
  conflicts?: RewindConflict[]
}

/**
 * Rewind scope (POST /api/rewind-execute `mode`, TUI RewindExecute mode):
 * "conversation_only" rolls back the conversation only (TUI /rewind
 * default); "all" also reverts the point's file snapshots.
 */
export type RewindMode = 'conversation_only' | 'all'

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

/** One itemized context-usage row (skills listing, MCP server listing). */
export type ContextUsageCategory = {
  label: string
  tokens: number
  detail?: string
}

/**
 * Context usage breakdown — `x.ai/session/info` `data.context`
 * (ContextInfo, camelCase on the wire). Feeds the `/context` detail view
 * (TUI ContextInfoBlock): category bar, legend rows and the
 * auto-compact estimate.
 */
export type ContextInfoDetail = {
  used: number
  total: number
  systemPromptTokens: number
  toolDefinitionsCount: number
  toolDefinitionsTokens: number
  compactionCount: number
  turnCount: number
  toolCallCount: number
  messageCount: number
  /** Bytes/4 estimate of all non-system conversation items. */
  messageTokens: number
  freeTokens: number
  /** Pre-rounded (u8, clamped) usage percent — bar/urgency source. */
  usagePct: number
  /** Resolved auto-compact threshold (6-tier; default 85). */
  autoCompactThresholdPercent: number
  usageCategories: ContextUsageCategory[]
}

/**
 * `x.ai/session/info` response (agent-side SessionInfoResponse, camelCase,
 * `data` flattened) — the FULL session snapshot the TUI /session-info and
 * /context are built from. Distinct from the host's thinner
 * POST /api/session-info (SessionInfoDetail).
 */
export type SessionInfoExt = {
  sessionId?: string
  cwd?: string
  model?: string
  modelDisplayName?: string
  resolvedModelId?: string
  apiBackend?: string
  agentName?: string
  turns?: number
  turnIndex?: number
  context?: ContextInfoDetail
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

/**
 * One `[model.<id>]` entry from config.toml — the custom BYOK model schema
 * (mirrors the TUI's `ConfigModelOverride` in
 * xai-grok-shell/src/agent/config.rs). All fields optional except the id
 * (section key), `model` (routing slug) and `base_url`.
 */
export type CustomModelConfig = {
  /** Section key — `[model.<id>]`. Required; stable identifier. */
  id: string
  /** Routing slug sent in API requests. Required. */
  model?: string
  /** Endpoint base URL, e.g. "https://api.x.ai/v1". Required. */
  base_url?: string
  name?: string
  description?: string
  api_key?: string
  /** Env var name(s) for the provider key — string or array. */
  env_key?: string | string[]
  /** Name of a `[auth_provider.<name>]` credential helper. */
  auth_provider?: string
  model_provider?: string
  /** Base URL for API-key auth (session auth uses base_url). */
  api_base_url?: string
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  /** "chat_completions" (default), "responses", "messages". */
  api_backend?: 'chat_completions' | 'responses' | 'messages'
  context_window?: number
  /** Auto-compact threshold percent (0-100). */
  auto_compact_threshold_percent?: number
  system_prompt_label?: string
  use_concise?: boolean
  /** System-prompt identity, e.g. "grok-build". */
  agent_type?: string
  inference_idle_timeout_secs?: number
  max_retries?: number
  hidden?: boolean
  supported_in_api?: boolean
  /** none | minimal | low | medium | high | xhigh | max */
  reasoning_effort?: string
  supports_reasoning_effort?: boolean
  reasoning_efforts?: (
    | string
    | { value: string; id?: string; label?: string; description?: string; default?: boolean }
  )[]
  supports_backend_search?: boolean
  /** true/false dynamic, or fixed N. */
  compactions_remaining?: boolean | number
  compaction_at_tokens?: boolean | number
  show_model_fingerprint?: boolean
  stream_tool_calls?: boolean
  extra_headers?: Record<string, string>
  query_params?: Record<string, string>
  env_http_headers?: Record<string, string>
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
  /**
   * Owning session (host Snapshot / client_request broadcast). Clients
   * filter pending on session switch so another conversation's permission
   * / ask_user_question never lands in the active UI. Optional for old
   * hosts — FE also peeks params.sessionId / session_id as fallback.
   */
  sessionId?: string
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

/**
 * 宿主侧 /api/usage-report 的单个统计行（总计或一个模型）。字段与 agent
 * 的 usage 对象一一对应；cacheHitRate 为派生命中率（cachedRead/input，
 * 0–1）。全部 optional —— 旧宿主没有该端点时前端防御性降级。
 */
export type TokenUsageStat = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  modelCalls?: number
  /** 统计到的回合终态事件数。 */
  turns?: number
  /** 命中率 0–1（cachedReadTokens / inputTokens）。 */
  cacheHitRate?: number
}

/**
 * POST /api/usage-report 响应（宿主侧聚合，非 x.ai 直通）。from/to 为
 * 归一化后的 unix 秒窗口；total 为总计，byModel 按模型分组（无分组数据
 * 归 "unknown"）。
 */
export type UsageReportData = {
  from?: number
  to?: number
  /** 覆盖的会话数（有窗口内事件的 updates.jsonl 文件数）。 */
  sessions?: number
  total?: TokenUsageStat
  byModel?: Record<string, TokenUsageStat>
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
      /**
       * Host-recorded canonical permission mode (ask / auto /
       * always-approve) — the agent's real state at snapshot time, used
       * to restore the permission badge on connect.
       */
      permissionMode?: string
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
  | { type: 'chunk'; text: string; messageId?: string; ts?: number; sessionId?: string }
  | {
      type: 'user_chunk'
      text: string
      /** Forwarded chunk meta (update._meta): system-injected prompts are hidden. */
      hideFromScrollback?: boolean
      /** Forwarded content-block meta (content._meta): display override + cron framing. */
      displayText?: string
      displayAsCron?: boolean
      /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
      sessionId?: string
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
      /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
      sessionId?: string
    }
  /**
   * Aggregated user message (history replay or live user_chunk).
   * `isCron` matches TUI UserPromptBlock::cron (scheduled /loop fire).
   */
  | { type: 'user_message'; text: string; ts?: number; isCron?: boolean; sessionId?: string }
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
      /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
      sessionId?: string
    }
  | { type: 'tool_call'; toolCall: ToolCall; sessionId?: string }
  | { type: 'tool_call_update'; toolCallUpdate: ToolCall; sessionId?: string }
  | { type: 'plan'; entries: unknown; sessionId?: string }
  /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
  | {
      type: 'usage'
      sessionId?: string
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
  /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
  | {
      type: 'gen_rate'
      sessionId?: string
      /** 生成输出速率（估算 tok/s）。 */
      rate?: number
      /** true = 流式期间实时值；false = 工具执行/turn 结束的冻结值。 */
      active?: boolean
    }
  /**
   * Host 对所有会话广播事件按 withSid 约定附加 sessionId（done/busy/
   * cancelled/error/status/log/usage/model/models_update 均带）——多会话
   * 模式下前端据此丢弃非当前会话的事件（store 分发时按 sessionId 过滤）。
   */
  | { type: 'busy'; sessionId?: string }
  | { type: 'done'; stopReason?: string; sessionId?: string }
  | { type: 'cancelled'; sessionId?: string }
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
  /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
  | {
      type: 'error'
      message: string
      sessionId?: string
      /**
       * 回合失败来源（host bridge 标记）：'agent' = agent 回复了 JSON-RPC
       * 错误（进程活着，只是拒绝了回合）；'transport' = host↔agent 传输
       * 失败（超时/写失败，agent 可能不可达、正在被 host 重启）。缺省 =
       * 老版本 host（按 'agent' 处理）。
       */
      source?: 'agent' | 'transport'
    }
  /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
  | { type: 'status'; text: string; sessionId?: string }
  /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
  | { type: 'log'; text: string; sessionId?: string }
  | {
      type: 'client_request'
      requestId: string
      method: string
      params?: Record<string, unknown>
      /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
      sessionId?: string
    }
  /**
   * Host: a pending client_request was settled (answered / cancelled /
   * timed out). Multi-tab clients drop the matching card by requestId.
   */
  | {
      type: 'client_request_resolved'
      requestId: string
      sessionId?: string
    }
  /**
   * Host: agent session/load is about to replay the conversation over SSE
   * (shared bus). Multi-tab peers viewing this session arm historyLoading
   * so replay chunks do not append onto the existing scrollback.
   */
  | {
      type: 'session_load_started'
      sessionId?: string
      cwd?: string
    }
  /**
   * Host: session/load finished (replay stream done). Multi-tab peers
   * rebuild the timeline from HTTP history.
   */
  | {
      type: 'session_load_finished'
      sessionId?: string
      cwd?: string
      ok?: boolean
    }
  /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
  | { type: 'modes_update'; modes?: unknown; sessionId?: string }
  | { type: 'config_options_update'; configOptions?: unknown }
  | { type: 'commands_update'; commands?: unknown }
  /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
  | { type: 'session_info'; title?: string; updatedAt?: unknown; sessionId?: string }
  /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
  | {
      type: 'model'
      sessionId?: string
      modelId?: string
      modelName?: string
      reasoningEffort?: string
    }
  // ── x.ai/* extension notifications (agent → client) ────────────────
  /** Raw x.ai/session_notification / x.ai/session/update envelope.
      Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
  | {
      type: 'session_notification'
      method?: string
      params?: Record<string, unknown>
      sessionId?: string
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
      /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
      sessionId?: string
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
  /**
   * Hub-level: the shared browser prefs doc (pins / todos) was replaced
   * (acp-hub broadcasts this on every PUT /api/prefs). Browsers apply it
   * live so one end's edit syncs to every end. No hostId — applies
   * regardless of the selected host.
   */
  | { type: 'prefs_changed'; params?: { prefs?: HubPrefsDoc } }
  /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
  | { type: 'models_update'; sessionId?: string; params?: Record<string, unknown> }
  | { type: 'announcements_update'; params?: Record<string, unknown> }
  | {
      type: 'scheduled_task_created'
      sessionId?: string
      /** Host contract shape: { taskId, prompt, interval, nextFireAt }. */
      task?: Record<string, unknown>
      params?: Record<string, unknown>
      /**
       * 原始 wire 字段保全：params 原样（humanSchedule/status/enabled/
       * createdAt/lastFiredAt/timezone、_meta.eventId 等）。store 现有
       * 消费逻辑（parseScheduledTask）只读 taskId/prompt/interval/
       * nextFireAt，无需改动。
       */
      rawParams?: Record<string, unknown>
      /** 原始 task/update 对象（created 才有）。 */
      rawTask?: Record<string, unknown>
      /** params._meta（如 x.ai/schedulerGeneration/Revision）。 */
      meta?: Record<string, unknown>
    }
  | {
      type: 'scheduled_task_deleted'
      sessionId?: string
      taskId?: string
      params?: Record<string, unknown>
      /**
       * 原始 wire 字段保全：params 原样（humanSchedule/status/enabled/
       * createdAt/lastFiredAt/timezone、_meta.eventId 等）。
       */
      rawParams?: Record<string, unknown>
      /** params._meta（如 x.ai/schedulerGeneration/Revision）。 */
      meta?: Record<string, unknown>
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
  | {
      type: 'prompt_complete'
      params?: Record<string, unknown>
      /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
      sessionId?: string
    }
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

/**
 * GET /api/status 响应（acp-host Status struct 镜像）。字段全 optional：
 * ready/busy/booting/sessionId/cwd/hostId/hostName/homeDir/agentInfo/
 * agentCapabilities/authMeta/modes/configOptions/sessionMeta/models/
 * bootError/text/pendingRequests/capabilities/roster/agentStartedAt。
 * pendingRequests 复用 PendingReq[]，其余以 unknown 兜底（host 结构随
 * 版本演进，前端按需收紧）。
 */
export type HostStatus = {
  ready?: boolean
  busy?: boolean
  booting?: boolean
  sessionId?: string
  /** 活动会话工作区。 */
  cwd?: string
  hostId?: string
  hostName?: string
  /** 用户主目录。 */
  homeDir?: string
  agentInfo?: unknown
  agentCapabilities?: unknown
  authMeta?: unknown
  modes?: unknown
  configOptions?: unknown
  sessionMeta?: unknown
  models?: unknown
  /** 启动失败错误信息。 */
  bootError?: string
  /**
   * 启动失败错误信息（旧 host 版本以 `error` 字段返回——chat.ts 的
   * hello 快照归一化路径同时读 bootError/error）。
   */
  error?: string
  text?: string
  /** 挂起的客户端请求（x.ai/* 与权限请求）。 */
  pendingRequests?: PendingReq[]
  capabilities?: unknown
  /** 各会话实时状态（SessionState[]）。 */
  roster?: unknown
  /** 当前 agent 进程启动时间戳（Unix ms）。 */
  agentStartedAt?: number
  /** host 记录的 agent 权威权限模式（ask / auto / always-approve）。 */
  permissionMode?: string
}

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
      /**
       * Additional EditFile calls merged into this row (TUI
       * collapsed_edit_blocks=true merges back-to-back same-file edits).
       * The renderer shows the combined diffstat and each diff body.
       */
      mergedRaws?: ToolCall[]
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
      /** Spawn wall-clock (epoch ms) — FE-local; live elapsed falls back
       *  to the wire `duration_ms` when absent (TUI display_elapsed:
       *  finished → duration_ms, running → started_at.elapsed()). */
      startedAt?: number
      /** Authoritative wall-clock duration (wire `duration_ms`, progress
       *  ticks + finish). */
      durationMs?: number
      /** subagent_id from x.ai/session_notification subagent_spawned. */
      subagentId?: string
      /**
       * The subagent's own session id (wire `child_session_id` from
       * subagent_spawned). The host broadcasts EVERY session's event
       * stream with a top-level sessionId — the child session's
       * chunk/thought/tool_call/… events carry this id, which the store
       * routes into the subagent's mini scrollback (block viewer
       * timeline, TUI subagent_views 同款)。
       */
      childSessionId?: string
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
      /** Context window capacity (wire `context_window_tokens`, progress). */
      contextWindowTokens?: number
      /** Context window usage 0–100 (wire `context_usage_pct`, progress). */
      contextUsagePct?: number
      /** Distinct tool names called so far (wire `tools_used`, progress). */
      toolsUsed?: string[]
      /** Errors encountered so far (wire `error_count`, progress). */
      errorCount?: number
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

/**
 * Mini scrollback of one subagent session (keyed by child_session_id).
 * Fed by the host's broadcast of the child session's own event stream
 * (live) and by on-demand history fetch of the child session's updates
 * (replay — TUI replay_inherited_updates 同款). No item cap — older
 * history is paged in on scroll-up.
 *
 * items 直接复用主 scrollback 的 ScrollEntry 模型——BlockViewer 的迷你
 * 时间线与主 scrollback 走同一条渲染管线（scanGroups/projectDisplayRows
 * → EntryShell/GroupHeaderView + AccentRail/Bullet），不再另设一套条目
 * 类型和样式。
 */
export type SubagentViewState = {
  items: ScrollEntry[]
  /**
   * On-demand fetch of the child session's stored updates:
   * idle → loading → loaded (loaded also on failure — no retry storm).
   */
  fetchState?: 'idle' | 'loading' | 'loaded'
  /**
   * 已回放的事件条数（宿主包络条数语义）——负 offset 分页游标，与主
   * scrollback 的 historyLoadedCount 同款。0 = 从未回放过（纯 live 捕获，
   * 不提供上滑分页，避免与 live 事件重复）。
   */
  loadedCount?: number
  /**
   * 宿主侧会话事件总数（session-updates 的 totalCount）；缺失时按
   * loadedCount 兜底 → 拉完一页即认为无更多。
   */
  totalCount?: number
}

/**
 * Host-side live state of one session — POST /api/session-state
 * (host's acp.SessionState, camelCase serialization). The host tracks
 * Busy (in-flight turn) + AwaitingInput (permission / x.ai question
 * pending) and derives the dashboard classification; `state` is not
 * serialized by the host — the transport derives it from busy +
 * awaitingInput (kept optional for hosts that do ship it).
 */
export type SessionState = {
  sessionId: string
  cwd?: string
  title?: string
  updatedAt?: string
  busy: boolean
  awaitingInput: boolean
  lastActiveAt?: number
  createdAt?: number
  /** Dashboard classification: active / awaiting / idle. */
  state?: 'active' | 'awaiting' | 'idle'
}

/** One branch row of x.ai/git/branches (rpc/git.rs GitBranch, camelCase). */
export type GitBranch = {
  name: string
  /** Whether this branch is the current HEAD (wire `current`). */
  current?: boolean
  upstream?: string
  commit?: string
}

/** x.ai/git/branches response (rpc/git.rs GitBranchesData, camelCase). */
export type GitBranchesData = {
  branches: GitBranch[]
}

/**
 * One agent skill row from x.ai/skills/list (camelCase; the agent
 * registry carries a live `enabled` state — the host-side
 * GET /api/extensions scan does not). Parsed defensively.
 */
export type AgentSkill = {
  name: string
  enabled?: boolean
  scope?: string
  description?: string
}

/**
 * x.ai/session/usage result — the agent's session token usage
 * (camelCase wire; snake_case accepted). All fields optional — the
 * exact payload varies by agent version; the UI degrades when absent.
 */
export type SessionUsageData = {
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  /** Context window size when the agent reports it. */
  contextSize?: number
  [k: string]: unknown
}
