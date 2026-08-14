import type { HostInfo } from './sessions'
import type { HubPrefsDoc } from './core'
import type { ToolCall } from './tools'

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
      /** 生成输出速率（字符/秒）。 */
      rate?: number
      /** true = 流式期间实时值（带 rate）；false = 输出结束（不带 rate，清除显示）。 */
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
      /** 该错误的恢复动作（当前：传输级失败 → 重启 agent）。 */
      action?: 'restart-agent'
    }
  /** Host withSid 约定：广播带 sessionId（多会话过滤用）。 */
  | {
      type: 'status'
      text: string
      sessionId?: string
      /** 该状态的恢复动作（host 侧标注；如进程退出/通道损坏 → 重启 agent）。 */
      action?: 'restart-agent'
    }
  /** hub WS 连接状态（仅 hub 模式，localTransport 本地发出）。 */
  | { type: 'hub_conn'; online: boolean }
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


/** One question in an x.ai/ask_user_question request (camelCase wire). */
export type AskQuestion = {
  id?: string
  question: string
  options: Array<{ label: string; description?: string; preview?: string; id?: string }>
  multiSelect?: boolean
}

/** x.ai/ask_user_question ext request params. */


/** x.ai/ask_user_question ext request params. */
export type AskUserQuestionReq = {
  sessionId?: string
  toolCallId?: string
  mode?: 'default' | 'plan'
  questions: AskQuestion[]
}

/** x.ai/exit_plan_mode ext request params. */


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
