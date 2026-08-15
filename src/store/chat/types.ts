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
  SessionInfo,
  SubagentStatus,
  SubagentViewState,
  TopTask,
  WorkspaceGroup,
} from '../../api/types'
import type { McpListServer } from '../../api/client'

import type {
  ConnState,
  ExtensionsTab,
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
  FocusMode,
  McpInitProgress,
  McpServerInfo,
  TodoCounts,
  TodoItem,
  ViewerTask,
  WorkflowRun,
} from './typesPublic'

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

export type ChatState = {
  entries: ScrollEntry[]
  conn: ConnState
  statusText: string
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
  sessionId?: string
  /** Active session workspace dir (hello/ready; TUI status-bar path). */
  cwd?: string
  /** Host user home dir — for "~/…" path shortening. */
  homeDir?: string
  hostId?: string
  hostName?: string
  hosts: HostInfo[]
  /** 连接模式：local（本机 capri-host，锁定本机，无 host 切换）/ hub（跨源 hub，可切换 host）。 */
  mode: 'local' | 'hub'
  /** Selected host (hub mode): API calls + event filtering target. */
  selectedHostId?: string
  /** Historical sessions for the history picker (from session/list). */
  sessions: SessionInfo[]
  /** Session summaries bucketed by workspace (workspace-list). */
  workspaces: WorkspaceGroup[]
  workspaceLoading: boolean
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
  historyOpen: boolean
  /** Desktop (lg+) persistent sidebar collapsed state — toggled by the TopBar collapse icon. */
  sidebarCollapsed: boolean
  toggleSidebar: () => void
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
  usage?: { used?: number; size?: number }
  /**
   * 当前会话的聚合统计（POST /api/session-stats 响应；composer 状态条
   * 数据源）。会话切换/回合终态后刷新；无会话或失败为 undefined。
   */
  sessionStats?: import('../../api/types').SessionStats
  pending: PendingReq[]
  modes?: unknown
  /**
   * Slash commands advertised by the agent (ACP `available_commands_update`
   * → host `commands_update`). The slash menu merges them after the local
   * registry (local names win on collision); invoking one sends the raw
   * `/name args` line as a user message (TUI PassThrough semantics).
   */
  agentCommands: AgentCommand[]
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
  /** Session title (top prompt border caption). */
  sessionTitle?: string
  /** Current model label for prompt info line (TUI model_name). */
  modelName?: string
  /** Reasoning effort suffix, e.g. "high". */
  reasoningEffort?: string
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
  /** Git head from x.ai/git_head_changed (TUI status-bar branch). */
  gitInfo?: { branch?: string | null; isWorktree?: boolean; mainRepo?: string | null }
  /** Permission mode from x.ai/yolo_mode_changed (TUI permission banner). */
  yoloMode?: boolean
  autoMode?: boolean
  permissionMode?: string
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
  // ── model catalog (agentInfo._meta.modelState.availableModels) ─────
  models: ModelOption[]
  /** Memory files from memory_files (TUI memory modal). */
  memoryFiles?: { name: string; path?: string; size?: number; updatedAt?: unknown; source?: string }[]
  /** Memory modal visibility (TUI /memory). */
  memoryOpen: boolean
  openMemory: () => void
  closeMemory: () => void
  /** Goal state from goal_updated (TUI goal panel). */
  goalState?: Record<string, unknown>
  /** Todo counts from plan updates (TUI status-bar todo badge). */
  todoCounts?: TodoCounts
  /** Todo items from plan updates (clickable badge panel). */
  todos?: TodoItem[]
  /** Diff review payloads from diff_review (TUI diff-review modal). */
  diffReview?: unknown[]
  /** Diff review modal visibility — notification path only (the request
   *  path is driven by the x.ai/diff_review entry in xaiRequests). */
  diffReviewOpen: boolean
  openDiffReview: () => void
  closeDiffReview: () => void
  /** Workflow runs keyed by run_id (TUI workflows pane). */
  workflowRuns: Record<string, WorkflowRun>
  /**
   * Run shown in the /workflows detail view (TUI detail_run_id). Undefined
   * keeps the panel on the run list; Esc in the detail returns to it.
   */
  selectedWorkflowRunId?: string
  setSelectedWorkflowRunId: (id: string | undefined) => void
  /** /goal detail panel visibility (GoalChip dropdown; /goal opens it). */
  goalPanelOpen: boolean
  setGoalPanelOpen: (open: boolean) => void
  /**
   * goal_updated receive time — elapsed fallback when the wire carries
   * neither elapsed_ms nor started_at (defensive chain).
   */
  goalReceivedAt?: number
  /** /workflows run-dashboard modal visibility. */
  workflowPanelOpen: boolean
  setWorkflowPanelOpen: (open: boolean) => void
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
  // streaming pointers
  openAssistantId?: string
  openThoughtId?: string
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
  toolIndex: Record<string, string> // toolCallId -> entry id
  /** TUI focus: Tab toggles prompt ↔ scrollback */
  focusMode: FocusMode
  /** Selected entry id (or synthetic `gh_<anchorId>` group header) */
  selectedId: string | null
  /**
   * Manually expanded verb / truncation groups, keyed by the first entry id
   * of the run (TUI expanded_groups).
   */
  expandedGroups: ReadonlySet<string>
  /**
   * Block viewer (TUI OpenBlockViewer): entry id currently shown fullscreen.
   * Enter / double-click open; Esc closes. Independent of inline expand.
   */
  viewerEntryId: string | null
  /**
   * Block viewer backed by a task id instead of an entry (top-strip
   * restored tasks, history-replay display rows). Mutually exclusive
   * with viewerEntryId.
   */
  viewerTask?: ViewerTask
  /** /session-info modal visibility (TUI session-info command). */
  sessionInfoOpen: boolean
  /** /context modal visibility (TUI context command — context breakdown). */
  contextOpen: boolean
  /** /usage modal visibility — 宿主侧 token 用量聚合 + billing credits。 */
  usageOpen: boolean
  openUsage: () => void
  closeUsage: () => void
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
  /**
   * Scheduled tasks (/loop) of the active session — TUI tasks pane
   * "调度任务" section. Fed by scheduled_task_created / fired / deleted
   * (both the session_notification tag carrier and standalone SSE events;
   * upserted by taskId so the dual paths dedupe). Cleared on session
   * switch / new session.
   */
  scheduledTasks: ScheduledTask[]
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
  /** Transient "Switched to mode: X" banner (TUI notices.rs mode_switch_banner). */
  modeBanner: string | null
  showModeBanner: (text: string) => void
  clearModeBanner: () => void
  /** Composer queue dropdown visibility (TUI queue pane). */
  queuePanelOpen: boolean
  /** Accepts a plain value or a functional updater (queue pill toggle). */
  setQueuePanelOpen: (open: boolean | ((v: boolean) => boolean)) => void
  /**
   * Local plan-mode flag (Shift+Tab cycle / /plan). Driven by the host's
   * toggle-plan-mode result when available; otherwise kept local and
   * nudged by yolo_mode_changed / modes_update payloads.
   */
  planMode: boolean
  /** Cancel the running turn — cancel panel options 1 / 3 / 4 (+ Ctrl+C). */
  cancelTurn: (opts?: {
    /** Also cancel every running subagent (panel "Stop running" / "Always stop"). */
    cancelSubagents?: boolean
    /** Legacy: additionally kill every running bg_task (incl. top strip). */
    stopTasks?: boolean
    /** Empty the composer send queue. */
    clearQueue?: boolean
  }) => Promise<void>
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

  // ── goal mode (TUI /goal) — HOST-ENGINE control ───────────────────
  // The host owns the goal tracker and /api/goal/* endpoints (the wire
  // defines goal_updated notifications but NO goal control methods, so
  // the engine lives host-side, not in prompts).
  goalSet: (objective: string, tokenBudget?: number) => void
  goalStatus: () => void
  goalPause: () => void
  goalResume: () => void
  goalClear: () => void
  // ── workflow control (TUI /workflows p/r/x) — same protocol gap: no
  // wire method for workflow control, so pause/resume/stop go through
  // the prompt path with a local optimistic row update first.
  workflowControl: (runId: string, action: 'pause' | 'resume' | 'stop') => void
  /** "Save script" — local-only clipboard copy of the run's script payload. */
  saveWorkflowScript: (runId: string) => Promise<void>
  /** Memory system — /flush: ask the host to persist session knowledge. */
  memoryFlush: () => Promise<void>

  init: () => () => void
  send: (
    text: string,
    blocks?: ContentBlock[],
    opts?: { fromShell?: boolean; promptId?: string },
  ) => Promise<void>
  cancel: () => Promise<void>
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
  /** x.ai/session/fork — fork the current session. */
  forkSession: (opts?: Record<string, unknown>) => Promise<void>
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
  /** 按工作区拉取会话摘要（workspace-list）；失败降级为 sessions 按 cwd 分组。retry 同 refreshSessions。 */
  refreshWorkspaces: (retry?: number) => Promise<void>
  /** 拉取当前会话的聚合统计（POST /api/session-stats，composer 状态条数据源）。 */
  refreshSessionStats: () => Promise<void>
  /** Fetch git branch/worktree state for the active session (x.ai/git/info). */
  refreshGitInfo: () => Promise<void>
  /**
   * Create a fresh session. cwd 显式指定时（右键分组"在此目录新建"）
   * 用指定目录；缺省继承当前会话的 cwd；两者皆空 → 宿主默认目录。
   */
  newSession: (cwd?: string) => Promise<void>
  /**
   * 进入无会话空状态（不创建会话）：停轮询、清流式缓冲、清空全部
   * 会话状态。侧边栏顶部 new 点击后先落在这里，用户选好工作目录
   * （或直接输入消息触发宿主自动创建）才真正创建会话。
   */
  resetToEmpty: () => void
  /** 空状态工作目录（用户输入/选择）；发送消息时用于创建新会话。 */
  setEmptyCwd: (cwd: string) => void
  refreshHosts: () => Promise<void>
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
  /** Load a historical session's updates; the host replays them via SSE. */
  loadHistory: (sessionId: string, cwd: string) => Promise<void>
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
  handleEvent: (ev: AcpEvent) => void
  toggleTool: (id: string) => void
  toggleThought: (id: string) => void
  /** Expand/collapse long user prompts (←/→ / click). */
  toggleUser: (id: string) => void
  setFocus: (mode: FocusMode) => void
  selectEntry: (id: string | null) => void
  selectDelta: (delta: number) => void
  /** → expand / ← collapse selected foldable block or group */
  setExpanded: (expanded: boolean) => void
  /**
   * Inline fold toggle for selected (←/→/click path). Not the viewer.
   * Kept for Space / group headers; tools use setExpanded via arrows/click.
   */
  toggleSelected: () => void
  /** Open TUI block viewer for entry (Enter / double-click). */
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
  toggleGroupExpansion: (anchorId: string) => void
  /** Open / close the /session-info modal. */
  openSessionInfo: () => void
  closeSessionInfo: () => void
  /** Open / close the /context detail modal. */
  openContext: () => void
  closeContext: () => void
  /**
   * TUI /session-info: fetch session details (POST /api/session-info) and
   * append them to the scrollback as a read-only text block (kind 'status')
   * — the TUI pushes a plain text block into the scrollback, no modal.
   */
  showSessionInfo: () => Promise<void>
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

export type SetState = (
  partial:
    | Partial<ChatState>
    | ((s: ChatState) => Partial<ChatState>),
) => void

export type ModeFlags = Partial<
  Pick<ChatState, 'permissionMode' | 'yoloMode' | 'autoMode'>
>
