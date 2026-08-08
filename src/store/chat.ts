import { create } from 'zustand'
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
  SessionInfoDetail,
  SubagentStatus,
  SubagentViewItem,
  SubagentViewState,
  TaskTimelineEvent,
  Toast,
  ToolCall,
  TopTask,
  WorkspaceGroup,
  WorkspaceSummary,
} from '../api/types'
import { transport, type McpListServer } from '../api/localTransport'
import { applyQueueChanged, usePromptQueue } from './promptQueue'
import { toolHeader } from '../theme/glyphs'
import { repoNameFromCwd } from '../components/historyGroups'
import {
  projectDisplayRows,
  scanGroups,
  spanContaining,
} from '../scrollback/verbGroup'
import {
  nextThoughtMode,
  thoughtDisplayMode,
  thoughtModeStepDown,
  thoughtModeStepUp,
  type ThoughtDisplayMode,
} from '../scrollback/thoughtMode'
let entrySeq = 0
const nid = () => `e_${++entrySeq}_${Date.now()}`

/** 会话完成提醒去重窗口：同一会话在此窗口内只通知一次。 */
const NOTICE_DEDUP_WINDOW_MS = 30_000

/**
 * Busy 快照（模块级，非响应式）：refreshSessions 成功后对比上一份，
 * 检测"某会话 busy true→false"（= 跑完了）——覆盖所有完成路径，不依赖
 * 完成事件是否带对 sessionId（host 的 sessionIdFrom 会回退到 active
 * 会话，多会话切换时可能错标）。
 */
let lastBusySnapshot: Record<string, boolean> = {}

// ── cancel-turn preference (TUI cancel_subagents_on_turn_cancel) ────
// Saved by the cancel panel's "Always stop" / "Always continue" options.
// Once saved, Esc / [stop] act directly and the panel never opens.
const CANCEL_SUBAGENTS_PREF_KEY = 'acpfe.cancelSubagentsOnTurnCancel'

function loadCancelSubagentsPref(): boolean | null {
  try {
    const raw = window.localStorage.getItem(CANCEL_SUBAGENTS_PREF_KEY)
    if (raw == null) return null
    return raw === 'true'
  } catch {
    return null
  }
}

// ── per-session mode-flag persistence ───────────────────────────────
// The agent persists ONLY the session-mode dimension into the timeline:
// current_mode_update {currentModeId: plan|default|…} lands in
// updates.jsonl and history replay restores it. Permission mode
// (x.ai/yolo_mode_changed: ask / auto / always-approve) is a fire-and-
// forget notification the agent NEVER stores, so replay cannot restore
// it from the timeline. The FE keeps its own per-session copy
// (localStorage) — the web analog of the TUI's persisted permission
// mode — refreshed on every flag change and re-applied on resume/reload.
type ModeFlags = Partial<Pick<ChatState, 'planMode' | 'permissionMode' | 'yoloMode' | 'autoMode'>>

const MODE_FLAGS_KEY = 'acpfe.modeFlags'
/** Keep the map bounded (newest sessions win; UUID-ish keys keep insertion order). */
const MODE_FLAGS_MAX = 50

function loadModeFlagsMap(): Record<string, ModeFlags> {
  try {
    const raw = window.localStorage.getItem(MODE_FLAGS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, ModeFlags>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveModeFlags(sessionId: string, flags: ModeFlags): void {
  try {
    const map = loadModeFlagsMap()
    map[sessionId] = flags
    const ids = Object.keys(map)
    if (ids.length > MODE_FLAGS_MAX) {
      for (const id of ids.slice(0, ids.length - MODE_FLAGS_MAX)) delete map[id]
    }
    window.localStorage.setItem(MODE_FLAGS_KEY, JSON.stringify(map))
  } catch {
    /* persistence is best-effort */
  }
}

/** The flags this client last knew for a session ({} when unknown). */
function restoreModeFlags(sessionId?: string): ModeFlags {
  if (!sessionId) return {}
  return loadModeFlagsMap()[sessionId] ?? {}
}

// ── client-global default permission mode (config.toml ui.permission_mode) ──
// A session with no per-browser record (miss) falls back to the
// client-global default — the TUI's `[ui] permission_mode`, served
// read-only by the host's GET /api/settings. Precedence mirrors the TUI's
// load_permission_mode: permission_mode > legacy approval_mode > yolo=true.

/** Map a settings `ui` section to permission flags ({} = no default). */
function permissionFlagsFromUi(ui?: Record<string, unknown>): ModeFlags {
  if (!ui) return {}
  const perm = typeof ui.permission_mode === 'string' ? ui.permission_mode : undefined
  if (perm === 'always-approve') return { yoloMode: true, autoMode: false }
  if (perm === 'auto') return { yoloMode: false, autoMode: true }
  // 'default' / 'ask' / unknown → no client default (agent's own default).
  if (perm === undefined) {
    const legacy = typeof ui.approval_mode === 'string' ? ui.approval_mode : undefined
    if (legacy === 'always-approve') return { yoloMode: true, autoMode: false }
    if (legacy === 'auto') return { yoloMode: false, autoMode: true }
    if (ui.yolo === true) return { yoloMode: true, autoMode: false }
  }
  return {}
}

let cachedDefaultModeFlags: ModeFlags | undefined
let cachedDefaultFlagsPromise: Promise<ModeFlags> | null = null

/** Fetch the client-global default permission flags once (host /api/settings). */
function ensureDefaultModeFlags(): Promise<ModeFlags> {
  cachedDefaultFlagsPromise ??= transport
    .settings()
    .then((s) => {
      cachedDefaultModeFlags = permissionFlagsFromUi(s.ui)
      return cachedDefaultModeFlags
    })
    .catch(() => {
      cachedDefaultModeFlags = {}
      return cachedDefaultModeFlags
    })
  return cachedDefaultFlagsPromise
}

/**
 * The client-global default for a session that has no saved record
 * (synchronous; {} until ensureDefaultModeFlags resolves). A session
 * WITH saved yolo/auto flags never falls back.
 */
function defaultModeFlagsIfMissed(sessionId?: string): ModeFlags {
  if (!sessionId) return {}
  const saved = restoreModeFlags(sessionId)
  if (saved.yoloMode !== undefined || saved.autoMode !== undefined) return {}
  return cachedDefaultModeFlags ?? {}
}

/** Session's effective flags: its own record wins, miss → global default. */
function sessionModeFlags(saved: ModeFlags, defaults: ModeFlags): ModeFlags {
  return saved.yoloMode !== undefined || saved.autoMode !== undefined ? saved : defaults
}

/**
 * Permission seeds for session/new|load `_meta` (TUI absent-key ≠ off:
 * only send when a flag is actually known). yolo wins over auto — the
 * two are mutually exclusive on the wire.
 */
function permissionSeedMeta(
  flags: ModeFlags,
): { yoloMode: boolean; autoMode: boolean } | undefined {
  if (flags.yoloMode === undefined && flags.autoMode === undefined) return undefined
  return {
    yoloMode: flags.yoloMode === true,
    autoMode: flags.autoMode === true && flags.yoloMode !== true,
  }
}

// ── agent-restart re-seed ───────────────────────────────────────────
// The agent's permission mode lives in ITS process memory only — host
// restart (or agent crash) resets every session to the default ask while
// this browser's localStorage still remembers the real flags. The host
// stamps each hello with the agent spawn time; when it changes (including
// first contact) the browser re-sends its known flags as a
// yolo_mode_changed notification (the same channel the TUI uses at
// launch) so the agent's behavior matches what the UI displays again.
const LAST_AGENT_STARTED_KEY = 'acpfe.lastAgentStartedAt'
/** Latest hello `agentStartedAt` seen (for the post-defaults re-seed check). */
let lastHelloAgentStartedAt: number | undefined

/**
 * Detect an agent restart via the hello `agentStartedAt` stamp and
 * re-seed its in-memory permission mode from the flags this browser
 * knows for the session. Idempotent: fires once per agent instance
 * (recorded in localStorage), so a plain page reload never re-broadcasts
 * and cannot clobber another client's newer choice. No-op for older
 * hosts without the stamp.
 */
function maybeReseedPermissionMode(
  _get: () => ChatState,
  _set: SetState,
  agentStartedAt: number | undefined,
  sessionId?: string,
): void {
  if (typeof agentStartedAt !== 'number' || agentStartedAt <= 0 || !sessionId) return
  let prev: string | null = null
  try {
    prev = window.localStorage.getItem(LAST_AGENT_STARTED_KEY)
  } catch {
    /* ignore */
  }
  if (prev === String(agentStartedAt)) return
  try {
    window.localStorage.setItem(LAST_AGENT_STARTED_KEY, String(agentStartedAt))
  } catch {
    /* ignore */
  }
  const flags = {
    ...restoreModeFlags(sessionId),
    ...defaultModeFlagsIfMissed(sessionId),
  }
  const seed = permissionSeedMeta(flags)
  if (!seed) return
  // Same wire the TUI uses at launch (yolo_mode_changed); the agent
  // applies it globally to its resident sessions. ask/default need no
  // seed — that IS the agent's default.
  void transport.setMode(seed.yoloMode ? 'always-approve' : 'auto')
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

/** TUI context_bar fmt_tokens: "500", "5.2k", "48.8k", "1.2M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return n >= 10_000_000 ? `${Math.round(n / 1_000_000)}M` : `${(n / 1_000_000).toFixed(1)}M`
  }
  if (n >= 1_000) {
    return n >= 10_000 ? `${Math.round(n / 1_000)}k` : `${(n / 1_000).toFixed(1)}k`
  }
  return String(n)
}

/**
 * TUI /session-info (format_session_info): the host's SessionInfoDetail
 * rendered as a plain text block (fields on separate lines) that gets
 * pushed into the scrollback — fields render exactly as the host
 * reports them.
 */
function formatSessionInfo(info: SessionInfoDetail): string {
  const lines: string[] = ['Session info']
  if (info.title) lines.push(`  Title: ${info.title}`)
  if (info.sessionId) lines.push(`  Session ID: ${info.sessionId}`)
  if (info.cwd) lines.push(`  Workspace: ${info.cwd}`)
  if (info.model) {
    const m = info.model
    const label = [m.name || m.modelId, m.reasoningEffort].filter(Boolean).join(' · ')
    lines.push(`  Model: ${label}`)
  }
  const ctxSize = info.contextSize || info.model?.contextWindow || 0
  if (ctxSize > 0) {
    const used = info.contextUsed ?? 0
    const pct = Math.round((used / ctxSize) * 100)
    lines.push(`  Context: ${fmtTokens(used)} / ${fmtTokens(ctxSize)} tokens (${pct}%)`)
  }
  if (info.gitBranch) {
    const wt =
      info.gitIsWorktree && info.gitMainRepo
        ? ` (worktree of ${info.gitMainRepo})`
        : info.gitIsWorktree
          ? ' (worktree)'
          : ''
    lines.push(`  Git: ${info.gitBranch}${wt}`)
  }
  if (info.hostName || info.hostId) {
    lines.push(`  Host: ${[info.hostName, info.hostId].filter(Boolean).join(' · ')}`)
  }
  return lines.join('\n')
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

/** Known non-plan permission modes (a `permissionMode` payload with one of
 *  these means the agent is NOT in plan mode). */
const NON_PLAN_MODES = new Set([
  'ask',
  'default',
  'normal',
  'always-approve',
  'always_approve',
  'yolo',
  'auto',
])

/**
 * Best-effort plan/permission flags out of an opaque `modes` payload
 * (hello / ready / modes_update). The host may ship the mode state under
 * several key spellings; anything unrecognized is left alone so the local
 * `planMode` value survives.
 */
function extractModeFlags(
  modes: unknown,
): Partial<
  Pick<ChatState, 'planMode' | 'permissionMode' | 'yoloMode' | 'autoMode'>
> | null {
  if (!modes || typeof modes !== 'object' || Array.isArray(modes)) return null
  const o = modes as Record<string, unknown>
  const out: Partial<
    Pick<ChatState, 'planMode' | 'permissionMode' | 'yoloMode' | 'autoMode'>
  > = {}
  const read = (...keys: string[]): unknown => {
    for (const k of keys) {
      const v = o[k]
      if (v !== undefined && v !== null) return v
    }
    return undefined
  }
  const plan = read('planMode', 'plan_mode', 'isPlanMode')
  if (typeof plan === 'boolean') out.planMode = plan
  // Explicitly permission-y keys; the generic `mode` key is only trusted
  // for plan-mode derivation below.
  const perm = read('permissionMode', 'permission_mode', 'modeId', 'mode_id')
  if (typeof perm === 'string' && perm) {
    out.permissionMode = perm
    if (perm === 'plan') out.planMode = true
    else if (NON_PLAN_MODES.has(perm)) out.planMode = false
  }
  // `mode`/'current_mode' as a plan indicator only (e.g. { mode: 'plan' }).
  const mode = read('mode', 'currentMode', 'current_mode')
  if (typeof mode === 'string' && mode) {
    if (mode === 'plan') out.planMode = true
    else if (NON_PLAN_MODES.has(mode)) out.planMode = false
  }
  // The agent's session-mode catalog uses `currentModeId` (session/new|load
  // `modes` AND the stored current_mode_update update — both carry
  // {currentModeId} directly). 'plan'/'default'/'ask' drive the plan
  // dimension; the agent also mirrors permission modes as session-mode ids
  // ('auto' / 'always-approve' / 'yolo'), so those restore the permission
  // flags when no explicit permissionMode key is present. Unknown ids are
  // left alone so the local flags survive.
  const currentMode = read('currentModeId', 'current_mode_id')
  if (typeof currentMode === 'string' && currentMode) {
    if (currentMode === 'plan') out.planMode = true
    else if (NON_PLAN_MODES.has(currentMode)) out.planMode = false
    if (perm == null) {
      if (currentMode === 'auto') {
        out.autoMode = true
        out.permissionMode = 'auto'
      } else if (
        currentMode === 'always-approve' ||
        currentMode === 'always_approve' ||
        currentMode === 'yolo'
      ) {
        out.yoloMode = true
        out.permissionMode = 'always-approve'
      }
    }
  }
  const yolo = read('yoloMode', 'yolo_mode')
  if (typeof yolo === 'boolean') out.yoloMode = yolo
  const auto = read('autoMode', 'auto_mode')
  if (typeof auto === 'boolean') out.autoMode = auto
  return Object.keys(out).length > 0 ? out : null
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
  /** Session summaries bucketed by workspace (workspace-list). */
  workspaces: WorkspaceGroup[]
  workspaceLoading: boolean
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
  /**
   * Slash commands advertised by the agent (ACP `available_commands_update`
   * → host `commands_update`). The slash menu merges them after the local
   * registry (local names win on collision); invoking one sends the raw
   * `/name args` line as a user message (TUI PassThrough semantics).
   */
  agentCommands: AgentCommand[]
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
  /** In-page completion toasts (fallback when system notifications are
   *  not granted). */
  toasts: Toast[]
  /** Mark a session's completion notice as seen (opened/being viewed). */
  clearCompletedNotice: (sessionId: string) => void
  /** Dismiss one in-page toast by id. */
  dismissToast: (id: string) => void
  /** Push one in-page toast (top-right stack, auto-dismisses ~6s). */
  pushToast: (text: string) => void
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
  /** Settings modal (TUI F2 / /settings) — read-only config.toml view. */
  settingsOpen: boolean
  openSettings: () => void
  closeSettings: () => void
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

  // ── goal mode (TUI /goal) — PROMPT-PATH control ─────────────────────
  // The wire defines `goal_updated` notifications but NO goal control
  // methods, so every goal action instructs the agent (which owns the
  // update_goal tool) through send()/promptQueue — the best feasible
  // port of the TUI's /goal set/status/pause/resume/clear.
  goalSet: (objective: string) => void
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
  send: (text: string, blocks?: ContentBlock[]) => Promise<void>
  cancel: () => Promise<void>
  /**
   * Append a LOCAL-ONLY scrollback entry (shell mode output, etc.) —
   * rendered like a normal row but never sent to the agent. Kind is
   * limited to the entry kinds the scrollback renders as plain text.
   */
  appendLocalEntry: (entry: {
    kind: 'user' | 'session_event' | 'error'
    text: string
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
  /** x.ai/sessions/changed — refresh the history list. */
  refreshSessions: () => Promise<void>
  /** 按工作区拉取会话摘要（workspace-list）；失败降级为 sessions 按 cwd 分组。 */
  refreshWorkspaces: () => Promise<void>
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
  /**
   * On-demand fetch of a subagent session's stored updates (block viewer
   * timeline, TUI replay_inherited_updates 同款): reads the child
   * session's updates.jsonl via the host's session-updates endpoint
   * (same cwd as the parent) and replays the envelopes through the same
   * view processor as live events. No-op unless the view exists and is
   * idle with an empty timeline.
   */
  fetchSubagentView: (childSessionId: string) => Promise<void>
  toggleGroupExpansion: (anchorId: string) => void
  /** Open / close the /session-info modal. */
  openSessionInfo: () => void
  closeSessionInfo: () => void
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

/**
 * Normalize an `image` event payload into a renderable <img> src.
 * Data URIs pass through untouched; bare base64 is wrapped with the
 * event's mimeType (image/png fallback when absent/invalid).
 */
function imageSrc(data: string, mimeType?: string): string | undefined {
  const d = typeof data === 'string' ? data.trim() : ''
  if (!d) return undefined
  if (d.startsWith('data:')) return d
  const mime =
    mimeType && /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ? mimeType : 'image/png'
  return `data:${mime};base64,${d}`
}

/**
 * Send a goal/workflow control prompt through the PROMPT path: queue
 * mid-turn like any Enter prompt (promptQueue auto-sends at turn end),
 * send immediately otherwise. `feedback` lands on the status line AFTER
 * send()'s synchronous 'Thinking' stamp so the confirmation stays
 * visible; the next connection event replaces it.
 */
function sendControlPrompt(
  get: () => ChatState,
  set: SetState,
  text: string,
  feedback: string,
): void {
  const st = get()
  if (st.conn === 'busy') {
    usePromptQueue.getState().enqueue({
      text,
      blocks: [{ type: 'text', text }],
    })
    set({ statusText: `${feedback}（已排队，回合结束后发送）` })
    return
  }
  void st.send(text)
  set({ statusText: feedback })
}

export const useChatStore = create<ChatState>((set, get) => ({
  entries: [],
  conn: 'connecting',
  statusText: '连接中…',
  awaitingNext: false,
  hosts: [],
  sessions: [],
  workspaces: [],
  workspaceLoading: false,
  historyOpen: false,
  historyLoading: false,
  historyLoadedCount: 0,
  historyHasMore: false,
  historyLoadingMore: false,
  pending: [],
  agentCommands: [],
  xaiRequests: [],
  subagentIndex: {},
  pendingSubagentFinishes: {},
  subagentChildIndex: {},
  subagentViews: {},
  bgTaskIndex: {},
  topTasks: [],
  completedNotices: {},
  toasts: [],
  mcpServers: [],
  mcpVersion: 0,
  mcpInit: undefined,
  followUps: undefined,
  followUpsResponseId: undefined,
  models: [],
  workflowRuns: {},
  selectedWorkflowRunId: undefined,
  setSelectedWorkflowRunId: (id) => set({ selectedWorkflowRunId: id }),
  goalReceivedAt: undefined,
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
  showTimestamps: true,
  toggleTimestamps: () =>
    set((s) => ({
      showTimestamps: !s.showTimestamps,
      statusText: s.showTimestamps ? '时间戳: 关' : '时间戳: 开',
    })),
  scheduledTasks: [],
  rewindOpen: false,
  openRewind: () => set({ rewindOpen: true }),
  closeRewind: () => set({ rewindOpen: false }),
  stashedDraft: null,
  setStashedDraft: (text) => set({ stashedDraft: text }),
  cancelPanelOpen: false,
  openCancelPanel: () => set({ cancelPanelOpen: true }),
  closeCancelPanel: () => set({ cancelPanelOpen: false }),
  cancelSubagentsPref: loadCancelSubagentsPref(),
  setCancelSubagentsPref: (stop) => {
    try {
      window.localStorage.setItem(CANCEL_SUBAGENTS_PREF_KEY, stop ? 'true' : 'false')
    } catch {
      /* storage unavailable — the preference stays in-memory */
    }
    set({ cancelSubagentsPref: stop })
  },
  hasRunningSubagent: () =>
    get().entries.some(
      (e) => e.kind === 'subagent' && e.running === true && !!e.subagentId,
    ),
  requestCancelTurn: async () => {
    const s = get()
    if (s.conn !== 'busy') return
    const pref = s.cancelSubagentsPref
    if (pref != null) {
      // Saved preference: act directly, never show the panel.
      await s.cancelTurn({ cancelSubagents: pref })
      return
    }
    if (s.hasRunningSubagent()) {
      // Running subagents + no preference → the panel decides.
      set({ cancelPanelOpen: true })
      return
    }
    // Nothing to prompt about — cancel the turn directly.
    await s.cancelTurn({})
  },
  modeBanner: null,
  showModeBanner: (text) => set({ modeBanner: text }),
  clearModeBanner: () => set({ modeBanner: null }),
  queuePanelOpen: false,
  setQueuePanelOpen: (open) =>
    set({
      queuePanelOpen:
        typeof open === 'function' ? open(get().queuePanelOpen) : open,
    }),
  planMode: false,

  // ── goal mode — PROMPT-PATH control (see ChatState docs) ────────────
  goalSet: (objective) => {
    const o = objective.trim()
    if (!o) {
      set({ statusText: '目标设定失败: 缺少目标描述' })
      return
    }
    sendControlPrompt(
      get,
      set,
      `请设定自主目标（用 update_goal 工具）：${o}`,
      '目标设定指令已发送',
    )
  },
  goalStatus: () =>
    sendControlPrompt(
      get,
      set,
      '请报告当前自主目标状态（goal status）',
      '目标状态查询已发送',
    ),
  goalPause: () =>
    sendControlPrompt(
      get,
      set,
      '请暂停当前自主目标（用 update_goal 工具暂停目标执行）',
      '目标暂停指令已发送',
    ),
  goalResume: () =>
    sendControlPrompt(
      get,
      set,
      '请恢复当前自主目标（用 update_goal 工具恢复目标执行）',
      '目标恢复指令已发送',
    ),
  goalClear: () =>
    sendControlPrompt(
      get,
      set,
      '请清除当前自主目标（用 update_goal 工具清除目标）',
      '目标清除指令已发送',
    ),

  /**
   * Workflow pause/resume/stop — same protocol gap as goals: no wire
   * method exists for workflow control, so the instruction goes through
   * the prompt path. Before sending, the row is optimistically updated
   * to the target status with a pendingControl marker; the next
   * workflow_updated for this run corrects both (the event is
   * authoritative).
   */
  workflowControl: (runId, action) => {
    const st = get()
    const run = st.workflowRuns[runId]
    if (!run) return
    const verb = action === 'pause' ? '暂停' : action === 'resume' ? '恢复' : '停止'
    const targetStatus =
      action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'cancelled'
    set({
      workflowRuns: {
        ...st.workflowRuns,
        [runId]: { ...run, status: targetStatus, pendingControl: action },
      },
    })
    sendControlPrompt(
      get,
      set,
      `请${verb}工作流 ${run.name}（用 workflow 工具的 ${action}）`,
      `工作流「${run.name}」${verb}指令已发送（等待 workflow_updated 校正）`,
    )
  },

  /**
   * "Save script" — local-only: copies the run's script payload (when
   * the workflow_updated event carried one) to the clipboard and reports
   * a summary on the status line. No wire round-trip; runs without a
   * script payload just report it as unavailable.
   */
  saveWorkflowScript: async (runId) => {
    const run = get().workflowRuns[runId]
    if (!run) return
    const script = run.script ?? ''
    if (!script.trim()) {
      set({
        statusText: `工作流「${run.name}」脚本不可用（workflow_updated 未携带 script 字段）`,
      })
      return
    }
    try {
      await navigator.clipboard.writeText(script)
      set({
        statusText: `已复制「${run.name}」脚本到剪贴板（${script.length} 字符）`,
      })
    } catch (e) {
      set({
        statusText: `复制失败: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  },
  goalPanelOpen: false,
  setGoalPanelOpen: (open) => set({ goalPanelOpen: open }),
  workflowPanelOpen: false,
  setWorkflowPanelOpen: (open) => set({ workflowPanelOpen: open }),
  diffReviewOpen: false,
  openDiffReview: () => set({ diffReviewOpen: true }),
  closeDiffReview: () => set({ diffReviewOpen: false }),
  memoryOpen: false,
  openMemory: () => set({ memoryOpen: true }),
  closeMemory: () => set({ memoryOpen: false }),
  extensionsOpen: false,
  extensionsTab: 'hooks',
  openExtensions: (tab) => set({ extensionsOpen: true, extensionsTab: tab }),
  closeExtensions: () => set({ extensionsOpen: false }),
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

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
        // 子代理会话事件流：宿主按 withSid 广播所有会话的 session/update
        // 事件，子代理（child_session_id）的 chunk/thought/tool_call/… 也
        // 在内。命中 subagentChildIndex 的会话喂给该子代理的迷你 scrollback
        // 视图处理器（不进主 handleEvent，避免污染宿主 scrollback）——TUI
        // 按 sessionId 路由进 subagent_views 的等价实现。
        if (s.subagentChildIndex[evSid] != null) {
          applySubagentViewEvent(set, evSid, ev)
        }
        return
      }
      s.handleEvent(ev)
    })
    // Persist plan/permission flags per session. The agent never stores
    // permission mode (yolo_mode_changed is fire-and-forget), so this
    // copy is what restores ask/auto/always-approve after a resume or
    // reload. Skipped while history is (re)building: loadHistory resets
    // the flags to defaults and replay re-derives them — persisting
    // mid-replay would clobber the live-known flags with reset values.
    const unsubMode = useChatStore.subscribe((s, prev) => {
      if (s.historyLoading || s.historyLoadingMore) return
      if (
        s.sessionId &&
        (s.planMode !== prev.planMode ||
          s.permissionMode !== prev.permissionMode ||
          s.yoloMode !== prev.yoloMode ||
          s.autoMode !== prev.autoMode)
      ) {
        saveModeFlags(s.sessionId, {
          planMode: s.planMode,
          permissionMode: s.permissionMode,
          yoloMode: s.yoloMode,
          autoMode: s.autoMode,
        })
      }
    })
    transport.connect()
    void get().refreshHosts()
    // Prefetch the client-global default permission mode (config.toml
    // ui.permission_mode) so hello/ready misses can show it immediately.
    // Once loaded, apply it to the announced session when nothing
    // session-specific is known yet, and re-check the agent-restart
    // re-seed — a hello that arrived before the defaults had nothing to
    // seed from, but now the miss fallback is available.
    void ensureDefaultModeFlags().then(() => {
      const s = get()
      if (s.sessionId && s.yoloMode === undefined && s.autoMode === undefined) {
        const flags = defaultModeFlagsIfMissed(s.sessionId)
        if (flags.yoloMode !== undefined || flags.autoMode !== undefined) set(flags)
      }
      if (lastHelloAgentStartedAt != null) {
        maybeReseedPermissionMode(get, set, lastHelloAgentStartedAt, s.sessionId)
      }
    })
    return () => {
      unsub()
      unsubMode()
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
      workspaces: [],
      workspaceLoading: false,
      pending: [],
      xaiRequests: [],
      diffReview: undefined,
      diffReviewOpen: false,
      memoryFiles: undefined,
      memoryOpen: false,
      pendingOptimisticUserId: undefined,
      modes: undefined,
      agentCommands: [],
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
      pendingSubagentFinishes: {},
      subagentChildIndex: {},
      subagentViews: {},
      bgTaskIndex: {},
      topTasks: [],
      scheduledTasks: [],
      followUps: undefined,
      followUpsResponseId: undefined,
      cancelPanelOpen: false,
      queuePanelOpen: false,
      planMode: false,
    })
    // Apply the host's status snapshot through the normal hello path so
    // model state, pending requests and busy flags hydrate consistently.
    try {
      const st = await transport.status()
      // GET /api/status serializes the host Status struct verbatim, so a
      // boot failure arrives as `bootError` — while the SSE hello event
      // (http.go handleSSE) maps the same field to `error`. Normalize so
      // a failed boot surfaces the error instead of hanging on "启动中…"
      // (the hello handler reads ev.error). Never clobber an `error` that
      // the snapshot itself already carried.
      const snapError: string | undefined =
        typeof st.bootError === 'string' && st.bootError
          ? st.bootError
          : typeof st.error === 'string'
            ? st.error
            : undefined
      transport.emitLocal({
        type: 'hello',
        ...st,
        ...(snapError ? { error: snapError } : {}),
      })
    } catch {
      set({ conn: 'error', statusText: 'Host 不可达' })
      return
    }
    void get().refreshSessions()
    void get().refreshWorkspaces()
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
        const { sessions } = await transport.listSessions()
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

  showSessionInfo: async () => {
    try {
      const info = await transport.sessionInfo()
      // Host's in-process record can lag on the title (agent-side
      // session_info_update not delivered for resumed sessions) — merge
      // it from the roster list we already fetched.
      if (!info.title) {
        const s = get().sessions.find((x) => x.sessionId === info.sessionId)
        if (s?.title) info.title = s.title
      }
      appendEntry(set, { kind: 'status', text: formatSessionInfo(info) })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      appendEntry(set, { kind: 'error', text: `/session-info 失败: ${msg}` })
    }
  },

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
      diffReview: undefined,
      diffReviewOpen: false,
      memoryFiles: undefined,
      memoryOpen: false,
      subagentIndex: {},
      pendingSubagentFinishes: {},
      subagentChildIndex: {},
      subagentViews: {},
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
      planMode: false,
      mcpServers: [],
      mcpInit: undefined,
      selectedId: null,
      focusMode: 'prompt',
      expandedGroups: new Set(),
      viewerEntryId: null,
      viewerTask: undefined,
      followUps: undefined,
      followUpsResponseId: undefined,
      error: undefined,
      statusWarning: undefined,
      usage: undefined,
      todoCounts: undefined,
      todos: undefined,
      turnStartedAt: undefined,
      scheduledTasks: [],
    })
    try {
      let loaded = 0
      let total = 0
      let pages = 0
      // Turn metadata of the newest replayed page (real start time + open
      // flag), used below to restore the in-flight turn timer.
      let replayMeta: { turnStartedAt?: number; turnOpen: boolean } = {
        turnOpen: false,
      }
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
          replayMeta = replayUpdates(get, updates)
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
        // In-flight session (replayed tail has no turn_completed): restore
        // the REAL turn start from the envelope timestamps so the timer
        // reads "已进行 Xs" instead of anchoring at replay time. Live
        // events arriving after the replay keep this start (busy keeps
        // turnStartedAt via ??). Closed turns clear it.
        ...(replayMeta.turnOpen
          ? {
              turnStartedAt: replayMeta.turnStartedAt,
              statusText: replayMeta.turnStartedAt
                ? `回合进行中（已进行 ${formatTurnDuration(
                    Date.now() - replayMeta.turnStartedAt,
                  )}）`
                : '回合进行中',
            }
          : {
              turnStartedAt: undefined,
              statusText: `历史已加载 (共 ${get().historyTotalCount ?? '?'} 条更新)`,
            }),
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

  // ── 会话完成提醒（非当前会话 turn 跑完）───────────────────────────
  // Live turn_completed 事件带 sessionId：别的会话跑完时置对勾 +
  // 系统通知（未授权则页面 toast）。同一会话 30s 窗口内不重复通知。
  clearCompletedNotice: (sessionId) => {
    if (!sessionId) return
    const cur = get().completedNotices
    if (!(sessionId in cur)) return
    const next = { ...cur }
    delete next[sessionId]
    set({ completedNotices: next })
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  pushToast: (text) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    set({ toasts: [...get().toasts, { id, text }].slice(-4) })
  },

  noteSessionCompleted: (sessionId) => {
    const s = get()
    if (!sessionId || sessionId === s.sessionId) return
    const now = Date.now()
    const last = s.completedNotices[sessionId]
    set({ completedNotices: { ...s.completedNotices, [sessionId]: now } })
    if (last && now - last < NOTICE_DEDUP_WINDOW_MS) return
    const live = s.sessions.find((x) => x.sessionId === sessionId)
    const title = live?.title || sessionId.slice(0, 12)
    const text = `「${title}」已完成`
    const toastId = `done_${sessionId}_${now}`
    // 系统通知（页面切走/最小化也能看到）；成功则不重复弹页面 toast。
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(`会话完成：${title}`, { body: '点击左侧会话列表查看' })
        return
      } catch {
        /* some browsers throw on construction — fall through to toast */
      }
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      // 首次遇到完成事件时请求一次授权。授予后系统通知已发出 — 撤掉
      // 刚入队的页面 toast，避免双重提醒；期间用户已打开该会话时通知
      // 作废，toast 一并撤掉。
      void Notification.requestPermission().then((p) => {
        if (!get().completedNotices[sessionId]) {
          set({ toasts: get().toasts.filter((t) => t.id !== toastId) })
          return
        }
        if (p !== 'granted') return
        try {
          new Notification(`会话完成：${title}`, { body: '点击左侧会话列表查看' })
          set({ toasts: get().toasts.filter((t) => t.id !== toastId) })
        } catch {
          /* 构造失败 — 保留页面 toast 作为兜底 */
        }
      })
    }
    set({ toasts: [...s.toasts, { id: toastId, text }].slice(-4) })
  },

  continueSession: async (sessionId: string, cwd: string) => {
    if (get().historyLoading || get().historyLoadingMore) return
    // Opening the session clears its completion notice.
    get().clearCompletedNotice(sessionId)
    set({ historyOpen: false, historyLoading: true })
    try {
      // 1) Make this session the active one (session/load or focus-if-busy);
      // 2) load its tail. Models come from the HTTP response — more reliable
      // than waiting for the SSE ready event, which can race historyLoading.
      // Permission mode rides session/load `_meta` (the agent never persists
      // ask/auto/always-approve — yolo_mode_changed is fire-and-forget), so
      // seed it from the flags this client saved for the session, TUI-style:
      // yoloMode/autoMode are mutually exclusive, yolo wins. Only send when
      // this browser actually knows the session's permission flags.
      const savedFlags = restoreModeFlags(sessionId)
      // Miss (no per-browser record for this session) → client-global
      // default from config.toml ui.permission_mode (TUI parity).
      const defaultFlags = await ensureDefaultModeFlags()
      const modeFlags = sessionModeFlags(savedFlags, defaultFlags)
      const modeMeta = permissionSeedMeta(modeFlags)
      const loaded = await transport.loadSession(sessionId, cwd, modeMeta)
      if (loaded.models != null || loaded.modes != null) {
        const modelSnap = applySessionModelState(loaded.models, undefined)
        set({
          ...modelSnap,
          ...(loaded.modes != null ? { modes: loaded.modes } : {}),
          // Same extraction as hello/ready: the load response's `modes`
          // (SessionModeState, currentModeId + availableModes) restores
          // the plan/permission flags — without it a plan-mode session
          // resumes showing Normal until the next mode change.
          ...(loaded.modes != null ? extractModeFlags(loaded.modes) : {}),
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
      // The agent never persists permission mode (yolo_mode_changed is a
      // fire-and-forget notification), so the replayed timeline cannot
      // restore ask/auto/always-approve — re-apply the flags this client
      // knows for the session (saved record, or the config.toml default on
      // a miss). Plan mode is re-derived by the replayed current_mode_update
      // timeline; the saved copy matches it in the common case and fills
      // the permission gaps.
      set({ ...modeFlags })
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
          // Same local-streaming guard as hello: if THIS frontend is
          // already streaming a turn (reconnect mid-turn), keep its live
          // status text instead of the generic host wait.
          const hasLocalStreaming =
            get().openThoughtId != null || get().openAssistantId != null
          set({
            historyLoading: false,
            conn: 'busy',
            statusText: hasLocalStreaming ? get().statusText : 'Waiting for host…',
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

  handleEvent: (ev) => {
    // Host typed-event carrier (protocol alignment — "single typed event
    // per kind"): modeled x.ai kinds arrive as {type: <kind>, update,
    // sessionId} with the verbatim SessionUpdate envelope in `update`
    // (subagent_spawned/progress/finished, session_recap, workflow_updated,
    // goal_updated, memory_flush_*, auto_compact_*, hook_*, task_*, …).
    // The FE's unified consumer for these kinds is the session_notification
    // channel keyed by the update's sessionUpdate tag — rewrite them here
    // so every kind reaches its shared handler. Typed turn_completed keeps
    // its own top-level path (cross-session notices ride ev.sessionId);
    // standalone-channel events ({type, params}) and normalized kinds
    // (tool_call, plan, usage, modes_update, …) carry no `update` and pass
    // through untouched.
    const raw = ev as { update?: unknown }
    if (raw.update && typeof raw.update === 'object') {
      const u = raw.update as { sessionUpdate?: unknown }
      if (typeof u.sessionUpdate === 'string' && ev.type !== 'turn_completed') {
        ev = {
          type: 'session_notification',
          method: 'session/update',
          params: u,
        } as AcpEvent
      }
    }
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
          // Permission mode is not in the agent's modes payload — re-apply
          // the flags this client saved for the session (extractModeFlags
          // below still wins for whatever the payload DOES carry). A miss
          // falls back to the config.toml default when already loaded.
          ...restoreModeFlags(ev.sessionId),
          ...defaultModeFlagsIfMissed(ev.sessionId),
          ...extractModeFlags(ev.modes),
        })
        if (ev.busy) {
          // Preserve an existing turn timer across mid-turn re-busy/reconnect;
          // otherwise anchor it now (same rule as the `busy` event handler).
          const busyTurn = get().turnStartedAt ?? Date.now()
          // The busy flag alone is not "waiting for host": a reconnect
          // mid-turn keeps this frontend's own streaming state, and its
          // live status text (Thinking… / Responding…) must stand. Only a
          // busy flag WITHOUT a local streaming turn (fresh page, or a
          // turn started by another client) is a genuine wait for the
          // host to sync the in-flight turn.
          const hasLocalStreaming =
            get().openThoughtId != null || get().openAssistantId != null
          set({
            conn: 'busy',
            statusText: hasLocalStreaming ? get().statusText : 'Waiting for host…',
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
          // The user is looking at this session now — clear its notice.
          if (ev.sessionId) get().clearCompletedNotice(ev.sessionId)
          void get().refreshGitInfo()
        }
        // Agent restart (host respawned the agent → in-memory permission
        // mode reset): re-seed the browser-known flags once per instance.
        if (typeof ev.agentStartedAt === 'number' && ev.agentStartedAt > 0) {
          lastHelloAgentStartedAt = ev.agentStartedAt
          maybeReseedPermissionMode(get, set, ev.agentStartedAt, ev.sessionId)
        }
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
          // Same restore as hello: the load response's modes rarely carries
          // permission info, so saved per-session flags fill the gap; a
          // miss falls back to the config.toml default when already loaded.
          ...restoreModeFlags(ev.sessionId),
          ...defaultModeFlagsIfMissed(ev.sessionId),
          ...extractModeFlags(ev.modes),
        })
        void get().refreshHosts()
        void get().refreshGitInfo()
        break
      }
      case 'busy': {
        // 多会话广播（host withSid 约定）：非当前会话的 busy 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // TUI: the Thinking… block is pre-created at stream_start (first
        // chunk), NOT on the busy flag — so a fresh busy is the
        // wait-for-first-token window ("Waiting for response…"). A busy
        // while THIS frontend is already streaming (reconnect mid-turn)
        // keeps the live status text.
        const s = get()
        // Anchor the "Worked for Xs" timer; don't reset on mid-turn re-busy.
        const turnStartedAt = s.turnStartedAt ?? Date.now()
        const hasLocalStreaming =
          s.openThoughtId != null || s.openAssistantId != null
        set({
          conn: 'busy',
          statusText: hasLocalStreaming ? s.statusText : 'Waiting for response…',
          awaitingNext: false,
          turnStartedAt,
          // A turn starting means the system recovered — clear stale
          // error/status banners.
          error: undefined,
          statusWarning: undefined,
        })
        break
      }
      case 'user_message':
      case 'user_chunk': {
        // Live echo (user_chunk) or history replay (user_message). Classify
        // like TUI handle_user_message: cron → UserPromptBlock::cron, other
        // system-reminder / auto-wake echoes → hidden, else normal prompt.
        const raw = ev.text || ''
        if (!raw) break
        // The host forwards chunk/content-block meta on live user_chunk
        // events (same shape the replay path reads): hideFromScrollback
        // drops the row, displayText overrides the raw text, displayAsCron
        // marks cron framing. Without this, live and replay classified the
        // same system-injected prompt differently.
        if (ev.type === 'user_chunk') {
          if (ev.hideFromScrollback === true) break
        }
        const metaText =
          ev.type === 'user_chunk' && typeof ev.displayText === 'string'
            ? ev.displayText
            : undefined
        const metaCron = ev.type === 'user_chunk' && ev.displayAsCron === true
        const classified = classifyUserPrompt(
          metaText ?? raw,
          ev.type === 'user_message' ? ev.isCron : metaCron,
        )
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
      case 'image': {
        // Image content block (agent_message_chunk / user_message_chunk).
        // 1. Open assistant row → append (sealing any open thought, same
        //    as text chunks);
        // 2. else pending optimistic user row → merge there (user-sent
        //    image echoed back — no duplicate row);
        // 3. else standalone image entry.
        const src = imageSrc(ev.data, ev.mimeType)
        if (!src) break
        const sealed = sealThought(get())
        const { openAssistantId, entries } = sealed
        const img = { data: src, mimeType: ev.mimeType }
        if (openAssistantId) {
          set({
            ...sealed,
            conn: 'busy',
            statusText: 'Responding…',
            awaitingNext: false,
            entries: entries.map((e) =>
              e.id === openAssistantId && e.kind === 'assistant'
                ? { ...e, images: [...(e.images ?? []), img] }
                : e,
            ),
          })
          break
        }
        const pendingId = get().pendingOptimisticUserId
        if (pendingId) {
          const idx = entries.findIndex((e) => e.id === pendingId && e.kind === 'user')
          if (idx >= 0) {
            set({
              ...sealed,
              openAssistantId: undefined,
              entries: entries.map((e) =>
                e.id === pendingId && e.kind === 'user'
                  ? { ...e, images: [...(e.images ?? []), img] }
                  : e,
              ),
            })
            break
          }
        }
        set({
          ...sealed,
          openAssistantId: undefined,
          entries: [
            ...entries,
            {
              id: nid(),
              kind: 'image',
              data: src,
              mimeType: ev.mimeType,
              ts: ev.ts ?? Date.now(),
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
            statusText: 'Responding…',
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
            statusText: 'Responding…',
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
              displayMode: 'expanded',
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
          statusText: 'Thinking…',
          awaitingNext: false,
          openThoughtId,
          openAssistantId: undefined,
          entries: entries.map((e) =>
            e.id === openThoughtId && e.kind === 'thought'
              ? {
                  ...e,
                  text: e.text + text,
                  streaming: true,
                  displayMode: 'expanded', // keep body visible while flowing
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
          // Activity start for the turn status line's phase timer (TUI
          // tracker started_at); replay/completed snapshots omit it.
          ...(running ? { startedAt: Date.now() } : {}),
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
        // A running tool settling is a wait-for-next-token window (TUI
        // Waiting(Model) between tool completion and the next inference
        // stream) — the status line reads "Waiting for response…" until
        // the next streamed event.
        const existing = get().entries.find((e) => e.id === entryId)
        const wasRunningBefore =
          existing?.kind === 'tool' &&
          (existing.status === 'pending' || existing.status === 'in_progress')
        const settledNow =
          wasRunningBefore &&
          (tc.status === 'completed' || tc.status === 'failed')
        set({
          ...(settledNow ? { statusText: 'Waiting for response…' } : {}),
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
        const planFlag = (ev as unknown as { planMode?: unknown }).planMode
        set({
          openAssistantId: undefined,
          todoCounts: counts,
          todos: items,
          // Some hosts piggyback the plan-mode flag on the plan event —
          // apply it when present, otherwise keep the local value.
          ...(typeof planFlag === 'boolean' ? { planMode: planFlag } : {}),
        })
        break
      }
      case 'usage':
        // 多会话广播（host withSid 约定）：非当前会话的 usage 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
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
        // Live done events carry the owning sessionId. A turn finished in
        // a DIFFERENT session → completion notice + sidebar ✓ only; the
        // seal below belongs to THIS session's turn (without this guard
        // another session's done would wrongly finalize the active one).
        if (ev.sessionId && ev.sessionId !== get().sessionId) {
          get().noteSessionCompleted(ev.sessionId)
          break
        }
        // TUI TurnCompleted marker ("Worked for 2.0s") — the last scrollback
        // line above the composer, mirroring turn_completion.rs. Idempotent:
        // prompt_complete may race ahead and finalize the turn first.
        // NOT for failed/cancelled turns: error/rate_limit get the
        // TurnFailed marker from the x.ai turn_completed rail, cancelled
        // gets its own TurnCancelled marker from the host's cancelled
        // event (TUI prompt_origin.rs stop_reason mapping) — neither
        // renders a "Worked for" line.
        const turnStart = get().turnStartedAt
        const failedTurn =
          ev.stopReason === 'error' ||
          ev.stopReason === 'rate_limit' ||
          ev.stopReason === 'cancelled'
        // TUI prompt_origin.rs: no-output turns suppress the marker
        // (had_output → None); bash turns (the `!` shell-mode prompt)
        // suppress it too (QueueEntryKind::BashCommand → bash_turn →
        // TurnComplete suppression, queue.rs:785). Only turns with real
        // output after the user prompt get the "Worked for" line.
        let bashTurn = false
        let hasOutput = false
        for (let i = get().entries.length - 1; i >= 0; i--) {
          const e = get().entries[i]
          if (e.kind === 'user') {
            bashTurn = (e as { isShell?: boolean }).isShell === true
            break
          }
          if (
            e.kind === 'assistant' ||
            e.kind === 'thought' ||
            e.kind === 'tool'
          ) {
            hasOutput = true
            break
          }
        }
        const marker =
          turnIsLive(get()) && !failedTurn && !bashTurn && hasOutput
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
          // Turn end: the host resolved every outstanding permission request
          // (approval timeout / completion), so a non-empty pending queue
          // here is stale — drop it (TUI drain_permission_queue).
          pending: [],
          entries: [
            ...settleTurnEntries(s.entries),
            ...(marker ? [marker] : []),
          ],
        }))
        break
      }
      case 'turn_completed': {
        // Live events carry the owning sessionId. A completion from a
        // DIFFERENT session (that session's turn finished while the user
        // is here) → completion notice + sidebar ✓ only — never touch
        // this session's turn (seal / awaitingNext belong to the active
        // conversation). Replayed history events have no sessionId and
        // fall through to the seal path below.
        //
        // stop_reason: hosts relay it nested in the x.ai `update`; replay
        // normalizes it flat (turnCompletedEvent).
        const upd = ev.update
        const stopReason =
          ev.stopReason ??
          (typeof upd?.stop_reason === 'string' ? upd.stop_reason : undefined)
        const agentResult =
          ev.agentResult ??
          (typeof upd?.agent_result === 'string' ? upd.agent_result : undefined)
        if (ev.sessionId) {
          if (ev.sessionId !== get().sessionId) {
            get().noteSessionCompleted(ev.sessionId)
            break
          }
          // A LIVE turn_completed is the host's relay of the x.ai durable
          // terminal. The stream's `done` event owns the finalize and the
          // "Worked for X" marker (TUI parity: PromptResponse /
          // prompt_complete is the marker source; the notification rail
          // only fills in when the driver RPC never arrives). Pushing
          // the plain "Turn completed." form here would stack with
          // `done`'s marker when the rail beats the stream terminal:
          // this arm leaves the turn live (turnStartedAt / conn are
          // untouched), so `done` still sees turnIsLive and appends
          // "Worked for X".
          //
          // EXCEPTION: failed turns. `done` deliberately skips its marker
          // for error / rate_limit — the TurnFailed line is this rail's
          // job (TUI prompt_origin.rs stop_reason mapping). Render it
          // with the anchored elapsed, deduped via tailAlreadyTurnEnded.
          // Sealed first so the marker never short-circuits the settle.
          const sealed = sealThought(get())
          const settled = settleTurnEntries(sealed.entries)
          if (!tailAlreadyTurnEnded(settled)) {
            set({
              ...sealed,
              openAssistantId: undefined,
              openThoughtId: undefined,
              entries: settled,
            })
          }
          if (stopReason === 'error' || stopReason === 'rate_limit') {
            if (!tailAlreadyTurnEnded(get().entries)) {
              const ts = get().turnStartedAt
              const { text, warning } = turnEndMarkerText(
                stopReason,
                agentResult,
                ts != null ? Date.now() - ts : undefined,
              )
              appendEntry(set, {
                kind: 'session_event',
                text,
                ...(warning ? { warning } : {}),
              })
            }
          }
          break
        }
        // Replayed history: seal the finished turn's streaming blocks
        // (live turns finalize via `done`). Idempotent — no-op when the
        // turn was already settled (stored history may carry both
        // response_completed and turn_completed for one turn; the
        // tailAlreadyTurnEnded guard skips the duplicate).
        //
        // One marker per closed turn, typed by the stored stop_reason:
        // failed → "Turn failed …", cancelled → "Turn cancelled …",
        // success → "Worked for X" when the envelope meta carries the
        // turn's real start (replayUpdates injects it), plain
        // "Turn completed." otherwise — replay must not fabricate live
        // timing. The idle watcher cue ("N commands still running") is
        // NOT a scrollback line — it lives in the composer turn-status
        // line (TUI turn_status.rs idle arm), gated on awaitingNext.
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
        const elapsedMs =
          ev.turnStartedAt != null &&
          ev.endMs != null &&
          ev.endMs >= ev.turnStartedAt
            ? ev.endMs - ev.turnStartedAt
            : undefined
        const { text, warning } = turnEndMarkerText(
          stopReason,
          agentResult,
          elapsedMs,
        )
        set({
          ...sealed,
          openAssistantId: undefined,
          openThoughtId: undefined,
          // Idle until the next user message — lets the turn-status line
          // show the still-running cue after a replayed history load.
          awaitingNext: true,
          entries: [
            ...settled,
            {
              id: nid(),
              kind: 'session_event',
              text,
              ...(warning ? { warning } : {}),
            },
          ],
        })
        break
      }
      case 'cancelled': {
        // 多会话广播（host withSid 约定）：非当前会话的 cancelled 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
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
          pending: [], // …and every pending permission request (turn cancelled)
          entries: [
            ...s.entries.map((e) => {
              if (e.kind === 'thought' && e.streaming) {
                return {
                  ...e,
                  streaming: false,
                  finishedAt: Date.now(),
                  displayMode: 'collapsed' as const,
                }
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
        // 多会话广播（host withSid 约定）：非当前会话的 error 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
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
        // 多会话广播（host withSid 约定）：非当前会话的 status 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
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
          const SUPPORTED = new Set([
            'x.ai/ask_user_question',
            'x.ai/exit_plan_mode',
            'x.ai/diff_review',
          ])
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
          // Permission/plan mode arrives via the standalone yolo_mode_changed
          // SSE event OR the session_notification tag (the x.ai carrier
          // replay routes every kind here) — identical flags either way.
          // current_mode_update (session-mode id, e.g. 'plan') restores the
          // plan/perm flags from the replayed timeline.
          case 'yolo_mode_changed':
            applyModeFlags(set, fields)
            break
          case 'current_mode_update': {
            const flags = extractModeFlags(fields)
            if (flags) set(flags)
            break
          }
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
            // First token hasn't arrived yet: wait window (TUI
            // Waiting(Model) until stream_start).
            const sealed = sealThought(get())
            set({ ...sealed, statusText: 'Waiting for response…' })
            break
          }
          case 'reasoning_completed':
            set({ statusText: 'Waiting for response…' })
            break
          case 'auto_compact_started': {
            const pct = fields.percentage as number | undefined
            // TUI turn_status.rs: AutoCompacting → "Compacting…".
            set({ statusText: 'Compacting…' })
            appendEntry(set, {
              kind: 'session_event',
              text: `自动压缩上下文… (${pct ?? '?'}%)`,
              streaming: false,
            })
            break
          }
          case 'auto_compact_completed': {
            // TUI CompactionCompleted: tokens_before/tokens_after/
            // elapsed_ms are optional on the wire — keep the plain line
            // when the data is absent.
            const before = fields.tokens_before ?? fields.tokensBefore
            const after = fields.tokens_after ?? fields.tokensAfter
            const elapsedMs = fields.elapsed_ms ?? fields.elapsedMs
            let text = '自动压缩完成'
            if (typeof after === 'number' && after > 0) {
              const beforePart =
                typeof before === 'number' && before > 0
                  ? `${fmtTokens(before)} → `
                  : ''
              text = `自动压缩完成: ${beforePart}${fmtTokens(after)} tokens`
              if (typeof elapsedMs === 'number' && elapsedMs >= 0) {
                text += ` (${(elapsedMs / 1000).toFixed(1)}s)`
              }
            }
            appendEntry(set, { kind: 'session_event', text })
            // Compact finished → back to the wait-for-token window (the
            // turn resumes streaming after compaction).
            set({ statusText: 'Waiting for response…' })
            break
          }
          case 'auto_compact_failed': {
            appendEntry(set, {
              kind: 'session_event',
              text: `自动压缩失败: ${String(fields.error ?? '未知错误')}`,
              warning: true,
            })
            set({ statusText: 'Waiting for response…' })
            break
          }
          case 'auto_compact_cancelled':
            appendEntry(set, { kind: 'session_event', text: '自动压缩已取消' })
            set({ statusText: 'Waiting for response…' })
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
            // Two-part recap block: bold "Recap" header + muted body
            // (TUI session_event Recap). The body IS the summary text;
            // the scrollback renders the header separately.
            appendEntry(set, {
              kind: 'session_event',
              text: summary,
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
            // Wire shape is TUI MemoryFileInfo {path, source, size_bytes,
            // modified_epoch_secs} — normalize to the modal's display
            // fields (name = path basename) and keep `source` so the
            // memory modal can group Global / Workspace / Sessions.
            const normalized = files
              .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
              .map((f) => {
                const path = typeof f.path === 'string' ? f.path : ''
                const name =
                  typeof f.name === 'string' && f.name
                    ? f.name
                    : path.split(/[\\/]/).filter(Boolean).pop() ?? path
                const size =
                  typeof f.size === 'number'
                    ? f.size
                    : typeof f.size_bytes === 'number'
                      ? f.size_bytes
                      : undefined
                return {
                  name,
                  ...(path ? { path } : {}),
                  ...(size !== undefined ? { size } : {}),
                  ...(f.updatedAt !== undefined
                    ? { updatedAt: f.updatedAt }
                    : f.modified_epoch_secs !== undefined
                      ? { updatedAt: f.modified_epoch_secs }
                      : {}),
                  ...(typeof f.source === 'string' && f.source ? { source: f.source } : {}),
                }
              })
              .filter((f) => f.name)
            set({ memoryFiles: normalized })
            const names = normalized.map((f) => f.name).join(', ')
            appendEntry(set, {
              kind: 'session_event',
              text: `记忆文件 ${normalized.length} 个${names ? `（${names.slice(0, 80)}）` : ''}`,
            })
            break
          }
          // ── retry / recovery ─────────────────────────────────────────
          case 'retry_state': {
            // Three wire variants (tagged by `type`): retrying has `attempt`,
            // exhausted has `attempts`/`reason`/`isRateLimited`, failed has
            // `errorType`/`message`. Rendering everything as "重试中…" hid
            // terminal failures entirely.
            const f = fields as Record<string, unknown>
            const kind = typeof f.type === 'string' ? f.type : undefined
            const attempt = f.attempt ?? f.attempts
            if (kind === 'failed') {
              const errType = typeof f.errorType === 'string' ? f.errorType : ''
              const msg = typeof f.message === 'string' ? f.message : ''
              appendEntry(set, {
                kind: 'session_event',
                text: `推理失败${errType ? `（${errType}）` : ''}${msg ? `: ${msg}` : ''}`,
                warning: true,
              })
            } else if (kind === 'exhausted') {
              const reason = typeof f.reason === 'string' ? f.reason : ''
              appendEntry(set, {
                kind: 'session_event',
                text: `重试已耗尽${attempt != null ? `（attempt ${String(attempt)}）` : ''}${reason ? `: ${reason}` : ''}${f.isRateLimited ? '（可能被限流）' : ''}`,
                warning: true,
              })
            } else {
              // TUI turn_status.rs: Retrying → "Retrying (attempt N)…"
              // (warning). The compressed turn resumes after compact —
              // back to the wait-for-token window.
              appendEntry(set, {
                kind: 'session_event',
                text: attempt != null ? `重试中… (attempt ${String(attempt)})` : '重试中…',
                warning: true,
              })
              set({
                statusText:
                  attempt != null
                    ? `Retrying (attempt ${String(attempt)})…`
                    : 'Retrying…',
              })
            }
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
            // Optional payload — parse defensively (the wire only
            // guarantees runId/name/status; the panel degrades when the
            // extras are absent): progress (0..1 or 0..100), script
            // (save-script source), agent roster, start time.
            const rawP = f.progress ?? f.progress_pct ?? f.progressPct
            const pNum = typeof rawP === 'number' ? rawP : Number(rawP)
            const progress =
              rawP != null && rawP !== '' && Number.isFinite(pNum)
                ? pNum > 1
                  ? pNum / 100
                  : pNum
                : undefined
            const rawAgents = Array.isArray(f.agents)
              ? f.agents
              : Array.isArray(f.agent_roster)
                ? f.agent_roster
                : undefined
            // Agents may be plain labels (older producers) or full
            // WorkflowAgentInfo objects {label, state, tokens_used, …}.
            // Both collapse into the same roster; the list-row labels come
            // from the same source (TUI shows them per row).
            const agentRoster = rawAgents
              ?.map((a) => {
                if (a && typeof a === 'object' && !Array.isArray(a)) {
                  const o = a as Record<string, unknown>
                  const name =
                    (typeof o.label === 'string' && o.label.trim()) ||
                    (typeof o.name === 'string' && o.name.trim()) ||
                    (typeof o.agent_id === 'string' ? o.agent_id : '')
                  if (!name) return null
                  const tokensRaw = o.tokens_used ?? o.tokensUsed ?? o.tokens
                  return {
                    name,
                    status: typeof o.state === 'string' ? o.state : undefined,
                    tokens:
                      tokensRaw != null &&
                      tokensRaw !== '' &&
                      Number.isFinite(Number(tokensRaw))
                        ? Number(tokensRaw)
                        : undefined,
                  }
                }
                const s = String(a).trim()
                return s ? { name: s } : null
              })
              .filter(
                (a): a is { name: string; status?: string; tokens?: number } =>
                  !!a,
              )
            const agents = agentRoster?.map((a) => a.name)
            const script = typeof f.script === 'string' ? f.script : undefined
            const objective =
              typeof f.objective === 'string' && f.objective.trim()
                ? f.objective
                : undefined
            const rawPhases = Array.isArray(f.phases) ? f.phases : undefined
            const phases = rawPhases
              ?.map((p) => {
                if (!p || typeof p !== 'object' || Array.isArray(p)) return null
                const o = p as Record<string, unknown>
                const title = typeof o.title === 'string' ? o.title.trim() : ''
                if (!title) return null
                return {
                  title,
                  state: typeof o.state === 'string' ? o.state : 'pending',
                }
              })
              .filter((p): p is { title: string; state: string } => !!p)
            const rawElapsed = f.elapsed_ms ?? f.elapsedMs
            const elapsedMs =
              rawElapsed != null &&
              rawElapsed !== '' &&
              Number.isFinite(Number(rawElapsed)) &&
              Number(rawElapsed) >= 0
                ? Number(rawElapsed)
                : undefined
            const rawStart = f.started_at ?? f.startedAt ?? f.start_time
            const sNum = typeof rawStart === 'number' ? rawStart : Number(rawStart)
            const startedAt =
              rawStart != null && rawStart !== '' && Number.isFinite(sNum) && sNum > 0
                ? sNum < 1e12
                  ? sNum * 1000
                  : sNum
                : undefined
            const prev = get().workflowRuns[runId]
            const prevStatus = prev?.status
            set({
              workflowRuns: {
                ...get().workflowRuns,
                [runId]: {
                  runId,
                  name,
                  status,
                  phase,
                  progress,
                  agents,
                  agentRoster,
                  phases,
                  objective,
                  script,
                  elapsedMs,
                  startedAt,
                  // Start-time fallback: first event that introduced the run.
                  firstSeenAt: prev?.firstSeenAt ?? Date.now(),
                  // The event is authoritative — clear any optimistic
                  // marker set by workflowControl before it arrived.
                  pendingControl: undefined,
                },
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
            // goalReceivedAt anchors the elapsed fallback chain (wire
            // elapsed_ms / started_at absent → receive time).
            set({ goalState: f, goalReceivedAt: Date.now() })
            // TUI turn_status.rs: goal completion verification window →
            // "Verifying…" (text_secondary); the status line returns to
            // the wait-for-token text once verification clears.
            const verifying = f.verifying_completion === true
            if (verifying) {
              set({ statusText: 'Verifying…' })
            } else if (get().statusText === 'Verifying…') {
              set({ statusText: 'Waiting for response…' })
            }
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
          // Wire fields mirror TUI SubagentProgress (xai-grok-shell
          // extensions/notification.rs): duration_ms / turn_count /
          // tool_call_count / tokens_used / context_window_tokens /
          // context_usage_pct / tools_used / error_count. Every tick
          // merges into the entry so the block viewer shows live
          // progress (TUI tasks-pane row + dashboard mini gauge); the
          // `detail` summary keeps the collapsed scrollback row glanceable.
          case 'subagent_progress': {
            const f = fields as Record<string, unknown>
            const id = String(f.subagent_id ?? '')
            const entryId = id ? get().subagentIndex[id] : undefined
            if (!entryId) break
            const num = (v: unknown): number | undefined =>
              typeof v === 'number' && Number.isFinite(v) ? v : undefined
            const str = (v: unknown): string | undefined =>
              typeof v === 'string' && v.trim() ? v : undefined
            const tools = Array.isArray(f.tools_used)
              ? (f.tools_used as unknown[])
                  .map((t) => (typeof t === 'string' ? t : ''))
                  .filter(Boolean)
              : undefined
            const turnCount = num(f.turn_count)
            const toolCount = num(f.tool_call_count)
            const pct = num(f.context_usage_pct)
            const tokens = num(f.tokens_used)
            const windowTokens = num(f.context_window_tokens)
            const errors = num(f.error_count)
            const durMs = num(f.duration_ms)
            const desc = str(f.description)
            set({
              entries: get().entries.map((e) =>
                e.id === entryId && e.kind === 'subagent'
                  ? {
                      ...e,
                      ...(durMs != null ? { durationMs: durMs } : {}),
                      ...(turnCount != null ? { turns: turnCount } : {}),
                      ...(toolCount != null ? { toolCalls: toolCount } : {}),
                      ...(tokens != null ? { tokensUsed: tokens } : {}),
                      ...(windowTokens != null ? { contextWindowTokens: windowTokens } : {}),
                      ...(pct != null ? { contextUsagePct: pct } : {}),
                      ...(errors != null ? { errorCount: errors } : {}),
                      ...(tools != null ? { toolsUsed: tools } : {}),
                      // TUI SubagentBlock activity suffix: the wire has
                      // no activity label, so keep a compact numeric
                      // summary ("turns=3 tools=7 42%") as the row detail.
                      // Running only — a late tick must not clobber the
                      // finish detail ("42s") once the subagent is done.
                      ...(e.running
                        ? {
                            detail:
                              desc ||
                              `turns=${String(turnCount ?? '?')} tools=${String(toolCount ?? '?')}${
                                pct != null ? ` ${String(pct)}%` : ''
                              }${durMs != null ? ` · ${(durMs / 1000).toFixed(0)}s` : ''}`,
                          }
                        : {}),
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
          // The same updates can ALSO arrive as standalone SSE events
          // (scheduled_task_created/deleted/fired) — both paths land in
          // the shared upsert/remove helpers keyed by taskId, so a task
          // delivered twice is never duplicated.
          case 'scheduled_task_created':
            upsertScheduledTask(set, parseScheduledTask(fields))
            break
          case 'scheduled_task_deleted': {
            const inner = fields.task as Record<string, unknown> | undefined
            const id = wireTaskId(fields.task_id, fields.taskId, inner?.taskId)
            if (id) removeScheduledTask(set, id)
            break
          }
          case 'scheduled_task_fired': {
            const id = wireTaskId(fields.task_id, fields.taskId)
            if (id) updateScheduledTaskFire(set, id, fields.next_fire_at ?? fields.nextFireAt)
            break
          }
          // ── misc ─────────────────────────────────────────────────────
          case 'diff_review': {
            const content = Array.isArray(fields.content) ? fields.content : []
            // Notification path (no requestId → no receipt): cache the
            // payload and open the modal read-only.
            set({ diffReview: content, diffReviewOpen: content.length > 0 })
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
            // TUI prompt_origin.rs stop_reason mapping → TurnFailed
            // marker: "Turn failed in 4.4s: <error>" (warning color).
            // The shell formats the request failure; here the
            // agent_result is the best error text and "rate limited"
            // stands in for a rate_limit without a payload. The `done`
            // event skips its "Worked for" marker for these reasons.
            // Fallback rail: typed turn_completed events (acp-host)
            // already render the failed marker — dedupe via the tail.
            if (reason === 'error' || reason === 'rate_limit') {
              if (tailAlreadyTurnEnded(get().entries)) break
              const err =
                reason === 'error'
                  ? String(f.agent_result ?? 'unknown error')
                  : 'rate limited'
              const ts = get().turnStartedAt
              const dur =
                ts != null ? formatTurnDuration(Date.now() - ts) : null
              appendEntry(set, {
                kind: 'session_event',
                text:
                  dur != null
                    ? `Turn failed in ${dur}: ${err}`
                    : `Turn failed: ${err}`,
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
      case 'yolo_mode_changed':
        // The agent sends snake_case ({yolo_mode, auto_mode, permission_mode});
        // accept both spellings (camelCase first for host-normalized paths).
        const p = (ev.params ?? {}) as Record<string, unknown>
        const yolo =
          typeof p.yoloMode === 'boolean'
            ? p.yoloMode
            : typeof p.yolo_mode === 'boolean'
              ? p.yolo_mode
              : undefined
        const auto =
          typeof p.autoMode === 'boolean'
            ? p.autoMode
            : typeof p.auto_mode === 'boolean'
              ? p.auto_mode
              : undefined
        const perm =
          typeof p.permissionMode === 'string' && p.permissionMode
            ? p.permissionMode
            : typeof p.permission_mode === 'string' && p.permission_mode
              ? p.permission_mode
              : undefined
        // Plan mode rides on the same wire: permissionMode 'plan' means the
        // agent is in plan mode (Shift+Tab cycle gear + prompt flag).
        const planMode =
          perm === 'plan' ? true : perm != null && perm !== '' ? false : undefined
        set({
          yoloMode: yolo,
          autoMode: auto,
          permissionMode: perm,
          ...(planMode !== undefined ? { planMode } : {}),
        })
        break
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
      case 'mcp_init_progress': {
        // x.ai/mcp/init_progress → mcp_init_progress (host bridge.go
        // forwards params verbatim; shell emits camelCase {total,
        // connected, sessionId} — acp_session_impl/mcp.rs). The TUI
        // status-bar chip is `MCP (connected/total)`; the startup seed
        // total==0 renders "Starting session…". No scrollback row.
        applyMcpInitProgress(set, ev.params)
        break
      }
      case 'mcp_tools_changed':
      case 'mcp_servers_updated':
        set({ mcpVersion: get().mcpVersion + 1 })
        break
      case 'sessions_changed':
        void get().refreshSessions()
        void get().refreshWorkspaces()
        break
      case 'hosts_changed':
        // Hub-level: a host paired / came online / dropped off.
        void get().refreshHosts()
        break
      case 'models_update': {
        // 多会话广播（host withSid 约定）：非当前会话的 models_update 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
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
      case 'scheduled_task_created':
        // Standalone SSE carrier (host may ALSO wrap the same update in a
        // session_notification tag — both paths upsert by taskId).
        upsertScheduledTask(set, parseScheduledTask(ev))
        break
      case 'scheduled_task_deleted': {
        const p = (ev.params ?? {}) as Record<string, unknown>
        const id = wireTaskId(ev.taskId, p.taskId, p.task_id)
        if (id) removeScheduledTask(set, id)
        break
      }
      case 'scheduled_task_fired': {
        const p = (ev.params ?? {}) as Record<string, unknown>
        const id = wireTaskId(ev.taskId, p.taskId, p.task_id)
        // TUI only updates the tasks pane (next_fire_at) — no scrollback
        // row. The turn itself surfaces as a cron UserPromptBlock via
        // user_chunk.
        if (id) updateScheduledTaskFire(set, id, ev.nextFireAt ?? p.nextFireAt ?? p.next_fire_at)
        break
      }
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
          // Turn end (scheduled-injection path): outstanding permission
          // requests were resolved host-side — drop any stale queue entry.
          pending: [],
          entries: [...settleTurnEntries(sealed.entries), marker],
        })
        break
      }
      case 'follow_ups': {
        // Typed carrier for x.ai/follow_ups (host bridge.go broadcasts it
        // as {type:'follow_ups', params}) — turn-end suggestion chips (TUI
        // follow_ups.rs): parsed into store state for the Composer's chip
        // row; NO scrollback line (the TUI renders them as a transient row
        // above the prompt). Newest-wins by response_id. Older hosts fall
        // back to the ext_notification arm below (same consumer).
        applyFollowUps(get, set, ev.params)
        break
      }
      case 'ext_notification': {
        // Status-type notifications with no scrollback UI value — drop
        // silently. Aligned with the TUI: these are panel-local status
        // feeds the TUI shows ONLY inside their dedicated surfaces
        // (file-watch panel, /search panel, terminal pane, settings
        // modal, MCP panel), never as scrollback rows — so a generic dim
        // status line here would be pure noise:
        // - x.ai/fs_notify / fs/index / fs/index/delta — file-watcher
        //   state (TUI file-watch panel); fires on every file change.
        // - x.ai/search/fuzzy/status / search/content/status — search
        //   engine status (TUI /search panel).
        // - x.ai/terminal/pty/notification — pty lifecycle (TUI
        //   terminal pane).
        // - x.ai/config_changed — config reload notice (TUI settings
        //   modal; FE has no config editor).
        // - x.ai/settings/update — pre-existing silence, same rationale.
        // x.ai/mcp/init_progress is NOT silent: the current host forwards
        // it as the typed `mcp_init_progress` event (consumed above); an
        // older host that falls back to ext_notification is consumed here
        // the same way — never rendered as a status line.
        if (ev.method === 'x.ai/mcp/init_progress') {
          applyMcpInitProgress(set, ev.params)
          break
        }
        // x.ai/queue/changed — agent's authoritative queue snapshot.
        // Older hosts forward it as ext_notification instead of the
        // typed `queue_changed` event; both rails feed the promptQueue
        // sync layer (guard on session id like the typed carrier — the
        // ext_notification AcpEvent type omits sessionId, but the host
        // attaches it via withSid).
        if (ev.method === 'x.ai/queue/changed') {
          const sid = (ev as { sessionId?: string }).sessionId
          if (!sid || sid === get().sessionId) {
            applyQueueChanged(ev.params)
          }
          break
        }
        if (SILENT_EXT_NOTIFICATIONS.has(ev.method ?? '')) break
        // x.ai/follow_ups — turn-end suggestion chips (TUI follow_ups.rs):
        // parsed into store state for the Composer's chip row; NO
        // scrollback line (the TUI renders them as a transient row above
        // the prompt). Newest-wins by response_id.
        if (ev.method === 'x.ai/follow_ups') {
          applyFollowUps(get, set, ev.params)
          break
        }
        // Unknown x.ai/* notification — render a dim status line so nothing
        // is silently dropped (matches the host's generic forwarding).
        appendEntry(set, {
          kind: 'status',
          text: `扩展通知: ${ev.method ?? 'x.ai/*'}`,
        })
        break
      }
      case 'modes_update':
        set({ modes: ev.modes, ...extractModeFlags(ev.modes) })
        break
      case 'session_info':
        if (ev.title != null && String(ev.title).trim()) {
          set({ sessionTitle: String(ev.title).trim() })
        }
        break
      case 'model': {
        // 多会话广播（host withSid 约定）：非当前会话的 model 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
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
      case 'commands_update': {
        // ACP `available_commands_update` (host-forwarded as
        // `{type:'commands_update', commands, sessionId}` — `commands`
        // is the agent's `AvailableCommand[]` passed through untouched).
        // Defensive extraction: the array may be absent/malformed; only
        // well-formed entries are kept (name required, rest best-effort).
        const raw = ev.commands
        const list = Array.isArray(raw) ? raw : []
        const agentCommands: AgentCommand[] = []
        for (const item of list) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue
          const o = item as Record<string, unknown>
          const name = typeof o.name === 'string' ? o.name.trim() : ''
          if (!name) continue
          let argHint: string | undefined
          const input = o.input
          if (typeof input === 'string' && input.trim()) {
            argHint = input.trim()
          } else if (input && typeof input === 'object' && !Array.isArray(input)) {
            const h = (input as Record<string, unknown>).hint
            if (typeof h === 'string' && h.trim()) argHint = h.trim()
          }
          const meta =
            o._meta && typeof o._meta === 'object' && !Array.isArray(o._meta)
              ? (o._meta as Record<string, unknown>)
              : undefined
          agentCommands.push({
            name,
            description: typeof o.description === 'string' ? o.description : undefined,
            argHint,
            ...(meta ? { meta } : {}),
          })
        }
        set({ agentCommands })
        break
      }
      case 'announcements_update': {
        // x.ai/announcements/update: { gen, announcements: [{id?, title?,
        // message?, severity?, cta?, …}] } — surface each as a status line so
        // the event is consumed instead of silently dropped.
        const p = (ev.params ?? {}) as Record<string, unknown>
        const items = Array.isArray(p.announcements) ? p.announcements : []
        for (const a of items) {
          if (!a || typeof a !== 'object') continue
          const o = a as Record<string, unknown>
          const title = typeof o.title === 'string' && o.title ? o.title : ''
          const message = typeof o.message === 'string' && o.message ? o.message : ''
          const sev = typeof o.severity === 'string' && o.severity ? o.severity : ''
          const text = [title, message].filter(Boolean).join(' — ')
          if (!text) continue
          appendEntry(set, {
            kind: 'session_event',
            text,
            warning: sev === 'error' || sev === 'critical',
          })
        }
        break
      }
      case 'queue_changed': {
        // x.ai/queue/changed (host bridge.go broadcasts the TYPED carrier)
        // — the agent's authoritative prompt-queue snapshot. The FE's
        // local queue mirrors the host (see store/promptQueue.ts sync
        // layer: mutations are mirrored fire-and-forget, the snapshot is
        // applied here). Guard on session id: withSid attaches the
        // emitting session — a stale broadcast from another session must
        // not clobber our queue.
        if (!ev.sessionId || ev.sessionId === get().sessionId) {
          applyQueueChanged(ev.params)
        }
        break
      }
      default:
        break
    }
  },

  send: async (text: string, blocks?: ContentBlock[], opts?: { fromShell?: boolean }) => {
    const t = text.trim()
    if (!t) return
    // Seal any leftover thought from prior turn, then append the user row.
    // Tag the user row so the live user_chunk echo merges into it (not a
    // 2nd row). NO pre-created Thinking… shell: TUI pre-creates the
    // thinking block at stream_start (first chunk), so between send and
    // the first token the status line reads "Waiting for response…".
    const sealed = sealThought(get())
    const userId = nid()
    // Shell-mode submissions (Composer `!` mode → prompt path) mark the
    // user row so the scrollback renders it with the TUI `$ ` prefix.
    const userEntry = {
      id: userId,
      kind: 'user' as const,
      text: t,
      ts: Date.now(),
      ...(opts?.fromShell ? { isShell: true } : {}),
    }
    set({
      ...sealed,
      entries: [...sealed.entries, userEntry],
      openAssistantId: undefined,
      openThoughtId: undefined,
      pendingOptimisticUserId: userId,
      conn: 'busy',
      statusText: 'Waiting for response…',
      awaitingNext: false,
      turnStartedAt: Date.now(),
      // A manual send starts a new turn: the previous turn's suggestion
      // chips are retired (TUI clears follow_ups at turn start).
      followUps: undefined,
      followUpsResponseId: undefined,
    })
    try {
      // Optional image blocks (Composer image chips): the caller passes
      // the full block list; default is the plain text prompt.
      await transport.prompt(
        blocks && blocks.length > 0 ? blocks : [{ type: 'text', text: t }],
      )
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

  /**
   * Append a LOCAL-ONLY scrollback entry (shell mode output, etc.) —
   * rendered like a normal row but never sent to the agent. Kind is
   * limited to the entry kinds the scrollback renders as plain text.
   */
  appendLocalEntry: (entry) => {
    appendEntry(set, entry as EntryWithoutId)
  },

  cancel: async () => {
    await transport.cancel()
  },

  /**
   * Cancel the running turn (panel options 1 / 3 / 4, Ctrl+C, and the
   * saved-preference fast path). Always cancels the turn; `cancelSubagents`
   * additionally cancels every running subagent ("Stop running" / "Always
   * stop"); `stopTasks` (legacy) kills running bg_tasks too; `clearQueue`
   * empties the composer's send queue. The panel closes either way.
   */
  cancelTurn: async (opts) => {
    set({ cancelPanelOpen: false })
    // TUI turn_status.rs: (TurnCancelling | CommandCancelling, _) →
    // "Cancelling…" in accent_error — shown until the host's `done`
    // / `cancelled` event seals the turn.
    set({ statusText: 'Cancelling…' })
    try {
      await transport.cancel()
    } catch (e) {
      appendEntry(set, {
        kind: 'error',
        text: `取消失败: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
    if (opts?.stopTasks) {
      const s = get()
      for (const e of s.entries) {
        if (e.kind === 'bg_task' && e.running && e.taskId) {
          void get().killTask(e.taskId)
        } else if (e.kind === 'subagent' && e.running && e.subagentId) {
          void get().cancelSubagent(e.subagentId)
        }
      }
      // Restored top-strip tasks are running by definition (host probe).
      for (const t of s.topTasks) {
        if (t.taskId) void get().killTask(t.taskId)
      }
    } else if (opts?.cancelSubagents) {
      const s = get()
      for (const e of s.entries) {
        if (e.kind === 'subagent' && e.running && e.subagentId) {
          void get().cancelSubagent(e.subagentId)
        }
      }
    }
    if (opts?.clearQueue) usePromptQueue.getState().clear()
  },

  /**
   * Shift+Tab mode cycle (TUI modes.rs): Normal → Plan → Auto →
   * Always-approve → Normal. Two dimensions — plan ∈ {off,on} × perm ∈
   * {ask,auto,always}: plan lives ONLY in the second slot; the plan·auto /
   * plan·always overlays exist only via /auto & /always while in plan mode
   * (Shift+Tab from an overlay leaves plan and advances the permission).
   * Each arm shows the "Switched to mode: X" banner (TUI notices.rs)
   * optimistically, like the TUI's show_mode_switch_banner.
   */
  cycleMode: async () => {
    const s = get()
    const inPlan = s.planMode === true || s.permissionMode === 'plan'
    const perm = (s.permissionMode || '').toLowerCase()
    const inAlways =
      s.yoloMode === true ||
      perm === 'always-approve' ||
      perm === 'always_approve' ||
      perm === 'yolo'
    const inAuto = s.autoMode === true || perm === 'auto'
    try {
      if (!inPlan && !inAuto && !inAlways) {
        // normal → plan
        get().showModeBanner('Switched to mode: Plan')
        await transport.setMode('plan')
        set({ planMode: true, permissionMode: undefined, statusText: '已切换到 plan 模式' })
      } else if (inPlan && !inAuto && !inAlways) {
        // plan → auto (leave plan)
        get().showModeBanner('Switched to mode: Auto')
        await transport.setMode('default')
        await transport.setMode('auto')
        set({
          planMode: false,
          autoMode: true,
          yoloMode: false,
          permissionMode: undefined,
          statusText: '已切换到 auto 模式',
        })
      } else if (inPlan && inAuto) {
        // plan·auto → always (leave plan)
        get().showModeBanner('Switched to mode: Always-Approve')
        await transport.setMode('default')
        await transport.setMode('always-approve')
        set({
          planMode: false,
          yoloMode: true,
          autoMode: false,
          permissionMode: undefined,
          statusText: '已切换到 always-approve 模式',
        })
      } else if (inPlan) {
        // plan·always → normal (leave plan)
        get().showModeBanner('Switched to mode: Normal')
        await transport.setMode('default')
        await transport.setMode('normal')
        set({
          planMode: false,
          autoMode: false,
          yoloMode: false,
          permissionMode: undefined,
          statusText: '已切换到 normal 模式',
        })
      } else if (inAuto) {
        // auto → always
        get().showModeBanner('Switched to mode: Always-Approve')
        await transport.setMode('always-approve')
        set({
          yoloMode: true,
          autoMode: false,
          permissionMode: undefined,
          statusText: '已切换到 always-approve 模式',
        })
      } else {
        // always → normal
        get().showModeBanner('Switched to mode: Normal')
        await transport.setMode('normal')
        set({
          autoMode: false,
          yoloMode: false,
          permissionMode: undefined,
          statusText: '已切换到 normal 模式',
        })
      }
    } catch (e) {
      appendEntry(set, {
        kind: 'error',
        text: `切换模式失败: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  },

  /**
   * /plan — enter plan mode only. Running /plan again while already in
   * plan (including the plan·auto / plan·always overlays) is a no-op: plan
   * can only be left via the Shift+Tab cycle back to Normal.
   */
  togglePlanMode: async () => {
    const s = get()
    if (s.planMode === true || s.permissionMode === 'plan') {
      set({ statusText: '已在 plan 模式（Shift+Tab 退出）' })
      return
    }
    try {
      await transport.setMode('plan')
      set({ planMode: true, permissionMode: undefined, statusText: '已切换到 plan 模式' })
    } catch (e) {
      appendEntry(set, {
        kind: 'error',
        text: `切换 plan 模式失败: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  },

  /**
   * /auto — toggle auto permission mode. Off plan: normal ↔ auto; in plan:
   * plan ↔ plan·auto (plan mode is preserved — the permission notification
   * does not touch it, and planMode is kept so the composer shows plan·auto).
   */
  setAutoMode: async () => {
    const s = get()
    const inPlan = s.planMode === true || s.permissionMode === 'plan'
    const perm = (s.permissionMode || '').toLowerCase()
    const inAuto = s.autoMode === true || perm === 'auto'
    try {
      if (inAuto) {
        await transport.setMode('normal')
        set({
          autoMode: false,
          yoloMode: false,
          permissionMode: undefined,
          statusText: inPlan ? '已退出 auto（plan 保持）' : '已切换到 normal 模式',
        })
      } else {
        await transport.setMode('auto')
        set({
          autoMode: true,
          yoloMode: false,
          permissionMode: undefined,
          statusText: inPlan ? '已切换到 plan·auto 模式' : '已切换到 auto 模式',
        })
      }
    } catch (e) {
      appendEntry(set, {
        kind: 'error',
        text: `切换 auto 模式失败: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  },

  /**
   * /always — toggle always-approve. Same shape as /auto: normal ↔
   * always-approve off plan, plan ↔ plan·always in plan. Mode ids tried in
   * order across host builds: always_approve → yolo → always-approve.
   */
  setAlwaysApproveMode: async () => {
    const s = get()
    const inPlan = s.planMode === true || s.permissionMode === 'plan'
    const perm = (s.permissionMode || '').toLowerCase()
    const inAlways =
      s.yoloMode === true ||
      perm === 'always-approve' ||
      perm === 'always_approve' ||
      perm === 'yolo'
    try {
      if (inAlways) {
        await transport.setMode('normal')
        set({
          yoloMode: false,
          autoMode: false,
          permissionMode: undefined,
          statusText: inPlan ? '已退出 always-approve（plan 保持）' : '已切换到 normal 模式',
        })
        return
      }
      for (const modeId of ['always_approve', 'yolo', 'always-approve']) {
        try {
          await transport.setMode(modeId)
          set({
            yoloMode: true,
            autoMode: false,
            permissionMode: undefined,
            statusText: inPlan ? '已切换到 plan·always-approve 模式' : '已切换到 always-approve 模式',
          })
          return
        } catch {
          // try the next candidate id
        }
      }
      appendEntry(set, {
        kind: 'error',
        text: 'host 暂不支持运行时切换 always-approve',
      })
    } catch (e) {
      appendEntry(set, {
        kind: 'error',
        text: `切换 always-approve 模式失败: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  },

  /** Forget every remembered permission rule (always-allow patterns…). */
  resetPermissions: async () => {
    try {
      await transport.permissionsReset(get().sessionId)
      set({ statusText: '已重置已记忆的权限规则' })
    } catch (e) {
      appendEntry(set, {
        kind: 'error',
        text: `重置权限规则失败: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  },

  respondPermission: async (requestId, optionId, cancelled, scope, followupMessage) => {
    await transport.respondPermission(requestId, optionId, cancelled, scope, followupMessage)
    set({ pending: get().pending.filter((p) => p.requestId !== requestId) })
  },

  respondXai: async (requestId, result, error) => {
    const req = get().xaiRequests.find((r) => r.requestId === requestId)
    try {
      await transport.respondClientRequest(requestId, result, error)
    } finally {
      set({ xaiRequests: get().xaiRequests.filter((r) => r.requestId !== requestId) })
      // x.ai/exit_plan_mode with an approving/abandoning outcome leaves
      // plan mode. Clear the local plan flag immediately — the agent does
      // not reliably broadcast yolo_mode_changed afterwards, so the
      // composer's `plan` flag (planMode || permissionMode==='plan') would
      // otherwise stay stuck. outcome 'cancelled' (request changes / 稍后
      // 再说) keeps plan mode.
      if (
        !error &&
        req?.method === 'x.ai/exit_plan_mode' &&
        (result as { outcome?: string } | undefined)?.outcome !== 'cancelled'
      ) {
        const s = get()
        set({
          planMode: false,
          ...(s.permissionMode === 'plan' ? { permissionMode: undefined } : {}),
        })
      }
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

  /**
   * Memory system — /flush (TUI /flush): persist the session's knowledge
   * to memory right now. The host contract is POST /api/memory-flush
   * `{ sessionId }` → `{ ok: true }` (parallel host work — a 404 here is
   * surfaced as an error row, not a hang). Progress events
   * (memory_flush_started / memory_flush_completed) arrive as
   * session_notification tags and render their own scrollback lines.
   */
  memoryFlush: async () => {
    const st = get()
    if (!st.sessionId) {
      appendEntry(set, { kind: 'error', text: '记忆刷新失败: 无活动会话' })
      return
    }
    try {
      await transport.memoryFlush(st.sessionId)
      set({ statusText: '正在刷新记忆…' })
      appendEntry(set, { kind: 'session_event', text: '等待记忆刷新完成…' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      appendEntry(set, { kind: 'error', text: `记忆刷新失败: ${msg}` })
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

  deleteSession: async (sessionId, cwd) => {
    try {
      await transport.sessionDelete(sessionId, cwd)
      const isCurrent = sessionId === get().sessionId
      set({ statusText: `已删除会话 ${sessionId.slice(0, 8)}` })
      void get().refreshSessions()
      void get().refreshWorkspaces()
      // Deleting the ACTIVE session ends it — fall back to a fresh
      // session (TUI /delete behavior). Historical deletes just refresh
      // the list.
      if (isCurrent) await get().newSession()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `删除会话失败: ${msg}` }],
      })
    }
  },

  compactSession: async (note) => {
    const s = get()
    if (!s.sessionId || !s.cwd) {
      set({ statusText: '压缩失败: 无活动会话' })
      return
    }
    try {
      await transport.compact(s.sessionId, note)
      set({ statusText: note ? `已提交压缩「${note}」` : '已提交压缩' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `压缩失败: ${msg}` }],
      })
    }
  },

  rewindPoints: async () => {
    const s = get()
    if (!s.sessionId || !s.cwd) throw new Error('无活动会话')
    try {
      const r = await transport.rewindPoints(s.sessionId, s.cwd)
      return r.points
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Audit row (same style as fork 失败); the picker rethrows so it
      // can render the inline error too.
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `获取回退点失败: ${msg}` }],
      })
      throw e
    }
  },

  rewindExecute: async (targetIndex, mode) => {
    const s = get()
    if (!s.sessionId || !s.cwd) {
      set({ statusText: '回退失败: 无活动会话' })
      return undefined
    }
    try {
      const r = await transport.rewindExecute(s.sessionId, targetIndex, mode)
      set({
        statusText: `已回退到索引 ${targetIndex}${
          mode === 'all' ? '（含文件）' : ''
        }，重新加载历史…`,
      })
      // The rewind landed on a point whose prompt the agent echoes back
      // (RewindResponse.prompt_text). Park it in stashedDraft so the
      // composer restores it on picker close — replacing the pre-picker
      // draft with the rewound prompt, ready to edit / resend. No
      // promptText → the user's original draft comes back untouched.
      if (r.promptText) set({ stashedDraft: r.promptText })
      // The rewind truncates the conversation tail — reload the current
      // session's history so the scrollback reflects the rewound state.
      // Scheduled tasks belong to the same session, so stash them across
      // the loadHistory reset (which clears per-session state).
      const keep = get().scheduledTasks
      await get().loadHistory(s.sessionId, s.cwd)
      if (keep.length > 0) set({ scheduledTasks: keep })
      // Outcome details (reverted files / conflicts) ride back to the
      // picker so it can surface file-revert feedback (toast / warning).
      return r
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `回退失败: ${msg}` }],
      })
      throw e
    }
  },

  deleteScheduledTask: async (taskId) => {
    const s = get()
    if (!s.sessionId) {
      set({ statusText: '删除调度任务失败: 无活动会话' })
      return
    }
    try {
      await transport.schedulerDelete(s.sessionId, taskId)
      // Optimistic local removal — the host's scheduled_task_deleted SSE
      // (either carrier) arrives later and is idempotent on a missing id.
      set({
        statusText: '已删除调度任务',
        scheduledTasks: get().scheduledTasks.filter((t) => t.taskId !== taskId),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `删除调度任务失败: ${msg}` }],
      })
    }
  },

  // ── MCP management (TUI /mcps — host endpoints may be unsupported;
  //    every method rethrows so the McpPanel renders the failure inline) ──
  mcpList: async () => {
    const r = await transport.mcpList()
    return r.servers
  },

  mcpToggle: async (name, enabled) => {
    await transport.mcpToggle(name, enabled)
  },

  mcpToggleTool: async (serverName, toolName, enabled) => {
    await transport.mcpToggleTool(serverName, toolName, enabled)
  },

  mcpAdd: async (server) => {
    await transport.mcpAdd(server)
  },

  mcpRemove: async (name) => {
    await transport.mcpRemove(name)
  },

  mcpAuthTrigger: async (name) => {
    const r = await transport.mcpAuthTrigger(name)
    // Agent contract: { status, setup?, error? } — surface a readable
    // message; keep url/code passthrough for hosts that offer an OAuth
    // link directly.
    const status = typeof r.status === 'string' ? r.status : undefined
    const error = typeof r.error === 'string' && r.error ? r.error : undefined
    const message =
      status === 'failed'
        ? `认证失败${error ? `: ${error}` : ''}`
        : status === 'setup_required'
          ? '该服务器需要先完成配置（setup）'
          : status === 'authenticated'
            ? '认证成功'
            : error
              ? `认证异常: ${error}`
              : undefined
    return {
      ...(typeof r.url === 'string' && r.url ? { url: r.url } : {}),
      ...(typeof r.code === 'string' && r.code ? { code: r.code } : {}),
      ...(message ? { message } : {}),
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
      const { sessions } = await transport.listSessions()
      set({ sessions })
      // Busy 转变检测（完成提醒兜底）：某会话从 busy → idle 且不是
      // 当前会话 → 通知 + ✓。第一次拉取只建基线，不误报。
      const next: Record<string, boolean> = {}
      for (const s of sessions) next[s.sessionId] = s.status?.busy === true
      const cur = get()
      for (const [sid, wasBusy] of Object.entries(lastBusySnapshot)) {
        if (wasBusy && next[sid] === false && sid !== cur.sessionId) {
          cur.noteSessionCompleted(sid)
        }
      }
      lastBusySnapshot = next
    } catch {
      /* ignore */
    }
  },

  refreshWorkspaces: async () => {
    set({ workspaceLoading: true })
    try {
      const workspaces = await transport.workspaceList()
      set({ workspaces, workspaceLoading: false })
    } catch {
      // 降级：workspace-list 不可用时按现有 sessions 的 cwd 分组，
      // 保证侧边栏永不白屏。
      const byCwd = new Map<string, WorkspaceSummary[]>()
      for (const s of get().sessions) {
        if (!s.cwd) continue
        const list = byCwd.get(s.cwd) ?? []
        list.push({
          sessionId: s.sessionId,
          cwd: s.cwd,
          ...(s.title ? { title: s.title } : {}),
          ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
        })
        byCwd.set(s.cwd, list)
      }
      const workspaces: WorkspaceGroup[] = [...byCwd.entries()].map(
        ([cwd, sessions]) => ({
          cwd,
          label: repoNameFromCwd(cwd),
          sessions,
        }),
      )
      set({ workspaces, workspaceLoading: false })
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
    // A new session inherits the current permission mode (TUI parity:
    // SessionFlags ride session/new `_meta`; the agent never persists
    // ask/auto/always-approve). Capture before the reset — yoloMode wins
    // over autoMode; a miss falls back to the config.toml default. Plan
    // mode is per-session on the agent side and always starts fresh.
    const cur = get()
    const defaultFlags = await ensureDefaultModeFlags()
    const curFlags = sessionModeFlags(
      { yoloMode: cur.yoloMode, autoMode: cur.autoMode },
      defaultFlags,
    )
    const inheritMeta = permissionSeedMeta(curFlags)
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
      diffReview: undefined,
      diffReviewOpen: false,
      memoryFiles: undefined,
      memoryOpen: false,
      subagentIndex: {},
      pendingSubagentFinishes: {},
      subagentChildIndex: {},
      subagentViews: {},
      bgTaskIndex: {},
      topTasks: [],
      gitInfo: undefined,
      // Keep the inherited permission flags in state so the UI matches
      // the agent's mode (the fresh session's own restoreModeFlags copy
      // is empty; the agent only announces yolo_mode_changed on change).
      yoloMode: curFlags.yoloMode,
      autoMode: curFlags.autoMode,
      permissionMode: undefined,
      planMode: false,
      mcpServers: [],
      mcpInit: undefined,
      selectedId: null,
      focusMode: 'prompt',
      expandedGroups: new Set(),
      viewerEntryId: null,
      viewerTask: undefined,
      followUps: undefined,
      followUpsResponseId: undefined,
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
      // A fresh session starts with an empty context window — drop the
      // previous session's usage or the top-right context chip keeps
      // showing the old conversation's tokens until the first
      // usage_update/turn_completed arrives (loadHistory already resets
      // this; newSession was the only path that missed it).
      usage: undefined,
      turnStartedAt: undefined,
      scheduledTasks: [],
    })
    // New session lands in the CURRENT conversation's workspace: inherit
    // its cwd so "new" starts in the same directory (captured above, before
    // the anchor reset clears it). Empty cwd (no session yet) → host default.
    await transport.newSession({
      ...(cur.cwd ? { cwd: cur.cwd } : {}),
      ...(inheritMeta ? { meta: inheritMeta } : {}),
    })
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
        e.id === id && e.kind === 'thought'
          ? { ...e, displayMode: nextThoughtMode(thoughtDisplayMode(e)) }
          : e,
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
      (entry.kind === 'thought' && thoughtDisplayMode(entry) === 'collapsed')

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
      // Three-state ladder (TUI collapse_mode/expand_selected): → steps up
      // collapsed → truncated → expanded; ← steps down expanded → truncated
      // → collapsed.
      const cur = thoughtDisplayMode(entry)
      const target: ThoughtDisplayMode = expanded
        ? thoughtModeStepUp(cur)
        : thoughtModeStepDown(cur)
      if (target === cur) return
      set({
        entries: entries.map((e) =>
          e.id === selectedId && e.kind === 'thought'
            ? { ...e, displayMode: target }
            : e,
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
    else if (e.kind === 'thought') get().toggleThought(e.id)
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

  fetchSubagentView: async (childSessionId) => {
    const s = get()
    const view = s.subagentViews[childSessionId]
    if (!view || view.items.length > 0 || view.fetchState === 'loading' || view.fetchState === 'loaded') {
      return
    }
    // 子代理与父会话同 cwd（宿主 session-updates 按 sessionId+cwd 分页）。
    const cwd = s.cwd
    if (!cwd) return
    set({
      subagentViews: {
        ...s.subagentViews,
        [childSessionId]: { ...view, fetchState: 'loading' },
      },
    })
    try {
      // 取最新一页（与 loadHistory 相同的负 offset 分页约定），按存储顺序
      // （时间正序）回放——同一 applySubagentViewEvent 处理器，live 与
      // 回放事件不会出现两套渲染逻辑。
      const r = await transport.loadSessionHistory(childSessionId, cwd, {
        offset: -SUBAGENT_VIEW_MAX_ITEMS,
        limit: SUBAGENT_VIEW_MAX_ITEMS,
      })
      // 拉取期间 live 事件已到达（视图非空）→ 跳过回放：没有事件 id 可
      // 去重，混入会造成重复/乱序；live 流已接管后续内容（TUI 靠事件 id
      // 去重，这里取更保守的策略）。
      if ((get().subagentViews[childSessionId]?.items.length ?? 0) > 0) {
        return
      }
      for (const env of r.updates ?? []) {
        const ev = envelopeToEvent(env)
        if (ev) applySubagentViewEvent(set, childSessionId, ev)
      }
    } catch {
      // 拉取失败（离线 / 宿主无该子代理会话）——保持空视图，结束状态置
      // loaded 防止弹窗打开期间的重试风暴。
    } finally {
      set((st) => {
        const v = st.subagentViews[childSessionId]
        if (!v) return {}
        return {
          subagentViews: {
            ...st.subagentViews,
            [childSessionId]: { ...v, fetchState: 'loaded' },
          },
        }
      })
    }
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

/**
 * Turn-end marker text for a finished turn — TUI session_event message()
 * parity (session_event.rs): TurnFailed / TurnCancelled / TurnCompleted
 * forms, each with or without an elapsed duration. Failed turns carry the
 * warning accent (amber), same as the x.ai notification rail.
 */
function turnEndMarkerText(
  stopReason: string | undefined,
  agentResult: string | undefined,
  elapsedMs: number | undefined,
): { text: string; warning?: boolean } {
  if (stopReason === 'error' || stopReason === 'rate_limit') {
    const err =
      stopReason === 'error' ? agentResult || 'unknown error' : 'rate limited'
    return {
      text:
        elapsedMs != null
          ? `Turn failed in ${formatTurnDuration(elapsedMs)}: ${err}`
          : `Turn failed: ${err}`,
      warning: true,
    }
  }
  if (stopReason === 'cancelled') {
    return {
      text:
        elapsedMs != null
          ? `Turn cancelled by user in ${formatTurnDuration(elapsedMs)}.`
          : 'Turn cancelled.',
    }
  }
  return {
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
      e.text.startsWith('Turn failed') ||
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
      case 'image':
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
        displayMode: 'collapsed',
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
    // Subagents are deliberately NOT settled here, same as bg_task: a
    // subagent without a `subagent_finished` in the loaded history was
    // still running when the snapshot was taken (or its finish is parked
    // in pendingSubagentFinishes until the spawn page replays) — only the
    // finish event ends it. Sealing at turn end would rewrite a genuinely
    // in-flight subagent into a green "Agent done" and drop it from the
    // top running-chip / tasks bar, exactly what the TUI avoids by
    // tracking subagent_sessions independently of the parent turn.
    return e
  })
}

// ── history envelope replay ───────────────────────────────────────
//
// A stored update is the JSONL envelope {timestamp, method, params} with
// params = {sessionId, update}. Mirrors the host's session/update mapping.

/** Updates per history page; older pages load on scroll-up. */
const HISTORY_PAGE_SIZE = 100

/**
 * Replay raw history envelopes through the live event pipeline.
 * Returns the replayed turn's metadata: the current turn's real start
 * time (authoritative `_meta.turnStartMs` / agentTimestampMs from the
 * shell, falling back to the first user_message envelope timestamp) and
 * whether that turn is still OPEN (no turn_completed / response_completed
 * after its start). loadHistory uses this to restore the in-flight turn
 * timer ("回合进行中（已进行 Xs）"). Turn-end markers are rendered
 * per-turn by the `turn_completed` handler: this function injects each
 * closing turn's tracked start into the event so the marker carries the
 * true duration (the `done` event is not persisted, so replay derives
 * the duration from the envelope stamps).
 */
function replayUpdates(
  getStore: () => ChatState,
  updates: unknown[],
): { turnStartedAt?: number; turnOpen: boolean } {
  let userBuf = ''
  let userIsCron = false
  let userTs: number | undefined
  let turnStartTs: number | undefined
  let anyEvent = false
  let sawTurnEnd = false
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
    anyEvent = true
    if (ev.type === 'turn_completed') {
      sawTurnEnd = true
      // Attach this closing turn's real start (tracked from the envelope
      // meta below) so the marker renders "Worked for X" / "Turn failed
      // in X" with the true duration. `endMs` comes from the completion
      // envelope's own timestamp (when the shell wrote it — the same
      // stamp the TUI's anchored elapsed reads). Reset the tracker so the
      // NEXT turn's start is captured from its own first envelope — the
      // old first-start→last-end pairing spanned multiple turns whenever
      // a page covered more than one closed turn.
      ev.turnStartedAt = turnStartTs
      turnStartTs = undefined
    }
    // Authoritative turn start: the shell stamps `_meta.turnStartMs`
    // (epoch ms; TUI tracker reads it the same way, falling back to
    // agentTimestampMs) on every streamed update of the turn. Take the
    // first one of the page — it belongs to the newest replayed turn.
    // The completion envelope itself never re-opens a turn.
    if (turnStartTs == null && ev.type !== 'turn_completed') {
      const meta = (env as RawEnvelope).params?._meta as
        | Record<string, unknown>
        | undefined
      const tsMs = meta?.turnStartMs ?? meta?.turn_start_ms ?? meta?.agentTimestampMs
      if (typeof tsMs === 'number' && Number.isFinite(tsMs)) {
        turnStartTs = tsMs
      } else if (typeof tsMs === 'string') {
        const parsed = Date.parse(tsMs)
        if (Number.isFinite(parsed)) turnStartTs = parsed
      }
    }
    // Fallback start: the first user message of the page (epoch seconds
    // from the shell; first-event timestamp for injected turns without a
    // user prompt).
    if (turnStartTs == null && ev.type !== 'turn_completed') {
      turnStartTs = envelopeTimestamp(env as RawEnvelope)
    }
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
  // The LAST turn is open when it never completed (no turn_completed in
  // the page) or when a new turn started after the page's last completion
  // (the tracker re-captured a start). turnStartedAt is then that current
  // turn's real start — loadHistory restores the in-flight timer from it.
  return {
    turnStartedAt: turnStartTs,
    turnOpen: anyEvent && (sawTurnEnd ? turnStartTs != null : true),
  }
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
      return turnCompletedEvent(up, envelopeTimestamp(e))
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
    case 'current_mode_update': {
      // The stored envelope carries {currentModeId} directly on the update
      // (the session/new|load `modes` shape), NOT inside modeState — the
      // old mapping read up.modeState, so plan/permission mode never
      // survived history replay. Feed either shape through extractModeFlags.
      const ms =
        up.modeState ??
        (typeof up.currentModeId === 'string'
          ? { currentModeId: up.currentModeId }
          : undefined)
      return ms ? { type: 'modes_update', modes: ms } : null
    }
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
      return turnCompletedEvent(up, envelopeTimestamp(e))
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
 * Build the typed `turn_completed` event from a stored envelope's update.
 * Carries the turn's stop_reason / agent_result (so replay can render the
 * correct marker — TurnFailed / TurnCancelled / Worked for — instead of a
 * blanket "Turn completed.") plus the envelope write time as the turn's end
 * stamp (replayUpdates injects the real start from the envelope meta).
 */
function turnCompletedEvent(
  up: Record<string, unknown>,
  endMs: number | undefined,
): AcpEvent {
  return {
    type: 'turn_completed',
    stopReason: typeof up.stop_reason === 'string' ? up.stop_reason : undefined,
    agentResult:
      typeof up.agent_result === 'string' ? up.agent_result : undefined,
    endMs,
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
      // Collapse body after finish (TUI truncated "Thought for Xs" preview)
      // finishedAt drives the short finish-flash accent (EntryRenderer)
      return {
        ...e,
        streaming: false,
        elapsed,
        displayMode: 'collapsed',
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

/**
 * Consume an x.ai/mcp/init_progress payload into `mcpInit` state — the
 * TUI McpInitProgress analog (total/connected counts, camelCase wire from
 * the shell; snake_case tolerated defensively). Malformed payloads are
 * ignored (state keeps its last value).
 */
function applyMcpInitProgress(set: SetState, params: unknown): void {
  const p =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {}
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
  const total = num(p.total) ?? num(p.totalCount) ?? num(p.total_count)
  const connected = num(p.connected) ?? num(p.connectedCount) ?? num(p.connected_count)
  if (total == null || connected == null) return
  set({
    mcpInit: {
      total,
      connected,
      startedAt: Date.now(),
    },
  })
}

// ── x.ai/follow_ups — turn-end suggestion chips (TUI follow_ups.rs) ─────
// The TUI renders these as a transient clickable row between the
// scrollback and the prompt — NEVER as scrollback rows — so the FE parses
// them into store state for the composer's chip row instead.

/**
 * x.ai/* notifications with no scrollback UI value — silently dropped in
 * `handleEvent`'s ext_notification case (the host forwards everything
 * pass-through, so suppression happens at the render boundary). Aligned
 * with the TUI: these are status-type notifications shown ONLY inside
 * their dedicated panels, never as scrollback rows. Everything NOT in
 * this set still falls through to the dim "扩展通知" status line
 * (forward visibility).
 */
const SILENT_EXT_NOTIFICATIONS = new Set([
  'x.ai/settings/update',
  // File-watcher state (TUI file-watch panel) — fires on every change.
  'x.ai/fs_notify',
  'x.ai/fs/index',
  'x.ai/fs/index/delta',
  // Search engine status (TUI /search panel).
  'x.ai/search/fuzzy/status',
  'x.ai/search/content/status',
  // Pty lifecycle (TUI terminal pane).
  'x.ai/terminal/pty/notification',
  // Config reload notice (TUI settings modal; FE has no config editor).
  'x.ai/config_changed',
  // NOTE: x.ai/mcp/init_progress is intentionally NOT here — it is
  // consumed into mcpInit state (McpPanel init progress), both as the
  // typed `mcp_init_progress` event and via the ext_notification
  // fallback in handleEvent.
  // NOTE: x.ai/queue/changed is intentionally NOT here — it feeds the
  // promptQueue sync layer (applyQueueChanged), both as the typed
  // `queue_changed` event and via the ext_notification fallback.
])

/** TUI MAX_FOLLOW_UPS — max chips kept from one (server-controlled) delivery. */
const MAX_FOLLOW_UPS = 6
/** TUI MAX_FOLLOW_UP_LABEL — max chars per (server-controlled) suggestion. */
const MAX_FOLLOW_UP_LABEL = 256

/**
 * Sanitize a server-supplied suggestion label (TUI `sanitize_suggestion`
 * → `is_unsafe_display_char`): strip control + bidi/format characters so
 * a chip can neither inject terminal escapes nor spoof layout, bound the
 * length, and trim surrounding whitespace. Iterated by code point
 * (Array.from) so surrogate pairs (emoji) survive.
 */
function sanitizeFollowUpLabel(label: string): string {
  const cleaned = Array.from(label)
    .filter((c) => {
      const cp = c.codePointAt(0)!
      const control = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)
      const bidiFormat =
        cp === 0x061c ||
        (cp >= 0x200b && cp <= 0x200f) ||
        (cp >= 0x202a && cp <= 0x202e) ||
        (cp >= 0x2060 && cp <= 0x206f) ||
        cp === 0xfeff
      return !control && !bidiFormat
    })
    .slice(0, MAX_FOLLOW_UP_LABEL)
    .join('')
  return cleaned.trim()
}

/**
 * Handle `x.ai/follow_ups` — store turn-end suggestion chips for the
 * latest assistant response. Wire params (TUI FollowUpsParams, snake_case
 * verbatim): `{ response_id, suggestions: [{ label, … }], promptId?,
 * _meta? }`. Only the labels are consumed; count/length are bounded and
 * labels sanitized at ingestion. No scrollback row — chips live in the
 * composer, above the input. Newest-wins keyed by `response_id` (TUI
 * AgentView::apply_follow_ups): a missing id is ignored, a same-id
 * re-delivery is idempotent, a newer id replaces, and an empty (or
 * all-sanitized-away) list retracts the chips. Malformed payloads are
 * ignored (no chip, no scrollback line).
 */
function applyFollowUps(
  get: () => ChatState,
  set: SetState,
  params?: Record<string, unknown>,
): void {
  let p = params
  // Defensive: some hosts ship the params as a raw JSON string (the TUI
  // reads `notif.params` as one) instead of a pre-parsed object.
  if (typeof p === 'string') {
    try {
      p = JSON.parse(p) as Record<string, unknown>
    } catch {
      return
    }
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return
  const responseId =
    (typeof p.response_id === 'string' && p.response_id ? p.response_id : '') ||
    (typeof p.responseId === 'string' ? p.responseId : '')
  if (!responseId || responseId === get().followUpsResponseId) return
  const raw = Array.isArray(p.suggestions) ? p.suggestions : []
  const suggestions: FollowUp[] = []
  for (const s of raw.slice(0, MAX_FOLLOW_UPS)) {
    const label =
      typeof s === 'string'
        ? s
        : s && typeof s === 'object'
          ? (s as Record<string, unknown>).label
          : undefined
    if (typeof label !== 'string') continue
    const cleaned = sanitizeFollowUpLabel(label)
    if (cleaned) suggestions.push({ label: cleaned })
  }
  set({
    followUpsResponseId: responseId,
    followUps: suggestions.length > 0 ? suggestions : undefined,
  })
}

/**
 * Shared plan/permission-flag application — used by the standalone
 * yolo_mode_changed SSE event, the session_notification tag, and history
 * replay. The agent sends snake_case ({yolo_mode, auto_mode,
 * permission_mode}); accept both spellings (camelCase first for
 * host-normalized paths). Plan mode rides the same wire: permissionMode
 * 'plan' means the agent is in plan mode (Shift+Tab cycle gear + prompt
 * flag).
 */
function applyModeFlags(set: SetState, p: Record<string, unknown>): void {
  const yolo =
    typeof p.yoloMode === 'boolean'
      ? p.yoloMode
      : typeof p.yolo_mode === 'boolean'
        ? p.yolo_mode
        : undefined
  const auto =
    typeof p.autoMode === 'boolean'
      ? p.autoMode
      : typeof p.auto_mode === 'boolean'
        ? p.auto_mode
        : undefined
  const perm =
    typeof p.permissionMode === 'string' && p.permissionMode
      ? p.permissionMode
      : typeof p.permission_mode === 'string' && p.permission_mode
        ? p.permission_mode
        : undefined
  const planMode =
    perm === 'plan' ? true : perm != null && perm !== '' ? false : undefined
  set({
    yoloMode: yolo,
    autoMode: auto,
    permissionMode: perm,
    ...(planMode !== undefined ? { planMode } : {}),
  })
}

/**
 * Normalize a subagent_finished wire status to the entry status set.
 * Absent status = success (the host may omit it); a PRESENT but unknown
 * status (error/timeout/killed/…) must not render as a green "Agent
 * done" — treat it as failed, like handleTaskCompleted's kill/nonzero
 * exit handling.
 */
function subagentFinishStatus(fields: Record<string, unknown>): SubagentStatus {
  const raw = typeof fields.status === 'string' ? fields.status : ''
  if (raw === 'completed' || raw === 'failed' || raw === 'cancelled') return raw
  return raw === '' ? 'completed' : 'failed'
}

/** Apply a subagent finish to its scrollback entry (shared live/replay). */
function applySubagentFinish(
  get: () => ChatState,
  set: SetState,
  entryId: string,
  status: SubagentStatus,
  durationMs?: number,
  output?: string,
  error?: string,
  toolCalls?: number,
  turns?: number,
  tokensUsed?: number,
): void {
  set({
    entries: get().entries.map((e) =>
      e.id === entryId && e.kind === 'subagent'
        ? {
            ...e,
            status,
            running: false,
            finishedAt: Date.now(),
            // Authoritative wall-clock (TUI display_elapsed: finished →
            // SubagentFinished duration_ms, not the local spawn stamp).
            ...(durationMs != null ? { durationMs } : {}),
            detail: durationMs != null ? `${(durationMs / 1000).toFixed(0)}s` : e.detail,
            ...(output != null ? { output } : {}),
            ...(error != null ? { error } : {}),
            ...(toolCalls != null ? { toolCalls } : {}),
            ...(turns != null ? { turns } : {}),
            ...(tokensUsed != null ? { tokensUsed } : {}),
          }
        : e,
    ),
  })
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
    // Child session id (wire `child_session_id`, always present alongside
    // subagent_id per the host tests): the subagent session's own event
    // stream is broadcast with this id — the block viewer's mini
    // scrollback is keyed by it (TUI subagent_views 同款).
    const childSid = nonBlankStr(fields.child_session_id)
    // Spawn metadata (SubagentSpawned wire fields): the model the child
    // runs, its persona / role and agent type. Stored so the scrollback
    // row and the block viewer can show them (TUI SubagentBlock meta).
    set((s) => ({
      subagentIndex: { ...s.subagentIndex, [id]: eid },
      ...(childSid
        ? {
            subagentChildIndex: { ...s.subagentChildIndex, [childSid]: eid },
            subagentViews: {
              ...s.subagentViews,
              [childSid]: { items: [], fetchState: 'idle' },
            },
          }
        : {}),
      entries: [
        ...s.entries,
        {
          id: eid,
          kind: 'subagent',
          title,
          status: 'started',
          running: true,
          // FE-local spawn stamp: live elapsed while running (TUI
          // SubagentInfo.started_at — the wire only carries duration_ms
          // on progress ticks, which trail by up to 2s).
          startedAt: Date.now(),
          subagentId: id,
          ...(childSid ? { childSessionId: childSid } : {}),
          model: nonBlankStr(fields.model),
          persona: nonBlankStr(fields.persona),
          role: nonBlankStr(fields.role),
          subagentType: nonBlankStr(fields.subagent_type),
        },
      ],
    }))
    // A finish may have replayed BEFORE its spawn: history loads the
    // newest page first, so a subagent_finished in a newer page is
    // orphaned until the older page's subagent_spawned arrives. Apply
    // the buffered finish now — the row carries the REAL status/duration
    // instead of staying "running" on a page boundary.
    const pending = get().pendingSubagentFinishes[id]
    if (pending) {
      applySubagentFinish(
        get,
        set,
        eid,
        pending.status,
        pending.durationMs,
        pending.output,
        pending.error,
        pending.toolCalls,
        pending.turns,
        pending.tokensUsed,
      )
      set((s) => {
        const next = { ...s.pendingSubagentFinishes }
        delete next[id]
        return { pendingSubagentFinishes: next }
      })
    }
    return
  }

  // finished
  const status = subagentFinishStatus(fields)
  // Finish payload fields (SubagentFinished wire): output text, failure
  // error, and the subagent's stats — buffered with the finish so an
  // orphaned finish replay still lands them on the row.
  const output = typeof fields.output === 'string' ? fields.output : undefined
  const error = typeof fields.error === 'string' ? fields.error : undefined
  const toolCalls = typeof fields.tool_calls === 'number' ? fields.tool_calls : undefined
  const turns = typeof fields.turns === 'number' ? fields.turns : undefined
  const tokensUsed =
    typeof fields.tokens_used === 'number' ? fields.tokens_used : undefined
  if (!entryId) {
    // History replay can deliver the finish before its spawn (page
    // boundary, newest page first) — buffer it until the spawn replays.
    // Live finishes never orphan (spawn always precedes finish in real
    // time). Cleared by every loadHistory / session reset.
    const durationMs =
      typeof fields.duration_ms === 'number' ? fields.duration_ms : undefined
    set((s) => ({
      pendingSubagentFinishes: {
        ...s.pendingSubagentFinishes,
        [id]: {
          status,
          ...(durationMs != null ? { durationMs } : {}),
          ...(output != null ? { output } : {}),
          ...(error != null ? { error } : {}),
          ...(toolCalls != null ? { toolCalls } : {}),
          ...(turns != null ? { turns } : {}),
          ...(tokensUsed != null ? { tokensUsed } : {}),
        },
      },
    }))
    return
  }
  const durMs = typeof fields.duration_ms === 'number' ? fields.duration_ms : undefined
  applySubagentFinish(
    get,
    set,
    entryId,
    status,
    durMs,
    output,
    error,
    toolCalls,
    turns,
    tokensUsed,
  )
}

/** Non-empty trimmed string, or undefined. */
function nonBlankStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

// ── 子代理迷你 scrollback（subagentViews）──────────────────────────
// 宿主按 withSid 广播所有会话的 session/update 事件；子代理会话
// （child_session_id）的事件流在这里被还原成子代理自己的活动时间线
// （TUI subagent_views 同款）。与主 scrollback 的条目模型不同：仅承载
// 渲染所需的最小字段，且只追加、不折叠。live 事件与按需历史回放
// （fetchSubagentView）共用同一个处理器。

/** 每个子代理视图最多保留的条目数（防内存膨胀，超出丢弃最旧）。 */
const SUBAGENT_VIEW_MAX_ITEMS = 500

/** 子代理视图的时间线末尾追加一条（含上限裁剪）。 */
function subagentViewPush(
  items: SubagentViewItem[],
  item: SubagentViewItem,
): SubagentViewItem[] {
  const next = [...items, item]
  return next.length > SUBAGENT_VIEW_MAX_ITEMS
    ? next.slice(-SUBAGENT_VIEW_MAX_ITEMS)
    : next
}

/** 把子代理会话的一个 AcpEvent 追加进对应视图（纯逻辑，live/回放共用）。 */
function applySubagentViewEvent(
  set: SetState,
  childSid: string,
  ev: AcpEvent,
): void {
  set((s) => {
    const prev = s.subagentViews[childSid]
    // 防御：spawn 尚未处理（索引已建但视图缺失）时惰性初始化。
    const items = subagentViewAppend(prev?.items ?? [], ev)
    const view: SubagentViewState = { ...(prev ?? { items: [], fetchState: 'idle' }), items }
    if (prev && prev.items === items) return {}
    return { subagentViews: { ...s.subagentViews, [childSid]: view } }
  })
}

/**
 * 子代理事件流 → 时间线条目（不可变 reducer）。仅处理 scrollback 相关
 * 类型：user/assistant/thought/tool/plan/image + 回合收口；其余忽略
 * （usage/status/hello/… 与宿主 scrollback 无关）。
 */
function subagentViewAppend(
  items: SubagentViewItem[],
  ev: AcpEvent,
): SubagentViewItem[] {
  switch (ev.type) {
    case 'user_message': {
      const text = ev.text ?? ''
      if (!text.trim()) return items
      return subagentViewPush(items, { kind: 'user', text, ts: ev.ts })
    }
    case 'user_chunk': {
      if (ev.hideFromScrollback === true) return items
      const text = (ev.displayText ?? ev.text) || ''
      if (!text.trim()) return items
      // 同一用户回合的连续 chunk 聚合进最后一条 user（主 scrollback 同款）。
      const last = items[items.length - 1]
      if (last && last.kind === 'user') {
        const next = [...items]
        next[next.length - 1] = { ...last, text: last.text + text }
        return next
      }
      return subagentViewPush(items, { kind: 'user', text })
    }
    case 'chunk': {
      const text = ev.text ?? ''
      if (!text) return items
      const last = items[items.length - 1]
      if (last && last.kind === 'assistant') {
        const next = [...items]
        next[next.length - 1] = { ...last, text: last.text + text, streaming: true }
        return next
      }
      return subagentViewPush(items, { kind: 'assistant', text, streaming: true, ts: ev.ts })
    }
    case 'thought': {
      const text = ev.text ?? ''
      if (!text) return items
      const last = items[items.length - 1]
      if (last && last.kind === 'thought') {
        const next = [...items]
        next[next.length - 1] = { ...last, text: last.text + text, streaming: true }
        return next
      }
      return subagentViewPush(items, { kind: 'thought', text, streaming: true })
    }
    case 'tool_call': {
      const tc = ev.toolCall || {}
      const item = subagentToolItem(tc)
      // 同 toolCallId 重复到达时原地替换，避免双行。
      const idx = item.toolCallId
        ? items.findIndex(
            (it) => it.kind === 'tool' && it.toolCallId === item.toolCallId,
          )
        : -1
      if (idx >= 0) {
        const next = [...items]
        next[idx] = item
        return next
      }
      return subagentViewPush(items, item)
    }
    case 'tool_call_update': {
      const tc = ev.toolCallUpdate || {}
      const toolCallId = toolCallIdOf(tc)
      if (toolCallId) {
        const idx = items.findIndex(
          (it) => it.kind === 'tool' && it.toolCallId === toolCallId,
        )
        if (idx >= 0) {
          const existing = items[idx]
          if (existing.kind === 'tool') {
            // 与主 scrollback 相同：update 的字段合并进 raw，标题/动词重算。
            const merged: ToolCall = { ...(existing.raw || {}), ...tc }
            const next = [...items]
            next[idx] = subagentToolItem(merged, existing)
            return next
          }
        }
      }
      // 未找到对应条目（回放分页边界）：按首次 tool_call 追加。
      return subagentViewAppend(items, { type: 'tool_call', toolCall: tc })
    }
    case 'plan':
      return subagentViewPush(items, { kind: 'plan', entries: ev.entries })
    case 'image': {
      const src = imageSrc(ev.data, ev.mimeType)
      if (!src) return items
      return subagentViewPush(items, {
        kind: 'image',
        data: src,
        mimeType: ev.mimeType,
        ts: ev.ts,
      })
    }
    case 'done':
    case 'turn_completed':
    case 'cancelled': {
      // 回合收口：assistant/thought 停止 streaming，追加回合结束标记。
      const sealed = items.map((it) =>
        (it.kind === 'assistant' || it.kind === 'thought') && it.streaming
          ? { ...it, streaming: false }
          : it,
      )
      const marker: SubagentViewItem = {
        kind: 'turn',
        text:
          ev.type === 'done'
            ? '— turn completed —'
            : ev.type === 'cancelled'
              ? '— turn cancelled —'
              : '— turn ended —',
      }
      return subagentViewPush(sealed, marker)
    }
    default:
      return items
  }
}

/** 从 ToolCall 提取迷你时间线的 tool 条目（title/verb/status/raw）。 */
function subagentToolItem(
  tc: ToolCall,
  prev?: Extract<SubagentViewItem, { kind: 'tool' }>,
): Extract<SubagentViewItem, { kind: 'tool' }> {
  const status = (tc.status as string) || prev?.status || 'pending'
  const kindName = (tc.kind as string) || prev?.kindName || 'other'
  const running = status === 'pending' || status === 'in_progress'
  return {
    kind: 'tool',
    toolCallId: toolCallIdOf(tc) ?? prev?.toolCallId,
    title: extractTarget(tc) || (tc.title as string) || kindName,
    verb: toolVerb(kindName, running),
    status,
    kindName,
    raw: tc,
  }
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

// ── scheduled tasks (/loop) ───────────────────────────────────────
// Both SSE carriers (session_notification tag + standalone event) route
// through these helpers keyed by taskId, so dual delivery never dupes.

/**
 * Normalize a scheduled-task payload into store shape. Accepts the host
 * contract envelope (`task: { taskId, prompt, interval, nextFireAt }`),
 * a flat fields object (snake_case / camelCase), or a standalone event
 * object carrying `task`.
 */
function parseScheduledTask(src: Record<string, unknown> | undefined): ScheduledTask | null {
  if (!src || typeof src !== 'object') return null
  const o = src as Record<string, unknown>
  const inner =
    o.task && typeof o.task === 'object' && !Array.isArray(o.task)
      ? (o.task as Record<string, unknown>)
      : o
  const taskId = wireTaskId(inner.task_id, inner.taskId)
  if (!taskId) return null
  const prompt =
    (typeof inner.prompt === 'string' && inner.prompt) ||
    (typeof inner.description === 'string' && inner.description) ||
    ''
  let interval = typeof inner.interval === 'string' ? inner.interval : ''
  if (!interval && typeof inner.interval_secs === 'number' && inner.interval_secs > 0) {
    interval = `${inner.interval_secs}s`
  }
  if (!interval) {
    // The agent's wire payload calls the schedule human_schedule — the
    // host normalizes it to `interval`, but tolerate the raw shape too.
    interval =
      (typeof inner.human_schedule === 'string' && inner.human_schedule) ||
      (typeof inner.humanSchedule === 'string' && inner.humanSchedule) ||
      ''
  }
  const nextRaw = inner.next_fire_at ?? inner.nextFireAt
  return {
    taskId,
    prompt,
    interval,
    ...(nextRaw != null && nextRaw !== '' ? { nextFireAt: String(nextRaw) } : {}),
  }
}

/** Upsert a scheduled task by taskId (create or replace). */
function upsertScheduledTask(set: SetState, task: ScheduledTask | null): void {
  if (!task || !task.taskId) return
  set((s) => {
    if (s.scheduledTasks.some((t) => t.taskId === task.taskId)) {
      return {
        scheduledTasks: s.scheduledTasks.map((t) =>
          t.taskId === task.taskId ? { ...t, ...task } : t,
        ),
      }
    }
    return { scheduledTasks: [...s.scheduledTasks, task] }
  })
}

/** Remove a scheduled task by taskId (idempotent). */
function removeScheduledTask(set: SetState, taskId: string): void {
  if (!taskId) return
  set((s) => ({
    scheduledTasks: s.scheduledTasks.filter((t) => t.taskId !== taskId),
  }))
}

/** scheduled_task_fired — update ONLY nextFireAt (when the event carries it). */
function updateScheduledTaskFire(set: SetState, taskId: string, nextFireAt: unknown): void {
  if (!taskId || nextFireAt == null || nextFireAt === '') return
  set((s) => ({
    scheduledTasks: s.scheduledTasks.map((t) =>
      t.taskId === taskId ? { ...t, nextFireAt: String(nextFireAt) } : t,
    ),
  }))
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
