import type { ToolCall } from './tools'

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
       * Shell-mode submission (Composer `!` 直执行 / send 的 fromShell)：
       * 行首用 TUI 的 `$ ` 前缀、等宽字体渲染，且回合收口不追加
       * "Worked for X" 标记。
       *
       * 之前这个字段只是各处 `as { isShell?: boolean }` 断言出来的隐式
       * 属性（写在 send.ts / appendLocalEntry，读在 UserEntry /
       * StickyPrompt / finalizeTurn）——类型上不存在的字段对重构不可见。
       */
      isShell?: boolean
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
  | {
      id: string
      kind: 'error'
      text: string
      /** 可执行的恢复动作（当前：传输级错误 → 重启 agent）。 */
      action?: 'restart-agent'
    }
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


export type SubagentStatus = 'started' | 'completed' | 'failed' | 'cancelled'

export type WorkflowStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'paused'

/**
 * Scrollback entry kinds — TUI RenderBlock surface + FE plan/status.
 * finishedAt (epoch ms) drives the EntryRenderer finish-flash window.
 */
