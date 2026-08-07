import { create } from 'zustand'
import type {
  AcpEvent,
  HostInfo,
  ModelOption,
  PendingReq,
  ScrollEntry,
  SessionInfo,
  TaskTimelineEvent,
  ToolCall,
  TopTask,
} from '../api/types'
import { transport } from '../api/localTransport'
import { toolHeader } from '../theme/glyphs'
import {
  projectDisplayRows,
  scanGroups,
  spanContaining,
} from '../scrollback/verbGroup'
let entrySeq = 0
const nid = () => `e_${++entrySeq}_${Date.now()}`

// ── per-session last-viewed persistence ─────────────────────────────
// The 待处理 bucket means "bg tasks finished, user hasn't looked yet".
// The viewed timestamp survives reloads so seen sessions never re-flag.
const LAST_VIEWED_KEY = 'acpfe.lastViewedAt'

function loadLastViewedAt(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(LAST_VIEWED_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function persistLastViewedAt(map: Record<string, number>): void {
  try {
    window.localStorage.setItem(LAST_VIEWED_KEY, JSON.stringify(map))
  } catch {
    // Private mode / quota — the in-memory copy still works this session.
  }
}

/**
 * Top-strip liveness poll: TUI-owned background tasks emit no events to
 * this host (their task_completed goes to the TUI's own pager), so the
 * restored strip converges via the host probe — drop dead tasks, pick up
 * newly started ones. One cheap lsof-backed HTTP call per tick.
 */
const TOP_TASK_POLL_MS = 10_000
let topTaskTimer: ReturnType<typeof window.setInterval> | null = null

/**
 * Merge a host probe result into the top task strip: drop tasks no
 * longer alive (the strip only holds running tasks), add newly alive
 * ones — skipping tasks already tracked as live scrollback rows
 * (bgTaskIndex) or already in the strip.
 */
function applyTopTaskProbe(
  get: () => ChatState,
  set: SetState,
  events: TaskTimelineEvent[],
): void {
  const s = get()
  const seen = new Set(s.topTasks.map((t) => t.taskId))
  const alive = new Set<string>()
  const added: TopTask[] = []
  for (const ev of events) {
    if (ev.kind !== 'task_backgrounded' || !ev.taskId) continue
    alive.add(ev.taskId)
    if (s.bgTaskIndex[ev.taskId] || seen.has(ev.taskId)) continue
    seen.add(ev.taskId)
    const command = typeof ev.command === 'string' ? ev.command : undefined
    const monitor =
      typeof ev.monitorDescription === 'string' ? ev.monitorDescription : undefined
    added.push({
      taskId: ev.taskId,
      title:
        monitor ||
        (typeof ev.description === 'string' ? ev.description : undefined) ||
        command ||
        `Task ${ev.taskId.slice(0, 8)}`,
      command,
      isMonitor: !!monitor,
      restored: true,
      outputFile: typeof ev.outputFile === 'string' ? ev.outputFile : undefined,
    })
  }
  const topTasks = s.topTasks.filter((t) => alive.has(t.taskId))
  if (added.length > 0 || topTasks.length !== s.topTasks.length) {
    set({ topTasks: [...topTasks, ...added] })
  }
}

/**
 * Tool call IDs suppressed from scrollback (TUI suppressed_tools +
 * bg_deferred_tools). Cleared when the transcript is reset.
 */
const suppressedToolIds = new Set<string>()

function clearSuppressedTools() {
  suppressedToolIds.clear()
}

function toolVerb(kind?: string, running?: boolean) {
  return toolHeader(kind, !!running).verb
}

function formatElapsed(ms: number): string {
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const rem = secs - mins * 60
  return `${mins}m${rem.toFixed(0)}s`
}

/**
 * TUI format_duration (xai-grok-pager-render/src/util.rs) — drives the
 * "Worked for Xs" turn-completion marker: <10s "5.2s", <60s "32s",
 * <60m "2m5s", else "1h2m".
 */
export function formatTurnDuration(ms: number): string {
  const totalSecs = Math.floor(ms / 1000)
  if (totalSecs < 10) return `${(ms / 1000).toFixed(1)}s`
  if (totalSecs < 60) return `${totalSecs}s`
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  if (mins < 60) return `${mins}m${secs}s`
  return `${Math.floor(mins / 60)}h${mins % 60}m`
}

/**
 * Map a `plan` event's entry list to todo items + counts (TUI
 * todo_item_from_plan_entry). Cancelled items (completed + meta.cancelled)
 * are excluded from `total`, matching the status-bar badge. Returns
 * undefined counts for empty/unknown lists so the badge stays hidden.
 * Exported so scrollback plan blocks render the same items as the badge.
 */
export function planTodos(entries: unknown): { items: TodoItem[]; counts?: TodoCounts } {
  if (!Array.isArray(entries)) return { items: [] }
  const items: TodoItem[] = []
  let inProgress = 0
  let pending = 0
  let completed = 0
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    const status = typeof r.status === 'string' ? r.status : ''
    let todoStatus: TodoItem['status'] = 'pending'
    if (status === 'completed' || status === 'done') {
      const meta = r.meta as Record<string, unknown> | undefined
      if (meta?.cancelled === true) {
        todoStatus = 'cancelled'
      } else {
        todoStatus = 'completed'
        completed++
      }
    } else if (
      status === 'in_progress' ||
      status === 'inProgress' ||
      status === 'running'
    ) {
      todoStatus = 'in_progress'
      inProgress++
    } else {
      pending++
    }
    items.push({
      id: typeof r.id === 'string' ? r.id : undefined,
      content: contentText(r.content) || String(r.title ?? ''),
      status: todoStatus,
      priority: typeof r.priority === 'string' ? r.priority : undefined,
    })
  }
  const total = inProgress + pending + completed
  return {
    items,
    counts: total === 0 && items.length === 0 ? undefined : { total, inProgress, pending, completed },
  }
}

function extractTarget(tc: ToolCall): string {
  const ri = toolRawInput(tc)
  if (!ri) return tc.title || ''
  const s =
    (ri.path as string) ||
    (ri.filePath as string) ||
    (ri.command as string) ||
    (ri.query as string) ||
    (ri.url as string) ||
    (ri.pattern as string) ||
    tc.title ||
    ''
  return String(s)
}

/** ACP ToolCall raw_input (camelCase or snake_case wire). */
function toolRawInput(tc: ToolCall): Record<string, unknown> | undefined {
  const ri = tc.rawInput ?? (tc as { raw_input?: unknown }).raw_input
  return ri && typeof ri === 'object' && !Array.isArray(ri)
    ? (ri as Record<string, unknown>)
    : undefined
}

function toolTitle(tc: ToolCall): string {
  return typeof tc.title === 'string' ? tc.title : ''
}

function toolVariant(tc: ToolCall): string | undefined {
  const v = toolRawInput(tc)?.variant
  return typeof v === 'string' ? v : undefined
}

function isExecuteToolFunctionName(s: string): boolean {
  switch (s.toLowerCase()) {
    case 'run_terminal_command':
    case 'run_terminal_cmd':
    case 'bash':
    case 'shell':
    case 'execute':
    case 'run_command':
    case 'terminal':
      return true
    default:
      return false
  }
}

/**
 * TUI is_bg_plumbing_tool — get/kill/wait task tools dump stdout into the
 * model; UI already has the bg_task row + dblclick viewer.
 *
 * Wire note: the *final* completed update often rewrites title to
 * `"npm run dev (taskId)"` and clears rawInput, leaving only
 * `rawOutput: { type: "TaskOutput", Result: {…} }`. Match that shape too
 * or the log reappears as "Ran other".
 */
function isBgPlumbingTool(tc: ToolCall): boolean {
  const title = toolTitle(tc)
  if (
    title === 'get_command_or_subagent_output' ||
    title === 'kill_command_or_subagent' ||
    title === 'wait_commands_or_subagents' ||
    title === 'get_task_output' ||
    title === 'kill_task' ||
    title === 'wait_tasks' ||
    title === 'get_task_or_subagent_output' ||
    title === 'kill_task_or_subagent' ||
    title === 'wait_tasks_or_subagents' ||
    title === 'AwaitShell' ||
    title === 'Await'
  ) {
    return true
  }
  if (
    title.startsWith('Await:') ||
    title.startsWith('Sleep ') ||
    title.startsWith('Wait tasks:') ||
    title.startsWith('Kill task:') ||
    // Display titles stamped on tool_call_update
    title.startsWith('Get task output') ||
    title.startsWith('Get command output') ||
    title.startsWith('Wait tasks') ||
    title.startsWith('Kill task')
  ) {
    return true
  }
  const variant = toolVariant(tc)
  if (
    variant === 'TaskOutput' ||
    variant === 'KillTask' ||
    variant === 'WaitTasks'
  ) {
    return true
  }
  // Final completed update: rawInput cleared, TaskOutput only in rawOutput.
  const ro = toolRawOutput(tc)
  if (ro && typeof ro === 'object' && !Array.isArray(ro)) {
    const t = (ro as { type?: unknown }).type
    if (t === 'TaskOutput' || t === 'KillTask' || t === 'WaitTasks') return true
  }
  return false
}

/** ACP ToolCall raw_output (camelCase or snake_case wire). */
function toolRawOutput(tc: ToolCall): unknown {
  return tc.rawOutput ?? (tc as { raw_output?: unknown }).raw_output
}

/** TUI is_bg_tool — execute with is_background; BgTask block owns the row. */
function isBgExecuteTool(tc: ToolCall): boolean {
  const kind = String(tc.kind || '').toLowerCase()
  const title = toolTitle(tc)
  const looksLikeExecute = kind === 'execute' || isExecuteToolFunctionName(title)
  if (!looksLikeExecute) return false
  const ri = toolRawInput(tc)
  if (!ri) return false
  const bg = ri.is_background ?? ri.background ?? ri.isBackground
  return bg === true
}

/** TUI is_task_tool — subagent spawn (SubagentBlock owns the row). */
function isTaskSpawnTool(tc: ToolCall): boolean {
  const title = toolTitle(tc)
  if (title === 'task' || title === 'Task' || title === 'spawn_subagent') return true
  const v = toolVariant(tc)
  return v === 'Task' || v === 'SpawnSubagent' || v === 'spawn_subagent'
}

function isTodoTool(tc: ToolCall): boolean {
  const title = toolTitle(tc)
  if (title === 'todo_write' || title === 'TodoWrite' || title === 'Updating plan')
    return true
  const v = toolVariant(tc)
  return v === 'TodoWrite' || v === 'todo_write' || v === 'UpdateTodos'
}

function isGoalTool(tc: ToolCall): boolean {
  const title = toolTitle(tc)
  if (title === 'update_goal' || title.startsWith('Goal:')) return true
  const v = toolVariant(tc)
  return v === 'UpdateGoal' || v === 'WorkflowSignal'
}

function isSchedulerTool(tc: ToolCall): boolean {
  const title = toolTitle(tc)
  if (title.startsWith('scheduler_')) return true
  const v = toolVariant(tc)
  return !!v && v.startsWith('Scheduler')
}

function isWorkflowTool(tc: ToolCall): boolean {
  const title = toolTitle(tc)
  const v = toolVariant(tc)
  const isWorkflow = title === 'workflow' || v === 'Workflow'
  if (!isWorkflow) return false
  const ri = toolRawInput(tc)
  const validateOnly =
    title.startsWith('Validating workflow') || ri?.validate_only === true
  return !validateOnly
}

/**
 * TUI handle_tool_call suppress list + bg-deferred execute.
 * Logs for background tasks must not appear as "Ran other" tool rows —
 * they live in the bg_task entry (double-click / Enter → BlockViewer).
 */
function shouldSuppressToolFromScrollback(tc: ToolCall): boolean {
  return (
    isBgPlumbingTool(tc) ||
    isBgExecuteTool(tc) ||
    isTaskSpawnTool(tc) ||
    isTodoTool(tc) ||
    isGoalTool(tc) ||
    isSchedulerTool(tc) ||
    isWorkflowTool(tc)
  )
}

/** toolCallId from camelCase or snake_case wire. */
function toolCallIdOf(tc: ToolCall): string | undefined {
  const id =
    tc.toolCallId ??
    (tc as { tool_call_id?: unknown }).tool_call_id ??
    (tc as { id?: unknown }).id
  return typeof id === 'string' && id ? id : undefined
}

/**
 * When a suppressed get_task_output completes, fold its Result.output into
 * the matching bg_task entry so dblclick viewer has the log without a
 * separate "Ran other" row.
 */
function absorbTaskOutputIntoBgTask(
  get: () => ChatState,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set: (partial: any) => void,
  tc: ToolCall,
): void {
  const ro = toolRawOutput(tc)
  if (!ro || typeof ro !== 'object' || Array.isArray(ro)) return
  const obj = ro as Record<string, unknown>
  if (obj.type !== 'TaskOutput') return
  const result = (obj.Result ?? obj.result) as Record<string, unknown> | undefined
  if (!result || typeof result !== 'object') return
  const taskId = wireTaskId(result.task_id, result.taskId)
  if (!taskId) return
  const output =
    typeof result.output === 'string'
      ? result.output
      : typeof result.stdout === 'string'
        ? result.stdout
        : undefined
  if (output == null) return
  const entryId = get().bgTaskIndex[taskId]
  if (!entryId) return
  const cmd =
    nonBlankStr(result.command) ?? nonBlankStr(result.display_command)
  set({
    entries: get().entries.map((e) => {
      if (e.id !== entryId || e.kind !== 'bg_task') return e
      const nextOut =
        output.length >= (e.output?.length ?? 0) ? output : e.output
      return {
        ...e,
        output: nextOut,
        command: cmd || e.command,
      }
    }),
  })
}

/** Bash rawOutput payload from execute tool streaming. */
function bashRawOutput(tc: ToolCall): Record<string, unknown> | null {
  const ro = toolRawOutput(tc)
  if (!ro || typeof ro !== 'object' || Array.isArray(ro)) return null
  const obj = ro as Record<string, unknown>
  const t = obj.type
  if (t === 'Bash' || t === 'bash') return obj
  return null
}

/**
 * History page-boundary orphan: streaming Bash tool_call_update with no
 * matching tool_call in the loaded page (and thus no is_background flag).
 * On "start acpfe" the last 100 envelopes are almost all of these — FE used
 * to invent "Ran other" rows and dump host/vite logs into scrollback.
 */
function isOrphanBashStreamUpdate(tc: ToolCall): boolean {
  const bash = bashRawOutput(tc)
  if (!bash) return false
  // Full tool_call with is_background is handled by isBgExecuteTool.
  if (isBgExecuteTool(tc)) return true
  const title = toolTitle(tc)
  const kind = tc.kind
  // Typical orphan shape: no title, no kind, status in_progress, Bash body.
  if (!title && (kind == null || kind === '' || String(kind).toLowerCase() === 'other')) {
    return true
  }
  // Truncated long-running stream (background servers).
  if (bash.truncated === true || bash.truncated === 'True') return true
  return false
}

/** Pull human-readable stdout from a Bash rawOutput object. */
function bashOutputText(bash: Record<string, unknown>): string | undefined {
  if (typeof bash.output_for_prompt === 'string' && bash.output_for_prompt) {
    return bash.output_for_prompt
  }
  if (typeof bash.outputForPrompt === 'string' && bash.outputForPrompt) {
    return bash.outputForPrompt
  }
  if (typeof bash.output === 'string' && bash.output && bash.output !== '[]') {
    return bash.output
  }
  return undefined
}

/**
 * Fold orphan Bash stream output into a bg_task row matched by command.
 * Does nothing when no matching task exists yet (timeline / live list will
 * create the row; later streams can attach once the index is populated).
 */
function absorbBashOutputIntoBgTask(
  get: () => ChatState,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set: (partial: any) => void,
  tc: ToolCall,
): void {
  const bash = bashRawOutput(tc)
  if (!bash) return
  const cmd =
    nonBlankStr(bash.command) ??
    nonBlankStr(toolRawInput(tc)?.command)
  const output = bashOutputText(bash)
  if (!cmd && !output) return

  // Prefer exact command match; fall back to suffix / includes.
  const entries = get().entries
  let entryId: string | undefined
  if (cmd) {
    const exact = entries.find(
      (e) => e.kind === 'bg_task' && e.command === cmd,
    )
    if (exact) entryId = exact.id
    if (!entryId) {
      const loose = entries.find(
        (e) =>
          e.kind === 'bg_task' &&
          !!e.command &&
          (e.command.endsWith(cmd) ||
            cmd.endsWith(e.command) ||
            e.command.includes(cmd) ||
            cmd.includes(e.command)),
      )
      if (loose) entryId = loose.id
    }
  }
  if (!entryId) return
  if (output == null) return
  set({
    entries: get().entries.map((e) => {
      if (e.id !== entryId || e.kind !== 'bg_task') return e
      const nextOut =
        output.length >= (e.output?.length ?? 0) ? output : e.output
      return {
        ...e,
        output: nextOut,
        command: cmd || e.command,
      }
    }),
  })
}

type ConnState = 'connecting' | 'ready' | 'busy' | 'error' | 'offline'
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

type ChatState = {
  entries: ScrollEntry[]
  conn: ConnState
  statusText: string
  sessionId?: string
  /** Active session workspace dir (hello/ready; TUI status-bar path). */
  cwd?: string
  /** Host user home dir — for "~/…" path shortening. */
  homeDir?: string
  hostId?: string
  hostName?: string
  hosts: HostInfo[]
  /** Selected host (hub mode): API calls + event filtering target. */
  selectedHostId?: string
  /** Historical sessions for the history picker (from session/list). */
  sessions: SessionInfo[]
  historyOpen: boolean
  historyLoading: boolean
  /** Bumped when a history load finishes; Scrollback re-follows the bottom. */
  historyLoadedAt?: number
  /** Active history timeline (scroll-up pagination state). */
  historySessionId?: string
  historyCwd?: string
  historyTotalCount?: number
  historyLoadedCount: number
  historyHasMore: boolean
  historyLoadingMore: boolean
  /** Bumped when an older page is prepended; Scrollback restores position. */
  historyPrependedAt?: number
  historyAnchorId?: string
  usage?: { used?: number; size?: number; turnTokens?: number }
  pending: PendingReq[]
  modes?: unknown
  error?: string
  /**
   * Latest connection warning from the host (`status` events — e.g.
   * "连接HOST异常" / "连接已断开，本次回复已取消"). Shown in the top
   * error banner in amber; superseded by `error`, cleared on recovery
   * (ready/busy) or dismissed manually.
   */
  statusWarning?: string
  /** Turn start (epoch ms) for the TUI "Worked for Xs" completion marker. */
  turnStartedAt?: number
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
   * Per-session "last viewed" time (epoch ms). The history sidebar uses
   * it for the 待处理 bucket (unread: activity after the user last
   * looked). Defaults to `openedAt` — the moment this page loaded — so
   * opening the browser marks EVERYTHING as read; only activity that
   * lands after that flags a session. Clicking a conversation updates
   * its entry (markViewed). Persisted to localStorage so a reload does
   * not re-flag seen sessions.
   */
  lastViewedAt: Record<string, number>
  /** Page-load moment (epoch ms) — the default "viewed" time for every
   *  session until it is explicitly marked (or opened). */
  openedAt: number
  /** Mark a session as viewed (opened) right now. */
  markViewed: (sessionId: string) => void
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
  // ── model catalog (agentInfo._meta.modelState.availableModels) ─────
  models: ModelOption[]
  /** Memory files from memory_files (TUI memory modal). */
  memoryFiles?: { name: string; path?: string; size?: number; updatedAt?: unknown }[]
  /** Goal state from goal_updated (TUI goal panel). */
  goalState?: Record<string, unknown>
  /** Todo counts from plan updates (TUI status-bar todo badge). */
  todoCounts?: TodoCounts
  /** Todo items from plan updates (clickable badge panel). */
  todos?: TodoItem[]
  /** Diff review payloads from diff_review (TUI diff-review modal). */
  diffReview?: unknown[]
  /** Workflow runs keyed by run_id (TUI workflows pane). */
  workflowRuns: Record<string, { runId: string; name: string; status: string; phase?: string }>
  /** Bumped on hooks_changed / plugins_changed so modals can refresh. */
  hooksVersion: number
  // streaming pointers
  openAssistantId?: string
  openThoughtId?: string
  /**
   * User row id inserted optimistically by send(). Live user_chunk echoes
   * absorb into this row instead of appending a second UserPromptBlock.
   */
  pendingOptimisticUserId?: string
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
  /**
   * Sticky running-tasks bar under the top bar (TUI tasks pane). Toggled
   * by the ⠋N chip and the composer's idle still-running cue — shared so
   * either surface can open the same list.
   */
  tasksBarOpen: boolean
  setTasksBarOpen: (open: boolean) => void

  init: () => () => void
  send: (text: string) => Promise<void>
  cancel: () => Promise<void>
  respondPermission: (requestId: string, optionId?: string, cancelled?: boolean) => Promise<void>
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
  /** x.ai/sessions/changed — refresh the history list. */
  refreshSessions: () => Promise<void>
  /** Fetch git branch/worktree state for the active session (x.ai/git/info). */
  refreshGitInfo: () => Promise<void>
  newSession: () => Promise<void>
  refreshHosts: () => Promise<void>
  /** Switch the target host (hub mode); resets per-host UI state. */
  switchHost: (hostId: string) => Promise<void>
  /** session/setModel — switch the session's model (grok /model). */
  setModel: (modelId: string, reasoningEffort?: string) => Promise<void>
  /** History picker: fetch session list and open the overlay. */
  openHistory: () => Promise<void>
  closeHistory: () => void
  /** Load a historical session's updates; the host replays them via SSE. */
  loadHistory: (sessionId: string, cwd: string) => Promise<void>
  /** Fetch the next older page of the active history and prepend it. */
  loadMoreHistory: (anchorId?: string) => Promise<void>
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
  toggleGroupExpansion: (anchorId: string) => void
  /** Open / close the /session-info modal. */
  openSessionInfo: () => void
  closeSessionInfo: () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  entries: [],
  conn: 'connecting',
  statusText: '连接中…',
  awaitingNext: false,
  hosts: [],
  sessions: [],
  historyOpen: false,
  historyLoading: false,
  historyLoadedCount: 0,
  historyHasMore: false,
  historyLoadingMore: false,
  lastViewedAt: loadLastViewedAt(),
  // The page load moment is the default "viewed" time for every session:
  // opening the browser marks everything as read until new activity lands.
  openedAt: Date.now(),
  pending: [],
  xaiRequests: [],
  subagentIndex: {},
  bgTaskIndex: {},
  topTasks: [],
  mcpServers: [],
  mcpVersion: 0,
  models: [],
  workflowRuns: {},
  hooksVersion: 0,
  toolIndex: {},
  focusMode: 'prompt',
  selectedId: null,
  expandedGroups: new Set(),
  viewerEntryId: null,
  viewerTask: undefined,
  sessionInfoOpen: false,
  tasksBarOpen: false,
  setTasksBarOpen: (open) => set({ tasksBarOpen: open }),

  init: () => {
    const unsub = transport.onEvent((ev) => {
      const s = get()
      // While switching to a historical session (historyLoading), the agent
      // re-streams the whole conversation as part of session/load (recap).
      // Drop those SSE events — loadHistory rebuilds the scrollback from
      // paginated updates instead. Status events still pass through.
      if (s.historyLoading && ev.type !== 'hello' && ev.type !== 'ready') return
      // Multi-session host: every session-scoped event carries sessionId.
      // Keep only events for the active session (hello/ready always pass —
      // they announce the session we are switching to; when sessionId is
      // undefined we are mid-switch and must not leak the old session's
      // events into the fresh scrollback).
      const evSid = (ev as { sessionId?: string }).sessionId
      if (
        evSid != null &&
        evSid !== s.sessionId &&
        ev.type !== 'hello' &&
        ev.type !== 'ready'
      ) {
        return
      }
      s.handleEvent(ev)
    })
    transport.connect()
    void get().refreshHosts()
    return () => {
      unsub()
      transport.disconnect()
    }
  },

  refreshHosts: async () => {
    try {
      const { hosts, defaultHostId } = await transport.listHosts()
      set({ hosts })
      const s = get()
      if (s.selectedHostId) return
      // First selection: persisted choice → hub default → first online →
      // first local host (local mode).
      let saved: string | null = null
      try {
        saved = localStorage.getItem('acp-fe.host')
      } catch {
        /* ignore */
      }
      const pick =
        (saved ? hosts.find((h) => h.hostId === saved) : undefined) ??
        hosts.find((h) => h.hostId === defaultHostId) ??
        hosts.find((h) => h.online) ??
        hosts.find((h) => h.local) ??
        hosts[0]
      if (pick) void get().switchHost(pick.hostId)
    } catch {
      /* ignore */
    }
  },

  switchHost: async (hostId) => {
    if (hostId === get().selectedHostId) return
    get().stopTopTaskPolling()
    transport.setHost(hostId)
    try {
      localStorage.setItem('acp-fe.host', hostId)
    } catch {
      /* ignore */
    }
    const host = get().hosts.find((h) => h.hostId === hostId)
    clearSuppressedTools()
    set({
      selectedHostId: hostId,
      hostId,
      hostName: host?.hostName,
      sessionId: undefined,
      cwd: undefined,
      homeDir: undefined,
      entries: [],
      sessions: [],
      pending: [],
      xaiRequests: [],
      pendingOptimisticUserId: undefined,
      modes: undefined,
      error: undefined,
      statusWarning: undefined,
      conn: 'connecting',
      statusText: host ? '连接中…' : 'Host 未配对',
      historyOpen: false,
      historyTotalCount: undefined,
      historyLoadedCount: 0,
      historyHasMore: false,
      toolIndex: {},
      subagentIndex: {},
      bgTaskIndex: {},
      topTasks: [],
    })
    // Apply the host's status snapshot through the normal hello path so
    // model state, pending requests and busy flags hydrate consistently.
    try {
      const st = await transport.status()
      transport.emitLocal({ type: 'hello', ...st })
    } catch {
      set({ conn: 'error', statusText: 'Host 不可达' })
      return
    }
    void get().refreshSessions()
  },

  setModel: async (modelId, reasoningEffort) => {
    try {
      await transport.setModel(modelId, reasoningEffort)
      // Optimistic: agent broadcasts model_changed on success, but the
      // request itself is the authority for local state (TUI does the same).
      const m = get().models.find((x) => x.modelId === modelId)
      const def =
        m?.reasoningEfforts?.find((r) => r.default) ??
        m?.reasoningEfforts?.[0]
      // Prefer the wire value (canonical level) for the caption suffix.
      const effort =
        reasoningEffort ??
        def?.value ??
        def?.id ??
        m?.reasoningEffort
      set({
        modelName: m?.name || modelId,
        reasoningEffort: effort,
      })
    } catch (e) {
      appendEntry(set, {
        kind: 'session_event',
        text: `切换模型失败: ${e instanceof Error ? e.message : String(e)}`,
        warning: true,
      })
    }
  },

  openHistory: async () => {
    const s = get()
    if (s.sessions.length === 0) {
      try {
        const sessions = await transport.listSessions()
        set({ sessions })
      } catch {
        /* ignore */
      }
    }
    set({ historyOpen: true })
  },

  closeHistory: () => set({ historyOpen: false }),

  openSessionInfo: () => set({ sessionInfoOpen: true }),
  closeSessionInfo: () => set({ sessionInfoOpen: false }),

  /** Dismiss the top error/status banner (user acknowledged the message). */
  dismissNotice: () => set({ error: undefined, statusWarning: undefined }),

  loadHistory: async (sessionId: string, cwd: string) => {
    // Reset the scrollback; load the newest page, then auto-page older
    // history when the tail is all suppressed noise (e.g. orphan Bash
    // streams on "start acpfe") so the user still sees real messages.
    clearSuppressedTools()
    set({
      historyOpen: false,
      historyLoading: true,
      historyLoadedAt: undefined,
      historySessionId: sessionId,
      historyCwd: cwd,
      historyTotalCount: undefined,
      historyLoadedCount: 0,
      historyHasMore: false,
      historyLoadingMore: false,
      historyPrependedAt: undefined,
      historyAnchorId: undefined,
      entries: [],
      openAssistantId: undefined,
      openThoughtId: undefined,
      pendingOptimisticUserId: undefined,
      toolIndex: {},
      pending: [],
      xaiRequests: [],
      subagentIndex: {},
      bgTaskIndex: {},
      // NOTE: topTasks is NOT reset here — continueSession probes the
      // still-running set BEFORE loadHistory, and replayUpdates needs it
      // populated to skip "Task started" rows of running tasks (those
      // live in the top strip only). applyTopTaskProbe replaces the
      // strip contents wholesale (alive filter + additions), so stale
      // entries from a previous session cannot linger.
      gitInfo: undefined,
      yoloMode: undefined,
      autoMode: undefined,
      permissionMode: undefined,
      mcpServers: [],
      selectedId: null,
      focusMode: 'prompt',
      expandedGroups: new Set(),
      viewerEntryId: null,
      viewerTask: undefined,
      error: undefined,
      statusWarning: undefined,
      usage: undefined,
      todoCounts: undefined,
      todos: undefined,
      turnStartedAt: undefined,
    })
    try {
      let loaded = 0
      let total = 0
      let pages = 0
      // Cap auto-pages so a fully-suppressed archive cannot spin forever.
      const MAX_AUTO_PAGES = 30

      while (pages < MAX_AUTO_PAGES) {
        const r = await transport.loadSessionHistory(sessionId, cwd, {
          offset: -(loaded + HISTORY_PAGE_SIZE),
          limit: HISTORY_PAGE_SIZE,
        })
        const updates = r.updates ?? []
        const fetched = updates.length
        total = r.totalCount ?? total

        if (pages === 0) {
          // Newest page: rebuild from scratch.
          replayUpdates(get, updates)
        } else {
          // Older page: same prepend semantics as loadMoreHistory.
          const split = get().entries.length
          replayUpdates(get, updates)
          const after = get()
          let oldEntries = after.entries.slice(0, split)
          const newEntries = after.entries.slice(split).map((e, i, arr) =>
            i === arr.length - 1 && e.kind === 'assistant'
              ? { ...e, streaming: false }
              : e,
          )
          const lastNew = newEntries[newEntries.length - 1]
          const firstOld = oldEntries[0]
          if (lastNew?.kind === 'assistant' && firstOld?.kind === 'assistant') {
            newEntries[newEntries.length - 1] = {
              ...lastNew,
              text: lastNew.text + firstOld.text,
            }
            oldEntries = oldEntries.slice(1)
          }
          set({
            entries: [...newEntries, ...oldEntries],
            openAssistantId: undefined,
            openThoughtId: undefined,
          })
        }

        pages += 1
        loaded =
          fetched === 0
            ? total || loaded
            : Math.min(loaded + fetched, total || loaded + fetched)

        // Replay is a settled transcript: seal mid-stream leftovers.
        const settled =
          get().turnStartedAt == null
            ? settleTurnEntries(get().entries)
            : get().entries
        const hasMore = (total || 0) > loaded && fetched > 0
        set({
          historyTotalCount: total || undefined,
          historyLoadedCount: loaded,
          historyHasMore: hasMore,
          conn: 'ready',
          entries: settled,
        })

        if (hasDisplayableScrollback(settled)) break
        if (!hasMore) break
        set({
          statusText: `历史偏空，继续加载更早记录… (${loaded}/${total || '?'})`,
        })
      }

      set({
        historyLoading: false,
        // Replay of stored thought chunks drives conn to 'busy'; history is
        // not a live turn — the user must be able to type right away.
        conn: 'ready',
        statusText: `历史已加载 (共 ${get().historyTotalCount ?? '?'} 条更新)`,
        historyLoadedAt: Date.now(),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        historyLoading: false,
        conn: 'ready',
        statusText: '历史加载失败',
        entries: [...get().entries, { id: nid(), kind: 'error', text: msg }],
      })
    }
  },

  continueSession: async (sessionId: string, cwd: string) => {
    if (get().historyLoading || get().historyLoadingMore) return
    // Opening a conversation counts as viewing it — finished bg tasks
    // stop being 待处理 from this moment on.
    get().markViewed(sessionId)
    set({ historyOpen: false, historyLoading: true })
    try {
      // 1) Make this session the active one (session/load or focus-if-busy);
      // 2) load its tail. Models come from the HTTP response — more reliable
      // than waiting for the SSE ready event, which can race historyLoading.
      const loaded = await transport.loadSession(sessionId, cwd)
      if (loaded.models != null || loaded.modes != null) {
        const modelSnap = applySessionModelState(loaded.models, undefined)
        set({
          ...modelSnap,
          ...(loaded.modes != null ? { modes: loaded.modes } : {}),
        })
      }
      // Anchor sessionId before history so live events for this session are
      // accepted once historyLoading drops (multi-session filter). The ready
      // event's cwd may land in the drop window below, so set it here too.
      set({ sessionId, cwd })
      // Restored sessions may live in a different workspace — refresh the
      // git branch/worktree state instead of waiting on the ready event.
      void get().refreshGitInfo()
      // Probe the still-running set BEFORE history replay: replayUpdates
      // skips the "Task started" row of any task that is still running
      // (that state lives in the top task strip only — see replayUpdates).
      // Probing first closes the window where the newest page would
      // otherwise render a dangling started row with no completion.
      await get().replayRunningTasks(sessionId, cwd)
      await get().loadHistory(sessionId, cwd)
      get().startTopTaskPolling(sessionId, cwd)
      // Grace window: session/load recap events stream over SSE and may still
      // be in flight (SSE and fetch are separate channels) — keep dropping
      // them briefly before reopening the live pipeline.
      set({ historyLoading: true })
      window.setTimeout(() => {
        // Re-apply the load response's SessionModelState — a stale hello
        // (EventSource reconnect) or the load's own ready may have raced
        // in with process-global models while historyLoading; the HTTP
        // response is the authority for the restored session.
        if (loaded.models != null) {
          const modelSnap = applySessionModelState(loaded.models, undefined)
          set({ ...modelSnap })
        }
        // Focusing an in-flight session: busy SSE was likely dropped while
        // historyLoading; restore spinner from the HTTP busy flag.
        if (loaded.busy) {
          // Anchor the turn timer so the composer shows "Worked for Xs"
          // instead of a dead spinner. Busy SSE was likely dropped while
          // historyLoading; turnStartedAt keeps the elapsed clock live.
          set({
            historyLoading: false,
            conn: 'busy',
            statusText: 'Waiting for Host',
            awaitingNext: false,
            sessionId,
            turnStartedAt: Date.now(),
          })
        } else {
          set({
            historyLoading: false,
            statusText: `已切换到会话 ${sessionId.slice(0, 8)}，可继续对话`,
            sessionId,
          })
        }
        // TUI rebuilds the tasks pane from the live registry after load —
        // history page + the historyLoading SSE drop can miss a still-
        // running task. Align bg_task rows with x.ai/task/list.
        void get().syncLiveTasks()
      }, 500)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        historyLoading: false,
        statusText: '切换会话失败',
        entries: [...get().entries, { id: nid(), kind: 'error', text: msg }],
      })
    }
  },

  loadMoreHistory: async (anchorId?: string) => {
    const s = get()
    if (
      s.historyLoading ||
      s.historyLoadingMore ||
      !s.historyHasMore ||
      !s.historySessionId ||
      !s.historyCwd
    ) {
      return
    }
    set({ historyLoadingMore: true, historyAnchorId: anchorId })
    const loaded = s.historyLoadedCount
    try {
      const r = await transport.loadSessionHistory(s.historySessionId, s.historyCwd, {
        offset: -(loaded + HISTORY_PAGE_SIZE),
        limit: HISTORY_PAGE_SIZE,
      })
      const fetched = r.updates?.length ?? 0
      // Replay appends; remember where the previous timeline started so the
      // new (older) page can be moved in front of it afterwards.
      const split = get().entries.length
      replayUpdates(get, r.updates ?? [])
      const after = get()
      let oldEntries = after.entries.slice(0, split)
      const newEntries = after.entries.slice(split).map((e, i, arr) =>
        i === arr.length - 1 && e.kind === 'assistant' ? { ...e, streaming: false } : e,
      )
      // Page boundaries can cut an assistant message in half; stitch the
      // continuation (first old entry) onto the new page's last entry.
      const lastNew = newEntries[newEntries.length - 1]
      const firstOld = oldEntries[0]
      if (lastNew?.kind === 'assistant' && firstOld?.kind === 'assistant') {
        newEntries[newEntries.length - 1] = { ...lastNew, text: lastNew.text + firstOld.text }
        oldEntries = oldEntries.slice(1)
      }
      const total = r.totalCount ?? s.historyTotalCount ?? loaded + fetched
      const loadedNew = fetched === 0 ? total : Math.min(loaded + fetched, total)
      // Same settled-transcript rule as loadHistory: a tool that is still
      // running here never received its completion in any loaded page
      // (its update was dropped for an unknown id when the newer page
      // replayed first) — close it out instead of leaving "Running …"
      // stuck on a historical page boundary. Skipped while a live turn
      // is in flight (turnStartedAt set).
      const merged = [...newEntries, ...oldEntries]
      set({
        entries: get().turnStartedAt == null ? settleTurnEntries(merged) : merged,
        openAssistantId: undefined,
        openThoughtId: undefined,
        // Replay of stored thought chunks drives conn to 'busy' — paging
        // history is not a live turn.
        conn: 'ready',
        historyLoadingMore: false,
        historyTotalCount: total,
        historyLoadedCount: loadedNew,
        historyHasMore: total > loadedNew,
        historyPrependedAt: Date.now(),
      })
    } catch {
      set({ historyLoadingMore: false })
    }
  },

  replayRunningTasks: async (sessionId, cwd) => {
    try {
      const r = await transport.sessionRunningTasks(sessionId, cwd)
      applyTopTaskProbe(get, set, r.events ?? [])
    } catch {
      // Offline / host without the endpoint — history-only view still works.
    }
  },

  refreshTopTasks: async (sessionId, cwd) => {
    // Periodic liveness refresh: TUI-owned tasks emit no events to this
    // host, so the strip converges via the probe (drop dead, add new).
    try {
      const r = await transport.sessionRunningTasks(sessionId, cwd)
      applyTopTaskProbe(get, set, r.events ?? [])
    } catch {
      // Transient offline — keep the last known strip state.
    }
  },

  startTopTaskPolling: (sessionId, cwd) => {
    get().stopTopTaskPolling()
    topTaskTimer = window.setInterval(() => {
      void get().refreshTopTasks(sessionId, cwd)
    }, TOP_TASK_POLL_MS)
  },

  stopTopTaskPolling: () => {
    if (topTaskTimer != null) {
      window.clearInterval(topTaskTimer)
      topTaskTimer = null
    }
  },

  markViewed: (sessionId) => {
    if (!sessionId) return
    const next = { ...get().lastViewedAt, [sessionId]: Date.now() }
    set({ lastViewedAt: next })
    persistLastViewedAt(next)
  },

  handleEvent: (ev) => {
    switch (ev.type) {
      case 'hello': {
        // Hub-level hello (acp-hub): registry info, no session state —
        // the selected host's snapshot is applied by switchHost.
        if (ev.service === 'hub') {
          set({ conn: 'ready', statusText: '就绪' })
          if (ev.hosts) set({ hosts: ev.hosts })
          void get().refreshHosts()
          break
        }
        const modelSnap = applySessionModelState(ev.models, ev.agentInfo)
        const reqs = ev.pendingRequests || []
        set({
          conn: ev.ready ? 'ready' : ev.error ? 'error' : 'connecting',
          statusText: ev.error || (ev.ready ? '就绪' : '启动中…'),
          sessionId: ev.sessionId,
          cwd: ev.cwd,
          homeDir: ev.homeDir,
          hostId: ev.hostId,
          hostName: ev.hostName,
          pending: reqs.filter((r) => !r.method.startsWith('x.ai/')),
          xaiRequests: reqs.filter((r) => r.method.startsWith('x.ai/')),
          modes: ev.modes,
          error: ev.error,
          statusWarning: undefined,
          ...modelSnap,
        })
        if (ev.busy) {
          // Preserve an existing turn timer across mid-turn re-busy/reconnect;
          // otherwise anchor it now (same rule as the `busy` event handler).
          const busyTurn = get().turnStartedAt ?? Date.now()
          set({
            conn: 'busy',
            statusText: 'Waiting for Host',
            awaitingNext: false,
            turnStartedAt: busyTurn,
            error: undefined,
            statusWarning: undefined,
          })
        }
        // Agent hello announces the active session — fetch git state now
        // (git_head_changed is fire-and-forget; a fresh page would miss it).
        if (ev.cwd) {
          set({ sessionId: ev.sessionId, cwd: ev.cwd })
          void get().refreshGitInfo()
        }
        // The user is looking at the announced session — mark it viewed
        // so finished bg tasks don't re-flag it as 待处理.
        if (ev.sessionId) get().markViewed(ev.sessionId)
        break
      }
      case 'ready': {
        // Prefer `ev.models` (session/new|load SessionModelState) — agentInfo
        // alone is the process-global initialize snapshot and is stale after
        // session/load restores a different session model.
        const modelSnap = applySessionModelState(ev.models, ev.agentInfo)
        set({
          conn: 'ready',
          // Keep "待处理" if a turn just finished; otherwise plain idle.
          statusText: get().awaitingNext ? '待处理' : '就绪',
          sessionId: ev.sessionId,
          cwd: ev.cwd,
          hostId: ev.hostId,
          hostName: ev.hostName,
          modes: ev.modes,
          error: undefined,
          statusWarning: undefined,
          ...modelSnap,
        })
        void get().refreshHosts()
        void get().refreshGitInfo()
        break
      }
      case 'busy': {
        // TUI pre-creates Thinking… before first thought delta arrives
        // (tracker.rs ensure_thinking / pre-create thinking block).
        const s = get()
        // Anchor the "Worked for Xs" timer; don't reset on mid-turn re-busy.
        const turnStartedAt = s.turnStartedAt ?? Date.now()
        if (!s.openThoughtId) {
          const id = nid()
          set({
            conn: 'busy',
            statusText: 'Thinking',
            awaitingNext: false,
            openThoughtId: id,
            openAssistantId: undefined,
            turnStartedAt,
            // A turn starting means the system recovered — clear stale
            // error/status banners.
            error: undefined,
            statusWarning: undefined,
            entries: [
              ...s.entries,
              {
                id,
                kind: 'thought',
                text: '',
                open: true, // live: show flowing body
                streaming: true,
                startedAt: Date.now(),
              },
            ],
          })
        } else {
          set({
            conn: 'busy',
            statusText: 'Thinking',
            awaitingNext: false,
            turnStartedAt,
            error: undefined,
            statusWarning: undefined,
          })
        }
        break
      }
      case 'user_message':
      case 'user_chunk': {
        // Live echo (user_chunk) or history replay (user_message). Classify
        // like TUI handle_user_message: cron → UserPromptBlock::cron, other
        // system-reminder / auto-wake echoes → hidden, else normal prompt.
        const raw = ev.text || ''
        if (!raw) break
        const classified = classifyUserPrompt(raw, ev.type === 'user_message' ? ev.isCron : undefined)
        if (!classified) break
        const sealed = sealThought(get())
        const entries = sealed.entries.map((e) =>
          e.id === sealed.openAssistantId && e.kind === 'assistant'
            ? { ...e, streaming: false }
            : e,
        )
        const ts = ev.type === 'user_message' ? (ev.ts ?? Date.now()) : Date.now()

        // send() already appended a UserPromptBlock for interactive prompts;
        // the agent then echoes the same turn as user_message_chunk →
        // user_chunk. Absorb the echo into that row so scrollback does not
        // show two identical user messages. Cron/inject paths never set
        // pendingOptimisticUserId and still create a fresh row.
        if (ev.type === 'user_chunk') {
          const absorbIdx = findOptimisticUserAbsorbIndex(
            entries,
            get().pendingOptimisticUserId,
            classified.text,
          )
          if (absorbIdx >= 0) {
            set({
              ...sealed,
              openAssistantId: undefined,
              pendingOptimisticUserId: undefined,
              entries: entries.map((e, i) =>
                i === absorbIdx && e.kind === 'user'
                  ? {
                      ...e,
                      // Prefer classified body (wrappers / cron framing stripped).
                      text: classified.text,
                      isCron: classified.isCron || e.isCron || undefined,
                      expanded: false,
                    }
                  : e,
              ),
            })
            break
          }
        }

        set({
          ...sealed,
          openAssistantId: undefined,
          pendingOptimisticUserId: undefined,
          entries: [
            ...entries,
            {
              id: nid(),
              kind: 'user',
              text: classified.text,
              isCron: classified.isCron || undefined,
              ts,
              expanded: false,
            },
          ],
        })
        break
      }
      case 'chunk': {
        const text = ev.text || ''
        const ts = ev.ts ?? Date.now()
        // seal open thought when assistant starts speaking
        const sealed = sealThought(get())
        const { openAssistantId, entries } = sealed
        if (openAssistantId) {
          set({
            ...sealed,
            conn: 'busy',
            statusText: 'Waiting for Responding',
            awaitingNext: false,
            entries: entries.map((e) =>
              e.id === openAssistantId && e.kind === 'assistant'
                ? { ...e, text: e.text + text, streaming: true }
                : e,
            ),
          })
        } else {
          const id = nid()
          set({
            ...sealed,
            conn: 'busy',
            statusText: 'Waiting for Responding',
            awaitingNext: false,
            openAssistantId: id,
            openThoughtId: undefined,
            entries: [...entries, { id, kind: 'assistant', text, streaming: true, ts }],
          })
        }
        break
      }
      case 'thought': {
        const text = ev.text || ''
        if (!text) break
        const s = get()
        let openThoughtId = s.openThoughtId
        let entries = s.entries

        // If placeholder missing (reconnect mid-turn), create one
        if (!openThoughtId || !entries.some((e) => e.id === openThoughtId && e.kind === 'thought')) {
          const id = nid()
          openThoughtId = id
          entries = [
            ...entries,
            {
              id,
              kind: 'thought',
              text: '',
              open: true,
              streaming: true,
              startedAt: Date.now(),
              // Replay carries the server-reported original duration
              // (agentTimestampMs - streamStartMs); live chunks have none
              // and seal against the local timer instead.
              ...(ev.elapsedMs != null ? { elapsedMs: ev.elapsedMs } : {}),
            },
          ]
        }

        set({
          conn: 'busy',
          statusText: 'Thinking',
          awaitingNext: false,
          openThoughtId,
          openAssistantId: undefined,
          entries: entries.map((e) =>
            e.id === openThoughtId && e.kind === 'thought'
              ? {
                  ...e,
                  text: e.text + text,
                  streaming: true,
                  open: true, // keep body visible while flowing
                  // Last chunk wins (TUI tracker updates on every chunk).
                  ...(ev.elapsedMs != null ? { elapsedMs: ev.elapsedMs } : {}),
                }
              : e,
          ),
        })
        break
      }
      case 'tool_call': {
        const sealed = sealThought(get())
        const tc = ev.toolCall || {}
        const toolCallId = toolCallIdOf(tc)
        // TUI: bg-task plumbing / background execute / task-spawn / todo /
        // goal / scheduler / workflow never become tool rows — their UI
        // lives on BgTask / Subagent / chips. Otherwise get_*_output dumps
        // appear as "Ran other" with the full task log in scrollback.
        if (toolCallId && suppressedToolIds.has(toolCallId)) {
          absorbTaskOutputIntoBgTask(get, set, tc)
          break
        }
        if (shouldSuppressToolFromScrollback(tc)) {
          if (toolCallId) suppressedToolIds.add(toolCallId)
          absorbTaskOutputIntoBgTask(get, set, tc)
          // Still seal thought so the next real row doesn't sit under an
          // open Thinking… shell (TUI finish_thinking on tool start).
          set({
            ...sealed,
            openAssistantId: undefined,
            openThoughtId: undefined,
          })
          break
        }
        const status = (tc.status as string) || 'pending'
        const kindName = (tc.kind as string) || 'other'
        const running = status === 'pending' || status === 'in_progress'
        const title = extractTarget(tc) || (tc.title as string) || kindName
        const id = nid()
        const entry: ScrollEntry = {
          id,
          kind: 'tool',
          toolCallId,
          title,
          verb: toolVerb(kindName, running),
          status,
          kindName,
          detail: tc.title as string | undefined,
          expanded: false,
          raw: tc,
        }
        const toolIndex = { ...get().toolIndex }
        if (toolCallId) toolIndex[toolCallId] = id
        set({
          ...sealed,
          openAssistantId: undefined,
          openThoughtId: undefined,
          toolIndex,
          entries: [...sealed.entries, entry],
        })
        break
      }
      case 'tool_call_update': {
        const tc = ev.toolCallUpdate || {}
        const toolCallId = toolCallIdOf(tc)
        if (!toolCallId) break
        if (suppressedToolIds.has(toolCallId)) {
          // Final TaskOutput / Bash stream — fold log into bg_task.
          absorbTaskOutputIntoBgTask(get, set, tc)
          absorbBashOutputIntoBgTask(get, set, tc)
          break
        }
        const entryId = get().toolIndex[toolCallId]
        // Late classification: raw_input arrives on update (is_background,
        // variant=TaskOutput, …). Demote any flash row and suppress further
        // updates — stdout belongs on the bg_task block (dblclick viewer).
        if (entryId) {
          const existing = get().entries.find((e) => e.id === entryId)
          const merged: ToolCall =
            existing?.kind === 'tool'
              ? { ...(existing.raw || {}), ...tc }
              : tc
          if (
            shouldSuppressToolFromScrollback(merged) ||
            isOrphanBashStreamUpdate(merged)
          ) {
            suppressedToolIds.add(toolCallId)
            const { [toolCallId]: _drop, ...toolIndex } = get().toolIndex
            set({
              toolIndex,
              entries: get().entries.filter((e) => e.id !== entryId),
            })
            absorbTaskOutputIntoBgTask(get, set, merged)
            absorbBashOutputIntoBgTask(get, set, merged)
            break
          }
        } else if (
          shouldSuppressToolFromScrollback(tc) ||
          isOrphanBashStreamUpdate(tc)
        ) {
          // Page-boundary orphan: history tail is pure Bash stream deltas
          // for a backgrounded execute whose tool_call lived on an earlier
          // page ("start acpfe" last-100 = vite/host logs as "Ran other").
          suppressedToolIds.add(toolCallId)
          absorbTaskOutputIntoBgTask(get, set, tc)
          absorbBashOutputIntoBgTask(get, set, tc)
          break
        }
        if (!entryId) {
          // treat as new
          get().handleEvent({ type: 'tool_call', toolCall: tc })
          break
        }
        set({
          entries: get().entries.map((e) => {
            if (e.id !== entryId || e.kind !== 'tool') return e
            const merged: ToolCall = { ...(e.raw || {}), ...tc }
            const status = (merged.status as string) || e.status
            const kindName = (merged.kind as string) || e.kindName || 'other'
            const running = status === 'pending' || status === 'in_progress'
            const wasRunning =
              e.status === 'pending' || e.status === 'in_progress'
            // Finish flash: stamp finishedAt when a running tool settles
            const finishedAt =
              wasRunning && !running ? Date.now() : e.finishedAt
            return {
              ...e,
              status,
              kindName,
              verb: toolVerb(kindName, running),
              title: extractTarget(merged) || e.title,
              raw: merged,
              finishedAt,
            }
          }),
        })
        break
      }
      case 'plan': {
        // Plan updates are the todo source (TUI todo pane + status-bar
        // badge). Matches the TUI: plan entries never land in the
        // scrollback — the TopBar TodoChip is the single display surface.
        const { items, counts } = planTodos(ev.entries)
        set({
          openAssistantId: undefined,
          todoCounts: counts,
          todos: items,
        })
        break
      }
      case 'usage':
        // Merge, don't overwrite: streamed session/update usage events
        // carry only `used`/`size` (no usage object) and must not clobber
        // the turn-accumulated count; x.ai turn_completed events carry the
        // standard usage object but may lack _meta.totalTokens (keep last
        // used). The turn total is the standard usage.totalTokens /
        // total_tokens field — the frontend separates it from the
        // context-window `used`.
        set((s) => {
          const u = ev.usage
          const turnTokens =
            typeof u?.totalTokens === 'number'
              ? u.totalTokens
              : typeof u?.total_tokens === 'number'
                ? u.total_tokens
                : s.usage?.turnTokens
          return {
            usage: {
              used: ev.used ?? s.usage?.used,
              size: ev.size ?? s.usage?.size,
              turnTokens,
            },
          }
        })
        break
      case 'done': {
        // TUI TurnCompleted marker ("Worked for 2.0s") — the last scrollback
        // line above the composer, mirroring turn_completion.rs. Idempotent:
        // prompt_complete may race ahead and finalize the turn first.
        const turnStart = get().turnStartedAt
        const marker = turnIsLive(get())
          ? turnMarker(turnStart != null ? Date.now() - turnStart : undefined)
          : null
        set((s) => ({
          conn: 'ready',
          // Blue "待处理" until the next user message.
          statusText: '待处理',
          awaitingNext: true,
          openAssistantId: undefined,
          openThoughtId: undefined,
          turnStartedAt: undefined,
          entries: [
            ...settleTurnEntries(s.entries),
            ...(marker ? [marker] : []),
          ],
        }))
        break
      }
      case 'turn_completed': {
        // Replayed history: seal the finished turn's streaming blocks
        // (live turns finalize via `done`). Idempotent — no-op when the
        // turn was already settled (stored history may carry both
        // response_completed and turn_completed for one turn; the
        // tailAlreadyTurnEnded guard skips the duplicate).
        //
        // The turn-end marker is the plain "Turn completed." form —
        // replay must not fabricate "Worked for Xs" live timing. The
        // idle watcher cue ("N commands still running") is NOT a
        // scrollback line — it lives in the composer turn-status line
        // (TUI turn_status.rs idle arm), gated on awaitingNext.
        const sealed = sealThought(get())
        const settled = settleTurnEntries(sealed.entries)
        if (tailAlreadyTurnEnded(settled)) {
          set({
            ...sealed,
            openAssistantId: undefined,
            openThoughtId: undefined,
            entries: settled,
          })
          break
        }
        set({
          ...sealed,
          openAssistantId: undefined,
          openThoughtId: undefined,
          // Idle until the next user message — lets the turn-status line
          // show the still-running cue after a replayed history load.
          awaitingNext: true,
          entries: [...settled, turnMarker(undefined)],
        })
        break
      }
      case 'cancelled': {
        // TUI TurnCancelled marker ("Turn cancelled by user in 2.0s.").
        // Idempotent: prompt_complete may have already finalized the turn.
        const turnStart = get().turnStartedAt
        const marker: ScrollEntry | null = turnIsLive(get())
          ? {
              id: nid(),
              kind: 'session_event',
              text:
                turnStart != null
                  ? `Turn cancelled by user in ${formatTurnDuration(Date.now() - turnStart)}.`
                  : 'Turn cancelled.',
            }
          : null
        set((s) => ({
          conn: 'ready',
          statusText: '待处理',
          awaitingNext: true,
          openAssistantId: undefined,
          openThoughtId: undefined,
          turnStartedAt: undefined,
          xaiRequests: [], // host answered every pending x.ai request already
          entries: [
            ...s.entries.map((e) => {
              if (e.kind === 'thought' && e.streaming) {
                return { ...e, streaming: false, finishedAt: Date.now(), open: false }
              }
              if (
                e.kind === 'tool' &&
                (e.status === 'pending' || e.status === 'in_progress')
              ) {
                return {
                  ...e,
                  status: 'cancelled',
                  verb: toolVerb(e.kindName, false),
                  finishedAt: Date.now(),
                }
              }
              return e
            }),
            ...(marker ? [marker] : []),
          ],
        }))
        break
      }
      case 'error':
        set({
          conn: 'error',
          statusText: ev.message,
          error: ev.message,
          statusWarning: undefined,
          turnStartedAt: undefined,
          entries: [...get().entries, { id: nid(), kind: 'error', text: ev.message }],
        })
        break
      case 'status':
        // Host status (connection warnings) is surfaced in the top-left
        // host button and the composer status line — deliberately NOT in
        // the scrollback.
        set({
          statusText: ev.text,
          statusWarning: ev.text,
        })
        break
      case 'task_lifecycle': {
        // History replay renders stored task lifecycle events with the
        // SAME look as live bg_task rows — but the entry is NOT captured
        // into the task system: no bgTaskIndex entry, never running, no
        // kill button, no ⠋N / running-bar membership. The live running
        // set comes from the host probe at resume (replayRunningTasks).
        appendEntry(set, {
          kind: 'bg_task',
          title: ev.title,
          status: ev.kind === 'started' ? 'started' : ev.failed ? 'failed' : 'completed',
          running: false,
          taskId: ev.taskId,
          command: ev.command,
          isMonitor: ev.isMonitor,
          output: ev.output,
          finishedAt: Date.now(),
        })
        break
      }
      case 'client_request': {
        const method = ev.method || ''
        if (method.startsWith('x.ai/')) {
          // Only interactive extension requests get UI; everything else is
          // answered immediately so the agent never hangs on a timeout.
          const SUPPORTED = new Set(['x.ai/ask_user_question', 'x.ai/exit_plan_mode'])
          if (!SUPPORTED.has(method)) {
            void get().respondXai(
              ev.requestId,
              undefined,
              `前端不支持方法 ${method}`,
            )
            break
          }
          set({
            xaiRequests: [
              ...get().xaiRequests.filter((r) => r.requestId !== ev.requestId),
              { requestId: ev.requestId, method, params: ev.params },
            ],
          })
        } else {
          set({
            pending: [
              ...get().pending.filter((p) => p.requestId !== ev.requestId),
              { requestId: ev.requestId, method: ev.method, params: ev.params },
            ],
          })
        }
        break
      }
      // ── x.ai/* extension notifications ────────────────────────────
      case 'session_notification': {
        const { tag, fields } = extractSessionUpdate(ev.params)
        if (!tag) break
        switch (tag) {
          case 'subagent_spawned':
          case 'subagent_finished':
            handleSubagentEvent(get, set, tag, fields)
            break
          case 'task_backgrounded':
            handleTaskBackgrounded(get, set, fields)
            break
          case 'task_completed':
            handleTaskCompleted(get, set, fields)
            break
          case 'monitor_event': {
            // Stdout accumulation for BOTH live rows (bgTaskIndex) and
            // history-replay display rows (no index — match by taskId
            // over entries so replayed tasks keep their log inline).
            const taskId = wireTaskId(fields.task_id, fields.taskId)
            if (!taskId) break
            const text =
              (typeof fields.event_text === 'string' && fields.event_text) ||
              (typeof fields.eventText === 'string' && fields.eventText) ||
              ''
            if (!text) break
            const entryId = get().bgTaskIndex[taskId]
            const eid =
              entryId ??
              get().entries.find(
                (e) => e.kind === 'bg_task' && e.taskId === taskId,
              )?.id
            if (!eid) break
            set({
              entries: get().entries.map((e) =>
                e.id === eid && e.kind === 'bg_task'
                  ? {
                      ...e,
                      output: (e.output ?? '') + text,
                      // Keep a short tail on the row detail for glanceability.
                      detail:
                        text.trim().split('\n').filter(Boolean).slice(-1)[0] ||
                        e.detail,
                    }
                  : e,
              ),
            })
            break
          }
          case 'response_started': {
            // A new LLM response started — finish any in-flight thought.
            const sealed = sealThought(get())
            set({ ...sealed, statusText: 'Thinking' })
            break
          }
          case 'reasoning_completed':
            set({ statusText: 'Waiting for Responding' })
            break
          case 'auto_compact_started': {
            const pct = fields.percentage as number | undefined
            appendEntry(set, {
              kind: 'session_event',
              text: `自动压缩上下文… (${pct ?? '?'}%)`,
              streaming: false,
            })
            break
          }
          case 'auto_compact_completed': {
            appendEntry(set, { kind: 'session_event', text: '自动压缩完成' })
            break
          }
          case 'auto_compact_failed': {
            appendEntry(set, {
              kind: 'session_event',
              text: `自动压缩失败: ${String(fields.error ?? '未知错误')}`,
              warning: true,
            })
            break
          }
          case 'auto_compact_cancelled':
            appendEntry(set, { kind: 'session_event', text: '自动压缩已取消' })
            break
          case 'auto_continue_completed': {
            const tokens = fields.total_tokens as number | undefined
            appendEntry(set, {
              kind: 'session_event',
              text: `继续生成${tokens != null ? ` (共 ${tokens} tokens)` : ''}`,
            })
            break
          }
          case 'image_compressed':
            appendEntry(set, {
              kind: 'session_event',
              text: `图片已压缩${fields.message ? `: ${String(fields.message)}` : ''}`,
            })
            break
          case 'session_recap': {
            const summary = typeof fields.summary === 'string' ? fields.summary : ''
            if (!summary.trim()) break
            appendEntry(set, {
              kind: 'session_event',
              text: `摘要: ${summary}`,
              recap: true,
              open: false,
            })
            break
          }
          case 'session_recap_unavailable':
            appendEntry(set, {
              kind: 'session_event',
              text: '暂无会话摘要（尚无对话内容）',
              recap: true,
              open: false,
            })
            break
          // ── memory system (TUI memory modal + scrollback lines) ──────
          case 'memory_flush_started':
            appendEntry(set, { kind: 'session_event', text: '记忆刷新…' })
            break
          case 'memory_flush_completed': {
            const r = String(fields.result ?? '')
            appendEntry(set, {
              kind: 'session_event',
              text: `记忆刷新完成${r ? `: ${r.slice(0, 120)}` : ''}`,
            })
            break
          }
          case 'memory_dream_completed': {
            const r = String(fields.result ?? '')
            appendEntry(set, {
              kind: 'session_event',
              text: `记忆整合完成${r ? `: ${r.slice(0, 120)}` : ''}`,
            })
            break
          }
          case 'memory_session_saved': {
            const p = String(fields.path ?? '')
            appendEntry(set, {
              kind: 'session_event',
              text: `会话记忆已保存${p ? ` → ${p}` : ''}`,
            })
            break
          }
          case 'memory_files': {
            const files = Array.isArray(fields.files) ? fields.files : []
            set({ memoryFiles: files as { name: string; path?: string; size?: number; updatedAt?: unknown }[] })
            const names = files
              .map((f) => (f as { name?: unknown }).name)
              .filter((n): n is string => typeof n === 'string')
              .join(', ')
            appendEntry(set, {
              kind: 'session_event',
              text: `记忆文件 ${files.length} 个${names ? `（${names.slice(0, 80)}）` : ''}`,
            })
            break
          }
          // ── retry / recovery ─────────────────────────────────────────
          case 'retry_state': {
            const f = fields as Record<string, unknown>
            const attempt = f.attempt
            appendEntry(set, {
              kind: 'session_event',
              text: attempt != null ? `重试中… (attempt ${String(attempt)})` : '重试中…',
              warning: true,
            })
            break
          }
          case 'auto_recovery_started': {
            const f = fields as Record<string, unknown>
            const err = typeof f.error === 'string' ? f.error.slice(0, 100) : ''
            appendEntry(set, {
              kind: 'session_event',
              text: `自动恢复中 (attempt ${String(f.attempt ?? '?')}/${String(f.max_retries ?? '?')})${err ? `: ${err}` : ''}`,
              warning: true,
            })
            break
          }
          case 'auto_recovery_exhausted':
            appendEntry(set, {
              kind: 'session_event',
              text: '自动恢复失败，重试次数已用尽',
              warning: true,
            })
            break
          // ── images ───────────────────────────────────────────────────
          case 'image_dropped': {
            const notes = Array.isArray(fields.notes)
              ? fields.notes.map(String).join('\n')
              : ''
            appendEntry(set, {
              kind: 'session_event',
              text: `图片未发送${notes ? `: ${notes}` : ''}`,
              warning: true,
            })
            break
          }
          // ── hooks / plugins (TUI hook annotations on tool blocks) ────
          case 'hook_annotation': {
            const msg = typeof fields.message === 'string' ? fields.message : ''
            if (msg.trim()) appendEntry(set, { kind: 'session_event', text: msg })
            break
          }
          case 'hook_execution': {
            const f = fields as Record<string, unknown>
            const evName = typeof f.event_name === 'string' ? f.event_name : ''
            const tool = typeof f.tool_name === 'string' ? f.tool_name : ''
            const runs = Array.isArray(f.runs) ? f.runs.length : 0
            appendEntry(set, {
              kind: 'session_event',
              text: `🪝 ${evName}${tool ? ` for ${tool}` : ''}${runs ? ` (${runs} 条运行)` : ''}`,
            })
            break
          }
          case 'hooks_changed':
          case 'plugins_changed':
            // No modal in the web UI; bump the version so future panels
            // can refresh, without spamming the scrollback.
            set((s) => ({ hooksVersion: s.hooksVersion + 1 }))
            break
          case 'plugin_updates_installed': {
            const updates = Array.isArray(fields.updates)
              ? fields.updates.map(String).join(', ')
              : ''
            appendEntry(set, {
              kind: 'session_event',
              text: `插件已更新${updates ? `: ${updates}` : ''}`,
            })
            break
          }
          // ── session title ────────────────────────────────────────────
          case 'session_summary_generated': {
            const title =
              typeof fields.session_summary === 'string'
                ? fields.session_summary.trim()
                : ''
            if (title) set({ sessionTitle: title })
            break
          }
          // ── model switches (TUI ModelUnavailable block / remote switch) ─
          case 'model_auto_switched': {
            const prev = String(fields.previous_model_id ?? '')
            const next = String(fields.new_model_id ?? '')
            const reason = String(fields.reason ?? '')
            set({ modelName: next || undefined })
            appendEntry(set, {
              kind: 'session_event',
              text: `模型 ${prev} 不可用，已切换为 ${next}${reason ? `（${reason}）` : ''}`,
              warning: true,
            })
            break
          }
          case 'model_changed': {
            const id =
              (typeof fields.model_id === 'string' && fields.model_id) ||
              (typeof fields.modelId === 'string' && fields.modelId) ||
              ''
            if (!id) break
            const m = get().models.find((x) => x.modelId === id)
            const effortRaw =
              fields.reasoning_effort ??
              fields.reasoningEffort ??
              (fields._meta &&
              typeof fields._meta === 'object' &&
              fields._meta !== null
                ? (fields._meta as Record<string, unknown>).reasoningEffort ??
                  (fields._meta as Record<string, unknown>).reasoning_effort
                : undefined)
            const effort =
              typeof effortRaw === 'string' && effortRaw.trim()
                ? effortRaw.trim()
                : get().reasoningEffort
            set({
              modelName: m?.name || id,
              ...(effort ? { reasoningEffort: effort } : {}),
            })
            break
          }
          // ── workflows (TUI workflows pane) ───────────────────────────
          case 'workflow_updated': {
            const f = fields as Record<string, unknown>
            const runId = typeof f.run_id === 'string' ? f.run_id : ''
            if (!runId) break
            const name = typeof f.name === 'string' ? f.name : runId.slice(0, 8)
            const status = typeof f.status === 'string' ? f.status : ''
            const phase =
              typeof f.current_phase === 'string' ? f.current_phase : undefined
            const prev = get().workflowRuns[runId]
            const prevStatus = prev?.status
            set({
              workflowRuns: {
                ...get().workflowRuns,
                [runId]: { runId, name, status, phase },
              },
            })
            // Surface transitions once (started / done / failed / paused).
            if (prevStatus !== status && status) {
              const text =
                !prevStatus && status === 'running'
                  ? `工作流启动: ${name}`
                  : status === 'done'
                    ? `工作流完成: ${name}`
                    : status === 'failed'
                      ? `工作流失败: ${name}`
                      : status === 'cancelled'
                        ? `工作流取消: ${name}`
                        : status === 'paused'
                          ? `工作流暂停: ${name}`
                          : `工作流 ${name} → ${status}`
              appendEntry(set, { kind: 'session_event', text })
            }
            break
          }
          // ── goal mode (TUI goal panel; web shows completion events) ───
          case 'goal_updated': {
            const f = fields as Record<string, unknown>
            const status = typeof f.status === 'string' ? f.status : ''
            const objective = typeof f.objective === 'string' ? f.objective : ''
            set({ goalState: f })
            if (status === 'complete') {
              appendEntry(set, {
                kind: 'session_event',
                text: `目标完成: ${objective}`,
              })
            } else if (status === 'cleared') {
              appendEntry(set, { kind: 'session_event', text: '目标已清除' })
            } else if (status === 'budget_limited') {
              appendEntry(set, {
                kind: 'session_event',
                text: `目标预算耗尽: ${objective}`,
                warning: true,
              })
            }
            break
          }
          // ── subagent progress ticks: state only, never scrollback ────
          case 'subagent_progress': {
            const f = fields as Record<string, unknown>
            const id = String(f.subagent_id ?? '')
            const entryId = id ? get().subagentIndex[id] : undefined
            if (!entryId) break
            const desc = String(f.description ?? '')
            const turns = f.turn_count
            const tools = f.tool_call_count
            const pct = f.context_usage_pct
            set({
              entries: get().entries.map((e) =>
                e.id === entryId && e.kind === 'subagent'
                  ? {
                      ...e,
                      detail:
                        desc ||
                        `turns=${String(turns ?? '?')} tools=${String(tools ?? '?')}${pct != null ? ` context=${String(pct)}%` : ''}`,
                    }
                  : e,
              ),
            })
            break
          }
          // ── scheduled tasks (TUI tasks pane only — not scrollback) ───
          // TUI updates agent.session.scheduled_tasks; the fire itself is
          // rendered later as UserPromptBlock::cron from the inject's
          // UserMessageChunk. No session_event rows for create/fire/delete.
          case 'scheduled_task_created':
          case 'scheduled_task_deleted':
          case 'scheduled_task_fired':
            break
          // ── misc ─────────────────────────────────────────────────────
          case 'diff_review': {
            const content = Array.isArray(fields.content) ? fields.content : []
            set({ diffReview: content })
            appendEntry(set, {
              kind: 'session_event',
              text: `收到 Diff 审查请求（${content.length} 个文件）`,
            })
            break
          }
          case 'feedback_request':
            appendEntry(set, { kind: 'session_event', text: '收到会话反馈请求' })
            break
          case 'turn_completed': {
            const f = fields as Record<string, unknown>
            const reason = typeof f.stop_reason === 'string' ? f.stop_reason : ''
            // done is the happy path; surface failures the frontend would
            // otherwise miss (TUI TurnFailed marker).
            if (reason === 'error' || reason === 'rate_limit') {
              appendEntry(set, {
                kind: 'session_event',
                text: `回合失败: ${String(f.agent_result ?? reason)}`,
                warning: true,
              })
            }
            break
          }
          // tool_call_delta_chunk: streamed args are superseded by the
          // final tool_call update — nothing to render.
          case 'tool_call_delta_chunk':
          case 'pending_interaction':
          case 'interaction_resolved':
          case 'relay_sync_status':
          case 'response_completed':
            break
          default:
            break
        }
        break
      }
      case 'task_backgrounded':
        handleTaskBackgrounded(get, set, extractSessionUpdate(ev.params).fields)
        break
      case 'task_completed':
        handleTaskCompleted(get, set, extractSessionUpdate(ev.params).fields)
        break
      case 'monitor_event': {
        const { fields } = extractSessionUpdate(ev.params)
        const taskId = wireTaskId(fields.task_id, fields.taskId)
        const entryId = taskId ? get().bgTaskIndex[taskId] : undefined
        // event_text is raw stdout (TUI appends to BgTaskState.stdout).
        const text =
          (typeof fields.event_text === 'string' && fields.event_text) ||
          (typeof fields.eventText === 'string' && fields.eventText) ||
          ''
        if (entryId && text) {
          set({
            entries: get().entries.map((e) =>
              e.id === entryId && e.kind === 'bg_task'
                ? {
                    ...e,
                    output: (e.output ?? '') + text,
                    // Keep a short tail on the row detail for glanceability.
                    detail: text.trim().split('\n').filter(Boolean).slice(-1)[0] || e.detail,
                  }
                : e,
            ),
          })
        }
        break
      }
      case 'git_head_changed': {
        const p = ev.params ?? {}
        const branch = p.branch == null ? undefined : String(p.branch)
        set({
          gitInfo: {
            branch: branch === '' ? '(detached)' : branch,
            isWorktree: !!p.isWorktree,
            mainRepo: p.mainRepo == null ? undefined : String(p.mainRepo),
          },
        })
        break
      }
      case 'yolo_mode_changed': {
        const p = ev.params ?? {}
        const yolo = typeof p.yoloMode === 'boolean' ? p.yoloMode : undefined
        const auto = typeof p.autoMode === 'boolean' ? p.autoMode : undefined
        const perm =
          typeof p.permissionMode === 'string' && p.permissionMode
            ? p.permissionMode
            : undefined
        set({ yoloMode: yolo, autoMode: auto, permissionMode: perm })
        break
      }
      case 'mcp_server_status': {
        const p = ev.params ?? {}
        const name = p.name ? String(p.name) : ''
        if (!name) break
        const existing = get().mcpServers.find((s) => s.name === name)
        const row: McpServerInfo = {
          name,
          source: existing?.source ?? (p.source ? String(p.source) : undefined),
          status: p.status ? String(p.status) : existing?.status,
          reason: p.reason ? String(p.reason) : existing?.reason,
          detail: p.detail ? String(p.detail) : existing?.detail,
        }
        set({
          mcpServers: [
            ...get().mcpServers.filter((s) => s.name !== name),
            row,
          ],
        })
        break
      }
      case 'mcp_tools_changed':
      case 'mcp_servers_updated':
        set({ mcpVersion: get().mcpVersion + 1 })
        break
      case 'sessions_changed':
        void get().refreshSessions()
        break
      case 'hosts_changed':
        // Hub-level: a host paired / came online / dropped off.
        void get().refreshHosts()
        break
      case 'models_update': {
        const p = (ev.params ?? {}) as Record<string, unknown>
        // Host/agent may push a full SessionModelState ({currentModelId,
        // availableModels}) — apply it as the authoritative session model
        // (catalog + current + effort). A pure catalog refresh keeps the
        // current effort when the model did not change (TUI
        // update_catalog semantics); a model switch applies the new
        // model's effort.
        if (
          p.currentModelId != null ||
          Array.isArray(p.availableModels) ||
          Array.isArray(p.available_models)
        ) {
          const snap = applySessionModelState(p, undefined)
          if (snap.models?.length || snap.modelName) {
            const hasExplicitEffort =
              (typeof p.reasoningEffort === 'string' && !!p.reasoningEffort.trim()) ||
              (typeof p.reasoning_effort === 'string' && !!p.reasoning_effort.trim())
            const modelChanged =
              snap.modelName != null && snap.modelName !== get().modelName
            set({
              ...snap,
              ...(!hasExplicitEffort && snap.reasoningEffort && !modelChanged
                ? { reasoningEffort: get().reasoningEffort || snap.reasoningEffort }
                : {}),
            })
          }
          break
        }
        // Best-effort: payload may carry {modelId, modelName} or {models:[…]}.
        const name =
          (typeof p.modelName === 'string' && p.modelName) ||
          (typeof p.modelId === 'string' && p.modelId) ||
          (typeof p.model === 'string' && p.model)
        if (name) set({ modelName: name })
        break
      }
      case 'scheduled_task_fired':
        // TUI only updates the tasks pane (next_fire_at) — no scrollback row.
        // The turn itself surfaces as a cron UserPromptBlock via user_chunk.
        break
      case 'scheduled_task_inject_prompt':
        // TUI enqueues the cron prompt (driver-only); scrollback comes from
        // the resulting UserMessageChunk, classified as is_cron. FE is not
        // the driver — ignore the inject signal and wait for user_chunk.
        break
      case 'prompt_complete': {
        // Agent-side turn end: x.ai/session/prompt_complete fires for EVERY
        // prompt turn — user-sent turns also get a host `done`, but
        // scheduled injections end with only this. Finalize exactly like
        // `done`; guarded on conn busy so a stale duplicate after `done`
        // (or during an idle gap) is a no-op.
        if (get().conn !== 'busy') break
        const turnStart = get().turnStartedAt
        const marker = turnMarker(turnStart != null ? Date.now() - turnStart : undefined)
        const sealed = sealThought(get())
        set({
          ...sealed,
          conn: 'ready',
          statusText: '待处理',
          awaitingNext: true,
          openAssistantId: undefined,
          openThoughtId: undefined,
          turnStartedAt: undefined,
          entries: [...settleTurnEntries(sealed.entries), marker],
        })
        break
      }
      case 'ext_notification': {
        // Known-noisy notifications with no UI value — drop silently. The
        // host forwards everything (pass-through), so suppress at the
        // render boundary; anything else stays visible as a dim status line.
        if (ev.method === 'x.ai/queue/changed') break
        if (ev.method === 'x.ai/settings/update') break
        // Unknown x.ai/* notification — render a dim status line so nothing
        // is silently dropped (matches the host's generic forwarding).
        appendEntry(set, {
          kind: 'status',
          text: `扩展通知: ${ev.method ?? 'x.ai/*'}`,
        })
        break
      }
      case 'modes_update':
        set({ modes: ev.modes })
        break
      case 'session_info':
        if (ev.title != null && String(ev.title).trim()) {
          set({ sessionTitle: String(ev.title).trim() })
        }
        break
      case 'model': {
        const name =
          (ev.modelName && String(ev.modelName).trim()) ||
          (ev.modelId && String(ev.modelId).trim()) ||
          undefined
        set({
          modelName: name,
          reasoningEffort: ev.reasoningEffort
            ? String(ev.reasoningEffort)
            : get().reasoningEffort,
        })
        break
      }
      case 'config_options_update': {
        // Best-effort: ACP config options may carry current model id/name.
        const opts = ev.configOptions as
          | Array<{ id?: string; type?: string; currentValue?: unknown; options?: Array<{ value?: string; name?: string }> }>
          | { model?: string; modelId?: string; modelName?: string }
          | undefined
        if (!opts) break
        if (Array.isArray(opts)) {
          const modelOpt = opts.find(
            (o) =>
              o?.id === 'model' ||
              o?.type === 'model' ||
              String(o?.id || '').toLowerCase().includes('model'),
          )
          if (modelOpt?.currentValue != null) {
            const cv = String(modelOpt.currentValue)
            const named = modelOpt.options?.find((x) => x.value === cv)?.name
            set({ modelName: (named && String(named)) || cv })
          }
        } else {
          const name =
            (opts.modelName && String(opts.modelName)) ||
            (opts.modelId && String(opts.modelId)) ||
            (opts.model && String(opts.model))
          if (name) set({ modelName: name })
        }
        break
      }
      default:
        break
    }
  },

  send: async (text: string) => {
    const t = text.trim()
    if (!t) return
    // Seal any leftover thought from prior turn, then append user + Thinking… shell.
    // Tag the user row so the live user_chunk echo merges into it (not a 2nd row).
    const sealed = sealThought(get())
    const userId = nid()
    const thoughtId = nid()
    set({
      ...sealed,
      entries: [
        ...sealed.entries,
        { id: userId, kind: 'user', text: t, ts: Date.now() },
        {
          id: thoughtId,
          kind: 'thought',
          text: '',
          open: true,
          streaming: true,
          startedAt: Date.now(),
        },
      ],
      openAssistantId: undefined,
      openThoughtId: thoughtId,
      pendingOptimisticUserId: userId,
      conn: 'busy',
      statusText: 'Thinking',
      awaitingNext: false,
      turnStartedAt: Date.now(),
    })
    try {
      await transport.prompt([{ type: 'text', text: t }])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // drop empty thinking shell on failure
      const after = sealThought(get())
      set({
        ...after,
        pendingOptimisticUserId: undefined,
        conn: 'error',
        statusText: msg,
        awaitingNext: false,
        turnStartedAt: undefined,
        entries: [...after.entries, { id: nid(), kind: 'error', text: msg }],
      })
    }
  },

  cancel: async () => {
    await transport.cancel()
  },

  respondPermission: async (requestId, optionId, cancelled) => {
    await transport.respondPermission(requestId, optionId, cancelled)
    set({ pending: get().pending.filter((p) => p.requestId !== requestId) })
  },

  respondXai: async (requestId, result, error) => {
    try {
      await transport.respondClientRequest(requestId, result, error)
    } finally {
      set({ xaiRequests: get().xaiRequests.filter((r) => r.requestId !== requestId) })
    }
  },

  dismissXai: async (requestId) => {
    await get().respondXai(requestId, { outcome: 'cancelled' })
  },

  requestRecap: async () => {
    try {
      await transport.recap(false)
      set({ statusText: '正在生成摘要…' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        statusText: '摘要失败',
        entries: [...get().entries, { id: nid(), kind: 'error', text: msg }],
      })
    }
  },

  forkSession: async (opts) => {
    try {
      const r = await transport.forkSession(opts ?? {})
      const newId =
        (r.result as Record<string, unknown> | undefined)?.newSessionId as
          | string
          | undefined
      appendEntry(set, {
        kind: 'status',
        text: newId ? `已 fork 新会话 ${newId.slice(0, 8)}…` : '已 fork 新会话',
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `fork 失败: ${msg}` }],
      })
    }
  },

  renameSession: async (title) => {
    try {
      await transport.renameSession(title)
      set({ sessionTitle: title, statusText: `已重命名为「${title}」` })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `重命名失败: ${msg}` }],
      })
    }
  },

  cancelSubagent: async (subagentId) => {
    try {
      await transport.cancelSubagent(subagentId)
      set({ statusText: '正在取消子代理…' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `取消子代理失败: ${msg}` }],
      })
    }
  },

  killTask: async (taskId) => {
    try {
      await transport.killTask(taskId)
      set({ statusText: '正在终止后台任务…' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `终止任务失败: ${msg}` }],
      })
    }
  },

  refreshTaskOutput: async (taskId, sessionId, cwd) => {
    if (!taskId) return
    const s = get()
    const entryId = s.bgTaskIndex[taskId]
    try {
      const snap = await transport.taskOutput(
        taskId,
        sessionId || cwd ? { sessionId, cwd } : undefined,
      )
      // Live row target: update the scrollback entry (viewer renders it).
      if (entryId) {
        set({
          entries: s.entries.map((e) => {
            if (e.id !== entryId || e.kind !== 'bg_task') return e
            // Prefer the longer buffer so a partial list response never
            // clobbers monitor_event-accumulated output.
            const nextOut =
              snap.output != null && snap.output.length >= (e.output?.length ?? 0)
                ? snap.output
                : e.output
            return {
              ...e,
              output: nextOut,
              command: snap.command || e.command,
              outputFile: snap.outputFile || e.outputFile,
              ...(snap.completed && e.running
                ? {
                    running: false,
                    status: 'completed' as const,
                    finishedAt: Date.now(),
                  }
                : {}),
            }
          }),
        })
      }
      // Task-view target: no entry exists (top strip / history replay) —
      // update the open viewer's task state so the log flows in.
      const vt = get().viewerTask
      if (vt && vt.taskId === taskId) {
        const nextOut =
          snap.output != null && snap.output.length >= (vt.output?.length ?? 0)
            ? snap.output
            : vt.output
        set({
          viewerTask: {
            ...vt,
            command: snap.command || vt.command,
            outputFile: snap.outputFile || vt.outputFile,
            output: nextOut,
            running: snap.running ?? (snap.completed ? false : vt.running),
            completed: snap.completed ?? vt.completed,
            failed: snap.failed ?? vt.failed,
          },
        })
      }
    } catch {
      // 404 / offline — viewer still shows whatever we already accumulated.
    }
  },

  syncLiveTasks: async () => {
    try {
      const tasks = await transport.listTasks()
      // Empty list is not authoritative (parse race / session still
      // focusing). Never use absence to settle running rows — that caused
      // a flash: history shows ⠋N, then sync marks everything completed.
      if (tasks.length === 0) return

      const s = get()
      let entries = s.entries
      let bgTaskIndex = { ...s.bgTaskIndex }
      let topTasks = s.topTasks
      let changed = false

      // Upsert only: keep live scrollback rows fresh; route RESTORED
      // running tasks to the TOP STRIP — the strip is the single place
      // for the running state (replay skips started rows, so no
      // scrollback row exists for them). Do NOT complete tasks merely
      // because they are missing from this response — wait for
      // task_completed SSE.
      for (const snap of tasks) {
        const existingId = bgTaskIndex[snap.taskId]
        const title =
          snap.description ||
          snap.command ||
          `Task ${snap.taskId.slice(0, 8)}`
        // A top-strip (restored) task the agent's registry knows: it
        // STAYS in the strip while running — no strip→scrollback move
        // (the running state only lives at the top). Completed entries
        // just drop from the strip; the completion settles the rows.
        if (topTasks.some((t) => t.taskId === snap.taskId)) {
          if (snap.completed === true) {
            topTasks = topTasks.filter((t) => t.taskId !== snap.taskId)
            changed = true
          }
          continue
        }
        if (!existingId) {
          // History never saw task_backgrounded (page boundary / dropped
          // SSE during historyLoading). A still-running task goes to the
          // TOP STRIP, not an invented scrollback row; fully completed
          // ghosts are skipped (the list may retain finished tasks).
          if (snap.completed) continue
          topTasks = [
            ...topTasks,
            {
              taskId: snap.taskId,
              title,
              command: snap.command,
              restored: true,
              outputFile: snap.outputFile,
            },
          ]
          changed = true
          continue
        }
        entries = entries.map((e) => {
          if (e.id !== existingId || e.kind !== 'bg_task') return e
          const nextOut =
            snap.output != null && snap.output.length >= (e.output?.length ?? 0)
              ? snap.output
              : e.output
          if (snap.completed === true && e.running) {
            changed = true
            return {
              ...e,
              title: e.title || title,
              status: 'completed' as const,
              running: false,
              finishedAt: e.finishedAt ?? Date.now(),
              output: nextOut,
              command: snap.command || e.command,
              outputFile: snap.outputFile || e.outputFile,
            }
          }
          if (
            nextOut !== e.output ||
            (snap.command && snap.command !== e.command) ||
            (snap.outputFile && snap.outputFile !== e.outputFile)
          ) {
            changed = true
            return {
              ...e,
              title: e.title || title,
              output: nextOut,
              command: snap.command || e.command,
              outputFile: snap.outputFile || e.outputFile,
            }
          }
          return e
        })
      }

      if (changed) set({ entries, bgTaskIndex, topTasks })
    } catch {
      // Offline / no session — leave history-only view.
    }
  },

  refreshSessions: async () => {
    try {
      const sessions = await transport.listSessions()
      set({ sessions })
    } catch {
      /* ignore */
    }
  },

  refreshGitInfo: async () => {
    const s = get()
    if (!s.sessionId || !s.cwd) return
    try {
      const info = await transport.gitInfo(s.sessionId, s.cwd)
      // Empty branch = not a git repo (or detached without a name) — hide
      // the status-bar branch entirely rather than showing "(detached)".
      set({
        gitInfo: info.branch
          ? {
              branch: info.branch,
              isWorktree: !!info.isWorktree,
              mainRepo: info.mainRepo ?? null,
            }
          : { branch: null, isWorktree: false, mainRepo: null },
      })
    } catch {
      /* ignore — keep whatever git_head_changed delivered */
    }
  },

  newSession: async () => {
    get().stopTopTaskPolling()
    clearSuppressedTools()
    set({
      entries: [],
      // Clear the session anchor: until the host's ready(newSessionId)
      // arrives, session-scoped events are dropped (no cross-session leak).
      sessionId: undefined,
      cwd: undefined,
      openAssistantId: undefined,
      openThoughtId: undefined,
      pendingOptimisticUserId: undefined,
      awaitingNext: false,
      statusText: '就绪',
      toolIndex: {},
      pending: [],
      xaiRequests: [],
      subagentIndex: {},
      bgTaskIndex: {},
      topTasks: [],
      gitInfo: undefined,
      yoloMode: undefined,
      autoMode: undefined,
      permissionMode: undefined,
      mcpServers: [],
      selectedId: null,
      focusMode: 'prompt',
      expandedGroups: new Set(),
      viewerEntryId: null,
      viewerTask: undefined,
      historySessionId: undefined,
      historyCwd: undefined,
      historyTotalCount: undefined,
      historyLoadedCount: 0,
      historyHasMore: false,
      historyLoadingMore: false,
      historyPrependedAt: undefined,
      historyAnchorId: undefined,
      todoCounts: undefined,
      todos: undefined,
      turnStartedAt: undefined,
    })
    await transport.newSession()
    // A brand-new session has nothing to review — mark it viewed so the
    // (empty) task state can never flag it as 待处理.
    const fresh = get().sessionId
    if (fresh) get().markViewed(fresh)
  },

  toggleTool: (id) => {
    set({
      entries: get().entries.map((e) =>
        e.id === id && e.kind === 'tool' ? { ...e, expanded: !e.expanded } : e,
      ),
      selectedId: id,
      focusMode: 'scrollback',
    })
  },

  toggleThought: (id) => {
    set({
      entries: get().entries.map((e) =>
        e.id === id && e.kind === 'thought' ? { ...e, open: !e.open } : e,
      ),
      selectedId: id,
      focusMode: 'scrollback',
    })
  },

  toggleUser: (id) => {
    set({
      entries: get().entries.map((e) =>
        e.id === id && e.kind === 'user' ? { ...e, expanded: !e.expanded } : e,
      ),
      selectedId: id,
      focusMode: 'scrollback',
    })
  },

  setFocus: (mode) => {
    const s = get()
    if (mode === 'scrollback') {
      const ids = selectableRowIds(s.entries, s.expandedGroups)
      const id =
        s.selectedId && ids.includes(s.selectedId)
          ? s.selectedId
          : (ids[ids.length - 1] ?? null)
      set({ focusMode: 'scrollback', selectedId: id })
    } else {
      set({ focusMode: 'prompt' })
    }
  },

  selectEntry: (id) => set({ selectedId: id, focusMode: id ? 'scrollback' : get().focusMode }),

  selectDelta: (delta) => {
    const { entries, selectedId, expandedGroups } = get()
    const ids = selectableRowIds(entries, expandedGroups)
    if (ids.length === 0) return
    const idx = selectedId ? ids.indexOf(selectedId) : -1
    let next = idx < 0 ? (delta > 0 ? 0 : ids.length - 1) : idx + delta
    next = Math.max(0, Math.min(ids.length - 1, next))
    set({ selectedId: ids[next], focusMode: 'scrollback' })
  },

  toggleGroupExpansion: (anchorId) => {
    const next = new Set(get().expandedGroups)
    if (next.has(anchorId)) next.delete(anchorId)
    else next.add(anchorId)
    set({ expandedGroups: next, focusMode: 'scrollback', selectedId: `gh_${anchorId}` })
  },

  setExpanded: (expanded) => {
    const { selectedId, entries, expandedGroups } = get()
    if (!selectedId) return

    // Group header (synthetic gh_<anchorId>): expand/collapse the whole run
    if (selectedId.startsWith('gh_')) {
      const anchorId = selectedId.slice(3)
      const next = new Set(expandedGroups)
      if (expanded) next.add(anchorId)
      else next.delete(anchorId)
      set({ expandedGroups: next, focusMode: 'scrollback' })
      return
    }

    const idx = entries.findIndex((e) => e.id === selectedId)
    const entry = idx >= 0 ? entries[idx] : undefined
    if (!entry) return

    const memberCollapsed =
      (entry.kind === 'tool' && !entry.expanded) ||
      (entry.kind === 'thought' && !entry.open)

    // ← on already-collapsed member inside an expanded group → fold the group
    if (!expanded && memberCollapsed) {
      const spans = scanGroups(entries, expandedGroups)
      const span = spanContaining(spans, idx)
      if (span?.expanded) {
        const next = new Set(expandedGroups)
        next.delete(span.anchorId)
        set({
          expandedGroups: next,
          selectedId: `gh_${span.anchorId}`,
          focusMode: 'scrollback',
        })
      }
      return
    }

    if (entry.kind === 'tool') {
      if (!!entry.expanded === expanded) return
      set({
        entries: entries.map((e) =>
          e.id === selectedId && e.kind === 'tool' ? { ...e, expanded } : e,
        ),
        focusMode: 'scrollback',
      })
      return
    }
    if (entry.kind === 'thought') {
      if (!!entry.open === expanded) return
      set({
        entries: entries.map((e) =>
          e.id === selectedId && e.kind === 'thought' ? { ...e, open: expanded } : e,
        ),
        focusMode: 'scrollback',
      })
      return
    }
    if (entry.kind === 'user') {
      if (!!entry.expanded === expanded) return
      set({
        entries: entries.map((e) =>
          e.id === selectedId && e.kind === 'user' ? { ...e, expanded } : e,
        ),
        focusMode: 'scrollback',
      })
      return
    }
    if (entry.kind === 'session_event' && entry.recap) {
      set({
        entries: entries.map((e) =>
          e.id === selectedId && e.kind === 'session_event'
            ? { ...e, open: expanded }
            : e,
        ),
        focusMode: 'scrollback',
      })
    }
  },

  toggleSelected: () => {
    const { selectedId, entries, expandedGroups } = get()
    if (!selectedId) return
    if (selectedId.startsWith('gh_')) {
      const anchorId = selectedId.slice(3)
      get().toggleGroupExpansion(anchorId)
      return
    }
    const e = entries.find((x) => x.id === selectedId)
    if (!e) return
    // Inline fold only (←/→/click/Space). Enter uses openViewer instead.
    if (e.kind === 'tool') get().setExpanded(!e.expanded)
    else if (e.kind === 'thought') get().setExpanded(!e.open)
    else if (e.kind === 'user') get().setExpanded(!e.expanded)
    else if (e.kind === 'session_event' && e.recap) get().setExpanded(!e.open)
    else {
      const idx = entries.findIndex((x) => x.id === selectedId)
      const spans = scanGroups(entries, expandedGroups)
      const span = spanContaining(spans, idx)
      if (span && !span.expanded) get().toggleGroupExpansion(span.anchorId)
    }
  },

  openViewer: (id) => {
    const s = get()
    const target = id ?? s.selectedId
    if (!target || target.startsWith('gh_')) return
    const e = s.entries.find((x) => x.id === target)
    if (!e) return
    // Only view contentful blocks (TUI has_normal_fullscreen_viewer)
    if (
      e.kind !== 'tool' &&
      e.kind !== 'thought' &&
      e.kind !== 'user' &&
      e.kind !== 'assistant' &&
      e.kind !== 'error' &&
      e.kind !== 'plan' &&
      e.kind !== 'bg_task' &&
      e.kind !== 'subagent'
    ) {
      return
    }
    if (e.kind === 'tool' && !e.raw && !e.title) return
    if (e.kind === 'bg_task' && e.taskId) {
      // Live rows (bgTaskIndex) keep the entry-backed viewer + live poll.
      // Replay display rows are NOT in the index — open the task viewer
      // so the log is fetched session-scoped (host reconstructs it from
      // the persisted timeline + on-disk log, unaffected by pagination).
      if (s.bgTaskIndex[e.taskId]) {
        set({
          viewerEntryId: target,
          viewerTask: undefined,
          selectedId: target,
          focusMode: 'scrollback',
        })
        // BgTask: pull live stdout (TUI reads central store on open + tick).
        void get().refreshTaskOutput(e.taskId)
      } else {
        get().openTaskViewer(e.taskId, {
          title: e.title,
          command: e.command,
          outputFile: e.outputFile,
          output: e.output,
        })
      }
      return
    }
    set({
      viewerEntryId: target,
      viewerTask: undefined,
      selectedId: target,
      focusMode: 'scrollback',
    })
  },

  openTaskViewer: (taskId, opts) => {
    if (!taskId) return
    const s = get()
    // Live scrollback row: reuse the entry-backed viewer + live poll.
    const entryId = s.bgTaskIndex[taskId]
    if (entryId) {
      get().openViewer(entryId)
      return
    }
    // History replay / restored top-strip task: task-only view backed by
    // the host's session-scoped log reconstruction. The currently viewed
    // history session wins the scope; fall back to the live session.
    const sessionId = opts?.sessionId ?? s.historySessionId ?? s.sessionId
    const cwd = opts?.cwd ?? s.historyCwd ?? s.cwd
    set({
      viewerEntryId: null,
      selectedId: null,
      focusMode: 'scrollback',
      viewerTask: {
        taskId,
        title: opts?.title,
        command: opts?.command,
        outputFile: opts?.outputFile,
        output: opts?.output ?? '',
        running: false,
        sessionId,
        cwd,
      },
    })
    void get().refreshTaskOutput(taskId, sessionId, cwd)
  },

  closeViewer: () => {
    set({ viewerEntryId: null, viewerTask: undefined })
  },
}))

/** Selectable row ids in display order (entries + synthetic group headers). */
function selectableRowIds(
  entries: ScrollEntry[],
  expandedGroups: ReadonlySet<string>,
): string[] {
  const spans = scanGroups(entries, expandedGroups)
  const rows = projectDisplayRows(entries, spans)
  return rows.map((r) => (r.type === 'entry' ? r.entry.id : r.id))
}

/** Whether a turn is currently live and needs a terminal marker/finalize. */
function turnIsLive(s: ChatState): boolean {
  return s.turnStartedAt != null || s.conn === 'busy' || s.openThoughtId != null
}

/**
 * TUI "Worked for Xs" marker entry. `elapsedMs` undefined → plain
 * "Turn completed." (TUI TurnCompleted with no elapsed).
 */
function turnMarker(elapsedMs: number | undefined): ScrollEntry {
  return {
    id: nid(),
    kind: 'session_event',
    text:
      elapsedMs != null
        ? `Worked for ${formatTurnDuration(elapsedMs)}`
        : 'Turn completed.',
  }
}

/** Whether a scrollback entry is a turn-end marker or still-running cue. */
function isTurnEndLine(e: ScrollEntry): boolean {
  return (
    e.kind === 'session_event' &&
    (e.text === 'Turn completed.' ||
      e.text.startsWith('Turn cancelled') ||
      e.text.startsWith('Worked for ') ||
      e.text.endsWith(' still running'))
  )
}

/**
 * Whether the scrollback tail already ends with a turn-end marker/cue and
 * no content after it. Stored history may carry BOTH response_completed
 * and turn_completed for one turn (hook/recap notifications can sit
 * between them) — the duplicate must not append a second marker/cue.
 * Non-content chrome (status/error lines) is walked past; the first
 * content entry (user/thought/assistant/tool/task/…) ends the scan.
 */
function tailAlreadyTurnEnded(entries: ScrollEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'status' || e.kind === 'error') continue
    if (e.kind === 'session_event') {
      if (isTurnEndLine(e)) return true
      continue
    }
    return false
  }
  return false
}

/**
 * TUI idle watcher cue (turn_status.rs format_still_running): counts-first,
 * "·"-joined, pluralized kinds, " still running" suffix — e.g.
 * `"2 commands · 1 monitor still running"`. Live rows (running) and
 * restored top-strip tasks (topTasks) count; the host only surfaces
 * liveness-probed tasks, so a restored task is a genuinely running one.
 *
 * A replayed 'started' row WITHOUT its completion is deliberately NOT
 * counted: history replay renders task_backgrounded as a display-only row
 * (running: false on purpose, so the ⠋N chip / running bar never count
 * settled history), and the session file can simply end with that event —
 * the task died with its owner and no task_completed was ever written.
 * The transcript can never settle such a row, so "no completion row" is
 * NOT liveness evidence; the host probe (topTasks) is the only authority
 * for restored tasks. Live rows always pair 'started' with running: true,
 * so counting `running` alone covers the live path.
 */
export function stillRunningCue(
  entries: ScrollEntry[],
  topTasks?: TopTask[],
): string | null {
  let commands = 0
  let monitors = 0
  let subagents = 0
  let workflows = 0
  for (const e of entries) {
    if (e.kind === 'bg_task') {
      if (!e.running) continue
      if (e.isMonitor) monitors++
      else commands++
    } else if (e.kind === 'subagent' && e.running) {
      subagents++
    } else if (e.kind === 'workflow' && e.running) {
      workflows++
    }
  }
  for (const t of topTasks ?? []) {
    if (t.isMonitor) monitors++
    else commands++
  }
  const parts: string[] = []
  const push = (n: number, noun: string) => {
    if (n > 0) parts.push(`${n} ${noun}${n === 1 ? '' : 's'}`)
  }
  push(commands, 'command')
  push(monitors, 'monitor')
  push(subagents, 'subagent')
  push(workflows, 'workflow')
  if (parts.length === 0) return null
  return `${parts.join(' · ')} still running`
}

/**
 * Whether the scrollback has anything a user would recognize as conversation
 * content. Used after history load: a page of only suppressed tool streams
 * (or empty) should trigger auto-paging older history.
 */
function hasDisplayableScrollback(entries: ScrollEntry[]): boolean {
  for (const e of entries) {
    switch (e.kind) {
      case 'user':
      case 'assistant':
      case 'thought':
      case 'tool':
      case 'plan':
      case 'subagent':
      case 'workflow':
      case 'bg_task':
      case 'error':
        return true
      case 'session_event':
        // Recap / markers are real UI chrome; bare status spam is not.
        if (e.recap || e.warning || (e.text && e.text.trim())) return true
        break
      case 'status':
        break
      default:
        break
    }
  }
  return false
}

/** Settle streaming/running entries at turn end (assistant/thought/tool). */
function settleTurnEntries(entries: ScrollEntry[]): ScrollEntry[] {
  return entries.map((e) => {
    if (e.kind === 'assistant' && e.streaming) return { ...e, streaming: false }
    if (e.kind === 'thought' && e.streaming) {
      // Replay: prefer the server-reported original duration; live falls
      // back to the local startedAt timer (TUI ThinkingBlock::finish
      // freeze order — server time wins, local timer only when absent).
      const elapsed =
        e.elapsedMs != null
          ? formatElapsed(e.elapsedMs)
          : e.startedAt != null
            ? formatElapsed(Date.now() - e.startedAt)
            : e.elapsed
      return {
        ...e,
        streaming: false,
        elapsed,
        open: false,
        finishedAt: Date.now(),
      }
    }
    if (e.kind === 'tool' && (e.status === 'pending' || e.status === 'in_progress')) {
      return {
        ...e,
        status: 'completed',
        verb: toolVerb(e.kindName, false),
        finishedAt: Date.now(),
      }
    }
    // History page boundaries can cut off the closing update of a
    // subagent / workflow block (subagent_finished etc. landed in
    // a newer page that replayed first and was dropped for an unknown
    // id) — settle them like any other finished transcript block.
    //
    // bg_task is deliberately NOT settled: a backgrounded task's
    // lifecycle is independent of the turn (the process may still be
    // running, e.g. `npm run dev`). Only a task_completed event ends it
    // — the TUI behaves the same way (replay skips turn completion
    // logic; a task without task_completed stays Running).
    if (e.kind === 'subagent' && e.running) {
      return { ...e, status: 'completed', running: false, finishedAt: Date.now() }
    }
    if (e.kind === 'workflow' && e.running) {
      return { ...e, status: 'done', running: false, finishedAt: Date.now() }
    }
    return e
  })
}

// ── history envelope replay ───────────────────────────────────────
//
// A stored update is the JSONL envelope {timestamp, method, params} with
// params = {sessionId, update}. Mirrors the host's session/update mapping.

/** Updates per history page; older pages load on scroll-up. */
const HISTORY_PAGE_SIZE = 100

/** Replay raw history envelopes through the live event pipeline. */
function replayUpdates(getStore: () => ChatState, updates: unknown[]): void {
  let userBuf = ''
  let userIsCron = false
  let userTs: number | undefined
  const flushUser = () => {
    if (userBuf) {
      getStore().handleEvent({
        type: 'user_message',
        text: userBuf,
        isCron: userIsCron || undefined,
        ts: userTs,
      })
      userBuf = ''
      userIsCron = false
      userTs = undefined
    }
  }
  for (const env of updates) {
    // Every envelope carries the session-accumulated token count in
    // `_meta.totalTokens`. The live bridge surfaces it as a usage event
    // (TUI ⇣ counter / context chip); replay must do the same or the
    // context chip stays empty after restoring history.
    const metaUsed = envelopeTotalTokens(env)
    if (metaUsed != null && metaUsed > 0) {
      getStore().handleEvent({ type: 'usage', used: metaUsed })
    }
    // History replay shows stored task lifecycle events as display-only
    // informational lines (envelopeToEvent) — never captured into the
    // task system. The live running set is established once at resume via
    // the host's liveness probe (replayRunningTasks).
    const ev = envelopeToEvent(env)
    if (!ev) continue
    // A STILL-RUNNING task's "started" row belongs ONLY in the top task
    // strip (host liveness probe) — never as a dangling scrollback row
    // without its completion. Live rows are unaffected (this path is
    // history replay only; the live pipeline uses handleTaskBackgrounded).
    if (ev.type === 'task_lifecycle' && ev.kind === 'started') {
      const taskId = ev.taskId
      if (taskId && getStore().topTasks.some((t) => t.taskId === taskId)) {
        continue
      }
    }
    if (ev.type === 'user_message') {
      // Aggregate consecutive chunks of one user turn; keep cron if any
      // chunk (or the framed full text) is a scheduled-task inject.
      userBuf += ev.text
      if (ev.isCron) userIsCron = true
      if (ev.ts != null) userTs = ev.ts
      continue
    }
    flushUser()
    getStore().handleEvent(ev)
  }
  flushUser()
}

/** Accumulated session tokens from a stored envelope's `_meta.totalTokens`. */
function envelopeTotalTokens(env: unknown): number | undefined {
  const e = env as RawEnvelope
  const meta = e.params?._meta as Record<string, unknown> | undefined
  return typeof meta?.totalTokens === 'number' ? meta.totalTokens : undefined
}

/**
 * Field extraction for a stored task lifecycle event in history replay.
 * The event renders with the same bg_task look as live (Task started /
 * completed / failed) but is NOT captured into the task system
 * (bgTaskIndex / ⠋N / running bar) — the live running set is established
 * once at resume via the host probe. Title priority mirrors the live
 * handler (monitor description → description → command).
 */
function historicalTaskEvent(
  up: Record<string, unknown>,
): { kind: 'started' | 'completed'; title: string; taskId?: string; command?: string; isMonitor?: boolean; failed?: boolean; output?: string } | null {
  const titleOf = (v: unknown): string => {
    const s = typeof v === 'string' ? v.trim() : ''
    return s ? s.slice(0, 80) : ''
  }
  if (up.sessionUpdate === 'task_backgrounded') {
    const monitor = titleOf(up.monitor_description) || titleOf(up.monitorDescription)
    const command = titleOf(up.command)
    return {
      kind: 'started',
      taskId: titleOf(up.task_id) || undefined,
      title:
        monitor ||
        titleOf(up.description) ||
        command ||
        'Task',
      command: command || undefined,
      isMonitor: !!monitor,
    }
  }
  if (up.sessionUpdate === 'task_completed') {
    const snap = (up.task_snapshot ?? {}) as Record<string, unknown>
    const title =
      titleOf(snap.description) ||
      titleOf(snap.display_command) ||
      titleOf(snap.displayCommand) ||
      titleOf(snap.command) ||
      'Task'
    const code = typeof snap.exit_code === 'number' ? snap.exit_code : undefined
    const sig = typeof snap.signal === 'string' && snap.signal ? snap.signal : undefined
    return {
      kind: 'completed',
      taskId: titleOf(snap.task_id) || undefined,
      title,
      command: titleOf(snap.display_command) || titleOf(snap.command) || undefined,
      failed: code != null && code !== 0 || !!sig,
      output: typeof snap.output === 'string' ? snap.output : undefined,
    }
  }
  return null
}

type RawEnvelope = {
  method?: string
  params?: {
    sessionId?: string
    update?: Record<string, unknown>
    /** Session-accumulated token count (live bridge surfaces it as usage). */
    _meta?: Record<string, unknown>
  }
}

/**
 * Stored JSONL envelope time: {timestamp, method, params}. The shell writes
 * epoch seconds; accept epoch ms and RFC3339 strings defensively.
 */
function envelopeTimestamp(env: RawEnvelope): number | undefined {
  const ts = (env as { timestamp?: unknown }).timestamp
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return ts > 1e11 ? ts : ts * 1000
  }
  if (typeof ts === 'string') {
    const ms = Date.parse(ts)
    return Number.isFinite(ms) ? ms : undefined
  }
  return undefined
}

/** Extract text from an ACP content value (string | {text} | nested | array). */
function contentText(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(contentText).join('')
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    return contentText(o.content)
  }
  return ''
}

/** Strip <fork-context>/<resume-context> wrappers from user message text. */
function stripContextWrappers(text: string): string {
  for (const tag of ['fork-context', 'resume-context']) {
    const open = `<${tag}>`
    const closeTag = `</${tag}>`
    for (;;) {
      const s = text.indexOf(open)
      if (s < 0) break
      const rel = text.slice(s + open.length).indexOf(closeTag)
      if (rel < 0) break
      const end = s + open.length + rel
      text = text.slice(0, s) + text.slice(end + closeTag.length).trimStart()
    }
  }
  return text
}

/**
 * TUI extract_cron_prompt_body — pull the raw prompt out of
 * format_scheduled_task_prompt framing:
 *   <system-reminder>\nThis is a scheduled task execution…\n</system-reminder>\n\n{prompt}
 * Returns null when the text is not cron-framed.
 */
function extractCronPromptBody(text: string): string | null {
  if (!text.startsWith('<system-reminder>')) return null
  const endTag = '</system-reminder>'
  const close = text.indexOf(endTag)
  if (close < 0) return null
  const header = text.slice(0, close)
  if (!header.includes('scheduled task execution')) return null
  const body = text.slice(close + endTag.length).trim()
  return body || null
}

/**
 * TUI user_message_hidden_from_scrollback (legacy text-shape arm).
 * Cron is handled earlier by extractCronPromptBody; everything else under
 * <system-reminder> / monitor XML / drain separators stays out of scrollback.
 */
function userMessageHiddenFromScrollback(text: string): boolean {
  const t = text.trimStart()
  if (t.startsWith('<system-reminder>')) return true
  if (t.startsWith('<monitor-event')) return true
  if (t.trim() === '---') return true
  const first = t.split('\n', 1)[0] ?? ''
  if (
    first.length > 0 &&
    first[0] >= '0' &&
    first[0] <= '9' &&
    first.includes(' monitor events from ') &&
    first.includes(' (use ')
  ) {
    return true
  }
  return false
}

/**
 * Classify a user-message body the way TUI handle_user_message does.
 * Returns null when the chunk must not become a scrollback row.
 */
function classifyUserPrompt(
  raw: string,
  forcedCron?: boolean,
): { text: string; isCron: boolean } | null {
  const text = stripContextWrappers(raw)
  if (!text) return null
  if (forcedCron) return { text, isCron: true }
  const cronBody = extractCronPromptBody(text)
  if (cronBody != null) return { text: cronBody, isCron: true }
  if (userMessageHiddenFromScrollback(text)) return null
  return { text, isCron: false }
}

/** Normalize user prompt text for optimistic-echo equality checks. */
function normalizeUserPromptText(text: string): string {
  let t = stripContextWrappers(text).trim()
  // Agent may echo the model-facing <user_query> envelope; send() stores raw input.
  const open = '<user_query>'
  const close = '</user_query>'
  if (t.startsWith(open)) {
    const end = t.endsWith(close)
      ? t.length - close.length
      : t.indexOf(close) > 0
        ? t.indexOf(close)
        : -1
    if (end > open.length) {
      t = t.slice(open.length, end).replace(/^\n/, '').replace(/\n$/, '').trim()
    }
  }
  return t
}

function userPromptTextsMatch(a: string, b: string): boolean {
  if (a === b) return true
  return normalizeUserPromptText(a) === normalizeUserPromptText(b)
}

/**
 * Index of the optimistic user row that a live user_chunk should merge into.
 * Prefer the pending id from send(); fall back to a trailing user whose text
 * matches (thought shells between user and the end are ignored).
 */
function findOptimisticUserAbsorbIndex(
  entries: ScrollEntry[],
  pendingId: string | undefined,
  echoText: string,
): number {
  if (pendingId) {
    const byId = entries.findIndex((e) => e.id === pendingId && e.kind === 'user')
    if (byId >= 0) return byId
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'thought') continue
    if (e.kind === 'user' && userPromptTextsMatch(e.text, echoText)) return i
    return -1
  }
  return -1
}

/**
 * Convert one stored session/update envelope into the AcpEvent the live
 * pipeline understands, or null when it carries no renderable content.
 */
function envelopeToEvent(env: unknown): AcpEvent | null {
  const e = env as RawEnvelope
  if (!e || (e.method !== 'session/update' && e.method !== '_x.ai/session/update')) {
    return null
  }
  const up = e.params?.update
  if (!up) return null
  // x.ai carrier (`_x.ai/session/update` on the wire): the live bridge
  // unwraps it and routes EVERY kind through the session_notification
  // channel (subagent/task/recap/retry/hook/model_changed/…). Replay must
  // do the same or those blocks silently vanish from loaded history.
  // Turn-end markers are the exception: they finalize streaming blocks.
  if (e.method === '_x.ai/session/update') {
    if (up.sessionUpdate === 'turn_completed' || up.sessionUpdate === 'response_completed') {
      return { type: 'turn_completed' }
    }
    // Display-only task rows under the x.ai carrier too (same look as live).
    const taskEv = historicalTaskEvent(up)
    if (taskEv) return { type: 'task_lifecycle', ...taskEv }
    return { type: 'session_notification', method: e.method, params: e.params }
  }
  switch (up.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = contentText(up.content)
      if (!text) return null
      return { type: 'chunk', text, ts: envelopeTimestamp(e) }
    }
    case 'agent_thought_chunk': {
      const text = contentText(up.content)
      if (!text) return null
      // TUI replay parity (NotificationMeta): the persisted envelope's
      // `_meta` keeps the ORIGINAL timestamps, so the replayed thought can
      // seal with the real duration instead of the replay wall-clock
      // (~0ms → bogus "Thought for 0.0s"). Graceful: old envelopes without
      // meta fall back to the local timer path.
      const meta = (e.params?._meta ?? {}) as Record<string, unknown>
      const agentTs =
        typeof meta.agentTimestampMs === 'number' ? meta.agentTimestampMs : undefined
      const streamStart =
        typeof meta.streamStartMs === 'number' ? meta.streamStartMs : undefined
      const elapsedMs =
        agentTs != null && streamStart != null && agentTs >= streamStart
          ? agentTs - streamStart
          : undefined
      return elapsedMs != null
        ? { type: 'thought', text, elapsedMs }
        : { type: 'thought', text }
    }
    case 'user_message_chunk': {
      // Prefer content-block / chunk meta (TUI user_prompt_meta +
      // user_message_chunk_meta); fall back to text-shape classification.
      // Wire shape: update._meta = ContentChunk.meta (hideFromScrollback);
      // content._meta = TextContent.meta (displayText / displayAsCron).
      const chunkMeta = (up._meta ?? up.meta) as Record<string, unknown> | undefined
      if (chunkMeta?.hideFromScrollback === true) return null
      const content = up.content as Record<string, unknown> | undefined
      const blockMeta =
        content && typeof content === 'object'
          ? ((content._meta ?? content.meta) as Record<string, unknown> | undefined)
          : undefined
      if (blockMeta?.hideFromScrollback === true) return null
      const displayText =
        typeof blockMeta?.displayText === 'string' ? blockMeta.displayText : undefined
      const displayAsCron = blockMeta?.displayAsCron === true
      const raw = displayText ?? contentText(up.content)
      if (!raw) return null
      // Pre-classify so history aggregation still carries isCron across chunks
      // that already have displayAsCron; text-shape cron framing is applied
      // after flush (full buffered text) in handleEvent.
      const classified = classifyUserPrompt(raw, displayAsCron)
      if (!classified) return null
      return {
        type: 'user_message',
        text: classified.text,
        isCron: classified.isCron || undefined,
        ts: envelopeTimestamp(e),
      }
    }
    case 'tool_call':
      return { type: 'tool_call', toolCall: up as unknown as ToolCall }
    case 'tool_call_update':
      return { type: 'tool_call_update', toolCallUpdate: up as unknown as ToolCall }
    case 'plan':
      return { type: 'plan', entries: up.entries }
    case 'usage_update':
      return {
        type: 'usage',
        used: up.used as number | undefined,
        size: up.size as number | undefined,
        cost: up.cost,
      }
    case 'current_mode_update':
      return { type: 'modes_update', modes: up.modeState }
    case 'config_option_update':
      return { type: 'config_options_update', configOptions: up.configOptions }
    case 'session_info_update':
      return { type: 'session_info', title: up.title as string | undefined }
    // Stored task lifecycle events render as display-only bg_task rows
    // in history (same look as live, never captured into the task
    // system): the live running set is established once at resume via
    // the host liveness probe; a captured row for a long-dead task would
    // stick as "running" forever.
    case 'task_backgrounded':
    case 'task_completed': {
      const taskEv = historicalTaskEvent(up)
      return taskEv ? { type: 'task_lifecycle', ...taskEv } : null
    }
    // Turn-end markers: every finished turn is stored with its closing
    // turn_completed (some builds use response_completed). Without it the
    // replayed scrollback would keep the turn's last thought/assistant
    // streaming forever — "stuck mid-thinking" after resuming history.
    case 'turn_completed':
    case 'response_completed':
      return { type: 'turn_completed' }
    default:
      // Standard carrier lifecycle kinds: route through the same
      // session_notification channel as the live bridge's default arm
      // (subagent/task/monitor/response/compact/recap/…).
      return {
        type: 'session_notification',
        method: e.method,
        params: e.params,
      }
  }
}

/**
 * Built-in effort menu (TUI fallback when supportsReasoningEffort is true
 * but the server list is empty / unusable): xhigh → low.
 */
const BUILTIN_REASONING_EFFORTS: ModelOption['reasoningEfforts'] = [
  { id: 'xhigh', label: 'xhigh', value: 'xhigh' },
  { id: 'high', label: 'high', value: 'high' },
  { id: 'medium', label: 'medium', value: 'medium' },
  { id: 'low', label: 'low', value: 'low' },
]

/**
 * Resolve a SessionModelState from either:
 *   - the top-level `models` field on session/new|load (preferred), or
 *   - agentInfo / agentInfo._meta.modelState (initialize snapshot).
 *
 * Direct SessionModelState shape: { currentModelId, availableModels }.
 */
function asModelState(...sources: unknown[]): Record<string, unknown> | undefined {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue
    const o = src as Record<string, unknown>
    // Direct SessionModelState
    if (
      o.currentModelId != null ||
      o.current_model_id != null ||
      Array.isArray(o.availableModels) ||
      Array.isArray(o.available_models)
    ) {
      return {
        currentModelId: o.currentModelId ?? o.current_model_id,
        availableModels: o.availableModels ?? o.available_models,
        reasoningEffort: o.reasoningEffort ?? o.reasoning_effort,
      }
    }
    const meta = o._meta as Record<string, unknown> | undefined
    const nested = (meta?.modelState ?? o.modelState) as
      | Record<string, unknown>
      | undefined
    if (nested && typeof nested === 'object') {
      return {
        currentModelId: nested.currentModelId ?? nested.current_model_id,
        availableModels: nested.availableModels ?? nested.available_models,
        reasoningEffort: nested.reasoningEffort ?? nested.reasoning_effort,
      }
    }
  }
  return undefined
}

/**
 * Build a store partial for models + current caption fields.
 * `sessionModels` (from session/new|load) wins over `agentInfo`.
 * When neither yields a model name, returns only the catalog if present.
 */
function applySessionModelState(
  sessionModels: unknown,
  agentInfo: unknown,
): Partial<Pick<ChatState, 'models' | 'modelName' | 'reasoningEffort'>> {
  // Prefer session models for both catalog and current selection.
  const primary = asModelState(sessionModels)
  const fallback = asModelState(agentInfo)
  const ms = primary ?? fallback
  const catalogSrc = sessionModels ?? agentInfo
  const list = extractModelsFromModelState(ms) 
  // Also try agentInfo path for catalog if ms was empty
  const models =
    list.length > 0
      ? list
      : extractModelsFromAgentInfo(catalogSrc)

  const name =
    extractModelNameFromState(ms) ??
    extractModelFromAgentInfo(agentInfo)
  const effort =
    extractEffortFromState(ms) ??
    extractEffortFromAgentInfo(agentInfo)

  const out: Partial<Pick<ChatState, 'models' | 'modelName' | 'reasoningEffort'>> =
    {}
  if (models.length > 0) out.models = models
  if (name) out.modelName = name
  // Always write effort when we have a session models payload so a restored
  // session without effort does not keep the previous session's suffix.
  if (sessionModels != null) {
    out.reasoningEffort = effort
  } else if (effort) {
    out.reasoningEffort = effort
  }
  return out
}

function extractModelsFromModelState(
  ms: Record<string, unknown> | undefined,
): ModelOption[] {
  if (!ms) return []
  return extractModelsFromAgentInfo({ modelState: ms })
}

function extractModelNameFromState(
  ms: Record<string, unknown> | undefined,
): string | undefined {
  if (!ms) return undefined
  return extractModelFromAgentInfo({ modelState: ms })
}

function extractEffortFromState(
  ms: Record<string, unknown> | undefined,
): string | undefined {
  if (!ms) return undefined
  return extractEffortFromAgentInfo({ modelState: ms })
}

/** Normalize one effort entry from model meta (id/value/label variants). */
function normalizeEffortOption(raw: unknown): {
  id: string
  label: string
  value: string
  default?: boolean
} | null {
  if (typeof raw === 'string' && raw.trim()) {
    const v = raw.trim()
    return { id: v, label: v, value: v }
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const value =
    (typeof o.value === 'string' && o.value.trim()) ||
    (typeof o.id === 'string' && o.id.trim()) ||
    ''
  if (!value) return null
  const id =
    (typeof o.id === 'string' && o.id.trim()) ||
    value
  const label =
    (typeof o.label === 'string' && o.label.trim()) ||
    (typeof o.name === 'string' && o.name.trim()) ||
    id
  return {
    id,
    label,
    value,
    ...(o.default === true ? { default: true } : {}),
  }
}

/** Model catalog from agentInfo._meta.modelState.availableModels. */
function extractModelsFromAgentInfo(info: unknown): ModelOption[] {
  if (!info || typeof info !== 'object') return []
  const o = info as Record<string, unknown>
  const meta = o._meta as Record<string, unknown> | undefined
  const modelState = (meta?.modelState ?? o.modelState) as
    | Record<string, unknown>
    | undefined
  // Direct SessionModelState passed as `info` itself.
  const list =
    modelState?.availableModels ??
    modelState?.available_models ??
    (Array.isArray(o.availableModels) ? o.availableModels : undefined) ??
    (Array.isArray(o.available_models) ? o.available_models : undefined)
  if (!Array.isArray(list)) return []
  const out: ModelOption[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const id =
      (typeof r.modelId === 'string' && r.modelId) ||
      (typeof r.model_id === 'string' && r.model_id) ||
      ''
    if (!id) continue
    // ACP ModelInfo.meta serializes as `_meta` on some crates and `meta`
    // on others — accept both.
    const rm =
      ((r._meta as Record<string, unknown> | undefined) ??
        (r.meta as Record<string, unknown> | undefined) ??
        {}) as Record<string, unknown>
    const supports =
      rm.supportsReasoningEffort === true ||
      rm.supports_reasoning_effort === true
    const parsed = Array.isArray(rm.reasoningEfforts)
      ? (rm.reasoningEfforts as unknown[])
          .map(normalizeEffortOption)
          .filter((x): x is NonNullable<typeof x> => x != null)
      : Array.isArray(rm.reasoning_efforts)
        ? (rm.reasoning_efforts as unknown[])
            .map(normalizeEffortOption)
            .filter((x): x is NonNullable<typeof x> => x != null)
        : []
    // TUI: supported + empty/unusable list → built-in low..xhigh menu.
    // Unsupported → no effort row (even if a list was present).
    let efforts: ModelOption['reasoningEfforts']
    if (supports) {
      efforts = parsed.length > 0 ? parsed : BUILTIN_REASONING_EFFORTS
    } else if (parsed.length > 0) {
      // Some payloads only ship the list without the bool flag.
      efforts = parsed
    } else {
      efforts = undefined
    }
    out.push({
      modelId: id,
      name: typeof r.name === 'string' ? r.name : undefined,
      description: typeof r.description === 'string' ? r.description : undefined,
      agentType: typeof rm.agentType === 'string' ? rm.agentType : undefined,
      // TUI context bar total: model meta.totalContextTokens (may be a
      // number or a numeric string across crates).
      contextWindow:
        typeof rm.totalContextTokens === 'number'
          ? rm.totalContextTokens
          : typeof rm.totalContextTokens === 'string' &&
              rm.totalContextTokens.trim() !== '' &&
              !Number.isNaN(Number(rm.totalContextTokens))
            ? Number(rm.totalContextTokens)
            : undefined,
      reasoningEffort:
        typeof rm.reasoningEffort === 'string'
          ? rm.reasoningEffort
          : typeof rm.reasoning_effort === 'string'
            ? rm.reasoning_effort
            : undefined,
      supportsReasoningEffort: supports || (efforts != null && efforts.length > 0),
      reasoningEfforts: efforts,
    })
  }
  return out
}

/** Current reasoning effort from agentInfo._meta.modelState (if any). */
function extractEffortFromAgentInfo(info: unknown): string | undefined {
  if (!info || typeof info !== 'object') return undefined
  const o = info as Record<string, unknown>
  const meta = o._meta as Record<string, unknown> | undefined
  const ms = (meta?.modelState ?? o.modelState) as
    | Record<string, unknown>
    | undefined
  if (!ms) return undefined
  for (const k of ['reasoningEffort', 'reasoning_effort', 'currentReasoningEffort']) {
    const v = ms[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  // Fall back to the current model's own default effort meta.
  const cur = ms.currentModelId ?? ms.current
  const avail = ms.availableModels
  if (typeof cur === 'string' && Array.isArray(avail)) {
    const m = avail.find((x) => {
      if (x == null || typeof x !== 'object') return false
      const r = x as Record<string, unknown>
      return r.modelId === cur || r.model_id === cur
    }) as Record<string, unknown> | undefined
    const rm =
      ((m?._meta as Record<string, unknown> | undefined) ??
        (m?.meta as Record<string, unknown> | undefined) ??
        {}) as Record<string, unknown>
    for (const k of ['reasoningEffort', 'reasoning_effort']) {
      const v = rm[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    const list = Array.isArray(rm.reasoningEfforts)
      ? rm.reasoningEfforts
      : Array.isArray(rm.reasoning_efforts)
        ? rm.reasoning_efforts
        : null
    if (list) {
      const def = list.find(
        (x) =>
          x != null &&
          typeof x === 'object' &&
          (x as Record<string, unknown>).default === true,
      ) as Record<string, unknown> | undefined
      const pick = def ?? (list[0] as Record<string, unknown> | undefined)
      if (pick) {
        const v = pick.value ?? pick.id
        if (typeof v === 'string' && v.trim()) return v.trim()
      }
    }
  }
  return undefined
}

/** Pull a display model name from ACP agentInfo when present. */
function extractModelFromAgentInfo(info: unknown): string | undefined {
  if (!info || typeof info !== 'object') return undefined
  const o = info as Record<string, unknown>
  for (const k of ['modelName', 'model', 'modelId', 'name']) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  // grok nests the model state under _meta.modelState: currentModelId +
  // availableModels (the same place extractModelsFromAgentInfo reads).
  const meta = o._meta as Record<string, unknown> | undefined
  const ms = (meta?.modelState ?? o.modelState) as
    | Record<string, unknown>
    | undefined
  const cur = ms?.currentModelId ?? ms?.current ?? ms?.current_model_id
  if (typeof cur === 'string' && cur.trim()) {
    const list = ms?.availableModels ?? ms?.available_models
    if (Array.isArray(list)) {
      const m = list.find((x) => {
        if (x == null || typeof x !== 'object') return false
        const r = x as Record<string, unknown>
        return r.modelId === cur || r.model_id === cur
      })
      const name = (m as Record<string, unknown> | undefined)?.name
      if (typeof name === 'string' && name.trim()) return name.trim()
    }
    return cur.trim()
  }
  const models = o.models
  if (models && typeof models === 'object') {
    const m = models as Record<string, unknown>
    const cur2 = m.current ?? m.currentModel ?? m.selected
    if (typeof cur2 === 'string' && cur2.trim()) return cur2.trim()
    if (cur2 && typeof cur2 === 'object') {
      const c = cur2 as Record<string, unknown>
      for (const k of ['name', 'modelName', 'id', 'modelId']) {
        const v = c[k]
        if (typeof v === 'string' && v.trim()) return v.trim()
      }
    }
  }
  return undefined
}

/**
 * Finish an open thought block when content moves on.
 * Empty placeholder (busy fired but no thought chunks) is removed entirely.
 */
function sealThought(
  s: ChatState,
): Pick<ChatState, 'entries' | 'openAssistantId' | 'openThoughtId'> {
  if (!s.openThoughtId) {
    return {
      entries: s.entries,
      openAssistantId: s.openAssistantId,
      openThoughtId: s.openThoughtId,
    }
  }
  const tid = s.openThoughtId
  const existing = s.entries.find((e) => e.id === tid)
  // Drop empty Thinking… placeholder if agent never sent thought chunks
  if (existing?.kind === 'thought' && !existing.text.trim()) {
    return {
      openAssistantId: s.openAssistantId,
      openThoughtId: undefined,
      entries: s.entries.filter((e) => e.id !== tid),
    }
  }
  return {
    openAssistantId: s.openAssistantId,
    openThoughtId: undefined,
    entries: s.entries.map((e) => {
      if (e.id !== tid || e.kind !== 'thought') return e
      // Replay: prefer the server-reported original duration; live falls
      // back to the local startedAt timer (same freeze order as the TUI's
      // ThinkingBlock::finish + finish_running_with_time).
      const elapsed =
        e.elapsedMs != null
          ? formatElapsed(e.elapsedMs)
          : e.startedAt != null
            ? formatElapsed(Date.now() - e.startedAt)
            : e.elapsed
      // Collapse body after finish (TUI collapsed "Thought for Xs")
      // finishedAt drives the short finish-flash accent (EntryRenderer)
      return {
        ...e,
        streaming: false,
        elapsed,
        open: false,
        finishedAt: Date.now(),
      }
    }),
  }
}

// ── x.ai/* event helpers ──────────────────────────────────────────

type SetState = (
  partial:
    | Partial<ChatState>
    | ((s: ChatState) => Partial<ChatState>),
) => void

/**
 * Normalize an x.ai notification payload. The shell sends either the
 * SessionNotification envelope {"update": {"sessionUpdate": tag, …}} or a
 * flat {"sessionUpdate": tag, …} (headless wire form).
 */
function extractSessionUpdate(
  params?: Record<string, unknown>,
): { tag?: string; fields: Record<string, unknown> } {
  const u = (params?.update as Record<string, unknown> | undefined) ?? params ?? {}
  const tag = typeof u.sessionUpdate === 'string' ? u.sessionUpdate : undefined
  return { tag, fields: u }
}

/** Distributive Omit (works over the ScrollEntry union). */
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never
type EntryWithoutId = DistributiveOmit<ScrollEntry, 'id'>

/** Append a non-streaming entry to the scrollback. */
function appendEntry(set: SetState, entry: EntryWithoutId): void {
  set((s) => ({
    entries: [...s.entries, { id: nid(), ...entry } as ScrollEntry],
  }))
}

/** subagent_spawned / subagent_finished (session_notification carrier). */
function handleSubagentEvent(
  get: () => ChatState,
  set: SetState,
  tag: string,
  fields: Record<string, unknown>,
): void {
  const id = String(fields.subagent_id ?? fields.child_session_id ?? '')
  if (!id) return
  const entryId = get().subagentIndex[id]

  if (tag === 'subagent_spawned') {
    if (entryId) return // already tracked
    const title =
      (typeof fields.description === 'string' && fields.description) ||
      (typeof fields.subagent_type === 'string' && fields.subagent_type) ||
      id
    const eid = nid()
    set((s) => ({
      subagentIndex: { ...s.subagentIndex, [id]: eid },
      entries: [
        ...s.entries,
        {
          id: eid,
          kind: 'subagent',
          title,
          status: 'started',
          running: true,
          subagentId: id,
        },
      ],
    }))
    return
  }

  // finished
  if (!entryId) return
  const statusRaw = typeof fields.status === 'string' ? fields.status : 'completed'
  const status =
    statusRaw === 'completed' || statusRaw === 'failed' || statusRaw === 'cancelled'
      ? statusRaw
      : 'completed'
  const durMs = typeof fields.duration_ms === 'number' ? fields.duration_ms : undefined
  set({
    entries: get().entries.map((e) =>
      e.id === entryId && e.kind === 'subagent'
        ? {
            ...e,
            status,
            running: false,
            finishedAt: Date.now(),
            detail: durMs != null ? `${(durMs / 1000).toFixed(0)}s` : e.detail,
          }
        : e,
    ),
  })
}

/** Non-empty trimmed string, or undefined. */
function nonBlankStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/**
 * task_backgrounded — create or promote a bg_task entry.
 *
 * Title priority mirrors TUI (pager handle_task_backgrounded):
 *   monitor_description → "[monitor] …" prefix on command → description
 *   (model tool description) → raw command → short task id.
 */
/** Coerce wire task_id (string | number | nested). */
function wireTaskId(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (c == null || c === '') continue
    if (typeof c === 'string' || typeof c === 'number' || typeof c === 'bigint') {
      return String(c)
    }
  }
  return ''
}

function handleTaskBackgrounded(
  get: () => ChatState,
  set: SetState,
  fields: Record<string, unknown>,
): void {
  const id = wireTaskId(fields.task_id, fields.taskId)
  if (!id) return
  // A LIVE task_backgrounded for a top-strip (restored) task: it is now
  // a genuine live scrollback row — drop it from the top strip and
  // create the entry below.
  if (get().topTasks.some((t) => t.taskId === id)) {
    set({ topTasks: get().topTasks.filter((t) => t.taskId !== id) })
  }
  if (get().bgTaskIndex[id]) return // already tracked

  const command = nonBlankStr(fields.command)
  const monitor =
    nonBlankStr(fields.monitor_description) ?? nonBlankStr(fields.monitorDescription)
  // Wire field is `description` (tool description); notif_description was a
  // mistaken name and never arrives on the wire.
  const description = nonBlankStr(fields.description)
  const outputFile = nonBlankStr(fields.output_file) ?? nonBlankStr(fields.outputFile)
  // Legacy / reparented monitors bake "[monitor] <desc>" into command.
  const monitorPrefix = command?.startsWith('[monitor] ')
    ? nonBlankStr(command.slice('[monitor] '.length))
    : undefined

  const title =
    monitor ??
    monitorPrefix ??
    description ??
    command ??
    `Task ${id.slice(0, 8)}`

  // When title is a human description, keep the raw command as secondary detail.
  const detail =
    command && command !== title && !monitorPrefix ? command : undefined

  const eid = nid()
  set((s) => ({
    bgTaskIndex: { ...s.bgTaskIndex, [id]: eid },
    entries: [
      ...s.entries,
      {
        id: eid,
        kind: 'bg_task',
        title,
        status: 'started',
        running: true,
        taskId: id,
        command: command ?? undefined,
        outputFile,
        detail,
        output: '',
        isMonitor: !!monitor || !!monitorPrefix,
      },
    ],
  }))
}

/** task_completed — settle a bg_task entry (finish flash). */
function handleTaskCompleted(
  get: () => ChatState,
  set: SetState,
  fields: Record<string, unknown>,
): void {
  // Envelope: {task_snapshot: {task_id, …}} (possibly nested in update).
  const snap = (fields.task_snapshot as Record<string, unknown> | undefined) ?? {}
  const id = wireTaskId(snap.task_id, snap.taskId, fields.task_id, fields.taskId)
  if (!id) return
  // A live completion for a top-strip (restored) task: it is over —
  // remove it from the strip (the orphan row below records the event).
  if (get().topTasks.some((t) => t.taskId === id)) {
    set({ topTasks: get().topTasks.filter((t) => t.taskId !== id) })
  }
  const entryId = get().bgTaskIndex[id]
  const snapOut = typeof snap.output === 'string' ? snap.output : undefined
  const snapCmd =
    nonBlankStr(snap.display_command) ??
    nonBlankStr(snap.displayCommand) ??
    nonBlankStr(snap.command)
  const snapDesc = nonBlankStr(snap.description)
  const failed =
    snap.explicitly_killed === true ||
    snap.explicitlyKilled === true ||
    (typeof snap.exit_code === 'number' && snap.exit_code !== 0) ||
    (typeof snap.exitCode === 'number' && snap.exitCode !== 0) ||
    (typeof snap.signal === 'string' && snap.signal.length > 0)
  const status = failed ? ('failed' as const) : ('completed' as const)

  // Page-boundary history: task_completed can land without the matching
  // task_backgrounded (it was in an older, not-yet-loaded page). TUI still
  // shows the row from the live registry / orphan scan — create one here.
  if (!entryId) {
    const title =
      snapDesc || snapCmd || `Task ${id.slice(0, 8)}`
    const eid = nid()
    set((s) => ({
      bgTaskIndex: { ...s.bgTaskIndex, [id]: eid },
      entries: [
        ...s.entries,
        {
          id: eid,
          kind: 'bg_task' as const,
          title,
          status,
          running: false,
          taskId: id,
          command: snapCmd,
          output: snapOut ?? '',
          finishedAt: Date.now(),
          detail:
            snapCmd && snapCmd !== title ? snapCmd : undefined,
        },
      ],
    }))
    return
  }

  set({
    entries: get().entries.map((e) =>
      e.id === entryId && e.kind === 'bg_task'
        ? {
            ...e,
            status,
            running: false,
            finishedAt: Date.now(),
            output:
              snapOut != null && snapOut.length >= (e.output?.length ?? 0)
                ? snapOut
                : e.output,
            command: snapCmd || e.command,
          }
        : e,
    ),
  })
}
