
export type HostInfo = {
  hostId: string
  hostName: string
  online: boolean
  ready?: boolean
  /** Hub registry realtime flag: any session has a turn in flight. */
  busy?: boolean
  /** Hub registry realtime flag: agent process has not finished booting. */
  booting?: boolean
  /** Hub registry realtime count: pending client requests (permits / questions). */
  pendingCount?: number
  local?: boolean
  /** Hub registry liveness timestamp (hub mode). */
  lastSeen?: string
}

/** Per-session todo status (hub-persisted UI prefs; absence = no record). */


export type SessionInfo = {
  sessionId: string
  cwd?: string
  title?: string
  updatedAt?: string
  meta?: unknown
  /**
   * Host-side live state (multi-session dashboard): derived by capri-host
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
   * 最后一轮动作摘要（agent 生成，wire `last_turn_summary`）——副行
   * 显示用：比整场会话标题（title）具体，是"上次干了什么"的即时代
   * 摘要。agent 未生成时缺失（副行不显示，不降级为时间）。
   */
  lastTurnSummary?: string
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


/**
 * Successful rewind outcome details (agent RewindResponse — snake_case
 * wire: reverted_files / clean_files / conflicts / prompt_text).
 */
export type RewindExecuteResult = {
  /**
   * 回退目标轮次（agent RewindResponse.target_prompt_index：保留
   * 0..=target-1 轮）。前端用它做本地即时截断（TUI dispatch_rewind_success
   * 同款），不依赖 updates.jsonl 的 rewind_marker 异步落盘。
   */
  targetPromptIndex?: number
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


/**
 * POST /api/session-stats response `stats` — 单会话聚合统计（composer
 * 状态条数据源；host 侧扫描 updates.jsonl，见 capri-host
 * bridge_ext_stats.go）。耗时类字段（toolDurationMs / firstTokenAvgMs /
 * tokensPerSec）在老数据（无 _meta 毫秒时间戳）时省略，UI 显示 '—'；
 * 会话无历史时为全零。
 */
export type SessionStats = {
  /** 回合数（user_message_chunk 去重计数）。 */
  turns: number
  /** 步数（tool_call 事件数）。 */
  steps: number
  /** LLM API 总耗时（ms，Σ usage.apiDurationMs，agent 权威值）。 */
  llmDurationMs: number
  /** 工具调用总耗时（ms，completed result − call 的 agentTimestampMs）。 */
  toolDurationMs?: number
  /** 首 token 平均延迟（ms，本回合第一条流的 streamStartMs − 用户发出）。 */
  firstTokenAvgMs?: number
  /**
   * 吞吐（tok/s = outputTokens / Σ(末包 − streamStart) × 1000）。
   * 无生成窗口时回退 llmDurationMs。
   */
  tokensPerSec?: number
  /** 缓存命中率 0–1（cachedReadTokens / inputTokens）。 */
  cacheHitRate: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedReadTokens: number
  modelCalls: number
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
  /** Model checkpoint fingerprint (TUI "Model Hash" row). */
  modelFingerprint?: string
  /** Catalog opt-in — governs both Model Hash display and resolved-id exposure. */
  showModelFingerprint?: boolean
  apiBackend?: string
  /** Gateway chat conversation id（gateway 代理会话才有，TUI "Conversation ID" 行）。 */
  conversationId?: string
  agentName?: string
  turns?: number
  turnIndex?: number
  context?: ContextInfoDetail
}

/** One effort row from model `_meta.reasoningEfforts` (or built-in fallback). */


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
