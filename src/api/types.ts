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
}

export type SessionInfo = {
  sessionId: string
  cwd?: string
  title?: string
  updatedAt?: string
  meta?: unknown
}

export type PendingReq = {
  requestId: string
  method: string
  params?: Record<string, unknown>
}

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
      text?: string
      error?: string
      hostId?: string
      hostName?: string
      agentInfo?: unknown
      modes?: unknown
      pendingRequests?: PendingReq[]
      capabilities?: unknown
    }
  | {
      type: 'ready'
      sessionId?: string
      hostId?: string
      hostName?: string
      agentInfo?: unknown
      modes?: unknown
    }
  | { type: 'chunk'; text: string; messageId?: string }
  | { type: 'user_chunk'; text: string }
  /** Aggregated user message replayed from session history. */
  | { type: 'user_message'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_call_update'; toolCallUpdate: ToolCall }
  | { type: 'plan'; entries: unknown }
  | { type: 'usage'; used?: number; size?: number; cost?: unknown }
  | { type: 'busy' }
  | { type: 'done'; stopReason?: string }
  | { type: 'cancelled' }
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
  | { type: 'sessions_changed'; params?: Record<string, unknown> }
  | { type: 'models_update'; params?: Record<string, unknown> }
  | { type: 'announcements_update'; params?: Record<string, unknown> }
  | { type: 'scheduled_task_fired'; params?: Record<string, unknown> }
  | { type: 'scheduled_task_inject_prompt'; params?: Record<string, unknown> }
  | { type: 'prompt_complete'; params?: Record<string, unknown> }
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
    }
  | { id: string; kind: 'assistant'; text: string; streaming?: boolean }
  | {
      id: string
      kind: 'thought'
      text: string
      open?: boolean
      streaming?: boolean
      elapsed?: string
      startedAt?: number
      finishedAt?: number
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
    }
  | {
      id: string
      kind: 'session_event'
      text: string
      recap?: boolean
      warning?: boolean
      streaming?: boolean
      open?: boolean
    }
  | { id: string; kind: 'credit_limit'; text: string }
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
