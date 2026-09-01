import type {
  AcpEvent,
  AgentCommand,
  ContentBlock,
  FollowUp,
  HostInfo,
  ModelOption,
  PendingReq,
  PermissionScope,
  RewindExecuteResult,
  RewindMode,
  RewindPoint,
  ScheduledTask,
  ScrollEntry,
  SessionHistoryProjected,
  SessionInfo,
  SubagentStatus,
  SubagentViewState,
  TopTask,
  WorkspaceGroup,
} from '../../api/types'
import type { McpListServer } from '../../api/client'
import type {
  PendingStopHooks,
  PendingToolHook,
} from './hookAttach'

import type {
  ConnState,
  ExtensionsTab,
  FileSearchState,
  FocusMode,
  McpInitProgress,
  McpServerInfo,
  TodoCounts,
  TodoItem,
  ViewerTask,
  WorkflowRun,
} from './typesPublic'

export type {
  ConnState,
  ExtensionsTab,
  FileSearchState,
  FileSearchMatch,
  FocusMode,
  McpInitProgress,
  McpServerInfo,
  TodoCounts,
  TodoItem,
  ViewerTask,
  WorkflowRun,
} from './typesPublic'

/**
 * forkSession 选项：
 * - targetPromptIndex — 按轮截断（agent ForkSessionRequest.target_prompt_index，
 *   0-based 含端点：副本保留第 0..=k 轮）。缺省 = 完整副本。
 * - worktree — TUI /fork --worktree：经 x.ai/git/worktree/resume_session 在
 *   新 git worktree 中派生（全量历史，无截断）。
 */
export type ForkSessionOpts = {
  targetPromptIndex?: number
  worktree?: boolean
}

/**
 * 一条分层错误（hub / host 层横幅数据源）。
 * - id：恢复事件精确清除用（如 hub-ws 重连成功只清该条）；缺省按层整体覆盖。
 * - action：横幅可执行的恢复动作（当前仅重启 agent）。
 */
export type LayerErr = {
  id?: string
  level: 'error' | 'warning'
  message: string
  action?: 'restart-agent'
  at: number
}

// ── ChatState 域拆分 ──────────────────────────────────────────────────
// ChatState 不再是单一大接口：字段按域拆成下面的 10 个接口，再用交集
// 组合（结构等价于原单接口，运行时零变化）。域与 store/chat 的切片模块
// 对应（见 barrel chat.ts 注释）：
//   ChatConnState        conn/events/conn、actions/hosts —— 连接与 host
//   ChatTimelineState    stream、entries、tools —— 滚动区时间线与流式
//   ChatHistoryState     loadHistory/loadMoreHistory/historyPage —— 会话列表与历史分页
//   ChatTurnState        turn/turnLifecycle/turnStatus —— 回合生命周期与统计
//   ChatModeState        modeFlags/modeApply/modePersist、actions/cancel —— 权限/模式/取消
//   ChatAgentExtState    events/ext*、subagent*、tasks —— x.ai/* 扩展状态
//   ChatMcpState         tools、events（mcp 状态）—— MCP
//   ChatGoalWorkflowState actions/goal —— 目标与工作流
//   ChatUiState          actions/viewer*、各 modal 可见性 —— 视图与面板
//   ChatActions          actions/*、send、sessionLoad —— 动作入口
// 新增字段先找域再落位；一个字段只属于一个域（跨域读写照旧允许——
// set/get 仍是整店视角——但声明归属让切片的读写范围在类型上可查）。

/** 连接与 host：连接状态、hub/local 模式、host 注册表、当前会话身份、分层错误。 */
export interface ChatConnState {
  conn: ConnState
  statusText: string
  /** 连接模式：local（本机 capri-host，锁定本机，无 host 切换）/ hub（跨源 hub，可切换 host）。 */
  mode: 'local' | 'hub'
  hostId?: string
  hostName?: string
  hosts: HostInfo[]
  /** Selected host (hub mode): API calls + event filtering target. */
  selectedHostId?: string
  sessionId?: string
  /** Active session workspace dir (hello/ready; TUI status-bar path). */
  cwd?: string
  /** Host user home dir — for "~/…" path shortening. */
  homeDir?: string
  /** Session title (top prompt border caption). */
  sessionTitle?: string
  /**
   * 分层错误栈：hub（中继/配对/token/离线）与 host（进程/boot/通道）
   * 各最多一条，同层新错误覆盖旧的；agent 回合级错误不进这里（它是
   * 会话时间线的一部分，由 scrollback 错误行承担）。横幅（ErrorBanner）
   * 从两层中选一条展示；恢复事件（ready/busy/新回合/重连成功）按层
   * 清除。error > warning，同级取 at 较新。
   */
  layerErrors: { hub?: LayerErr; host?: LayerErr }
  /** 写入/清除某一层的错误（undefined = 清除该层）。 */
  setLayerError: (layer: 'hub' | 'host', err: LayerErr | undefined) => void
}

/** 时间线与流式：滚动区条目、流式缓冲指针、乐观插入的用户行。 */
export interface ChatTimelineState {
  entries: ScrollEntry[]
  toolIndex: Record<string, string> // toolCallId -> entry id
  /**
   * Tool-hook batches (`pre_tool_use` / `post_tool_use`) whose tool row has
   * not been created yet. The wire announces the hook before the `tool_call`
   * envelope, so the batch waits here and is claimed by the row that matches
   * its `tool_name`. Cleared with the turn.
   */
  pendingToolHooks: PendingToolHook[]
  /**
   * Turn-end (`stop` family) batches held for the turn's terminal marker —
   * they arrive while the turn is still open, so the marker line folds them in
   * (`stop  [hooks: 2]`) instead of getting a row of their own. TUI
   * `AgentView::pending_stop_hooks`.
   */
  pendingStopHooks?: PendingStopHooks
  // streaming pointers
  openAssistantId?: string
  openThoughtId?: string
  /** Agent-side stream identity shared by interleaved assistant/thought chunks. */
  currentStreamStartMs?: number
  /**
   * Live streaming text, kept OUT of `entries`.
   *
   * Pipeline: SSE → streamBuf (rAF) → liveStream → flushLiveStream → entry.text
   *
   * Invariant (thought + assistant): during streaming, sealed base text
   * in the entry is empty (or only previously sealed content if resuming).
   * ALL in-flight stream text lives here. First chunk creates the entry
   * with `text: ''` + `streaming: true` and seeds liveStream; later chunks
   * append via rAF into liveStream only. Flushed into the entry
   * (entry.text += liveStream.text) at seal / turn end; consumers that
   * render entry text (Scrollback, BlockViewer) use `liveText ?? e.text`
   * while the entry is streaming.
   */
  liveStream: { entryId: string; text: string; elapsedMs?: number } | null
  /**
   * User row id inserted optimistically by send(). Live user_chunk echoes
   * absorb into this row instead of appending a second UserPromptBlock.
   */
  pendingOptimisticUserId?: string
  /**
   * id of the user row created by the most recent send() — page_flip_on_send
   * (Scrollback) scrolls this row to the top of the viewport.
   */
  lastSentPromptId?: string
}

/** 会话列表与历史分页：workspace 摘要、历史时间线分页游标、空状态工作目录。 */
export interface ChatHistoryState {
  /** Historical sessions for the history picker (from session/list). */
  sessions: SessionInfo[]
  /** Session summaries bucketed by workspace（workspace-list-recent，按需分页加载）。 */
  workspaces: WorkspaceGroup[]
  workspaceLoading: boolean
  /** recent 分页：当前已请求的 limit（初始 50，「加载更多」每次 +50）。 */
  workspaceRecentLimit: number
  /** 会话列表底部「加载更多」请求中（按钮转圈）。 */
  workspaceRecentLoadingMore: boolean
  /** 是否还有更早的会话：首屏/切回按 count>0 乐观置位，「加载更多」按翻页后总数是否增长终止（count 受隐藏会话过滤，不能当判定依据）。 */
  workspaceRecentHasMore: boolean
  /**
   * 会话列表展示模式：recent = workspace-list-recent 分页（底部
   * 「已加载最近 N 条 + 加载更多」）；full = 全量 workspace-list
   * （底部「已加载全部」）。用户切换会持久化到 localStorage
   * （capri-fe-workspace-mode），下次启动按记忆的偏好加载；recent
   * 端点不可用时的降级展示也是 full（但不改写偏好）。
   */
  workspaceListMode: 'recent' | 'full'
  historyOpen: boolean
  historyLoading: boolean
  /** Bumped when a history load finishes; Scrollback re-follows the bottom. */
  historyLoadedAt?: number
  /** Active history timeline (scroll-up pagination state). */
  historySessionId?: string
  historyCwd?: string
  historyTotalCount?: number
  /**
   * 已加载包络条数（展示/兼容）。权威游标是 historyLoadedStart：
   * 已加载区 = [historyLoadedStart, totalCount)（live 追加不改 start）。
   */
  historyLoadedCount: number
  /**
   * 已加载区在 live timeline 上的最老行号（绝对下标，含）。
   * 分页一律用绝对 offset，禁止用「从尾部倒数 loaded 条」换算负 offset——
   * live 追加会抬高 totalCount，负 offset 会整窗前移，与已加载区重叠、
   * 同一轮条目重复出现。undefined = 尚未成功加载过。
   */
  historyLoadedStart?: number
  historyHasMore: boolean
  historyLoadingMore: boolean
  /** 加载更早历史失败的原因（按钮上就地显示；下次分页时清除）。 */
  historyLoadError?: string
  /** Bumped when an older page is prepended; Scrollback restores position. */
  historyPrependedAt?: number
  historyAnchorId?: string
  /**
   * 按轮次加载：宿主返回的全部 user 轮次起始行号（live timeline 绝对下标）。
   * 首页只拉最后 1 轮；loadMoreHistory 按「轮次窗口」往前一次一轮。
   * 缺失（旧宿主）时退化为按条数绝对 offset 分页。每次分页响应会刷新。
   */
  historyPromptStarts?: number[]
  /** historyPromptStarts 中「最老已加载轮次」的下标；每往前加载一轮减 1；0 = 无更早轮次。 */
  historyTurnIdx: number
  /**
   * 最新一页的 host 投影回显（契约 [B]）：'lite' = 本页工具正文被裁（条目
   * 带 liteOmitted，展开时按需补全）；undefined = 本页是全量（开关关闭 /
   * 旧 host / 无可裁内容）。
   */
  historyProjected?: SessionHistoryProjected
  /** 本页被裁掉的总字节数（projected 生效时带）。 */
  historyOmittedBytes?: number
  /**
   * 在途的后台正文补全请求数（TopBar 的 lite 进度图标用）。每个请求落地时
   * 自减，切会话时由 loadHistory 归零。
   */
  liteFillBusy?: number
  /**
   * 空状态（无活动会话）时用户选/输入的工作目录；发送消息时用它
   * 创建新会话（空串 = 宿主默认目录）。resetSessionState 清空。
   */
  emptyCwd?: string
  /**
   * 按 host 记忆空状态工作目录：`emptyCwd` 是"当前 host"的取值，
   * 切换 host 时从这里取该 host 自己的目录，绝不沿用别的 host 的路径
   * （同一路径在不同 host 上是不同的文件系统）。
   */
  emptyCwdByHost?: Record<string, string>
}

/** 回合生命周期与统计：当前/上一回合锚点、速率、recap、token 用量。 */
export interface ChatTurnState {
  /** Turn start (epoch ms) for the TUI "Worked for Xs" completion marker. */
  turnStartedAt?: number
  /**
   * 当前 live 回合的权威 prompt id（agent 侧 `_meta.promptId`）。send() /
   * adoptTurn() 锚定时记录（send 顺带 mint 一个走 wire，agent 在
   * PromptResponse 与每个 SessionNotification 的 `_meta` 上回显）；
   * 回合收口/取消/错误时随 turnStartedAt 一起清空。终端事件（done /
   * prompt_complete / live turn_completed）带非空 pid 且与它不符 →
   * 上一个回合的迟到/错标广播（RPC 与 live 通道乱序、hub 缓冲重放、
   * 队列收养窗口），必须忽略——否则会把刚锚定的新回合立即收口、
   * 渲染 "Worked for 0.0s" 之类的假标记（TUI finalize_turn_from_terminal
   * 的 exact-pid 匹配同款）。无 pid（旧 shell）→ 退回 legacy 行为。
   */
  currentPromptId?: string
  /**
   * Identity of the most recently completed turn. It remains after history
   * resume even when the UI status rail is reset to idle, so a late agent
   * chunk cannot reopen the closed turn before the next user prompt.
   */
  lastCompletedTurn?: {
    turnStartMs?: number
    streamStartMs?: number
    endMs?: number
  }
  /**
   * 生成输出速率（字符/秒）——host 流式期间推送 gen_rate 事件实时更新；
   * 输出结束（工具执行/turn 结束）推送 active:false 清除（只在输出过程
   * 中显示，无回合末冻结值）；新一轮发送清空（host 在 user_message_chunk
   * 时静默复位，不发事件）。
   */
  genRate?: number
  /**
   * True after a turn finishes until the next send — UI shows blue "待处理"
   * (session is idle and waiting for the next user prompt).
   */
  awaitingNext: boolean
  /**
   * /recap 已发出、等待 session_recap 返回。记录发起会话的 id——只有
   * 该会话处于活动状态时才显示等待指示（切换会话后不残留），事件
   * 返回/失败/会话复位时清空。
   */
  recapPendingFor?: string
  /**
   * 按会话缓存最近一次 recap 摘要：recap 事件是 display-only、不进
   * 持久化历史，跨会话期间到达的摘要若直接进当前滚动区会污染视图、
   * 切回原会话时又因 loadHistory 重建而丢失——这里按会话存，切回时
   * 按生成时间就近回填（覆盖写，只留最新）。回填前检查滚动区是否
   * 已有同文本条目，保证同一视图内不重复；每次重建后都会重新回填。
   */
  recapCache: Record<string, { text: string; at: number }>
  usage?: { used?: number; size?: number }
  /**
   * 当前会话的聚合统计（POST /api/session-stats 响应；composer 状态条
   * 数据源）。会话切换/回合终态后刷新；无会话或失败为 undefined。
   */
  sessionStats?: import('../../api/types').SessionStats
}

/** 权限与模式：待审批请求、yolo/auto/plan 模式、取消回合面板与偏好。 */
export interface ChatModeState {
  pending: PendingReq[]
  modes?: unknown
  /** Permission mode from x.ai/yolo_mode_changed (TUI permission banner). */
  permissionMode?: string
  yoloMode?: boolean
  autoMode?: boolean
  /**
   * Local plan-mode flag (Shift+Tab cycle / /plan). Driven by the host's
   * toggle-plan-mode result when available; otherwise kept local and
   * nudged by yolo_mode_changed / modes_update payloads.
   */
  planMode: boolean
  /** /plan — enter plan mode only (no-op while already in plan). */
  togglePlanMode: () => Promise<void>
  /** Shift+Tab mode cycle: Normal → Plan → Auto → Always-approve → Normal. */
  cycleMode: () => Promise<void>
  /** /auto — toggle auto permission mode (normal ↔ auto, plan ↔ plan·auto). */
  setAutoMode: () => Promise<void>
  /** /always — toggle always-approve (normal ↔ always, plan ↔ plan·always). */
  setAlwaysApproveMode: () => Promise<void>
  /** POST /api/permissions-reset — forget remembered permission rules. */
  resetPermissions: () => Promise<void>
  /** Transient "Switched to mode: X" banner (TUI notices.rs mode_switch_banner). */
  modeBanner: string | null
  showModeBanner: (text: string) => void
  clearModeBanner: () => void
  /**
   * Cancel-turn panel (TUI CancelTurnPanel): Esc / [stop] while busy opens
   * it instead of cancelling immediately — only when the current turn has
   * running subagents AND no saved preference (see cancelSubagentsPref).
   * While open it owns the keyboard (1-4 / ↑↓ / Enter confirm, Esc =
   * keep running, Ctrl+C = direct cancel).
   */
  cancelPanelOpen: boolean
  openCancelPanel: () => void
  closeCancelPanel: () => void
  /**
   * Saved cancel-turn preference (TUI `cancel_subagents_on_turn_cancel`):
   * true = cancel running subagents with the turn, false = keep them
   * running, null = ask via the panel (only when subagents are running).
   * With a saved preference the panel never opens — Esc / [stop] act
   * directly per it. Persisted to localStorage acpfe.cancelSubagentsOnTurnCancel.
   */
  cancelSubagentsPref: boolean | null
  setCancelSubagentsPref: (stop: boolean) => void
  /** True when at least one subagent of the current turn is still running
   *  (scrollback `subagent` entries via subagentIndex; TUI subagent_sessions). */
  hasRunningSubagent: () => boolean
  /**
   * Esc / [stop] flow (TUI dispatch_cancel_turn): saved preference → cancel
   * per it; no preference + running subagents → open the cancel panel;
   * otherwise cancel the turn directly (nothing to prompt about).
   */
  requestCancelTurn: () => Promise<void>
  /** Cancel the running turn — cancel panel options 1 / 3 / 4 (+ Ctrl+C). */
  cancelTurn: (opts?: {
    /** Also cancel every running subagent (panel "Stop running" / "Always stop"). */
    cancelSubagents?: boolean
    /** Legacy: additionally kill every running bg_task (incl. top strip). */
    stopTasks?: boolean
    /** Empty the composer send queue. */
    clearQueue?: boolean
  }) => Promise<void>
}

/** x.ai/* 扩展状态：转发请求、subagent / 后台任务索引、followUps、模型目录、git 信息。 */
export interface ChatAgentExtState {
  // ── x.ai/* extension state ────────────────────────────────────────
  /** Forwarded agent → client x.ai/* requests (ask_user_question, exit_plan_mode…). */
  xaiRequests: PendingReq[]
  /** subagent_id → entry id (session_notification subagent_spawned/finished). */
  subagentIndex: Record<string, string>
  /**
   * Orphaned subagent_finished payloads that replayed BEFORE their
   * subagent_spawned (history loads newest page first; spawn and finish
   * can straddle a page boundary). Applied when the spawn arrives, so a
   * replayed subagent keeps its real status/duration/output instead of
   * staying "running" forever. Live finishes never orphan (spawn always
   * precedes finish in real time).
   */
  pendingSubagentFinishes: Record<
    string,
    {
      status: SubagentStatus
      durationMs?: number
      output?: string
      error?: string
      toolCalls?: number
      turns?: number
      tokensUsed?: number
    }
  >
  /**
   * child_session_id → entry id (subagent_spawned wire `child_session_id`).
   * The host broadcasts every session's event stream with a top-level
   * sessionId; the init onEvent guard uses this index to route a KNOWN
   * subagent session's events into its mini scrollback instead of
   * dropping them (TUI subagent_views 路由同款).
   */
  subagentChildIndex: Record<string, string>
  /**
   * Mini scrollbacks of subagent sessions, keyed by child_session_id
   * (block viewer 活动时间线). Fed by the child session's own event
   * stream (live) and by on-demand history fetch (replay). Same
   * lifecycle as subagentIndex / pendingSubagentFinishes.
   */
  subagentViews: Record<string, SubagentViewState>
  /** task_id → entry id (task_backgrounded / task_completed). */
  bgTaskIndex: Record<string, string>
  /**
   * Restored running tasks (host liveness probe at session resume) —
   * rendered ONLY in the top task strip; deliberately NOT scrollback
   * entries. Maintained by live events (completion / new backgrounded)
   * AND a periodic probe (startTopTaskPolling) so TUI-owned tasks, which
   * emit no events to this host, also converge (drop dead / pick up new).
   */
  topTasks: TopTask[]
  /**
   * Sessions that finished a turn while the user was elsewhere
   * (sessionId → completion epoch ms). Drives the sidebar ✓ badge and
   * the completion notification; cleared when the session is opened.
   */
  completedNotices: Record<string, number>
  /** Mark a session's completion notice as seen (opened/being viewed). */
  clearCompletedNotice: (sessionId: string) => void
  /** Record a different session's turn completion: ✓ badge + notify. */
  noteSessionCompleted: (sessionId: string) => void
  /**
   * Scheduled tasks (/loop) of the active session — TUI tasks pane
   * "调度任务" section. Fed by scheduled_task_created / fired / deleted
   * (both the session_notification tag carrier and standalone SSE events;
   * upserted by taskId so the dual paths dedupe). Cleared on session
   * switch / new session.
   */
  scheduledTasks: ScheduledTask[]
  /**
   * Turn-end suggestion chips (`x.ai/follow_ups`) — TUI FollowUps state.
   * Rendered by the Composer above the input, never as scrollback rows
   * (the TUI shows them as a transient row between the scrollback and
   * the prompt). Cleared on user send and on session resets; hidden
   * while a turn is in flight.
   */
  followUps?: FollowUp[]
  /**
   * Newest-wins key of the shown chips (TUI FollowUps.response_id): a
   * delivery with the same id as the current one is an idempotent
   * re-delivery, a newer id replaces.
   */
  followUpsResponseId?: string
  /**
   * Slash commands advertised by the agent (ACP `available_commands_update`
   * → host `commands_update`). The slash menu merges them after the local
   * registry (local names win on collision); invoking one sends the raw
   * `/name args` line as a user message (TUI PassThrough semantics).
   */
  agentCommands: AgentCommand[]
  /** Git head from x.ai/git_head_changed (TUI status-bar branch). */
  gitInfo?: { branch?: string | null; isWorktree?: boolean; mainRepo?: string | null }
  // ── model catalog (agentInfo._meta.modelState.availableModels) ─────
  models: ModelOption[]
  /** Current model label for prompt info line (TUI model_name). */
  modelName?: string
  /** Reasoning effort suffix, e.g. "high". */
  reasoningEffort?: string
  /** Memory files from memory_files (TUI memory modal). */
  memoryFiles?: { name: string; path?: string; size?: number; updatedAt?: unknown; source?: string }[]
  /** Todo counts from plan updates (TUI status-bar todo badge). */
  todoCounts?: TodoCounts
  /** Todo items from plan updates (clickable badge panel). */
  todos?: TodoItem[]
}

/** MCP：server 状态、init 进度与管理端点动作。 */
export interface ChatMcpState {
  /** MCP server statuses from x.ai/mcp/server_status (TUI MCP panel). */
  mcpServers: McpServerInfo[]
  /** Bumped on mcp tools_changed / servers_updated so panels can refresh. */
  mcpVersion: number
  /**
   * MCP init progress (x.ai/mcp/init_progress → mcp_init_progress) — the
   * aggregate connected/total counts the TUI status bar shows as
   * `MCP (connected/total)` while initializing. Undefined = no init in
   * flight. Reset on session switches, replaced on every progress event.
   */
  mcpInit?: McpInitProgress
  // ── MCP management (TUI /mcps modal; host endpoints may be unsupported —
  //    every method rethrows so the panel renders the failure inline) ──
  /** GET /api/mcp/list — configured servers (host reads config.toml). */
  mcpList: () => Promise<McpListServer[]>
  /** POST /api/mcp-toggle — enable/disable a server. */
  mcpToggle: (name: string, enabled: boolean) => Promise<void>
  /** POST /api/mcp-toggle-tool — enable/disable one tool of a server. */
  mcpToggleTool: (serverName: string, toolName: string, enabled: boolean) => Promise<void>
  /** POST /api/mcp-add — add a stdio server. */
  mcpAdd: (server: {
    name: string
    command: string
    args?: string[]
    env?: Record<string, string>
  }) => Promise<void>
  /** POST /api/mcp-remove — remove a server. */
  mcpRemove: (name: string) => Promise<void>
  /** POST /api/mcp-auth-trigger — OAuth trigger; returns url/code when offered. */
  mcpAuthTrigger: (name: string) => Promise<{ url?: string; code?: string; message?: string }>
}

/** 目标与工作流：goal 跟踪状态与 /workflows 运行面板（控制端点在 host 侧）。 */
export interface ChatGoalWorkflowState {
  /** Goal state from goal_updated (TUI goal panel). */
  goalState?: Record<string, unknown>
  /**
   * goal_updated receive time — elapsed fallback when the wire carries
   * neither elapsed_ms nor started_at (defensive chain).
   */
  goalReceivedAt?: number
  /** /goal detail panel visibility (GoalChip dropdown; /goal opens it). */
  goalPanelOpen: boolean
  setGoalPanelOpen: (open: boolean) => void
  // ── goal mode (TUI /goal) — HOST-ENGINE control ───────────────────
  // The host owns the goal tracker and /api/goal/* endpoints (the wire
  // defines goal_updated notifications but NO goal control methods, so
  // the engine lives host-side, not in prompts).
  goalSet: (objective: string, tokenBudget?: number) => void
  goalStatus: () => void
  goalPause: () => void
  goalResume: () => void
  goalClear: () => void
  /** Workflow runs keyed by run_id (TUI workflows pane). */
  workflowRuns: Record<string, WorkflowRun>
  /**
   * Run shown in the /workflows detail view (TUI detail_run_id). Undefined
   * keeps the panel on the run list; Esc in the detail returns to it.
   */
  selectedWorkflowRunId?: string
  setSelectedWorkflowRunId: (id: string | undefined) => void
  /** /workflows run-dashboard modal visibility. */
  workflowPanelOpen: boolean
  setWorkflowPanelOpen: (open: boolean) => void
  // ── workflow control (TUI /workflows p/r/x) — same protocol gap: no
  // wire method for workflow control, so pause/resume/stop go through
  // the prompt path with a local optimistic row update first.
  workflowControl: (runId: string, action: 'pause' | 'resume' | 'stop') => void
  /** "Save script" — local-only clipboard copy of the run's script payload. */
  saveWorkflowScript: (runId: string) => Promise<void>
}

/** 视图与面板：焦点/选择/展开、block viewer、各 modal 可见性、Composer 草稿与队列。 */
export interface ChatUiState {
  /** Desktop (lg+) persistent sidebar collapsed state — toggled by the TopBar collapse icon. */
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  /** TUI focus: Tab toggles prompt ↔ scrollback */
  focusMode: FocusMode
  setFocus: (mode: FocusMode) => void
  /** Selected entry id (or synthetic `gh_<anchorId>` group header) */
  selectedId: string | null
  selectEntry: (id: string | null) => void
  selectDelta: (delta: number) => void
  /**
   * Manually expanded verb / truncation groups, keyed by the first entry id
   * of the run (TUI expanded_groups).
   */
  expandedGroups: ReadonlySet<string>
  toggleGroupExpansion: (anchorId: string) => void
  /**
   * Block viewer (TUI OpenBlockViewer): entry id currently shown fullscreen.
   * Enter / 「查看」按钮打开；Esc 关闭。与行内折叠独立。
   */
  viewerEntryId: string | null
  /**
   * Block viewer backed by a task id instead of an entry (top-strip
   * restored tasks, history-replay display rows). Mutually exclusive
   * with viewerEntryId.
   */
  viewerTask?: ViewerTask
  /** Open TUI block viewer for entry (Enter / 「查看」). */
  openViewer: (id?: string | null) => void
  /**
   * Open the block viewer for a task by id — used by the top task strip
   * and history-replay rows. Live rows (bgTaskIndex) keep the
   * entry-backed viewer; everything else gets a session-scoped task view
   * whose log is reconstructed by the host (pagination-independent).
   */
  openTaskViewer: (taskId: string, opts?: Partial<ViewerTask>) => void
  closeViewer: () => void
  /**
   * On-demand fetch of a subagent session's stored updates (block viewer
   * timeline, TUI replay_inherited_updates 同款): reads the child
   * session's updates.jsonl via the host's session-updates endpoint
   * (same cwd as the parent) and replays the envelopes through the same
   * view processor as live events. No-op unless the view exists and is
   * idle with an empty timeline.
   */
  fetchSubagentView: (childSessionId: string) => Promise<void>
  /**
   * 上滑加载子代理时间线更早的一页（负 offset 分页，主 scrollback
   * loadMoreHistory 同款）：新页 prepend 到时间线前面，跨页截断的
   * assistant/thought 缝合。仅回放填充的视图（loadedCount > 0）提供——
   * 纯 live 捕获的视图历史从 spawn 起已完整，回放会与 live 重复。
   * 返回 true = 加载成功（可能还有更多），false = 无更多/失败。
   */
  loadMoreSubagentView: (childSessionId: string) => Promise<boolean>
  /** /session-info modal visibility (TUI session-info command). */
  sessionInfoOpen: boolean
  /** Open / close the /session-info modal. */
  openSessionInfo: () => void
  closeSessionInfo: () => void
  /** /context modal visibility (TUI context command — context breakdown). */
  contextOpen: boolean
  /** Open / close the /context detail modal. */
  openContext: () => void
  closeContext: () => void
  /** /usage modal visibility — 宿主侧 token 用量聚合 + billing credits。 */
  usageOpen: boolean
  openUsage: () => void
  closeUsage: () => void
  /** /view-plan modal visibility (TUI view-plan command — plan preview). */
  planViewerOpen: boolean
  /** Open / close the /view-plan plan viewer modal. */
  openPlanViewer: () => void
  closePlanViewer: () => void
  /**
   * Sticky running-tasks bar under the top bar (TUI tasks pane). Toggled
   * by the ⠋N chip and the composer's idle still-running cue — shared so
   * either surface can open the same list.
   */
  tasksBarOpen: boolean
  setTasksBarOpen: (open: boolean) => void
  /** /timestamps — right-aligned prompt timestamps in the scrollback. */
  showTimestamps: boolean
  toggleTimestamps: () => void
  /** /rewind picker modal visibility (TUI /rewind). */
  rewindOpen: boolean
  openRewind: () => void
  closeRewind: () => void
  /**
   * Composer draft parked while the /rewind picker is open (TUI
   * StashedPrompt). The Composer moves its local buffer here on open and
   * restores it on close — a rewind reloads the session history and must
   * not eat the user's in-progress text.
   */
  stashedDraft: string | null
  setStashedDraft: (text: string | null) => void
  /**
   * Live composer draft length, mirrored from the Composer's local buffer
   * for the GLOBAL key handler (useScrollbackKeys Ctrl+C ladder: draft
   * cleared before a running turn is cancelled). Write-only mirror —
   * nothing subscribes to it, so per-keystroke updates cost no renders.
   */
  composerDraftLen: number
  /**
   * Global Ctrl+C "clear the draft first" custody: the key handler bumps
   * this nonce; the Composer watches it and clears its local buffer
   * (text + chips). Kept as a nonce so repeated clears always fire.
   */
  composerClearNonce: number
  clearComposerDraft: () => void
  /** Composer 内联队列是否展开（无弹窗；顶部 +N / 「N queued」共用）。 */
  queuePanelOpen: boolean
  /** Accepts a plain value or a functional updater (queue pill toggle). */
  setQueuePanelOpen: (open: boolean | ((v: boolean) => boolean)) => void
  /** Memory modal visibility (TUI /memory). */
  memoryOpen: boolean
  openMemory: () => void
  closeMemory: () => void
  /** Diff review payloads from diff_review (TUI diff-review modal). */
  diffReview?: unknown[]
  /** Diff review modal visibility — notification path only (the request
   *  path is driven by the x.ai/diff_review entry in xaiRequests). */
  diffReviewOpen: boolean
  openDiffReview: () => void
  closeDiffReview: () => void
  /** Bumped on hooks_changed / plugins_changed so modals can refresh. */
  hooksVersion: number
  // ── extensions modal (TUI /hooks /plugins /skills /marketplace) ──────
  extensionsOpen: boolean
  extensionsTab: ExtensionsTab
  openExtensions: (tab: ExtensionsTab) => void
  closeExtensions: () => void
  /** Settings modal (TUI F2 / /settings) — read-only config.toml view + effective permission default. */
  settingsOpen: boolean
  openSettings: () => void
  closeSettings: () => void
  // ── content search modal (TUI /search panel; /api/search/content) ────
  contentSearchOpen: boolean
  /** Prefill for the query input — `/search foo` opens mid-search. */
  contentSearchPrefill: string
  openContentSearch: (query?: string) => void
  closeContentSearch: () => void
  // ── @ file picker engine state (TUI fuzzy file search) ───────────────
  /**
   * Live fuzzy file-search session feeding the Composer's @ popover.
   * Null = closed. Matches arrive via the `search_fuzzy_status` SSE event
   * (each generation carries the full snapshot); the searchId guards
   * stale sessions. The Composer owns open/change/close lifecycle.
   */
  fileSearch: FileSearchState | null
  /**
   * 按需补全一条 lite 工具行的正文（契约 [E]）：按该条目的
   * [msgSeq, msgSeqEnd] 区间拉 detail=full，只把 raw.rawOutput / raw.content
   * 填回原行。展开入口（toggleTool / 「查看」/ Diff 审查 / 子代理迷你视图）
   * 与占位行上的重试都走这里；同区间只拉一次。
   */
  fillToolEntryDetail: (entryId: string) => Promise<void>
  /** 整窗补全：一次展开一片的入口（Diff 审查弹窗打开时调）。 */
  fillLiteToolBodies: (opts?: { editOnly?: boolean }) => Promise<void>
  toggleTool: (id: string) => void
  toggleThought: (id: string) => void
  /** Expand/collapse long user prompts (←/→ / click). */
  toggleUser: (id: string) => void
  /** 折叠/展开 btw 侧问区块（←/→ / click；条目默认展开，见 askBtw）。 */
  toggleBtw: (id: string) => void
  /** 折叠/展开 lifecycle hook 行（TUI LifecycleEventBlock，默认折叠）。 */
  toggleLifecycle: (id: string) => void
  /** 折叠/展开 session_event（recap 或带 stop-hook 的回合标记）。 */
  toggleSessionEvent: (id: string) => void
  /** → expand / ← collapse selected foldable block or group */
  setExpanded: (expanded: boolean) => void
  /**
   * Inline fold toggle for selected (←/→/click path). Not the viewer.
   * Kept for Space / group headers; tools use setExpanded via arrows/click.
   */
  toggleSelected: () => void
}

/** 动作入口：init / send / 会话管理 / host 管理 / 事件分发等顶层动作。 */
export interface ChatActions {
  init: () => () => void
  send: (
    text: string,
    blocks?: ContentBlock[],
    opts?: { fromShell?: boolean; promptId?: string },
  ) => Promise<void>
  cancel: () => Promise<void>
  handleEvent: (ev: AcpEvent) => void
  /**
   * Append a LOCAL-ONLY scrollback entry (shell mode output, etc.) —
   * rendered like a normal row but never sent to the agent. Kind is
   * limited to the entry kinds the scrollback renders as plain text.
   */
  appendLocalEntry: (entry: {
    kind: 'user' | 'session_event' | 'error'
    text: string
    /** Render a user row with the TUI `$ ` shell prefix (direct `!` exec). */
    isShell?: boolean
    /** Render `session_event` text as ANSI-colored output (raw bytes kept). */
    ansi?: boolean
    /** Amber accent (warning rail + text) for session_event rows. */
    warning?: boolean
  }) => void
  respondPermission: (
    requestId: string,
    optionId?: string,
    cancelled?: boolean,
    /**
     * Structured "always allow" scope picked with ←/→ on the permission
     * card (TUI BashCommandSelectedTerms) — sent only for always options.
     */
    scope?: PermissionScope,
    /** Optional followup message on a reject (TUI RejectOnce followup). */
    followupMessage?: string,
  ) => Promise<void>
  // NOTE: when `optionId` is the canonical `enable-always-approve` row
  // (TUI prompter position 0), the store ALSO flips always-approve on
  // (host /api/set-mode → x.ai/yolo_mode_changed) and drains the queued
  // requests with AllowOnce — TUI dispatch_permission_select parity.
  /** Respond to a forwarded x.ai/* request with a raw result (or error). */
  respondXai: (requestId: string, result?: Record<string, unknown>, error?: string) => Promise<void>
  /** Cancel a forwarded x.ai/* request (outcome:cancelled / error). */
  dismissXai: (requestId: string) => Promise<void>
  /** Dismiss the top error/status banner (user acknowledged the message). */
  dismissNotice: () => void
  /** x.ai/recap — fire-and-forget "where was I" summary. */
  requestRecap: () => Promise<void>
  /**
   * x.ai/btw — 旁路小话（/btw）：busy 中也直接发出、不占 prompt 队列；
   * 结果以 btw 滚动区块呈现（按发起会话绑定，切走会话不残留）。
   */
  askBtw: (question: string) => Promise<void>
  /**
   * Fork the current session (x.ai/session/fork; TUI /fork). On success the
   * FE switches to the forked session (TUI switches to the peer agent) and
   * refreshes the session lists.
   * - `targetPromptIndex` — fork keeps turns 0..=k (0-based, inclusive;
   *   agent ForkSessionRequest.target_prompt_index). Omitted → full copy.
   * - `worktree` — TUI /fork --worktree: derive in a fresh git worktree via
   *   x.ai/git/worktree/resume_session (full history; no truncation).
   */
  forkSession: (opts?: ForkSessionOpts) => Promise<void>
  /** x.ai/session/rename. */
  renameSession: (title: string) => Promise<void>
  /** x.ai/subagent/cancel. */
  cancelSubagent: (subagentId: string) => Promise<void>
  /** x.ai/task/kill — kill a background task. */
  killTask: (taskId: string) => Promise<void>
  /** x.ai/session/delete — delete a session (TUI /delete). */
  deleteSession: (sessionId: string, cwd: string) => Promise<void>
  /** x.ai/session/compact — compress the active session's context (TUI /compact). */
  compactSession: (note?: string) => Promise<void>
  /** x.ai/session/rewind_points — candidate rewind targets for the /rewind picker. */
  rewindPoints: () => Promise<RewindPoint[]>
  /** x.ai/session/rewind — rewind the active session to a stored index (TUI /rewind). */
  rewindExecute: (targetIndex: number, mode?: RewindMode) => Promise<RewindExecuteResult | undefined>
  /** x.ai/scheduler/delete — remove a scheduled task (TUI /loop delete). */
  deleteScheduledTask: (taskId: string) => Promise<void>
  /**
   * Pull stdout for a bg_task (x.ai/task/list, or the host's session-
   * scoped TaskLog reconstruction when sessionId/cwd are given). No-op
   * target resolution: updates the scrollback row when indexed, the
   * open task viewer otherwise. Used by the block viewer + openViewer.
   */
  refreshTaskOutput: (taskId: string, sessionId?: string, cwd?: string) => Promise<void>
  /**
   * Align bg_task entries with the host's live x.ai/task/list.
   * TUI restores the live registry on session/load; history-only replay
   * can miss still-running tasks (page boundary / SSE drop during load).
   */
  syncLiveTasks: () => Promise<void>
  /** x.ai/sessions/changed — refresh the history list. retry: 启动窗口容错（agent 预热 boot 超时）重试次数。 */
  refreshSessions: (retry?: number) => Promise<void>
  /**
   * 拉取最近会话摘要（workspace-list-recent，limit = workspaceRecentLimit）；
   * 失败降级为全量 workspace-list，再降级为 sessions 按 cwd 分组。
   * retry 同 refreshSessions。
   */
  refreshWorkspaces: (retry?: number) => Promise<void>
  /**
   * 会话列表分页「加载更多」：limit +50 重拉 workspace-list-recent 并
   * 增量合并（已有行原位更新，新行 append 到对应分组末尾）。
   */
  workspaceLoadMore: () => Promise<void>
  /**
   * 切换会话列表展示模式（recent 分页 ⇄ 全量），并持久化偏好到
   * localStorage。切换中 workspaceLoading=true。
   */
  switchWorkspaceListMode: (mode: 'recent' | 'full') => Promise<void>
  /** 拉取当前会话的聚合统计（POST /api/session-stats，composer 状态条数据源）。 */
  refreshSessionStats: () => Promise<void>
  /** Fetch git branch/worktree state for the active session (x.ai/git/info). */
  refreshGitInfo: () => Promise<void>
  /**
   * Create a fresh session. cwd 显式指定时（右键分组"在此目录新建"）
   * 用指定目录；缺省继承当前会话的 cwd；两者皆空 → 宿主默认目录。
   */
  newSession: (cwd?: string) => Promise<string | undefined>
  /**
   * 进入无会话空状态（不创建会话）：停轮询、清流式缓冲、清空全部
   * 会话状态。侧边栏顶部 new 点击后先落在这里，用户选好工作目录
   * （或直接输入消息触发宿主自动创建）才真正创建会话。
   */
  resetToEmpty: () => void
  /** 空状态工作目录（用户输入/选择）；发送消息时用于创建新会话。 */
  setEmptyCwd: (cwd: string) => void
  /** Refresh the host registry (+ auto-select). snap 来自 hub 的 WS hello
   *  快照（含 defaultHostId）时跳过 GET /api/hosts，省一次跨网往返。 */
  refreshHosts: (snap?: { hosts: HostInfo[]; defaultHostId?: string }) => Promise<void>
  /** Switch the target host (hub mode); resets per-host UI state. */
  switchHost: (hostId: string) => Promise<void>
  /** 修改已配对 host 的展示名（hub 管理端点；成功后刷新注册表）。返回是否成功。 */
  renameHost: (hostId: string, hostName: string) => Promise<boolean>
  /** 删除（解除配对）一个 host；若删的是当前选中 host 则自动切到剩余 host。返回是否成功。 */
  deleteHost: (hostId: string) => Promise<boolean>
  /** 用户显式重启当前 host 的 agent 进程（杀进程 + 重新 boot + 恢复上次会话）。返回是否成功。 */
  restartAgent: () => Promise<boolean>
  /** 当前配对码（添加新 host 用；仅 hub 模式）。 */
  fetchPairingCode: () => Promise<{ code: string; expiresAt?: string; ttl?: number }>
  /** 轮换配对码（旧码立即失效）→ 新码。 */
  rotatePairingCode: () => Promise<{ code: string; expiresAt?: string }>
  /** session/setModel — switch the session's model (grok /model). */
  setModel: (modelId: string, reasoningEffort?: string) => Promise<void>
  /** History picker: fetch session list and open the overlay. */
  openHistory: () => Promise<void>
  closeHistory: () => void
  /** Load a historical session's updates; the host replays them via SSE.
   *  opts.awaitBeforeReplay：回放应用前等待的探活 promise（并行切会话时
   *  由 continueSession 传入任务探活，防止「仍在跑任务」的 started 行悬空）。 */
  loadHistory: (
    sessionId: string,
    cwd: string,
    opts?: { awaitBeforeReplay?: Promise<void> },
  ) => Promise<void>
  /** Fetch the next older page of the active history and prepend it.
   *  chainedPages：内部续翻计数（零 user 页自动续翻，见实现），调用方
   *  不传。 */
  loadMoreHistory: (anchorId?: string, chainedPages?: number) => Promise<void>
  /**
   * Replay the session's STILL-RUNNING tasks (host liveness probe of
   * updates.jsonl) into the top task strip (topTasks). Deliberately NO
   * scrollback entries — restored tasks only live in the top strip and
   * maintain state via live events. History page replays IGNORE task
   * lifecycle events (see envelopeToEvent), so this is the single
   * source of restored running tasks.
   */
  replayRunningTasks: (sessionId: string, cwd: string) => Promise<void>
  /**
   * One-shot probe refresh of the top strip (drop dead / add new) —
   * used by the periodic poller (TUI-owned tasks emit no events here).
   */
  refreshTopTasks: (sessionId: string, cwd: string) => Promise<void>
  /** Start the periodic top-strip liveness poll (one per active session). */
  startTopTaskPolling: (sessionId: string, cwd: string) => void
  /** Stop the periodic top-strip liveness poll. */
  stopTopTaskPolling: () => void
  /** Switch the active session to a historical one and load its tail. */
  continueSession: (sessionId: string, cwd: string) => Promise<void>
  /** Memory system — /flush: ask the host to persist session knowledge. */
  memoryFlush: () => Promise<void>
  /** Memory system — /remember: send a raw note to the agent's LLM rewriter. */
  rememberNote: (rawText: string) => Promise<void>
}

export type ChatState = ChatConnState &
  ChatTimelineState &
  ChatHistoryState &
  ChatTurnState &
  ChatModeState &
  ChatAgentExtState &
  ChatMcpState &
  ChatGoalWorkflowState &
  ChatUiState &
  ChatActions

export type SetState = (
  partial:
    | Partial<ChatState>
    | ((s: ChatState) => Partial<ChatState>),
) => void

export type ModeFlags = Partial<
  Pick<ChatState, 'permissionMode' | 'yoloMode' | 'autoMode'>
> & {
  /**
   * Last-known write was an explicit ask/normal (Shift+Tab / /auto off /
   * settings). Distinct from a hello-ask echo, which must not be persisted
   * — that would shadow config.toml on maybeReseed.
   */
  confirmedAsk?: boolean
}
