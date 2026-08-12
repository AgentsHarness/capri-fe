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
  SubagentViewState,
  TaskTimelineEvent,
  Toast,
  ToolCall,
  TopTask,
  WorkspaceGroup,
  WorkspaceSummary,
} from '../api/types'
import { transport, AgentTurnError, type McpListServer } from '../api/localTransport'
import { applyQueueChanged, qid, usePromptQueue } from './promptQueue'
import { ensureUiSettings, uiBool, uiSettingsLoaded } from './settings'
import { shouldNotify } from './notifyConfig'
import { toolHeader } from '../theme/glyphs'
import { repoNameFromCwd } from '../components/historyGroups'
import { usePins } from '../components/historyPins'
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

/**
 * 已显示过的公告指纹（模块级，非响应式）：key = 公告 id（无 id 回退到
 * title—message 内容），value = severity + 文案指纹。announcements_update
 * 只在公告内容变化时落新行——TUI 在每次 /new、启动后 2s 都会 Force 重推
 * 同一份列表，没有这层去重 scrollback 会被同样的公告行刷屏。
 */
const displayedAnnouncementFingerprints = new Map<string, string>()

/**
 * continueSession 的宽限窗口定时器（模块级，非响应式）：切换会话后
 * 500ms 内 SSE recap 事件仍在路上，需要继续丢弃；但该窗口到期回写
 * 快照的 setTimeout 必须可取消——否则在窗口内切 host/删会话/开新会话
 * 时，旧会话的快照会无条件回锚（把 UI 钉死在已离开的会话上）。
 * switchHost / newSession / resetToEmpty 等切换点负责 clearTimeout。
 */
let continueSessionTimer: ReturnType<typeof setTimeout> | null = null
function clearContinueSessionTimer() {
  if (continueSessionTimer != null) {
    clearTimeout(continueSessionTimer)
    continueSessionTimer = null
  }
}

/**
 * Multi-tab peer session/load: another client called session/load for
 * the session we are viewing. Agent replays the full conversation on the
 * shared SSE bus — without this gate we APPEND the replay onto our
 * existing entries (doubled timeline). Armed on session_load_started
 * when we are NOT already historyLoading (initiator path); cleared when
 * we rebuild from HTTP on session_load_finished.
 */
let peerSessionLoadSid: string | null = null
function clearPeerSessionLoad() {
  peerSessionLoadSid = null
}

/**
 * 会话/宿主切换代数（模块级）：每次 switchHost / newSession / resetToEmpty
 * 递增。在途的 loadHistory / continueSession 异步结果落库前校验代数，
 * 不匹配即丢弃——旧 host 的历史数据绝不写进新 host 的视图。
 */
let sessionSwitchGen = 0

/**
 * 会话创建在飞（newSession 的 POST 窗口，含 resetSessionState 清锚后、
 * 响应回填前的空窗）。窗口期内宿主的 hello 快照（本地 SSE 重连 / hub
 * 回放可能随时到达）只贡献 models/modes，绝不重锚 sessionId、绝不套用
 * busy、绝不触发 loadHistory——否则旧会话的 busy/历史会污染刚创建的新
 * 会话，导致第一条消息被 turnIsLive 误判而错误排队。
 */
let newSessionInFlight = false

/**
 * 最近一次 live 队列广播（queue_changed / x.ai/queue/changed）到达时间
 * （epoch ms）。load 后主动拉取的快照在应用前与它比较：拉取发出之后
 * 若有更新的 live 广播到达（agent 状态已前进），丢弃 HTTP 旧快照避免
 * 回退 —— 下一次 live 广播会带来权威状态。
 */
let lastLiveQueueChangedAt = 0

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

// ── pending client requests (permission / x.ai questions) ───────────
// Interactive x.ai/* methods that get a UI card. Everything else is
// auto-rejected so the agent never hangs on an unsupported method.
const SUPPORTED_XAI_REQUESTS = new Set([
  'x.ai/ask_user_question',
  'x.ai/exit_plan_mode',
  'x.ai/diff_review',
])

/** Owning session of a pending request (top-level wire, or params fallback). */
function pendingReqSessionId(r: PendingReq): string | undefined {
  if (typeof r.sessionId === 'string' && r.sessionId) return r.sessionId
  const p = r.params
  if (!p || typeof p !== 'object') return undefined
  const sid = p.sessionId ?? p.session_id
  return typeof sid === 'string' && sid ? sid : undefined
}

/**
 * Split host pending into permission strip vs x.ai cards, optionally
 * scoped to one session. Untagged rows (old host / no params id) are
 * kept only when `includeUntagged` is true — used for hello of the
 * host's active session, where legacy snapshots had no per-row id.
 * When `sessionId` is undefined (mid-switch / empty state) rows tagged
 * with a KNOWN session are still dropped — they belong to a specific
 * session we are not looking at; only untagged rows pass.
 */
function partitionPendingRequests(
  reqs: PendingReq[] | undefined,
  sessionId: string | undefined,
  opts: { includeUntagged?: boolean } = {},
): { pending: PendingReq[]; xaiRequests: PendingReq[] } {
  const pending: PendingReq[] = []
  const xaiRequests: PendingReq[] = []
  if (!reqs?.length) return { pending, xaiRequests }
  for (const r of reqs) {
    const sid = pendingReqSessionId(r)
    if (sessionId) {
      if (sid && sid !== sessionId) continue
      if (!sid && !opts.includeUntagged) continue
    } else {
      // 无已知会话（切换中 / 空状态）：带已知会话标签的行绝不能画到
      // 当前视图——只放行无标签（legacy）行，它们无法归属到别处。
      if (sid) continue
    }
    const tagged: PendingReq = sid ? { ...r, sessionId: sid } : r
    if (tagged.method.startsWith('x.ai/')) {
      if (SUPPORTED_XAI_REQUESTS.has(tagged.method)) xaiRequests.push(tagged)
    } else {
      pending.push(tagged)
    }
  }
  return { pending, xaiRequests }
}

/**
 * Rehydrate the active session's pending permission / question cards
 * from GET /api/status (authoritative host clientReqs). Used after
 * continueSession — live client_request SSE for a non-active session
 * is filtered out, so switching back would otherwise leave the agent
 * waiting with an empty UI until the 15min approval timeout.
 *
 * Unsupported x.ai/* methods are auto-rejected (same as live path).
 */
async function syncPendingForSession(
  sessionId: string,
  get: () => ChatState,
  set: (partial: Partial<ChatState>) => void,
  myGen: number,
): Promise<void> {
  try {
    const st = await transport.status()
    if (myGen !== sessionSwitchGen) return
    if (get().sessionId !== sessionId) return
    const reqs = st.pendingRequests ?? []
    // Auto-reject unsupported x.ai methods for THIS session so they
    // don't sit until approvalTimeout with no UI.
    for (const r of reqs) {
      const sid = pendingReqSessionId(r)
      if (sid && sid !== sessionId) continue
      if (!sid && st.sessionId !== sessionId) continue
      if (
        r.method.startsWith('x.ai/') &&
        !SUPPORTED_XAI_REQUESTS.has(r.method)
      ) {
        void get().respondXai(r.requestId, undefined, `前端不支持方法 ${r.method}`)
      }
    }
    // After loadSession the host active session is `sessionId`; untagged
    // rows (old host) are attributed to that active session only.
    const includeUntagged = !st.sessionId || st.sessionId === sessionId
    const next = partitionPendingRequests(reqs, sessionId, { includeUntagged })
    if (myGen !== sessionSwitchGen || get().sessionId !== sessionId) return
    set({ pending: next.pending, xaiRequests: next.xaiRequests })
  } catch {
    /* offline / status failed — leave pending empty until next live event */
  }
}

// ── permission-mode persistence (process-global, follows the agent) ──
// The agent persists ONLY the session-mode dimension into the timeline:
// current_mode_update {currentModeId: plan|default|…} lands in
// updates.jsonl and history replay restores it. Permission mode
// (x.ai/yolo_mode_changed: ask / auto / always-approve) is a fire-and-
// forget notification the agent NEVER stores, and the yolo_mode_changed
// channel is CLIENT-scoped: one toggle applies to EVERY resident session
// of the sending client. The FE therefore keeps ONE global copy
// (localStorage) — the web analog of the TUI's persisted permission
// mode — refreshed on every broadcast and re-applied on resume/reload.
// Plan mode is per-session on the agent side (toggle_plan_mode addresses
// a sessionId), so its persisted copy stays keyed by session as a
// best-effort complement to the timeline-derived truth.
type ModeFlags = Partial<Pick<ChatState, 'permissionMode' | 'yoloMode' | 'autoMode'>>

/** Global permission-mode flags (single object, all sessions share it). */
const MODE_FLAGS_KEY = 'acpfe.modeFlags'
/** Per-session plan-mode copies (replay/current_mode_update is the authority). */
const PLAN_FLAGS_KEY = 'acpfe.planModes'

/**
 * Normalize mode flags for persistence: default-y permission values need
 * no record. A saved permissionMode 'ask'/'default'/'normal' would sit in
 * the record shadowing nothing itself (the composer filters those) but a
 * stale 'ask' written over optimistic flags would suppress the composer
 * badge after a resume even when the agent is actually always-approve.
 * Also applied on read so old records written before this rule clean up.
 */
function normalizeModeFlags(flags: ModeFlags): ModeFlags {
  const out: ModeFlags = { ...flags }
  if (
    out.permissionMode === 'ask' ||
    out.permissionMode === 'default' ||
    out.permissionMode === 'normal'
  ) {
    out.permissionMode = undefined
  }
  return out
}

function loadGlobalModeFlags(): ModeFlags {
  try {
    const raw = window.localStorage.getItem(MODE_FLAGS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // 白名单提取：只认权限三字段，其余一律忽略——旧格式（per-session
    // map）或未知结构读出来就是 {}，绝不把杂散 key 展开进 store。
    const o = parsed as Record<string, unknown>
    return normalizeModeFlags({
      yoloMode: typeof o.yoloMode === 'boolean' ? o.yoloMode : undefined,
      autoMode: typeof o.autoMode === 'boolean' ? o.autoMode : undefined,
      permissionMode: typeof o.permissionMode === 'string' ? o.permissionMode : undefined,
    })
  } catch {
    return {}
  }
}

/** Persist the GLOBAL permission-mode flags (shared by every session). */
function saveModeFlags(flags: ModeFlags): void {
  try {
    window.localStorage.setItem(
      MODE_FLAGS_KEY,
      JSON.stringify(normalizeModeFlags(flags)),
    )
  } catch {
    /* persistence is best-effort */
  }
}

/** The global permission-mode flags this client last knew ({} when unknown). */
function restoreModeFlags(): ModeFlags {
  return loadGlobalModeFlags()
}

function loadPlanModes(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(PLAN_FLAGS_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Persist one session's plan-mode copy (replay is the authority, this is a hint). */
function savePlanMode(sessionId: string, planMode: boolean): void {
  try {
    const map = loadPlanModes()
    map[sessionId] = planMode
    window.localStorage.setItem(PLAN_FLAGS_KEY, JSON.stringify(map))
  } catch {
    /* persistence is best-effort */
  }
}

/** Restore one session's plan-mode copy ({} when unknown). */
function restorePlanMode(sessionId?: string): Partial<Pick<ChatState, 'planMode'>> {
  if (!sessionId) return {}
  try {
    const v = loadPlanModes()[sessionId]
    return typeof v === 'boolean' ? { planMode: v } : {}
  } catch {
    return {}
  }
}

// ── exit_plan_mode approval grace window ────────────────────────────
// After the FE approves/abandons a plan it clears planMode locally (the
// agent does not reliably re-broadcast afterwards). SSE events and the
// approval HTTP round-trip travel on separate channels, so a 'plan'
// broadcast queued BEFORE the approval can still land AFTER the local
// clear and wrongly resurrect the flag. For a short window after the
// approval, plan-ON signals are ignored — the approval response is
// causally later than any in-flight pre-exit event. After the window a
// 'plan' signal applies normally (the agent genuinely re-entered plan).
const PLAN_EXIT_GRACE_MS = 1500
let planExitApprovedAt = 0
function planOnWithinGrace(): boolean {
  return Date.now() - planExitApprovedAt < PLAN_EXIT_GRACE_MS
}

// ── client-global default permission mode (config.toml ui.permission_mode) ──
// Used ONLY as the seed for a NEW session (session/new `_meta`): with no
// global record yet, a fresh conversation inherits the TUI's `[ui]
// permission_mode` default, served read-only by the host's GET
// /api/settings. Live display never consults this — it follows the
// agent's yolo_mode_changed broadcasts (client-scoped, all sessions).
// Precedence mirrors the TUI's load_permission_mode: permission_mode >
// legacy approval_mode > yolo=true.

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

/**
 * Fetch the client-global default permission flags (host /api/settings,
 * shared cache in settings.ts). A FAILED fetch is NOT cached: the abort
 * window during host-switch / reconnect (abortInflight kills in-flight
 * fetches) must not permanently lose the config default — the next
 * caller simply retries. Only a resolved settings payload marks the
 * default as loaded.
 */
function ensureDefaultModeFlags(): Promise<ModeFlags> {
  cachedDefaultFlagsPromise ??= ensureUiSettings().then((ui) => {
    if (uiSettingsLoaded()) {
      cachedDefaultModeFlags = permissionFlagsFromUi(ui)
      return cachedDefaultModeFlags
    }
    // Fetch failed (resolved {}): don't cache — retry next call.
    cachedDefaultFlagsPromise = null
    return {}
  })
  return cachedDefaultFlagsPromise
}

/**
 * hello 快照的权威权限模式（host 记录，canonical ask/auto/always-approve）
 * → store flags。无条件映射：ask 也显式给出（清掉 stale 的 yolo/auto），
 * 因为 host 的记录就是 agent 的真实状态——agent 内存态、经 host 每次
 * 变更与回显更新、随 agent 重启复位为 ask。缺字段（老 host / hub 直连）
 * 返回 {} 不干预。
 */
function permissionModeFromSnapshot(mode: unknown): ModeFlags {
  if (mode === 'always-approve') {
    return { yoloMode: true, autoMode: false, permissionMode: 'always-approve' }
  }
  if (mode === 'auto') {
    return { yoloMode: false, autoMode: true, permissionMode: 'auto' }
  }
  if (typeof mode === 'string') {
    return { yoloMode: false, autoMode: false, permissionMode: undefined }
  }
  return {}
}

/**
 * Effective flags for a NEW session: the current global permission mode
 * wins; with none known yet, fall back to the config.toml default.
 */
function sessionModeFlags(saved: ModeFlags, defaults: ModeFlags): ModeFlags {
  return saved.yoloMode !== undefined || saved.autoMode !== undefined ? saved : defaults
}

/** TUI [ui] collapsed_edit_blocks — read from the shared settings cache. */
function collapsedEditBlocks(): boolean {
  return uiBool('collapsed_edit_blocks', false)
}

/**
 * Permission seeds for session/new|load `_meta` (TUI absent-key ≠ off:
 * only send when a flag is actually known). yolo wins over auto — the
 * two are mutually exclusive on the wire. A false-only record (= ask,
 * the agent's own default) is NOT a seed: the restart re-seed used to
 * map it through setMode(seed.yoloMode ? 'always-approve' : 'auto'),
 * silently switching an always-approve-configured agent to auto.
 */
function permissionSeedMeta(
  flags: ModeFlags,
): { yoloMode: boolean; autoMode: boolean } | undefined {
  if (flags.yoloMode !== true && flags.autoMode !== true) return undefined
  return {
    yoloMode: flags.yoloMode === true,
    autoMode: flags.autoMode === true && flags.yoloMode !== true,
  }
}

/**
 * 清空当前会话的全部本地状态，落到"无会话"空状态（sessionId 置空，
 * 直到宿主 ready(newSessionId) 到达前，session 级事件一律丢弃，防止
 * 跨会话串扰）。newSession 与"删除当前会话落到空状态"共用同一份 reset。
 * 权限模式（yolo/auto/permissionMode）是进程级全局状态，跟随 agent
 * 广播，**不随会话复位**；planMode 是会话态，随复位清空（由下次
 * replay/load 恢复）。
 */
function resetSessionState(set: (partial: Partial<ChatState>) => void): void {
  set({
    entries: [],
    liveStream: null,
    // Clear the session anchor: until the host's ready(newSessionId)
    // arrives, session-scoped events are dropped (no cross-session leak).
    sessionId: undefined,
    cwd: undefined,
    emptyCwd: undefined,
    emptyCwdByHost: {},
    // 会话级失败提示随视图复位：新视图不该残留上一个会话的加载失败。
    historyLoadError: undefined,
    openAssistantId: undefined,
    openThoughtId: undefined,
    pendingOptimisticUserId: undefined,
    awaitingNext: false,
    // 复位必须同步重置 conn：旧会话的回合还在 host 跑（本端不再显示它），
    // 若沿用 busy，状态栏会渲染成"就绪 + 旧回合残留计时器"，且旧回合
    // done 走"不同会话"分支不会把 conn 收回，conn 会永久卡在 busy，
    // 新会话的消息也会被 turnIsLive 误判而错误排队。置 ready = 本端
    // 没有活跃回合，诚实的空闲状态；新会话的 ready 事件会再锚定。
    conn: 'ready',
    statusText: '就绪',
    lastSentPromptId: undefined,
    recapPendingFor: undefined,
    recapCache: {},
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
    // 权限模式是进程级全局状态（agent 客户端级广播），不随会话复位；
    // planMode 是会话态，复位清空（replay/current_mode_update 恢复）。
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
    // 标题/目标/工作流是会话级状态：切会话必须清空，否则新会话沿用
    // 旧会话的标题、目标芯片与工作流面板。
    sessionTitle: undefined,
    goalState: undefined,
    workflowRuns: {},
    historySessionId: undefined,
    historyCwd: undefined,
    historyTotalCount: undefined,
    historyLoadedCount: 0,
    historyLoadedStart: undefined,
    historyHasMore: false,
    // 复位即弃用一切在途历史加载：不在此清会让旧会话 loadHistory 的
    // 完成回调把历史灌进新会话、或让 historyLoading 卡住新会话的发送
    // （send 的 historyLoading 守卫会 toast 拒发）。loadHistory 完成时
    // 的 staleLoad 守卫只收口标志，不污染状态。
    historyLoading: false,
    historyLoadingMore: false,
    historyPromptStarts: undefined,
    historyTurnIdx: 0,
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
    currentPromptId: undefined,
    genRate: undefined,
    scheduledTasks: [],
  })
  // 跨会话防线：会话复位时撤销在飞的子代理收口兜底——它属于离开的
  // 会话，绝不能在新会话里触发收口（F1 的 sessionId 守卫之外的兜底）。
  clearSubagentSettleTimer()
  // 同款防线：HTTP 瞬断看门狗属于离开的会话，复位即弃（触发时也有
  // sessionId/turnStartedAt 守卫，这里是双保险）。
  clearTurnBlipTimer()
  // The prompt queue is per-session widget state: the session-tracking
  // subscription below (switchSession on every sessionId change) stashes
  // this session's queue under its id when the anchor clears here, and
  // the queue returns when the session becomes active again.
}

// ── agent-restart follow ────────────────────────────────────────────
// The agent's permission mode lives in ITS process memory only — host
// restart (or agent crash) resets every session to the default ask. The
// host stamps each hello with the agent spawn time; when it changes
// (including first contact) the browser's GLOBAL permission-mode copy is
// stale and must NOT be replayed onto the agent — the UI follows the
// agent, so the copy is cleared and the badge falls back to ask until
// the user (or another client) toggles a mode again.
const LAST_AGENT_STARTED_KEY = 'acpfe.lastAgentStartedAt'

/**
 * Detect an agent restart via the hello `agentStartedAt` stamp and drop
 * the global permission-mode record so the UI follows the agent's fresh
 * ask default. Idempotent: fires once per agent instance (recorded in
 * localStorage), so a plain page reload never clears on its own — the
 * stamp is unchanged and the reload simply re-reads the (still valid)
 * global flags. No-op for older hosts without the stamp.
 */
function clearModeFlagsOnAgentRestart(
  set: SetState,
  agentStartedAt: number | undefined,
): void {
  if (typeof agentStartedAt !== 'number' || agentStartedAt <= 0) return
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
  try {
    window.localStorage.removeItem(MODE_FLAGS_KEY)
  } catch {
    /* ignore */
  }
  // Plan mode is per-session and timeline-derived — untouched here.
  set({
    yoloMode: undefined,
    autoMode: undefined,
    permissionMode: undefined,
  })
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

/** TUI context_bar fmt_tokens: "500", "5.2K", "48.8K", "1.2M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return n >= 10_000_000 ? `${Math.round(n / 1_000_000)}M` : `${(n / 1_000_000).toFixed(1)}M`
  }
  if (n >= 1_000) {
    return n >= 10_000 ? `${Math.round(n / 1_000)}K` : `${(n / 1_000).toFixed(1)}K`
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
    // TUI usage_percentage_u8 clamps at 100 — never render >100% even
    // when used transiently exceeds the window (pre-auto-compact).
    const pct = Math.min(100, Math.round((used / ctxSize) * 100))
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

/** Canonical ACP option id for the prepended "enable always-approve mode"
 *  row (TUI prompter.rs ENABLE_ALWAYS_APPROVE_OPTION_ID — position 0 on
 *  TUI-class clients). Picking it is a two-part action: the shell maps the
 *  response to AllowOnce (this request allowed once, nothing persisted),
 *  and the CLIENT must additionally flip always-approve on — persist +
 *  x.ai/yolo_mode_changed (TUI dispatch_permission_select →
 *  set_yolo_mode(true)). Without the flip the session-wide toggle never
 *  applies and the agent keeps prompting. */
const ENABLE_ALWAYS_APPROVE_OPTION_ID = 'enable-always-approve'

/** Wire kind of the ACP AllowOnce option (serde snake_case — the fake
 *  host ships `"kind": "allow_once"`; the prompter's option ids are the
 *  kebab form `allow-once`). Matches both. */
const ALLOW_ONCE_KIND_RE = /^allow[-_]once$/i

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

/**
 * Session-mode channel patch (modes_update / current_mode_update /
 * hello|ready modes / session-load modes) — extractModeFlags plus two
 * guarantees that keep the composer's plan flag honest:
 *
 *  1. plan ON right after an exit_plan_mode approval is dropped: the
 *     approval response is causally later than any in-flight pre-exit
 *     broadcast (SSE and the approval HTTP round-trip are separate
 *     channels, so a queued 'plan' event can land after the local
 *     clear). See PLAN_EXIT_GRACE_MS.
 *  2. plan OFF authoritatively clears a lingering permissionMode 'plan'
 *     (from an earlier permission broadcast or a saved record) so the
 *     composer's `inPlan` cannot stay true against the session-mode
 *     truth. A permissionMode the payload itself carries (e.g. the
 *     currentModeId mirror) is left alone.
 */
function sessionModesPatch(
  get: () => ChatState,
  modes: unknown,
): Partial<
  Pick<ChatState, 'planMode' | 'permissionMode' | 'yoloMode' | 'autoMode'>
> | null {
  const flags = extractModeFlags(modes)
  if (!flags) return null
  if (flags.planMode === true && planOnWithinGrace()) {
    delete flags.planMode
  }
  if (
    flags.planMode === false &&
    flags.permissionMode === undefined &&
    get().permissionMode === 'plan'
  ) {
    return { ...flags, permissionMode: undefined }
  }
  return Object.keys(flags).length > 0 ? flags : null
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
  /** 连接模式：local（本机 acp-host，锁定本机，无 host 切换）/ hub（跨源 hub，可切换 host）。 */
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
   * 生成输出速率（估算 tok/s）——host 流式期间推送 gen_rate 事件实时更新；
   * 工具执行/turn 结束推送冻结终值；新一轮发送清空（host 在
   * user_message_chunk 时静默复位，不发事件）。
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
 * Send a workflow control prompt through the PROMPT path: queue
 * mid-turn like any Enter prompt (promptQueue auto-sends at turn end),
 * send immediately otherwise. `feedback` lands on the status line AFTER
 * send()'s synchronous 'Thinking' stamp so the confirmation stays
 * visible; the next connection event replaces it.
 * (Goals no longer use this path — they are driven by the host engine
 * via /api/goal/*; see the goalSet docs above.)
 */
function sendControlPrompt(
  get: () => ChatState,
  set: SetState,
  text: string,
  feedback: string,
): void {
  const st = get()
  if (st.conn === 'busy') {
    usePromptQueue.getState().enqueue(
      {
        text,
        blocks: [{ type: 'text', text }],
      },
      st.sessionId ?? '',
    )
    set({ statusText: `${feedback}（已排队，回合结束后发送）` })
    return
  }
  void st.send(text)
  set({ statusText: feedback })
}

export const useChatStore = create<ChatState>((setRaw, get) => {
  // 无 store 条数上限：entries 全量保留（不再 MAX_ENTRIES 丢弃最旧）。
  const set: SetState = (partial) => {
    setRaw((s) => {
      const patch = typeof partial === 'function' ? partial(s) : partial
      return patch
    })
  }
  return {
    entries: [],
  liveStream: null,
  conn: 'connecting',
  statusText: '连接中…',
  recapPendingFor: undefined,
  recapCache: {},
  awaitingNext: false,
  hosts: [],
  mode: 'local',
  sessions: [],
  workspaces: [],
  workspaceLoading: false,
  historyOpen: false,
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  historyLoading: false,
  historyLoadedCount: 0,
  historyLoadedStart: undefined,
  historyHasMore: false,
  historyLoadingMore: false,
  historyPromptStarts: undefined,
  historyTurnIdx: 0,
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
  contextOpen: false,
  usageOpen: false,
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

  // ── goal mode — HOST-ENGINE control (TUI /goal parity) ─────────────
  // The host owns the goal tracker (acp-host goal.go): these actions call
  // /api/goal/* directly instead of the old prompt path (the wire has no
  // goal control methods, and the prompt path only worked when the agent
  // happened to have an update_goal tool). Responses carry the current
  // goal state, applied to goalState immediately; the host also
  // broadcasts goal_updated events on every state change.
  goalSet: async (objective, tokenBudget) => {
    const o = objective.trim()
    if (!o) {
      set({ statusText: '目标设定失败: 缺少目标描述' })
      return
    }
    // Tolerate a trailing --budget in the objective for direct callers.
    let budget = tokenBudget
    const budgetMatch = o.match(/--budget\s+([\d.]+[kKmM]?)/i)
    const clean = budgetMatch ? o.slice(0, budgetMatch.index).trim() : o
    if (budgetMatch && budget == null) {
      const n = Number(budgetMatch[1])
      if (!Number.isNaN(n)) budget = Math.round(n)
    }
    try {
      const data = await transport.goalSet(clean, budget, get().sessionId)
      if (data.goal) set({ goalState: data.goal, goalReceivedAt: Date.now() })
      set({ statusText: '目标已设定，开始执行' })
    } catch (e) {
      set({ statusText: `目标设定失败: ${e instanceof Error ? e.message : e}` })
    }
  },
  goalStatus: async () => {
    try {
      const data = await transport.goalStatus(get().sessionId)
      if (data.goal) {
        set({ goalState: data.goal, goalReceivedAt: Date.now() })
        set({ statusText: `目标状态: ${String(data.goal.status)}` })
      } else {
        set({ statusText: '暂无目标状态（当前没有进行中的目标）' })
      }
    } catch (e) {
      set({ statusText: `目标状态查询失败: ${e instanceof Error ? e.message : e}` })
    }
  },
  goalPause: async () => {
    try {
      const data = await transport.goalPause(get().sessionId)
      if (data.goal) set({ goalState: data.goal, goalReceivedAt: Date.now() })
      set({ statusText: '目标已暂停' })
    } catch (e) {
      set({ statusText: `目标暂停失败: ${e instanceof Error ? e.message : e}` })
    }
  },
  goalResume: async () => {
    try {
      const data = await transport.goalResume(get().sessionId)
      if (data.goal) set({ goalState: data.goal, goalReceivedAt: Date.now() })
      set({ statusText: '目标已恢复' })
    } catch (e) {
      set({ statusText: `目标恢复失败: ${e instanceof Error ? e.message : e}` })
    }
  },
  goalClear: async () => {
    try {
      const data = await transport.goalClear(get().sessionId)
      if (data.goal) set({ goalState: data.goal, goalReceivedAt: Date.now() })
      set({ statusText: '目标已清除' })
    } catch (e) {
      set({ statusText: `目标清除失败: ${e instanceof Error ? e.message : e}` })
    }
  },

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
      if (s.historyLoading && ev.type !== 'hello' && ev.type !== 'ready') {
        // ...but NEVER swallow the active session's turn-terminal events:
        // switching to a busy session and having its `done` land inside
        // the historyLoading window would leave the composer stuck on
        // "Waiting for host…" forever (finalizeTurn never runs).
        // Same for client_request (permission / ask_user_question): a
        // pending that lands during the load/grace window must paint, or
        // the agent sits blocked until approvalTimeout with no UI.
        // session_load_finished: multi-tab peer rebuilds HTTP history
        // after another tab's session/load replay ends.
        const evSid = (ev as { sessionId?: string }).sessionId
        const isTurnEnd =
          ev.type === 'done' ||
          ev.type === 'turn_completed' ||
          ev.type === 'cancelled'
        // client_request (+ resolved): permission / ask_user_question cards
        // that land or clear during the load/grace window must update UI,
        // or multi-tab answers leave a zombie card / missed prompt.
        const isClientRequest =
          ev.type === 'client_request' || ev.type === 'client_request_resolved'
        const isSessionLoadBoundary =
          ev.type === 'session_load_started' ||
          ev.type === 'session_load_finished'
        if (!isTurnEnd && !isClientRequest && !isSessionLoadBoundary) return
        if (evSid && evSid !== s.sessionId) return
        // Fall through: deliver this session's own turn-terminal /
        // client_request / session-load boundary event.
      }
      // Multi-session host: every session-scoped event carries sessionId.
      // Keep only events for the active session (hello/ready always pass —
      // they announce the session we are switching to; when sessionId is
      // undefined we are mid-switch and must not leak the old session's
      // events into the fresh scrollback).
      const evSid = (ev as { sessionId?: string }).sessionId
      // 子代理收口兜底取消（任务 2）：父会话自身的推进事件（chunk/
      // thought/tool/response_started/client_request/…）说明父回合仍在
      // 活动（子代理完成后父还会继续输出）——撤销待触发的延迟收口。
      // 子代理自身的通知（subagent_spawned/progress/finished）不算父
      // 推进，不取消。
      if (
        (evSid == null || evSid === s.sessionId) &&
        PARENT_TURN_ACTIVITY_TYPES.has(ev.type)
      ) {
        clearSubagentSettleTimer()
      }
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
          if (TURN_TERMINAL_TYPES.has(ev.type)) {
            // 主回合终态被归属到已知子代理 sid → 武装延迟收口（父回合
            // 自己的 done 可能永远不会来）。
            armSubagentTurnSettleFallback(set, get)
          } else if (SUBAGENT_VIEW_ACTIVITY_TYPES.has(ev.type)) {
            // 子代理后续活动（多回合子代理的下一回合）→ 撤消上一终态
            // 武装的兜底。
            clearSubagentSettleTimer()
          }
        } else if (ev.type === 'queue_changed') {
          // 非活跃普通会话的队列广播（切走期间 agent 已 pop 队首开跑）：
          // 喂给该会话的 stash——切回时镜像才是权威的，被收养的行绝不
          // 能仍显示 queued（收养渲染只发生在活跃会话，这里仅更新镜像）。
          applyQueueChanged(ev.params, evSid)
        } else if (
          ev.type === 'ext_notification' &&
          (ev as { method?: string }).method === 'x.ai/queue/changed'
        ) {
          applyQueueChanged(ev.params, evSid)
        }
        return
      }
      s.handleEvent(ev)
    })
    // Persist mode flags. Permission mode (yolo/auto/always-approve) is
    // process-global on the agent side (client-scoped yolo_mode_changed
    // broadcast), so its copy is ONE global record shared by every
    // session. Plan mode is per-session (toggle_plan_mode addresses a
    // sessionId) — its copy stays keyed by session as a best-effort
    // complement to the timeline-derived truth. Skipped while history is
    // (re)building: loadHistory resets the flags to defaults and replay
    // re-derives them — persisting mid-replay would clobber the
    // live-known flags with reset values.
    const unsubMode = useChatStore.subscribe((s, prev) => {
      if (s.historyLoading || s.historyLoadingMore) return
      if (
        s.permissionMode !== prev.permissionMode ||
        s.yoloMode !== prev.yoloMode ||
        s.autoMode !== prev.autoMode
      ) {
        saveModeFlags({
          permissionMode: s.permissionMode,
          yoloMode: s.yoloMode,
          autoMode: s.autoMode,
        })
      }
      if (s.sessionId && s.planMode !== prev.planMode) {
        savePlanMode(s.sessionId, s.planMode)
      }
    })
    transport.connect()
    // 模式由 App 探测阶段（transport.detectMode）决定并 setConnectionMode：
    // - hub：拉 host 列表并自动选中（现状）；local 模式不调，锁定本机。
    const mode = transport.getConnectionMode()
    set({ mode })
    if (mode === 'hub') {
      void get().refreshHosts()
    } else {
      // 本地模式：清掉任何残留的 host 选择状态（hub 痕迹 / 旧版
      // acp-fe.host 残留），左上角固定显示 Localhost。
      set({
        hosts: [],
        selectedHostId: undefined,
        hostId: undefined,
        hostName: 'Localhost',
      })
    }
    // Prefetch the config.toml default permission mode — used only as the
    // seed for NEW sessions (session/new `_meta`). Live display never
    // consults it: the UI follows the agent's yolo_mode_changed broadcasts.
    void ensureDefaultModeFlags()
    // 置顶/待办偏好从 hub 拉取并合并（localStorage 是离线缓存；hub 为
    // 持久层，见 historyPins.ts）。hub 模式生效，local 模式内部跳过。
    void usePins.getState().syncPrefsFromHub()
    return () => {
      unsub()
      unsubMode()
      clearContinueSessionTimer()
      clearPeerSessionLoad()
      get().stopTopTaskPolling()
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
    // 本地模式锁定本机：host 切换只在 hub 模式有效（也不写
    // localStorage acp-fe.host，避免残留状态）。
    if (transport.getConnectionMode() !== 'hub') return
    if (hostId === get().selectedHostId) return
    // Invalidate every in-flight async result from the previous host.
    sessionSwitchGen += 1
    clearContinueSessionTimer()
    clearPeerSessionLoad()
    get().stopTopTaskPolling()
    transport.setHost(hostId)
    try {
      localStorage.setItem('acp-fe.host', hostId)
    } catch {
      /* ignore */
    }
    const host = get().hosts.find((h) => h.hostId === hostId)
    clearSuppressedTools()
    clearStreamBuf()
    set({
      selectedHostId: hostId,
      hostId,
      hostName: host?.hostName,
      sessionId: undefined,
      cwd: undefined,
      // 换 host 即换会话视图：旧 host 的加载失败提示一并清掉。
      historyLoadError: undefined,
      // 空状态工作目录按 host 隔离：切换到哪个 host 就显示哪个 host
      // 自己选过的目录（没有则 undefined → 宿主默认），绝不沿用别的
      // host 的路径。
      emptyCwd: (get().emptyCwdByHost ?? {})[hostId] ?? undefined,
      homeDir: undefined,
      entries: [],
      liveStream: null,
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
      historyLoadedStart: undefined,
      historyHasMore: false,
      historyPromptStarts: undefined,
      historyTurnIdx: 0,
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
      // Host 不可达：丢弃未落库的流式缓冲并取消 rAF，避免残留 flush
      // 在错误态之后把 conn 重新顶回 busy。
      clearStreamBuf()
      set({ conn: 'error', statusText: 'Host 不可达' })
      return
    }
    void get().refreshSessions()
    void get().refreshWorkspaces()
  },

  renameHost: async (hostId, hostName) => {
    try {
      await transport.renameHost(hostId, hostName)
      // 本地乐观更新 + 后台刷新注册表（hub 也会广播 hosts_changed）。
      set({
        hosts: get().hosts.map((h) =>
          h.hostId === hostId ? { ...h, hostName } : h,
        ),
      })
      if (get().selectedHostId === hostId) set({ hostName })
      void get().refreshHosts()
      get().pushToast('Host 名称已更新')
      return true
    } catch (e) {
      get().pushToast(`修改 Host 失败: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  },

  deleteHost: async (hostId) => {
    const host = get().hosts.find((h) => h.hostId === hostId)
    try {
      await transport.unpairHost(hostId)
      // 删掉的是当前选中 host：清掉选择，让 refreshHosts 重新挑选
      // （持久化选择一并清除，避免下次进页面选中一个已删除的 host）。
      if (get().selectedHostId === hostId) {
        try {
          localStorage.removeItem('acp-fe.host')
        } catch {
          /* ignore */
        }
        set({ selectedHostId: undefined })
      }
      // refreshHosts 直接以新注册表为准（不依赖 hosts_changed 广播）。
      const remaining = get().hosts.filter((h) => h.hostId !== hostId)
      set({
        hosts: remaining,
        // 一个 host 都不剩时清掉 host 展示态（下拉兜底显示 Local Host）。
        ...(remaining.length === 0
          ? { hostId: undefined, hostName: undefined }
          : {}),
      })
      await get().refreshHosts()
      get().pushToast(`Host「${host?.hostName ?? hostId}」已删除`)
      return true
    } catch (e) {
      get().pushToast(`删除 Host 失败: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  },

  fetchPairingCode: async () => {
    try {
      return await transport.pairingCode()
    } catch (e) {
      get().pushToast(`获取配对码失败: ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  },

  rotatePairingCode: async () => {
    try {
      const next = await transport.rotatePairingCode()
      get().pushToast('已生成新配对码，旧码立即失效')
      return next
    } catch (e) {
      get().pushToast(`轮换配对码失败: ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  },

  setModel: async (modelId, reasoningEffort) => {
    const prevName = get().modelName
    const prevEffort = get().reasoningEffort
    try {
      await transport.setModel(modelId, reasoningEffort, get().sessionId)
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
      const name = m?.name || modelId
      set({
        modelName: name,
        reasoningEffort: effort,
      })
      // Model switch feedback goes to the scrollback (session_event),
      // like the TUI's `Switched to <model>` pager toast. The host's
      // model_changed broadcast also prints its own line. Amber accent
      // (warning) makes the switch visible in the timeline.
      appendEntry(set, {
        kind: 'session_event',
        text:
          prevName && prevName !== name
            ? `模型已从 ${modelLabel(prevName, prevEffort)} 切换到 ${modelLabel(name, effort)}`
            : `模型已切换到 ${modelLabel(name, effort)}`,
        warning: true,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      appendEntry(set, {
        kind: 'session_event',
        text: `切换模型失败: ${msg}`,
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

  openContext: () => set({ contextOpen: true }),
  closeContext: () => set({ contextOpen: false }),

  openUsage: () => set({ usageOpen: true }),
  closeUsage: () => set({ usageOpen: false }),

  showSessionInfo: async () => {
    try {
      const info = await transport.sessionInfo(get().sessionId)
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
    // Reset the scrollback; load only the newest turn (turnIndex: 1).
    // Older turns load on scroll-up via loadMoreHistory — one turn per
    // gesture. Sticky pins the user prompt when it scrolls away; after
    // a prepend it pins the newly loaded turn's user (no pre-fetch of
    // the previous turn for sticky).
    clearSuppressedTools()
    // 流式缓冲丢弃：换会话后旧流的文本绝不能落进新 scrollback。
    clearStreamBuf()
    // 本次加载的会话锚：加载期间视图可能已切走（newSession / resetToEmpty /
    // switchHost / 窗口期 hello 重锚）——完成时校验，绝不把旧会话的历史
    // 与 turnStartedAt 灌进新会话的空白时间线（否则新会话第一条消息会被
    // turnIsLive 误判而错误排队；历史本身也会污染新会话视图）。
    const loadSid = sessionId
    const staleLoad = () => get().sessionId !== loadSid
    // 入口即校验：调用方（hello / continueSession / rewind / peer）都在
    // 调用前锚定了 sessionId，这里不匹配说明调用后、执行前会话已被切走
    // （newSession / resetToEmpty / switchHost）——连 entries 清空都不该
    // 发生，直接收口标志返回。
    if (staleLoad()) {
      set({ historyLoading: false, historyLoadingMore: false })
      return
    }
    set({
      historyOpen: false,
      historyLoading: true,
      historyLoadedAt: undefined,
      historySessionId: sessionId,
      historyCwd: cwd,
      historyTotalCount: undefined,
      historyLoadedCount: 0,
      historyLoadedStart: undefined,
      historyHasMore: false,
      historyLoadingMore: false,
      historyPromptStarts: undefined,
      historyTurnIdx: 0,
      historyLoadError: undefined,
      historyPrependedAt: undefined,
      historyAnchorId: undefined,
      entries: [],
      liveStream: null,
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
      currentPromptId: undefined,
      genRate: undefined,
      // 换会话复位：旧会话的「待处理」标记绝不能在新会话触发 Composer
      // 自动发送；标题/目标/工作流同理是会话级状态，须一并清空。
      awaitingNext: false,
      sessionTitle: undefined,
      goalState: undefined,
      workflowRuns: {},
      scheduledTasks: [],
    })
    try {
      // 首页始终只拉最后 1 轮（turnIndex: INITIAL_TURNS），渲染这一轮。
      // 上一条由用户上滑 loadMoreHistory 按需加载——不再为 sticky 预取
      // 多轮。宿主不返回 promptStarts 时 hasMore 走按条数 offset 兜底。
      let promptStarts: number[] | undefined
      let turnIdx = 0
      // Turn metadata of the newest replayed page (real start time + open
      // flag), used below to restore the in-flight turn timer.
      let replayMeta: { turnStartedAt?: number; turnOpen: boolean } = {
        turnOpen: false,
      }
      // 加载期间会话被切走：放弃本次加载（historyLoading 由下方
      // stale 分支收口），绝不把旧会话的页灌进新视图。
      if (staleLoad()) {
        set({ historyLoading: false, historyLoadingMore: false })
        return
      }
      // turnIndex only — no limit. Capping at INITIAL_TURN_LIMIT used to
      // cut the END of long last turns (agent returns [start, start+limit)),
      // so assistant text / turn_completed after the cap never appeared
      // between that user message and the next. Older turns still page via
      // loadMoreHistory (previousTurnWindow / offset fallback).
      const r = await transport.loadSessionHistory(sessionId, cwd, {
        turnIndex: INITIAL_TURNS,
      })
      if (staleLoad()) {
        set({ historyLoading: false, historyLoadingMore: false })
        return
      }
      promptStarts = r.promptStarts
      turnIdx =
        promptStarts && promptStarts.length > 0
          ? Math.max(0, promptStarts.length - INITIAL_TURNS)
          : 0
      const updates = r.updates ?? []
      const fetched = updates.length
      const total = r.totalCount ?? 0
      // Newest page: rebuild from scratch. This page carries the
      // session's FINAL context usage (newest envelope) — the only
      // page allowed to update the context chip.
      replayMeta = replayUpdates(get, updates)
      // 绝对游标：按轮次时最老已加载行 = promptStarts[turnIdx]；
      // 否则视作从尾部加载了 fetched 条 → start = total - fetched。
      // 后续 loadMore 一律用绝对 offset，live 追加抬高 total 也不会重叠。
      const turnBased =
        promptStarts != null && promptStarts.length > 0 && total > 0
      const loadedStart = turnBased
        ? promptStarts![turnIdx]!
        : fetched === 0
          ? total || 0
          : Math.max(0, (total || fetched) - fetched)
      const loaded =
        total > 0 ? Math.max(0, total - loadedStart) : fetched
      // 先把 liveStream 文本并入条目，再按是否仍 open 收口。
      // 切勿在未 flush 时 liveStream:null——thought/assistant 流式期间
      // 正文只在 liveStream，直接清空会留下 text:'' 的空壳；随后
      // loadMore 的首条 user 触发 sealThought 会删掉空壳，length 收缩，
      // 新 user 落入「已加载区」被 merge 甩到时间线末尾。
      const flushed = flushLiveStream(get())
      const sealed = sealThought(flushed)
      // 已结束的回合：settle + 清流式指针。仍 open（真·进行中）时保留
      // open*，但 liveStream 已 flush，文本不会丢。
      const entries = replayMeta.turnOpen
        ? sealed.entries
        : settleTurnEntries(sealed.entries)
      // 按轮次模式：还有更早轮次 ⟺ 游标 > 0；按条数兜底：loadedStart > 0。
      const hasMore = turnBased
        ? turnIdx > 0
        : loadedStart > 0 && historyHasMorePage(total || undefined, loaded, fetched, INITIAL_TURN_LIMIT)
      set({
        historyTotalCount: total || undefined,
        historyLoadedCount: loaded,
        historyLoadedStart: total > 0 || fetched > 0 ? loadedStart : undefined,
        historyHasMore: hasMore,
        historyPromptStarts: promptStarts,
        historyTurnIdx: turnIdx,
        conn: 'ready',
        entries,
        liveStream: null,
        openAssistantId: replayMeta.turnOpen ? sealed.openAssistantId : undefined,
        openThoughtId: replayMeta.turnOpen ? sealed.openThoughtId : undefined,
      })
      if (staleLoad()) {
        // 会话已切走：只收口 loading 标志，不动 entries / conn /
        // turnStartedAt / statusText ——新会话的状态由自己的锚定负责。
        set({ historyLoading: false, historyLoadingMore: false })
        return
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
        // 恢复回合的 pid 无法从回放推导：置空走 legacy 匹配——残留的
        // 旧 pid 会把该回合自己的 live 终端事件误判成迟到事件（pid
        // 不符被忽略 → 回合卡死）。
        ...(replayMeta.turnOpen
          ? {
              turnStartedAt: replayMeta.turnStartedAt,
              currentPromptId: undefined,
              statusText: replayMeta.turnStartedAt
                ? `回合进行中（已进行 ${formatTurnDuration(
                    Date.now() - replayMeta.turnStartedAt,
                  )}）`
                : '回合进行中',
            }
          : {
              turnStartedAt: undefined,
              currentPromptId: undefined,
              statusText: `历史已加载 (共 ${get().historyTotalCount ?? '?'} 条更新)`,
            }),
        historyLoadedAt: Date.now(),
        // 权限模式是进程级全局状态（跟随 agent 客户端级广播），replay
        // 推导不出 ask/auto/always-approve——这里恢复全局记录；plan 是
        // 会话态，从 per-session 副本补充（权威仍是 replay 的
        // current_mode_update）。
        ...restoreModeFlags(),
        ...restorePlanMode(sessionId),
      })
      // 会话级 recap 缓存回填：该会话最近一次摘要（display-only、不
      // 持久化）在跨会话期间到达时只进了 cache——这里在历史重建后
      // 按生成时间就近插回对应对话位置（会话中间生成的 recap 显示在
      // 中间，而不是贴在最末尾）。滚动区已含同文本 recap（live 事件
      // 刚 append 过）则跳过，避免同一视图内重复；entries 重建后
      // 每次都会重新回填，重复加载始终可见。
      const cachedRecap = get().recapCache[loadSid]
      if (
        cachedRecap &&
        !staleLoad() &&
        !get().entries.some(
          (e) =>
            e.kind === 'session_event' && e.recap === true && e.text === cachedRecap.text,
        )
      ) {
        const recapEntry: ScrollEntry = {
          id: nid(),
          kind: 'session_event',
          text: cachedRecap.text,
          recap: true,
          open: true,
        }
        // 定位插入点：最后一条时间戳 <= 生成时刻的条目之后（条目
        // 时间取 ts / startedAt；无时间戳的条目跳过，天然落到邻近
        // 有时间的条目之间）。找不到则插到开头；等于末尾则贴末尾。
        const at = cachedRecap.at
        let insertIdx = -1
        const entries = get().entries
        for (let i = 0; i < entries.length; i++) {
          const t = entryTimestamp(entries[i])
          if (t != null && t <= at) insertIdx = i
        }
        set({
          entries: [
            ...entries.slice(0, insertIdx + 1),
            recapEntry,
            ...entries.slice(insertIdx + 1),
          ],
        })
      }
      // 队列状态不随历史回放（agent 不持久化 pending_inputs、load 不
      // 回放 queue_changed）：主动向 host 拉最近一次广播快照对齐镜像
      // （覆盖断线期间错过的 pop/adoption 广播）。静默失败 —— 拉取只是
      // 尽力纠偏，host 无缓存（agent 重启过）或请求失败时保持现状，
      // 后续 live 广播仍会纠正。拉取发出后若有更新的 live 广播到达
      // （lastLiveQueueChangedAt > 发出时刻），说明状态已前进，丢弃
      // 旧快照等下一次广播。adoption 返回值忽略：历史回放已渲染过该
      // 回合的用户行，这里只应用镜像更新，绝不重复 adoptTurn。
      const queuePullSentAt = Date.now()
      void transport
        .queueStatus(sessionId, cwd)
        .then((qr) => {
          if (staleLoad()) return
          if (lastLiveQueueChangedAt > queuePullSentAt) return
          const qsnap = qr.queue
          if (qsnap && typeof qsnap === 'object') {
            applyQueueChanged(qsnap, sessionId)
          }
        })
        .catch(() => {})
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (staleLoad()) {
        // 会话已切走：失败信息属于旧会话，收口标志即可，不渲染错误行。
        set({ historyLoading: false, historyLoadingMore: false })
        return
      }
      set({
        historyLoading: false,
        conn: 'ready',
        statusText: '历史加载失败',
        historyLoadError: msg,
        // 权限模式全局恢复（同成功分支注释）；plan 按会话补充。
        ...restoreModeFlags(),
        ...restorePlanMode(sessionId),
        // 已加载出内容时保留内容 + 内联错误行（就地重试语义）；完全没
        // 加载出来时保持空列表，由 scrollback 中央"加载失败"覆盖层显示。
        entries:
          get().entries.length > 0
            ? [...get().entries, { id: nid(), kind: 'error', text: msg }]
            : [],
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
    const next = { ...s.completedNotices, [sessionId]: now }
    // 上限：超 100 个会话时清最旧 50（字符串对象键按插入序迭代），
    // 防止长时间运行后 completedNotices 无上限增长。
    const keys = Object.keys(next)
    if (keys.length > 100) {
      for (const k of keys.slice(0, 50)) delete next[k]
    }
    set({ completedNotices: next })
    if (last && now - last < NOTICE_DEDUP_WINDOW_MS) return
    // TUI [ui.notifications] gate: condition/events decide whether the
    // completion surfaces (default "unfocused" — while the tab is visible
    // the sidebar ✓ is the feedback; no system notif / toast at all).
    if (!shouldNotify('turn_complete')) return
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
    // A previous session's grace-window callback must never fire after we
    // start switching again (it would re-anchor the OLD session's snapshot).
    clearContinueSessionTimer()
    // We are the load initiator — never treat our own session_load_* as a
    // peer rebuild (would double loadHistory).
    clearPeerSessionLoad()
    // Invalidate in-flight async results from a previous switch.
    const myGen = ++sessionSwitchGen
    // The prompt queue is per-session: swap the active queue to the
    // target session's NOW (stash the current session's queue under its
    // id, restore the target's) — before any async work, so neither the
    // old session's queue can auto-send here nor its rows show in the
    // panel during the switch. The session-tracking subscription makes
    // the same call idempotently when sessionId is re-anchored below.
    usePromptQueue.getState().switchSession(sessionId)
    // Opening the session clears its completion notice.
    get().clearCompletedNotice(sessionId)
    // 立即选中：同步锚定目标会话——列表行马上高亮"当前"、视图即刻切到
    // 新会话的加载态，不等 loadSession 的 HTTP 往返（旧实现要等返回才
    // 锚定，点击后行高亮有明显延迟）。加载失败时停留在该选中态并显示
    // 失败（下方 catch 收口为 historyLoadError，scrollback 中央转"加载
    // 失败"）。
    set({
      historyOpen: false,
      historyLoading: true,
      sessionId,
      cwd,
      historyLoadError: undefined,
      entries: [],
      pending: [],
      xaiRequests: [],
    })
    // load 响应 models 的应用 + effort 兜底（立即应用与宽限窗口重放共用）：
    // agent 的 session/load 会把会话持久化的模型 id 映射到当前 catalog 键
    // （如 deepseek-v4-flash → deepseek-v4-flash-go），响应 models 通常不带
    // reasoningEffort —— applySessionModelState 会回落到新模型的默认档（如
    // low），静默覆盖用户原选的 max。wire 缺 effort 时从 workspace 列表
    // （agent summary 的 reasoning_effort，持久化的是用户真实选择）恢复。
    const applyLoadedModels = (models: unknown) => {
      const raw = models as Record<string, unknown> | undefined
      const hasWireEffort =
        (raw?.reasoningEffort != null &&
          typeof raw.reasoningEffort === 'string' &&
          raw.reasoningEffort.trim() !== '') ||
        (raw?.reasoning_effort != null &&
          typeof raw.reasoning_effort === 'string' &&
          raw.reasoning_effort.trim() !== '')
      const snap = applySessionModelState(models, undefined)
      if (!hasWireEffort) {
        const row = get()
          .workspaces.flatMap((g) => g.sessions)
          .find((x) => x.sessionId === sessionId)
        if (row?.reasoningEffort && row.reasoningEffort.trim()) {
          snap.reasoningEffort = row.reasoningEffort.trim()
        }
      }
      return snap
    }
    try {
      // 1) Make this session the active one (session/load or focus-if-busy);
      // 2) load its tail. Models come from the HTTP response — more reliable
      // than waiting for the SSE ready event, which can race historyLoading.
      // Permission mode is NOT seeded here: the yolo_mode_changed channel is
      // client-scoped (a toggle applies to EVERY resident session of this
      // client), so loading a session must leave the agent's global mode
      // untouched — sending a per-session seed would rewrite the global
      // state on every switch. Display follows the agent (global copy).
      const loaded = await transport.loadSession(sessionId, cwd)
      // The user may have switched host / opened another session while we
      // were loading — never write this session's data into that view.
      if (myGen !== sessionSwitchGen) return
      if (loaded.models != null || loaded.modes != null) {
        const modelSnap = applyLoadedModels(loaded.models)
        set({
          ...modelSnap,
          ...(loaded.modes != null ? { modes: loaded.modes } : {}),
          // Same extraction as hello/ready: the load response's `modes`
          // (SessionModeState, currentModeId + availableModes) restores
          // the plan/permission flags — without it a plan-mode session
          // resumes showing Normal until the next mode change.
          ...(loaded.modes != null ? (sessionModesPatch(get, loaded.modes) ?? {}) : {}),
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
      if (myGen !== sessionSwitchGen) return
      // 权限模式是进程级全局状态（跟随 agent 广播），store 中即最新值，
      // 无需按会话恢复；plan 按会话从副本补充（权威是 replay 的
      // current_mode_update）。
      set({ ...restorePlanMode(sessionId) })
      get().startTopTaskPolling(sessionId, cwd)
      // Rehydrate pending permission / ask_user_question cards for THIS
      // session. Live client_request SSE while another session was active
      // was filtered out at init — without this pull, the agent stays
      // blocked with an empty UI until the host's 15min approval timeout.
      void syncPendingForSession(sessionId, get, set, myGen)
      // Grace window: session/load recap events stream over SSE and may still
      // be in flight (SSE and fetch are separate channels) — keep dropping
      // them briefly before reopening the live pipeline.
      set({ historyLoading: true })
      continueSessionTimer = window.setTimeout(() => {
        continueSessionTimer = null
        // Another switch happened inside the grace window: do NOT re-anchor
        // this (now stale) session's snapshot.
        if (myGen !== sessionSwitchGen) return
        // Re-apply the load response's SessionModelState — a stale hello
        // (EventSource reconnect) or the load's own ready may have raced
        // in with process-global models while historyLoading; the HTTP
        // response is the authority for the restored session.
        if (loaded.models != null) {
          const modelSnap = applyLoadedModels(loaded.models)
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
          // Preserve the REAL turn start that loadHistory just restored
          // from the envelope meta (in-flight turn) — the ?? only anchors
          // at now when the replay had nothing to restore, matching the
          // hello/busy handlers; an unconditional Date.now() here would
          // restart the composer's total-turn timer from zero.
          const hasLocalStreaming =
            get().openThoughtId != null || get().openAssistantId != null
          set({
            historyLoading: false,
            conn: 'busy',
            statusText: hasLocalStreaming ? get().statusText : 'Waiting for host…',
            awaitingNext: false,
            sessionId,
            turnStartedAt: get().turnStartedAt ?? Date.now(),
          })
        } else {
          // Idle resume: queued rows are agent-owned (the agent drains
          // them itself at turn end) or FE-owned degraded rows that send
          // manually (双 Enter / [发送现在]) — no auto-send on resume.
          // The queue count is shown in the status line as a hint only.
          const queued = usePromptQueue.getState().queue.length
          set({
            historyLoading: false,
            statusText: queued > 0
              ? `已切换到会话 ${sessionId.slice(0, 8)}，${queued} 条排队消息（双 Enter 发送）`
              : `已切换到会话 ${sessionId.slice(0, 8)}，可继续对话`,
            sessionId,
            awaitingNext: false,
          })
        }
        // TUI rebuilds the tasks pane from the live registry after load —
        // history page + the historyLoading SSE drop can miss a still-
        // running task. Align bg_task rows with x.ai/task/list.
        void get().syncLiveTasks()
      }, 500)
    } catch (e) {
      if (myGen !== sessionSwitchGen) return
      const msg = e instanceof Error ? e.message : String(e)
      // 加载失败：从加载态收口为失败态——scrollback 中央加载提示转为
      // "加载失败 + 原因"（historyLoadError，见 Scrollback 覆盖层），
      // 列表保持已选中的行（sessionId 已在入口同步锚定，再点一次即重试）。
      // 复位回合状态：旧会话的忙态/turnStartedAt 绝不能留在已选中的
      // 会话上（turnIsLive 误判 → 第一条消息错误排队）。
      set({
        historyLoading: false,
        historyLoadingMore: false,
        conn: 'ready',
        statusText: '加载失败',
        historyLoadError: msg,
        entries: [],
        turnStartedAt: undefined,
        currentPromptId: undefined,
        genRate: undefined,
        awaitingNext: false,
        openAssistantId: undefined,
        openThoughtId: undefined,
        liveStream: null,
      })
    }
  },

  loadMoreHistory: async (anchorId?: string, chainedPages?: number) => {
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
    // 续翻归属校验：链式翻页期间会话被切走（newSession 清 historySessionId）
    // 即停，绝不把旧会话的页继续灌进新会话。
    const sid = s.historySessionId
    const chained = chainedPages ?? 0
    // 已加载区最老行（绝对下标）。缺失时用 total-loaded 兜底（旧状态）。
    const loadedStart =
      s.historyLoadedStart ??
      (typeof s.historyTotalCount === 'number' && s.historyTotalCount > 0
        ? Math.max(0, s.historyTotalCount - s.historyLoadedCount)
        : 0)
    if (loadedStart <= 0) {
      set({ historyHasMore: false })
      return
    }
    // 按轮次：一次拉「最老已加载轮次的前一轮」[promptStarts[k-1], promptStarts[k])，
    // 用**绝对** offset（不是 start-total 负 offset）——live 追加抬高 total
    // 时负 offset 会整窗前移，与已加载区重叠。窗口 end 钳到 loadedStart，
    // 杜绝任何与已加载区的交叉。
    const win = previousTurnWindow(
      s.historyPromptStarts,
      s.historyTurnIdx,
      loadedStart,
    )
    // 页大小自适应（adaptivePageSize）：按条数兜底分页目标固定为「加载
    // 到上一条 user 消息为止」——新页含 user 即停（下方续翻条件）；中间
    // 隔的长工具流段由翻倍页大小一次覆盖更多，而不是固定 100 条一页地
    // 多次续翻。
    const pageSize = win ? win.limit : adaptivePageSize(chained)
    // 绝对 offset 窗口，与已加载区 [loadedStart, ∞) 严格相接、不重叠。
    let reqOffset: number
    let reqLimit: number
    if (win) {
      reqOffset = win.offset
      reqLimit = win.limit
    } else {
      if (loadedStart <= pageSize) {
        reqOffset = 0
        reqLimit = loadedStart
      } else {
        reqOffset = loadedStart - pageSize
        reqLimit = pageSize
      }
    }
    if (reqLimit <= 0) {
      set({ historyHasMore: false })
      return
    }
    set({ historyLoadingMore: true, historyAnchorId: anchorId, historyLoadError: undefined })
    try {
      const r = await transport.loadSessionHistory(s.historySessionId, s.historyCwd, {
        offset: reqOffset,
        limit: reqLimit,
      })
      // 会话在 await 期间被切走：丢弃本页，不灌 entries。
      if (get().historySessionId !== sid) {
        set({ historyLoadingMore: false })
        return
      }
      const fetched = r.updates?.length ?? 0
      // 真·live 回合：本端发送中 / 已知 promptId / loadHistory 对仍 open
      // 回合恢复的 turnStartedAt。turnOpen 已收紧（completed 后 stray
      // thought 不再误开），故 turnStartedAt 可信——不得 settle 掉在流条目。
      // 在途 live 在回放前采样：回放会改 open*/conn，不能回放后再判。
      const liveLocal =
        get().pendingOptimisticUserId != null ||
        get().currentPromptId != null ||
        get().turnStartedAt != null
      // 回放前先把已加载区的 liveStream flush + 空 thought 收口，避免
      // 回放首条 user 触发 sealThought 删空壳时改写「已加载」集合。
      // （prepend 已改 id 集合差，删壳不再错位；这里仍清掉脏 open*，
      // 让回放在干净指针上起步。）
      if (!liveLocal) {
        const pre = sealThought(flushLiveStream(get()))
        set({
          entries: settleTurnEntries(pre.entries),
          openAssistantId: undefined,
          openThoughtId: undefined,
          liveStream: null,
          conn: 'ready',
        })
      }
      // Replay appends; split by entry id set（不是 length）。
      // length split 在回放过程中若删掉已加载区空 thought，新 user 会
      // 落进 old 段，merge 后甩到时间线末尾。
      // Older pages never update the context chip (applyUsage: false) —
      // only the newest page (loadHistory) carries the session's current usage.
      const priorIds = new Set(get().entries.map((e) => e.id))
      replayUpdates(get, r.updates ?? [], { applyUsage: false })
      const after = get()
      let oldEntries = after.entries.filter((e) => priorIds.has(e.id))
      let newEntries = after.entries
        .filter((e) => !priorIds.has(e.id))
        .map((e, i, arr) =>
          i === arr.length - 1 && e.kind === 'assistant'
            ? { ...e, streaming: false }
            : e,
        )
      // Page boundaries can cut an assistant message in half; stitch the
      // continuation (first old entry) onto the new page's last entry.
      const lastNew = newEntries[newEntries.length - 1]
      const firstOld = oldEntries[0]
      if (lastNew?.kind === 'assistant' && firstOld?.kind === 'assistant') {
        newEntries[newEntries.length - 1] = { ...lastNew, text: lastNew.text + firstOld.text }
        oldEntries = oldEntries.slice(1)
      }
      // 刷新 total / promptStarts（agent 每次都回；live 追加后 total 变大，
      // 旧负 offset 会漂——我们已改绝对 offset，这里只同步元数据）。
      const rawTotal = r.totalCount ?? s.historyTotalCount
      const total = rawTotal ?? loadedStart + fetched
      const newLoadedStart = fetched === 0 ? loadedStart : reqOffset
      const loadedNew =
        typeof total === 'number' && total > 0
          ? Math.max(0, total - newLoadedStart)
          : s.historyLoadedCount + fetched
      // 同步 promptStarts；win 路径游标 -1，offset 路径按边界行号 remap。
      const promptStarts =
        r.promptStarts && r.promptStarts.length > 0
          ? r.promptStarts
          : s.historyPromptStarts
      // win 路径：游标减 1。offset 兜底（超长回合）保持原 turnIdx——
      // 绝不能用 loadedStart 反查提前跳到更早轮，否则会跳过长回合未加载前缀。
      // promptStarts 因 live 新回合 append 变长时，旧下标仍指向同一 start 行。
      const nextTurnIdx = win
        ? Math.max(0, s.historyTurnIdx - 1)
        : remapTurnIdx(s.historyPromptStarts, s.historyTurnIdx, promptStarts)
      // Same settled-transcript rule as loadHistory: a tool that is still
      // running here never received its completion in any loaded page
      // (its update was dropped for an unknown id when the newer page
      // replayed first) — close it out instead of leaving "Running …"
      // stuck on a historical page boundary. Skipped only for true local
      // live turns (see liveLocal above).
      const merged = [...newEntries, ...oldEntries]
      // 回放后 openAssistantId/liveStream 常被「本页半截 assistant」填上，
      // 不代表真 live。历史分页一律 settle + conn ready；本端发送中则
      // 整段跳过，避免打掉正在流的条目 / 未合并的 liveStream。
      const streaming =
        liveLocal ||
        get().pendingOptimisticUserId != null ||
        get().currentPromptId != null
      // hasMore：还有更早行（绝对游标 > 0）且本页非空。空页停翻，避免
      // 宿主异常时死循环。按轮次时 nextTurnIdx/promptStarts 只影响下一
      // 次 previousTurnWindow；是否可翻只看游标（含首轮前 preamble）。
      const hasMore = fetched > 0 && newLoadedStart > 0
      // 历史页回放可能把 conn/statusText 打成 busy/Responding…——非 live
      // 时强制收口（先 flush 再 settle，避免清空 liveStream 丢正文）。
      if (streaming) {
        set({
          entries: merged,
          historyLoadingMore: false,
          historyTotalCount: total,
          historyLoadedCount: loadedNew,
          historyLoadedStart: newLoadedStart,
          historyHasMore: hasMore,
          historyPromptStarts: promptStarts,
          historyTurnIdx: nextTurnIdx,
          historyLoadError: undefined,
          historyPrependedAt: Date.now(),
        })
      } else {
        const sealedMerged = sealThought(
          flushLiveStream({ ...get(), entries: merged }),
        )
        set({
          entries: settleTurnEntries(sealedMerged.entries),
          openAssistantId: undefined,
          openThoughtId: undefined,
          liveStream: null,
          // Replay of stored thought chunks drives conn to 'busy' — paging
          // history is not a live turn.
          conn: 'ready',
          historyLoadingMore: false,
          historyTotalCount: total,
          historyLoadedCount: loadedNew,
          historyLoadedStart: newLoadedStart,
          historyHasMore: hasMore,
          historyPromptStarts: promptStarts,
          historyTurnIdx: nextTurnIdx,
          historyLoadError: undefined,
          historyPrependedAt: Date.now(),
        })
      }
      // 自动续翻（仅按条数兜底路径；页大小随 chained 翻倍）：本页无
      // user（纯工具流段）就继续向后翻——分页目标固定为「加载到上一条
      // user 消息为止」。按轮次路径每页必含 user，无需续翻。或翻尽
      // （hasMore=false / 空页）/ 出错 / 达到 MAX_AUTO_FETCH_ENTRIES 累计
      // 条数上限。视口锚点由组件按 historyAnchorId 保持（每页 prepend 后
      // 把同一锚点滚回视口顶），续翻不打断阅读位置——「向上滚动加载更早
      // 历史」一次手势就能穿过整段工具流，落到真正的对话上；翻页间隙的
      // sticky 保证由 Scrollback 的回退钉选兜底（窗口上方最近一条 user）。
      if (
        !win &&
        countUserMessages(newEntries) === 0 &&
        hasMore &&
        loadedNew < MAX_AUTO_FETCH_ENTRIES &&
        get().historySessionId === sid
      ) {
        void get().loadMoreHistory(anchorId, chained + 1)
      }
    } catch (e) {
      // 失败必须就地可见：静默吞掉会让「点击加载」看起来无效（按钮闪
      // 一下恢复、什么也没发生）。错误显示在加载按钮上，下次点击/上滑
      // 自动重试。
      set({
        historyLoadingMore: false,
        historyLoadError: `加载更早历史失败：${
          e instanceof Error ? e.message : String(e)
        }`,
      })
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
    // 流式合并缓冲：非流式事件（收口/状态/…）处理前强制 flush，保证
    // tool_call/chunk/回合终态之前的思考文本已落库；同类流式事件
    // （thought,thought,… / chunk,chunk,…）之间不 flush——由 rAF 合并。
    if (ev.type === 'thought' ? streamBufKind === 'assistant' : streamBufText !== '') {
      flushStreamBuf(set, get)
    }
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
        // Stale/foreign hello：快照宣告的会话不是当前视图锚定的会话
        // （continueSession 在途时上一会话的迟到快照，或别的客户端把
        // host 的 active 会话切走了）。只应用连接级状态（conn/错误/
        // host 信息），绝不重新锚定视图、绝不应用其会话级快照
        // （models/modes/pending 都是会话级的——套用会把当前会话的
        // 模型/审批卡覆盖成别的会话的）。`ready` 事件有同款守卫；
        // hello 是唯一无条件重新锚定的入口。
        const foreign =
          get().sessionId != null &&
          ev.sessionId != null &&
          ev.sessionId !== get().sessionId
        if (foreign) {
          set({
            conn: ev.ready ? 'ready' : ev.error ? 'error' : 'connecting',
            statusText: ev.error || (ev.ready ? '就绪' : '启动中…'),
            homeDir: ev.homeDir,
            hostId: ev.hostId,
            hostName: ev.hostName,
            error: ev.error,
            statusWarning: undefined,
          })
          break
        }
        const modelSnap = applySessionModelState(ev.models, ev.agentInfo)
        const reqs = ev.pendingRequests || []
        // 迟到的旧会话 hello：resetSessionState 清锚之后、newSession 响应
        // 回填之前（newSessionInFlight = 建会话 POST 在飞；或空状态发消息
        // 路径已过 newSession、pendingOptimisticUserId 非空），旧会话的
        // hello 若照常回锚 sessionId/cwd，会把旧会话重新钉进视图并触发
        // 下方 loadHistory 把旧历史灌入新会话的空白时间线；其 busy 快照
        // 还会把 conn/turnStartedAt 打成忙——新会话第一条消息因此被
        // turnIsLive 误判而错误排队（hub 双连接 SSE 重连 / WS 缺口回放
        // 是主要触发源）。此窗口内 hello 只贡献 models/模式快照，不碰
        // 会话锚、不套 busy、不触发 loadHistory（switchHost 的 hello 不受
        // 影响——彼时两个条件均不成立，照常锚定宿主当前会话）。
        const suppressAnchor =
          get().sessionId == null &&
          ev.sessionId != null &&
          (get().pendingOptimisticUserId != null || newSessionInFlight)
        // Pending is host-global (all sessions' clientReqs). Scope to the
        // session this hello is announcing so another conversation's
        // permission / question never paints on the active view. Untagged
        // rows (old host) are attributed to the announced active session.
        const pendingSnap = suppressAnchor
          ? { pending: [] as PendingReq[], xaiRequests: [] as PendingReq[] }
          : partitionPendingRequests(reqs, ev.sessionId, {
              includeUntagged: true,
            })
        set({
          conn: ev.ready ? 'ready' : ev.error ? 'error' : 'connecting',
          statusText: ev.error || (ev.ready ? '就绪' : '启动中…'),
          ...(suppressAnchor
            ? {}
            : { sessionId: ev.sessionId, cwd: ev.cwd }),
          homeDir: ev.homeDir,
          hostId: ev.hostId,
          hostName: ev.hostName,
          pending: pendingSnap.pending,
          xaiRequests: pendingSnap.xaiRequests,
          modes: ev.modes,
          error: ev.error,
          statusWarning: undefined,
          ...modelSnap,
          // 权限模式是进程级全局状态：恢复全局记录（页面刷新后徽标不丢），
          // 权威是 host 在 hello 里携带的 agent 真实模式快照
          // （permissionMode，host 记录每次变更并随 agent 重启复位）——
          // 快照置于记录之后，无条件覆盖；extractModeFlags 对 modes 载荷
          // 里确实携带的字段依然生效。plan 按会话补充。
          ...restoreModeFlags(),
          ...restorePlanMode(ev.sessionId),
          ...permissionModeFromSnapshot(ev.permissionMode),
          ...(sessionModesPatch(get, ev.modes) ?? {}),
        })
        // 抑制窗口内的 busy 快照：旧会话的忙态绝不能灌进刚创建的新会话
        // （turnIsLive 误判 → 第一条消息错误排队）。窗口外照常应用
        // （reconnect mid-turn 保留本端流式状态等语义不变）。
        if (ev.busy && !suppressAnchor) {
          // 已锚定视图的 hello busy 走与 busy 事件相同的 plausibility 门
          // （busyPlausibleForView）：断线重连时 host 宣告的 busy 可能属于
          // 别的会话（sessionIdFrom active 回退错标）——已完成/空闲的当前
          // 会话不能因此亮起别的会话的 turn status。空状态（无会话锚）的
          // hello 是唯一信息源，照常套用。
          const helloNow = get()
          const plausibleBusy =
            helloNow.sessionId == null || busyPlausibleForView(helloNow)
          if (plausibleBusy) {
            // Preserve an existing turn timer across mid-turn re-busy/reconnect;
            // otherwise anchor it now (same rule as the `busy` event handler).
            const busyTurn = get().turnStartedAt ?? Date.now()
            const newTurn = get().turnStartedAt == null
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
              // 新回合由 busy 锚定（非本端发送/收养）——回合身份未知，
              // pid 置空走 legacy 匹配；reconnect mid-turn（newTurn=false）
              // 保留原 pid。
              ...(newTurn ? { genRate: undefined, currentPromptId: undefined } : {}),
              error: undefined,
              statusWarning: undefined,
            })
          }
        }
        // Agent hello announces the active session — fetch git state now
        // (git_head_changed is fire-and-forget; a fresh page would miss it).
        if (ev.cwd && !suppressAnchor) {
          set({ sessionId: ev.sessionId, cwd: ev.cwd })
          // The user is looking at this session now — clear its notice.
          if (ev.sessionId) get().clearCompletedNotice(ev.sessionId)
          void get().refreshGitInfo()
        }
        // Fresh page / refresh landing on an already-active session: the
        // hello snapshot carries sessionId/cwd but NOT the message history
        // (the host never replays it on connect), so replay it here. Guard
        // on empty entries so a mid-session reconnect (timeline already
        // live) never reloads, and skip while history is being loaded.
        if (
          !suppressAnchor &&
          ev.sessionId &&
          get().entries.length === 0 &&
          !get().historyLoading
        ) {
          void get().loadHistory(ev.sessionId, ev.cwd || '')
        }
        // Agent restart (host respawned the agent → in-memory permission
        // mode reset to ask): clear the browser's global copy once per
        // instance so the UI follows the agent instead of stale flags.
        if (typeof ev.agentStartedAt === 'number' && ev.agentStartedAt > 0) {
          clearModeFlagsOnAgentRestart(set, ev.agentStartedAt)
        }
        break
      }
      case 'ready': {
        // 多会话广播（host withSid 约定）：非当前会话的 ready 直接忽略。
        // 别的客户端新建/加载会话会广播 ready(sessionId)，若无守卫会把
        // 本页强制切到那个会话（conn/sessionId 无条件覆盖），当前会话的
        // 回合流事件随之全部被丢弃——视觉上就是"对话被 cancel 了"。
        // 本端主动的 newSession / continueSession 都会先锚定 sessionId
        // （POST /api/session 响应 / loadSession 返回），ready 到达时守卫
        // 通过，幂等覆盖 models 等字段，不受影响。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // 缺 sid 的 ready 在已锚定视图上不能照单全收：ready 会把
        // sessionId/cwd 无条件写成事件字段（缺省 = undefined）——错标/
        // 缺省事件会清空视图锚，之后所有带 sid 的事件都被路由丢弃
        // （视图冻结），还顺带误清 turnStartedAt。老单会话 host 从不
        // 建立锚（hello 也无 sid），不受影响；多会话 host 的 ready 恒带
        // sid。此分支只应用连接级/空闲状态，绝不覆盖锚、不套 models/
        // modes（无法归属，宁可保持现状）。
        if (!ev.sessionId && get().sessionId != null) {
          const s = get()
          set({
            conn: 'ready',
            statusText: s.awaitingNext ? '待处理' : '就绪',
            hostId: ev.hostId,
            hostName: ev.hostName,
            error: undefined,
            statusWarning: undefined,
            ...(s.openThoughtId == null &&
            s.openAssistantId == null &&
            s.pendingOptimisticUserId == null
              ? { turnStartedAt: undefined, currentPromptId: undefined }
              : {}),
          })
          void get().refreshHosts()
          void get().refreshGitInfo()
          break
        }
        // Prefer `ev.models` (session/new|load SessionModelState) — agentInfo
        // alone is the process-global initialize snapshot and is stale after
        // session/load restores a different session model.
        const s = get()
        const modelSnap = applySessionModelState(ev.models, ev.agentInfo)
        set({
          conn: 'ready',
          // Keep "待处理" if a turn just finished; otherwise plain idle.
          statusText: s.awaitingNext ? '待处理' : '就绪',
          sessionId: ev.sessionId,
          cwd: ev.cwd,
          hostId: ev.hostId,
          hostName: ev.hostName,
          modes: ev.modes,
          error: undefined,
          statusWarning: undefined,
          ...modelSnap,
          // 与 hello 相同的恢复：权限模式全局（刷新后徽标不丢，权威是
          // yolo_mode_changed 广播）；plan 按会话补充。
          ...restoreModeFlags(),
          ...restorePlanMode(ev.sessionId),
          ...(sessionModesPatch(get, ev.modes) ?? {}),
          // ready 宣告会话空闲：清掉残留的 turnStartedAt（窗口期旧 hello /
          // 旧 loadHistory 灌入的脏计时），否则 turnIsLive() 会把空闲会话
          // 误判成忙、新会话第一条消息被错误排队。本端确有在途回合
          // （流式指针 / 乐观用户行）时保留，多 tab 同会话加载不打断计时。
          ...(s.openThoughtId == null &&
          s.openAssistantId == null &&
          s.pendingOptimisticUserId == null
            ? { turnStartedAt: undefined, currentPromptId: undefined }
            : {}),
        })
        void get().refreshHosts()
        void get().refreshGitInfo()
        break
      }
      case 'busy': {
        // 多会话广播（host withSid 约定）：非当前会话的 busy 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // 多会话宿主防线（turn-status 跨会话污染）：busy 事件的 sessionId
        // 由 host 的 sessionIdFrom 派生——多会话切换时会回退到 active 会话
        // 错标（见模块头注释），或干脆缺省。带当前 sid / 不带 sid 的 busy
        // 都可能是别的进行中会话的忙态：切到已完成的会话后若照单全收，
        // 会把那个会话的 turn status（spinner + "Waiting for response…" +
        // 相位计时器）显示在本会话上，直到它的 done 到达才被收口。只有
        // 当前视图确实在跑回合时才接受（busyPlausibleForView）——真回合
        // 的首个 chunk/thought/tool_call（envelope 归属，可信）会自行把
        // conn 顶回 busy，忽略只损失首 token 前的等待提示。
        if (!busyPlausibleForView(get())) break
        // TUI: the Thinking… block is pre-created at stream_start (first
        // chunk), NOT on the busy flag — so a fresh busy is the
        // wait-for-first-token window ("Waiting for response…"). A busy
        // while THIS frontend is already streaming (reconnect mid-turn)
        // keeps the live status text.
        const s = get()
        // Anchor the "Worked for Xs" timer; don't reset on mid-turn re-busy.
        const turnStartedAt = s.turnStartedAt ?? Date.now()
        // 新回合开始（上一回合已收口 → turnStartedAt 为空）时，上一回合的
        // 生成段速率失效；mid-turn re-busy（tool 调用等）保留。
        const newTurn = s.turnStartedAt == null
        const hasLocalStreaming =
          s.openThoughtId != null || s.openAssistantId != null
        set({
          conn: 'busy',
          statusText: hasLocalStreaming ? s.statusText : 'Waiting for response…',
          awaitingNext: false,
          turnStartedAt,
          // 新回合由 busy 锚定（非本端发送/收养）——回合身份未知，pid
          // 置空走 legacy 匹配；mid-turn re-busy 保留原 pid。
          ...(newTurn ? { genRate: undefined, currentPromptId: undefined } : {}),
          // A turn starting means the system recovered — clear stale
          // error/status banners.
          error: undefined,
          statusWarning: undefined,
        })
        break
      }
      case 'user_message':
      case 'user_chunk': {
        // 多会话广播（host withSid 约定）：非当前会话的回合流事件忽略
        // （后台回合的 echo 不能进当前 transcript；replay 无 sessionId，
        // 照常通过）。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // 权威回合开始修正（队列收养回合的本地锚定误差，见
        // adoptLiveTurnStart）。
        adoptLiveTurnStart(set, get, ev)
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
        // Close the assistant stream: merge liveStream text into the
        // entry BEFORE the streaming:false seal, then seal any thought.
        const flushed = flushLiveStream(get())
        const sealed = sealThought(flushed)
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
            // agent 盖章的发送时刻（params._meta.agentTimestampMs，host
            // 透传）：收养场景用户行 ts 是本地收养时刻（可能晚几分钟），
            // 修正为真实发送时刻，与回放路径的 envelope 时间戳对齐。
            const anyEv = ev as { agentTimestampMs?: unknown }
            const agentTs =
              typeof anyEv.agentTimestampMs === 'number' &&
              Number.isFinite(anyEv.agentTimestampMs) &&
              anyEv.agentTimestampMs > 0
                ? anyEv.agentTimestampMs
                : undefined
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
                      ...(agentTs != null ? { ts: agentTs } : {}),
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
        // 多会话广播（host withSid 约定）：非当前会话忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
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
        // 多会话广播（host withSid 约定）：非当前会话忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // 权威回合开始修正（队列收养回合的本地锚定误差，见
        // adoptLiveTurnStart）。
        adoptLiveTurnStart(set, get, ev)
        const text = ev.text || ''
        const ts = ev.ts ?? Date.now()
        // seal open thought when assistant starts speaking
        const sealed = sealThought(get())
        const { openAssistantId, entries } = sealed
        if (openAssistantId) {
          // 已有回答条目：文本只进合并缓冲（rAF 统一落库，见
          // appendStreamBuf）。状态字段（conn/statusText/awaitingNext）
          // 由 flushStreamBuf 落库时每帧至多刷新一次——每个 chunk 都
          // set()（~30ms 一次）会让全部 zustand 订阅者跟着空转，正是
          // rAF 缓冲要消灭的通知风暴。首个 chunk 的 sealed 状态与条目
          // 创建在下方 else 分支（openAssistantId 从无到有）一次性落库；
          // 若流式指针已存在（openThoughtId 同开属异常交错），sealThought
          // 的结果也在该分支的 set 里生效，此处无状态可丢。
          appendStreamBuf(set, get, 'assistant', text)
        } else {
          const id = nid()
          set({
            ...sealed,
            conn: 'busy',
            statusText: 'Responding…',
            awaitingNext: false,
            openAssistantId: id,
            openThoughtId: undefined,
            entries: [
              ...entries,
              { id, kind: 'assistant', text: '', streaming: true, ts },
            ],
            liveStream: { entryId: id, text },
          })
        }
        break
      }
      case 'thought': {
        // 多会话广播（host withSid 约定）：非当前会话忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // 权威回合开始修正（队列收养回合的本地锚定误差，见
        // adoptLiveTurnStart）。
        adoptLiveTurnStart(set, get, ev)
        const text = ev.text || ''
        if (!text) break
        const s = get()
        let openThoughtId = s.openThoughtId
        let entries = s.entries
        // Stream switch (assistant → thought, or a stale live stream):
        // seal the previous stream into ITS entry before the new one
        // starts, so no text is lost when the pointer moves. After the
        // map, liveStream must not keep pointing at the old entry — the
        // first-chunk path reassigns it; the continue path clears it.
        const prevLs = s.liveStream
        let sealedForeignLive = false
        if (prevLs && prevLs.entryId !== openThoughtId) {
          entries = entries.map((e) => {
            if (e.id !== prevLs.entryId || !('text' in e)) return e
            const nextText = e.text + prevLs.text
            if (e.kind === 'assistant') {
              // Mid-turn seal of the interrupted assistant stream.
              return {
                ...e,
                text: nextText,
                streaming: false,
                ...(prevLs.elapsedMs != null
                  ? { elapsedMs: prevLs.elapsedMs }
                  : {}),
              }
            }
            return {
              ...e,
              text: nextText,
              ...(prevLs.elapsedMs != null
                ? { elapsedMs: prevLs.elapsedMs }
                : {}),
            }
          })
          sealedForeignLive = true
        }

        // If placeholder missing (reconnect mid-turn / first thought
        // chunk), create one. Invariant: entry.text stays empty during
        // streaming; ALL in-flight text lives in liveStream (same as
        // assistant first chunk). UI merges with mergeLiveText(e.text, live).
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
          set({
            conn: 'busy',
            statusText: 'Thinking…',
            awaitingNext: false,
            openThoughtId,
            openAssistantId: undefined,
            entries,
            // Seed liveStream with the first chunk (do NOT put first
            // chunk only into entry.text — later deltas append to
            // liveStream; seal does entry.text += liveStream.text).
            liveStream: {
              entryId: id,
              text,
              ...(ev.elapsedMs != null ? { elapsedMs: ev.elapsedMs } : {}),
            },
          })
          assertStreamInvariants(get(), 'thought:first')
          break
        }
        // 已有进行中的思考块：文本进合并缓冲，rAF 统一落库（每帧至多一次
        // set()——移动端思考流渲染卡顿的主因）。
        if (sealedForeignLive) {
          // Apply the sealed foreign stream + drop the stale liveStream
          // pointer so UI does not double-render (entry already has text).
          set({
            entries,
            openAssistantId: undefined,
            liveStream: null,
          })
        }
        appendStreamBuf(set, get, 'thought', text, ev.elapsedMs)
        break
      }
      case 'tool_call': {
        // 多会话广播（host withSid 约定）：非当前会话忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // Seal assistant stream (liveStream → entry + streaming:false) so
        // the streaming flag drops immediately; then seal
        // any open thought. Do not leave assistant streaming:true until
        // turn-end settleTurnEntries.
        const sealedAsst = sealAssistantStream(get())
        const sealed = sealThought(sealedAsst)
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

        // TUI [ui] collapsed_edit_blocks=true: edits render as one-line
        // +N/-M diffstats (collapsed) and back-to-back same-file edits
        // merge into one row (default false = diffs expanded, no merge).
        if (kindName === 'edit' && collapsedEditBlocks()) {
          const prev = sealed.entries[sealed.entries.length - 1]
          if (
            prev &&
            prev.kind === 'tool' &&
            prev.kindName === 'edit' &&
            prev.title === title
          ) {
            const toolIndex = { ...get().toolIndex }
            // Route the new call's updates into the merged row.
            if (toolCallId) toolIndex[toolCallId] = prev.id
            set({
              ...sealed,
              conn: 'busy',
              awaitingNext: false,
              openAssistantId: undefined,
              openThoughtId: undefined,
              toolIndex,
              entries: [
                ...sealed.entries.slice(0, -1),
                {
                  ...prev,
                  mergedRaws: [...(prev.mergedRaws ?? []), tc],
                  status,
                  verb: toolVerb(kindName, running),
                },
              ],
            })
            break
          }
        }

        const entry: ScrollEntry = {
          id,
          kind: 'tool',
          toolCallId,
          title,
          verb: toolVerb(kindName, running),
          status,
          kindName,
          detail: tc.title as string | undefined,
          // collapsed_edit_blocks=false (default): edit diffs expanded.
          expanded: kindName === 'edit' && !collapsedEditBlocks(),
          raw: tc,
          // Activity start for the turn status line's phase timer (TUI
          // tracker started_at); replay/completed snapshots omit it.
          ...(running ? { startedAt: Date.now() } : {}),
        }
        const toolIndex = { ...get().toolIndex }
        if (toolCallId) toolIndex[toolCallId] = id
        set({
          ...sealed,
          // 回合确实在跑（envelope 归属的 tool_call 可信）：busy 事件可能
          // 被 host 错标/缺省而没点亮状态行——工具先行回合（无 thought/
          // chunk 前置）在这里补上 busy，turn-status 行才能显示工具活动。
          // 回放路径同样适用（回放 chunk 本就驱动 conn busy，load 页末
          // 统一复位 ready）。
          conn: 'busy',
          awaitingNext: false,
          openAssistantId: undefined,
          openThoughtId: undefined,
          toolIndex,
          entries: [...sealed.entries, entry],
        })
        break
      }
      case 'tool_call_update': {
        // 多会话广播（host withSid 约定）：非当前会话忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
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
            // TUI collapsed_edit_blocks merged row: an update for a
            // merged sub-call patches that slot — raw stays the row's own
            // first call, mergedRaws keep the others (display order).
            const mergedIdx =
              e.mergedRaws?.findIndex((m) => toolCallIdOf(m) === toolCallId) ??
              -1
            if (mergedIdx >= 0) {
              const mergedRaws = [...(e.mergedRaws ?? [])]
              mergedRaws[mergedIdx] = { ...mergedRaws[mergedIdx], ...tc }
              const status = (tc.status as string) || e.status
              const kindName = (tc.kind as string) || e.kindName || 'other'
              const running = status === 'pending' || status === 'in_progress'
              const finishedAt =
                wasRunningBefore && !running ? Date.now() : e.finishedAt
              return {
                ...e,
                status,
                kindName,
                verb: toolVerb(kindName, running),
                mergedRaws,
                finishedAt,
              }
            }
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
        // 多会话广播（host withSid 约定）：非当前会话忽略（后台回合的
        // plan 不能覆盖当前会话的 todo 面板）。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // Plan updates are the todo source (TUI todo pane + status-bar
        // badge). Matches the TUI: plan entries never land in the
        // scrollback — the TopBar TodoChip is the single display surface.
        const { items, counts } = planTodos(ev.entries)
        const planFlag = (ev as unknown as { planMode?: unknown }).planMode
        // Plan can arrive mid-stream: seal assistant (merge live text +
        // streaming:false) before the openAssistantId pointer drops.
        const sealedAsst = sealAssistantStream(get())
        set({
          ...sealedAsst,
          todoCounts: counts,
          todos: items,
          // Some hosts piggyback the plan-mode flag on the plan event —
          // apply it when present, otherwise keep the local value.
          ...(typeof planFlag === 'boolean' ? { planMode: planFlag } : {}),
        })
        break
      }
      case 'gen_rate': {
        // 多会话广播（host withSid 约定）：非当前会话的 gen_rate 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // 同 busy 防线：gen_rate 由 host 合成，sid 可能错标或缺省（见
        // 模块头 sessionIdFrom 注释）——别的会话的生成速率不能显示在
        // 本会话的状态行上。只有当前视图确实在跑回合才接受；回放不
        // 派发 gen_rate，无需豁免。
        if (!busyPlausibleForView(get())) break
        // 生成输出速率（估算 tok/s）由 host 推送：流式期间 ≥250ms 一条
        // live 值，工具执行/turn 结束发冻结值；user_message_chunk 时
        // host 静默复位不发事件（FE 在 send 时清空）。
        if (ev.rate == null) break
        set({ genRate: ev.rate })
        break
      }
      case 'usage':
        // 多会话广播（host withSid 约定）：非当前会话的 usage 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // 同 busy 防线（错标/缺省 sid 的 usage 会把别的会话的 token 数
        // 画在已完成会话的 context chip 上）：当前视图没有 live 回合时
        // 不接受。回放（loadHistory / loadMoreHistory）的 usage 无 sid 且
        // 属于正在加载的会话本身，照常应用（历史页只在新页应用 usage）。
        if (
          !get().historyLoading &&
          !get().historyLoadingMore &&
          !busyPlausibleForView(get())
        ) {
          break
        }
        // Merge, don't overwrite: streamed session/update usage events
        // carry only `used`/`size` (no usage object) and must not clobber
        // the context-window `used`.
        set((s) => ({
          usage: {
            used: ev.used ?? s.usage?.used,
            size: ev.size ?? s.usage?.size,
          },
        }))
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
        // 无 sid 的 done + 当前无 live 回合 = 别的会话的收口（host 未附
        // sessionId，见模块头 sessionIdFrom 错标注释）——不能 finalize
        // 本视图：本端没有可收的回合，finalize 的副作用（awaitingNext /
        // pending 清空 / statusText 覆盖）都不该落在已完成的会话上。
        if (!ev.sessionId && !turnIsLive(get())) break
        // 回合身份校验：done 的 `meta` = prompt-result `_meta`（agent 回显
        // 客户端 mint 的 promptId）。带非空 pid 且与当前回合不符 → 上一
        // 个回合的迟到 done（RPC 与 live 通道乱序 / hub 缓冲重放）——
        // 不能收口新回合：finalize 的清锚副作用会打断刚发送的回合。
        // 无 pid（旧 host 丢弃 / 旧 shell）→ 退回 legacy 行为。
        if (promptIdMismatch((ev as { meta?: unknown }).meta, get().currentPromptId)) break
        // TUI TurnCompleted marker ("Worked for 2.0s") — the last scrollback
        // line above the composer, mirroring turn_completion.rs. Idempotent:
        // prompt_complete may race ahead and finalize the turn first.
        // NOT for failed/cancelled turns: error/rate_limit get the
        // TurnFailed marker from the x.ai turn_completed rail, cancelled
        // gets its own TurnCancelled marker from the host's cancelled
        // event (TUI prompt_origin.rs stop_reason mapping) — neither
        // renders a "Worked for" line.
        finalizeTurn(set, get, ev.stopReason)
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
          // 带当前 sid 的 live 收口但本视图没有 live 回合：host 可能把别的
          // 会话的收口错标成当前会话（sessionIdFrom active 回退，见模块头）。
          // 成功收口直接跳过（finalize 的副作用——awaitingNext/pending 清空
          // ——不该落在已完成的会话上）；失败收口放行——done 对失败回合不
          // 追加标记，本 rail 的 TurnFailed 标记是唯一来源，必须照常渲染。
          if (!turnIsLive(get()) && stopReason !== 'error' && stopReason !== 'rate_limit') {
            break
          }
          // LIVE turn_completed —— 宿主转发的 x.ai 持久化回合终态（rail）。
          // 任务 2：此前该分支只 settle 流式条目、把收口留给 `done`
          // （session/prompt RPC 结果）。但子代理完成后的注入回合
          // （subagent-complete / 调度注入）不经过 ACP session/prompt
          // RPC——`done` 与 `prompt_complete` 都不会来，主对话因此永远
          // 卡在 "Responding…"（实测：父会话在子代理 spawn 后 ~14s 结束
          // 自身回合，随后 agent 以注入 prompt 唤醒父会话产出最终答复，
          // 该注入回合只有 turn_completed、没有 done）。改为在这里直接
          // 收口（rail 收口）；`done` 到达时 turnIsLive 已为 false，
          // finalizeTurn 的标记被守卫跳过，不会出现双标记（幂等）。
          //
          // 失败回合的 TurnFailed 标记仍是本 rail 的职责（done 对
          // error/rate_limit 不追加 "Worked for"，见 finalizeTurn）：
          // 收口后补失败标记，tailAlreadyTurnEnded 去重。
          // 权威回合开始修正：turn_completed 的 update 原样携带 shell
          // 盖章的 turnStartMs —— 队列收养的回合若在收养后立即完成
          // （没有 chunk/thought 可修正），在这里修正后再 finalize，
          // marker 才是真实时长而非 "Worked for 0.0s"。
          // 回合身份校验：live turn_completed 的 `meta` = params._meta
          // （agent 在每个 SessionNotification 上回显 promptId）。带非空
          // pid 且与当前回合不符 → 上一个回合的迟到收口（乱序 / hub 缓冲
          // 重放）——绝不能收养/收口新回合（adoptLiveTurnStart 会把新
          // 回合的锚错改成旧回合的开始时间，时长虚高）。
          if (promptIdMismatch((ev as { meta?: unknown }).meta, get().currentPromptId)) break
          adoptLiveTurnStart(set, get, ev)
          const railEndTs = get().turnStartedAt
          finalizeTurn(set, get, stopReason)
          if (stopReason === 'error' || stopReason === 'rate_limit') {
            if (!tailAlreadyTurnEnded(get().entries)) {
              const { text, warning } = turnEndMarkerText(
                stopReason,
                agentResult,
                railEndTs != null ? Date.now() - railEndTs : undefined,
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
        // 回合收口：assistant 的 liveStream 文本先并入条目（sealThought
        // 只处理思考；不 flush 的话文本滞留 liveStream，切会话即丢）。
        const flushed = flushLiveStream(get())
        const sealed = sealThought(flushed)
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
        // 无 sid 的 cancelled + 当前无 live 回合 = 别的会话的取消（host
        // 未附 sessionId，见模块头错标注释）：跳过——否则会把本会话的
        // pending/x.ai 卡清空、awaitingNext 置位（副作用属于别人）。
        if (!ev.sessionId && !turnIsLive(get())) break
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
        set((s) => {
          // Merge any live text into its entry first (cancel rewrites the
          // streaming entries; without the flush the text would be lost).
          const flushed = flushLiveStream(s)
          return {
            conn: 'ready',
            statusText: '待处理',
            awaitingNext: true,
            openAssistantId: undefined,
            openThoughtId: undefined,
            turnStartedAt: undefined,
            currentPromptId: undefined,
            xaiRequests: [], // host answered every pending x.ai request already
            pending: [], // …and every pending permission request (turn cancelled)
            // flushLiveStream's liveStream: null rides on the entry merge —
            // zustand set() shallow-merges, so carry it explicitly.
            liveStream: null,
            entries: [
              ...flushed.entries.map((e) => {
              if (e.kind === 'assistant' && e.streaming) {
                return { ...e, streaming: false }
              }
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
          }
        })
        break
      }
      case 'error': {
        // 多会话广播（host withSid 约定）：非当前会话的 error 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // Host withSid 约定：带 sessionId 的 error 是 agent 回合失败——
        // host 只是透传 agent 的错误（如模型 API 400 "Internal Error"），
        // host 本身没坏。渲染成 scrollback 错误行即可，不翻转连接状态、
        // 不亮红色 Host 横幅。不带 sessionId 的 error 才是 host 级错误
        // （boot 失败：agent 进程起不来 / initialize / authenticate 失败），
        // 保留原硬错误处理。
        if (ev.sessionId) {
          const s = get()
          set({
            conn: s.conn === 'busy' ? 'ready' : s.conn,
            // source='transport'：host↔agent 传输断了（agent 可能正被
            // host 重启）——给恢复提示；'agent'/缺省：agent 报错，直接
            // 显示错误文本。
            statusText:
              ev.source === 'transport'
                ? 'agent 连接异常，正在重启…'
                : ev.message,
            error: undefined,
            statusWarning: undefined,
            turnStartedAt: undefined,
            currentPromptId: undefined,
            entries: [...s.entries, { id: nid(), kind: 'error', text: ev.message }],
          })
          break
        }
        // Host 级错误（host 崩溃/重启）：丢弃未落库的流式缓冲并取消 rAF
        // （clearStreamBuf 同时 cancelAnimationFrame），避免残留 flush 在
        // 错误态之后把 conn 重新顶回 busy。
        clearStreamBuf()
        set({
          conn: 'error',
          statusText: ev.message,
          error: ev.message,
          statusWarning: undefined,
          turnStartedAt: undefined,
          currentPromptId: undefined,
          entries: [...get().entries, { id: nid(), kind: 'error', text: ev.message }],
        })
        break
      }
      case 'status': {
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
      }
      case 'task_lifecycle': {
        // 多会话广播（host withSid 约定）：非当前会话的任务回放行忽略
        // （缺 sid = 本会话历史回放，照常通过）。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
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
        // Prefer the broadcast sessionId; fall back to params for hosts
        // that only put it inside the agent params map.
        const evSid =
          (typeof ev.sessionId === 'string' && ev.sessionId) ||
          (typeof ev.params?.sessionId === 'string' && ev.params.sessionId) ||
          (typeof ev.params?.session_id === 'string' && ev.params.session_id) ||
          undefined
        const row: PendingReq = {
          requestId: ev.requestId,
          method,
          params: ev.params,
          ...(evSid ? { sessionId: evSid } : {}),
        }
        if (method.startsWith('x.ai/')) {
          // Only interactive extension requests get UI; everything else is
          // answered immediately so the agent never hangs on a timeout.
          if (!SUPPORTED_XAI_REQUESTS.has(method)) {
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
              row,
            ],
          })
        } else {
          set({
            pending: [
              ...get().pending.filter((p) => p.requestId !== ev.requestId),
              row,
            ],
          })
        }
        break
      }
      case 'client_request_resolved': {
        // Multi-tab: another client (or this tab, or host timeout) settled
        // the request — drop the matching card. Idempotent when we already
        // cleared locally after respondPermission / respondXai.
        const rid = ev.requestId
        if (!rid) break
        const s = get()
        if (
          !s.pending.some((p) => p.requestId === rid) &&
          !s.xaiRequests.some((r) => r.requestId === rid)
        ) {
          break
        }
        set({
          pending: s.pending.filter((p) => p.requestId !== rid),
          xaiRequests: s.xaiRequests.filter((r) => r.requestId !== rid),
        })
        break
      }
      case 'session_load_started': {
        // Multi-tab: another client is calling agent session/load for this
        // session. Agent will replay the full conversation on the shared
        // SSE bus. The initiator already has historyLoading (HTTP rebuild);
        // peers must arm the same gate or replay chunks APPEND onto the
        // existing scrollback (doubled timeline).
        const sid = ev.sessionId
        if (!sid || sid !== get().sessionId) break
        if (get().historyLoading) {
          // We are the initiator (continueSession / loadHistory already
          // running) — leave peerSessionLoad unset so finished is ignored.
          break
        }
        peerSessionLoadSid = sid
        // Drop gate only — loadHistory on finished clears/rebuilds entries.
        // statusText so the peer tab shows a brief loading cue.
        set({
          historyLoading: true,
          statusText: '另一窗口正在重放会话，同步中…',
        })
        break
      }
      case 'session_load_finished': {
        const sid = ev.sessionId
        if (!sid) break
        // Only the peer path rebuilds here. Initiator finishes via its own
        // continueSession → loadHistory chain and never set peerSessionLoadSid.
        if (peerSessionLoadSid !== sid) break
        peerSessionLoadSid = null
        if (get().sessionId !== sid) {
          // User navigated away mid-load — drop the gate and leave the
          // new session alone.
          if (get().historyLoading) set({ historyLoading: false })
          break
        }
        const cwd = (typeof ev.cwd === 'string' && ev.cwd) || get().cwd || ''
        if (ev.ok === false) {
          // Load failed on the other tab — just unstick the gate; keep
          // whatever scrollback we still have (historyLoading may have
          // blocked live events but we did not clear entries).
          set({
            historyLoading: false,
            statusText: '会话重放失败，保持当前视图',
          })
          break
        }
        if (!cwd) {
          set({ historyLoading: false, statusText: '会话重放完成' })
          break
        }
        // Rebuild from HTTP history (same path as continueSession). loadHistory
        // sets historyLoading again and replaces entries wholesale.
        void get().loadHistory(sid, cwd).then(() => {
          if (get().sessionId !== sid) return
          void syncPendingForSession(sid, get, set, sessionSwitchGen)
        })
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
            // 权限模式是客户端级全局状态：agent 对发送客户端的所有会话
            // 生效，广播无条件应用——所有会话的显示同步（订阅器落全局
            // 记录）。current_mode_update（session-mode id，如 'plan'）
            // 从回放的 timeline 恢复 plan/perm flags。
            applyModeFlags(set, fields)
            break
          case 'current_mode_update': {
            // 多会话广播守卫：非当前会话的 plan 状态快照不应用。
            if (ev.sessionId && ev.sessionId !== get().sessionId) break
            const flags = sessionModesPatch(get, fields)
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
            // 归属会话：事件带 sessionId 用事件值，否则当前活动会话。
            // 两者都缺（异常）时只清等待标志、不缓存。
            const targetSid = ev.sessionId || get().sessionId
            // 重放去重：同文本且 5 秒内再到达（SSE 重连 / hub 回放
            // 重推同一事件）视为重复，直接跳过——事件与 cache 都
            // 不再处理，避免滚动区出现两条相同摘要。
            const prev = targetSid ? get().recapCache[targetSid] : undefined
            if (prev && prev.text === summary && Date.now() - prev.at < 5000) {
              if (
                ev.sessionId == null ||
                get().recapPendingFor === ev.sessionId
              ) {
                set({ recapPendingFor: undefined })
              }
              break
            }
            // 按会话缓存（覆盖写，只留最新）：recap 事件 display-only、
            // 不进持久化历史，跨会话期间到达时若直接 append 会污染当前
            // 视图、切回原会话又因 loadHistory 重建而丢失。缓存后切回时
            // 由 loadHistory 按时间就近回填。
            const isActiveTarget = targetSid === get().sessionId
            const recapCache = targetSid
              ? {
                  ...get().recapCache,
                  [targetSid]: { text: summary, at: Date.now() },
                }
              : get().recapCache
            set({
              recapCache,
              // 摘要已返回：清掉等待指示。事件带 sessionId 时按会话匹配
              // 清除（多会话并发 recap 互不误清）；不带（活动会话省略
              // 约定）则全局清。
              ...(ev.sessionId == null || get().recapPendingFor === ev.sessionId
                ? { recapPendingFor: undefined }
                : {}),
            })
            // 仅目标会话是当前活动会话时才进滚动区——跨会话的摘要绝不
            // 污染当前视图。historyLoading 期间（loadHistory 重建中）
            // 到达的摘要不直接 append（条目会被下一轮 replay 的
            // entries 覆盖而丢失），只进 cache 交给回填插入。
            if (isActiveTarget && !get().historyLoading && targetSid) {
              // Two-part recap block: bold "Recap" header + muted body
              // (TUI session_event Recap). The body IS the summary text;
              // the scrollback renders the header separately. 默认展开：
              // 摘要全文（含换行）直接显示，点击行可折叠成单行预览。
              appendEntry(set, {
                kind: 'session_event',
                text: summary,
                recap: true,
                open: true,
              })
            }
            break
          }
          case 'session_recap_unavailable':
            // 无摘要可生成：同样清掉等待指示（按会话匹配，见上）。
            set((s) =>
              ev.sessionId == null || s.recapPendingFor === ev.sessionId
                ? { recapPendingFor: undefined }
                : {},
            )
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
              // TUI turn_status.rs: Retrying → "Retrying (attempt N)…".
              // 重试中状态由 composer busy 行（statusText fallback）展示，
              // 不往 scrollback 追加条目——transient 状态只在 busy 框出现；
              // 终态（failed / exhausted）仍保留在 scrollback。
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
            // 多会话广播：非当前会话的 model_changed 忽略（事件可能在
            // 顶层或 params 携带 sessionId；`model` 事件同款守卫）。
            const notifSid =
              (ev as { sessionId?: string }).sessionId ??
              (typeof ev.params?.sessionId === 'string'
                ? ev.params.sessionId
                : undefined)
            if (notifSid && notifSid !== get().sessionId) break
            // 会话切换中忽略：agent 的 session/load 会把持久化的模型 id
            // 映射到当前 catalog 键（如 deepseek-v4-flash →
            // deepseek-v4-flash-go）并广播新模型的默认 effort（如 low），
            // 会覆盖 load 响应恢复的用户原档位（如 max）。切换期间模型
            // 状态以 HTTP load 响应为准（ready 事件同款守卫）。
            if (get().historyLoading) break
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
            const name = m?.name || id
            const prevName = get().modelName
            const prevEffort = get().reasoningEffort
            // Wire effort only for the new model's label: if the
            // broadcast omits it, the parens are dropped rather than
            // recycling the previous model's effort into the new one.
            // The state update below also skips when the wire omits it
            // (leaving reasoningEffort untouched — same as the old
            // no-op fallback).
            const wireEffort =
              typeof effortRaw === 'string' && effortRaw.trim()
                ? effortRaw.trim()
                : undefined
            set({
              modelName: name,
              ...(wireEffort ? { reasoningEffort: wireEffort } : {}),
            })
            // A model_changed broadcast marks a switch point: print the
            // "模型已从 xx(effort) 切换到 xx(effort)" line. The echo of
            // our own optimistic setModel usually arrives after modelName
            // was already updated (prevName === name) — nothing switched
            // from this store's perspective, so it stays silent (the
            // setModel line already recorded it). The host never persists
            // model_changed, so replay shows switches via the
            // user_message_chunk modelId diff in replayUpdates instead.
            if (prevName && prevName !== name) {
              appendEntry(set, {
                kind: 'session_event',
                text: `模型已从 ${modelLabel(prevName, prevEffort)} 切换到 ${modelLabel(name, wireEffort)}`,
                warning: true,
              })
            }
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
          // follow-ups (turn-end suggestion chips; TUI follow_ups.rs):
          // live 走 typed `follow_ups` 事件 / ext_notification 兜底，回放
          // 走 x.ai carrier 的 session_notification 通道——切走期间回合
          // 结束的广播被丢弃，切回时若不重放，chips 永远不出现。
          case 'follow_ups':
          case 'followups':
            applyFollowUps(get, set, fields)
            break
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
        // 客户端级全局广播（agent 对发送客户端的所有会话生效）：无条件
        // 应用，所有会话的显示同步（订阅器落全局记录）。sessionId 标记
        // （host withSid 约定）不代表会话级变更，不做过滤。
        // The agent sends snake_case ({yolo_mode, auto_mode, permission_mode});
        // accept both spellings (camelCase first for host-normalized paths).
        // applyModeFlags merges (absent keys never wipe local flags) and
        // keeps planMode armed underneath permission broadcasts.
        applyModeFlags(set, (ev.params ?? {}) as Record<string, unknown>)
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
        // 会话切换中忽略：load 时模型映射广播会带新模型的默认 effort
        // （如 low），覆盖 load 响应恢复的用户原档位（如 max）；切换
        // 期间模型状态以 HTTP load 响应为准。
        if (get().historyLoading) break
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
        // 多会话广播（host withSid 约定）：非当前会话的回合终态忽略——
        // 否则后台回合的 prompt_complete 会把当前会话的回合错误收尾。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // Agent-side turn end: x.ai/session/prompt_complete fires for EVERY
        // prompt turn — user-sent turns also get a host `done`, but
        // scheduled injections end with only this.
        //
        // 回合身份校验（TUI finalize_turn_from_terminal exact-pid 匹配）：
        // payload 带 promptId（lost-response fix 后的 shell）且与当前回合
        // 不符 → 上一个回合的迟到广播（RPC 与 live 通道乱序、hub 缓冲
        // 重放、队列收养窗口）——绝不能收口新回合：新回合刚锚定
        // （conn=busy、turnStartedAt=现在），被它收口会渲染
        // "Worked for 0.0s" 假标记并清掉新回合的锚。无 pid（旧 shell）
        // → 退回 conn busy 守卫的 legacy 行为。
        const s = get()
        if (s.conn !== 'busy') break
        if (promptIdMismatch(ev.params, s.currentPromptId)) break
        // stop_reason 原样携带（shell PromptCompletePayload）——失败/取消
        // 回合必须渲染 TurnFailed / TurnCancelled，而不是 "Worked for"。
        const p = (ev.params ?? {}) as Record<string, unknown>
        const stopReason =
          typeof p.stopReason === 'string'
            ? p.stopReason
            : typeof p.stop_reason === 'string'
              ? p.stop_reason
              : undefined
        const agentResult =
          typeof p.agentResult === 'string'
            ? p.agentResult
            : typeof p.agent_result === 'string'
              ? p.agent_result
              : undefined
        // 与 `done` 同款收口（finalizeTurn：hasOutput / bashTurn / turnIsLive
        // 守卫 + 幂等 settle）；失败/取消标记是本 rail 的职责（done 对
        // error/rate_limit 不追加标记），收口后按 tailAlreadyTurnEnded
        // 去重补渲染（TUI viewer 的 stop_reason 映射同款）。
        const railEndTs = s.turnStartedAt
        finalizeTurn(set, get, stopReason)
        if (
          stopReason === 'error' ||
          stopReason === 'rate_limit' ||
          stopReason === 'cancelled'
        ) {
          if (!tailAlreadyTurnEnded(get().entries)) {
            const { text, warning } = turnEndMarkerText(
              stopReason,
              agentResult,
              railEndTs != null ? Date.now() - railEndTs : undefined,
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
      case 'follow_ups': {
        // 多会话广播（host withSid 约定）：非当前会话的跟进建议忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // 同 busy 防线：follow_ups 由 host 在回合结束时广播，sid 可能错标
        // 或缺省（见模块头 sessionIdFrom 注释）——别的会话的回合结束建议
        // 不能出现在本会话输入框上方（点选还会把跟进消息发进本会话）。
        // 只有当前视图确实在跑/刚在跑回合（turnIsLive / 发送在飞 /
        // roster 显示 busy）才接受；回放的 chips 走 session_notification
        // 通道（无 sid），不受影响。
        if (!busyPlausibleForView(get())) break
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
            lastLiveQueueChangedAt = Date.now()
            const adopted = applyQueueChanged(ev.params)
            if (adopted) adoptTurn(set, get, adopted)
          }
          break
        }
        if (SILENT_EXT_NOTIFICATIONS.has(ev.method ?? '')) break
        // x.ai/follow_ups — turn-end suggestion chips (TUI follow_ups.rs):
        // parsed into store state for the Composer's chip row; NO
        // scrollback line (the TUI renders them as a transient row above
        // the prompt). Newest-wins by response_id.
        if (ev.method === 'x.ai/follow_ups') {
          // 同 typed 入口的防线：ext_notification 的 sid 由 host 附加
          // （可能错标/缺省）——不是当前视图的回合就别画 chips。
          if (!busyPlausibleForView(get())) break
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
        // 多会话广播守卫（同 ready/model）：非当前会话的 modes 快照
        // 不得覆盖本会话的模式标志。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        set({ modes: ev.modes, ...(sessionModesPatch(get, ev.modes) ?? {}) })
        break
      case 'session_info':
        // 多会话广播（host withSid 约定）：非当前会话的会话信息忽略
        // （别的会话的 session_info_update 不能改写本会话的标题）。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        if (ev.title != null && String(ev.title).trim()) {
          set({ sessionTitle: String(ev.title).trim() })
        }
        break
      case 'model': {
        // 多会话广播（host withSid 约定）：非当前会话的 model 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // 会话切换中忽略：load 时模型映射广播（model_changed → model）
        // 会带新模型的默认 effort（如 low），覆盖 load 响应恢复的用户
        // 原档位（如 max）；切换期间以 HTTP load 响应为准。
        if (get().historyLoading) break
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
        // the event is consumed instead of silently dropped. The host/TUI
        // re-pushes the SAME list on every /new, startup, and settings
        // refresh — only append a row when an announcement's content
        // actually changed (dedup by id, content-fallback like the TUI's
        // announcement_hide_key).
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
          // Key: the announcement id when present, else its rendered content
          // (same fallback semantics as the TUI's announcement_hide_key).
          const rawId = typeof o.id === 'string' ? o.id.trim() : ''
          const key = rawId || `content:${text}`
          const fingerprint = `${sev}\u{1f}${text}`
          if (displayedAnnouncementFingerprints.get(key) === fingerprint) continue
          displayedAnnouncementFingerprints.set(key, fingerprint)
          // 上限：超 200 条时清最旧 50 条（Map 迭代序即插入序），防止
          // 公告 id 持续变化（如时间戳类内容键）时 Map 无上限增长。
          if (displayedAnnouncementFingerprints.size > 200) {
            let dropped = 0
            for (const k of displayedAnnouncementFingerprints.keys()) {
              displayedAnnouncementFingerprints.delete(k)
              if (++dropped >= 50) break
            }
          }
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
        // not clobber our queue. The emitting sessionId also tags the
        // queue so drains stay session-scoped. When the broadcast carries
        // a running_prompt_id that matches a local queue row, the agent
        // has auto-drained it into the running slot — adopt it: render
        // the user row (server-authoritative turn start, no prompt RPC).
        if (!ev.sessionId || ev.sessionId === get().sessionId) {
          lastLiveQueueChangedAt = Date.now()
          const adopted = applyQueueChanged(ev.params, ev.sessionId)
          if (adopted) adoptTurn(set, get, adopted)
        }
        break
      }
      default:
        break
    }
  },

  send: async (
    text: string,
    blocks?: ContentBlock[],
    opts?: { fromShell?: boolean; promptId?: string },
  ) => {
    const t = text.trim()
    if (!t) return
    // 空状态（无活动会话）：发送消息即开始新对话 — 先用空状态选择的
    // 工作目录创建会话（目录留空 → 宿主默认），POST /api/session 响应
    // 携带 sessionId，锚定后直接发送本条消息。
    if (!get().sessionId) {
      const emptyCwd = get().emptyCwd?.trim()
      try {
        await get().newSession(emptyCwd || undefined)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        set({
          entries: [
            ...get().entries,
            { id: nid(), kind: 'error', text: `创建会话失败: ${msg}` },
          ],
        })
        return
      }
    }
    // 忙时守卫：当前会话已有活动回合（流式中 / 回合未收口，含恢复的
    // 在飞会话 turnStartedAt 未清）时走 server-authoritative 入队——
    // enqueue 立即 fire-and-forget 发 session/prompt（带 `_meta.promptId`，
    // agent 把它插进权威队列），本地插乐观回显行；RPC 失败（含竞态
    // 409）→ 行保留 degraded + 渲染错误行，手动重发。sendFollowUp /
    // slash 命令 / sendQueuedHead 竞态下忙时调用 send 也走这里。
    const live = get()
    // 会话切换进行中守卫：continueSession（点会话列表切会话）入口即同步
    // 锚定 sessionId（列表行立即高亮选中），随后 historyLoading 拉取历史
    // ——切换完成前绝不能把消息发进正在加载的会话：保留草稿不发（与
    // sendQueuedToSession 的 historyLoading 守卫一致），等加载完成由用户
    // 重发。空状态 newSession 不置 historyLoading，不受影响。
    if (live.sessionId && live.historyLoading) {
      get().pushToast('正在切换会话，请稍候再发送')
      return
    }
    if (live.sessionId && turnIsLive(live)) {
      usePromptQueue.getState().enqueue(
        {
          text: t,
          blocks:
            blocks && blocks.length > 0 ? blocks : [{ type: 'text', text: t }],
        },
        live.sessionId,
      )
      return
    }
    // 流式缓冲先落库：上一回合的思考文本完整后再收口/追加用户行。
    flushStreamBuf(set, get)
    // Seal any leftover thought from prior turn, then append the user row.
    // Tag the user row so the live user_chunk echo merges into it (not a
    // 2nd row). NO pre-created Thinking… shell: TUI pre-creates the
    // thinking block at stream_start (first chunk), so between send and
    // the first token the status line reads "Waiting for response…".
    // A new turn closes any stale stream — seal assistant (text +
    // streaming:false) and thought before the pointers drop.
    const sealedAsst = sealAssistantStream(get())
    const sealed = sealThought(sealedAsst)
    const userId = nid()
    // 回合身份：mint 一个 promptId 走 wire（TUI 同款——agent 在
    // PromptResponse / SessionNotification 的 `_meta` 上回显），终端事件
    // 按它做 exact-pid 匹配，杜绝上一回合的迟到 prompt_complete/done
    // 收口新回合（"Worked for 0.0s" 假标记）。降级行重发沿用原 id
    // （agent queue_meta 身份一致）；旧 host 忽略该字段 → 事件无 pid，
    // 匹配退回 legacy。与队列 promptId 同源（promptQueue 的 qid）。
    const promptId = opts?.promptId ?? qid()
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
      lastSentPromptId: userId,
      conn: 'busy',
      statusText: 'Waiting for response…',
      awaitingNext: false,
      turnStartedAt: Date.now(),
      currentPromptId: promptId,
      // A manual send starts a new turn: the previous turn's suggestion
      // chips are retired (TUI clears follow_ups at turn start).
      followUps: undefined,
      followUpsResponseId: undefined,
      // 新回合开始：上一回合的速率数字失效（host 在 user_message_chunk
      // 时静默复位，不发事件）。
      genRate: undefined,
    })
    try {
      // Optional image blocks (Composer image chips): the caller passes
      // the full block list; default is the plain text prompt.
      // promptId：本回合身份（普通发送 mint 新 id；降级行重发保持与
      // 镜像行同 id，agent 侧 queue_meta 一致）。
      await transport.prompt(
        blocks && blocks.length > 0 ? blocks : [{ type: 'text', text: t }],
        // 显式绑定会话列表选中的会话：请求确定发往 get().sessionId
        // （与 sendQueuedToSession 一致），而不是依赖 host 的活动会话——
        // 避免 host 活动会话与 FE 列表选中会话在竞态窗口内不一致时发错会话。
        { promptId, sessionId: get().sessionId },
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // drop empty thinking shell on failure
      const s = get()
      const after = sealThought(s)
      // 回合失败 ≠ 连接失败：HTTP 错误响应说明 host 活着，错误来自 agent
      // （host 只是透传，如模型 API 400 "Internal Error"）——滚动一条错误
      // 行即可，连接保持就绪、不亮红色 Host 横幅。只有网络级失败（fetch
      // 拒绝 = host 不可达，即 AgentTurnError 之外的异常）才进 host 错误
      // 处理（conn: 'error' + 横幅）。
      if (!(e instanceof AgentTurnError)) {
        // 网络级失败（fetch 拒绝）。但 POST /api/prompt（回合 RPC）与
        // live 通道（SSE/WS，回合输出）是两条独立连接——三种情形：
        // 1) 回合已被 live 通道收口（done/turn_completed 先到，turnStartedAt
        //    已清）：回合结果以 live 通道为准，SSE 侧已渲染过该渲染的
        //    （成功标记或错误行）——HTTP 拒绝只是陈旧通道的产物，静默返回。
        // 2) 回合仍在 live 通道上运行（自 turnStartedAt 以来有事件送达）：
        //    fetch 失败只是通道瞬断（host 重启 / 代理抖动 / HTTP/2 reset），
        //    输出照常流——不渲染错误行、不翻转 conn，武装看门狗兜底
        //    （仅当回合卡死且通道断开才补错误态）。
        // 3) 回合从未启动（本回合零 live 事件）：真 host 不可达 / prompt
        //    丢失——保留原硬错误处理（conn: 'error' + 横幅）。
        const started = s.turnStartedAt
        if (started == null) return
        const lastLive = transport.lastLiveEventAt()
        if (lastLive != null && lastLive >= started) {
          armTurnBlipWatchdog(set, get, msg)
          return
        }
        // 网络级失败（host 不可达）：丢弃未落库的流式缓冲并取消 rAF，
        // 避免残留 flush 在错误态之后把 conn 重新顶回 busy。
        clearStreamBuf()
        set({
          ...after,
          pendingOptimisticUserId: undefined,
          conn: 'error',
          statusText: msg,
          awaitingNext: false,
          turnStartedAt: undefined,
          currentPromptId: undefined,
          entries: [...after.entries, { id: nid(), kind: 'error', text: msg }],
        })
        return
      }
      // 代理超时（524 Cloudflare / 504 nginx / 408）≠ agent 拒绝：这是
      // 反代等不到源站响应头（Cloudflare ~100s）主动掐断阻塞的 POST。
      // 新 host 已改为受理即返回，不会再触发；此分支是旧 host（阻塞到
      // 回合结束）的防御——host 的 handler 早已 detach（ctx.Done()）、
      // 回合在后台照常跑、输出继续走 live 通道，回合结果由 live 通道
      // 收口（成功或 SSE 错误事件）。渲染 "prompt failed (524)" 只会
      // 污染已正常完成的回合。与网络瞬断同构：不渲染错误行，武装看门狗
      // 兜底——仅当回合卡死且 live 通道断开才补错误态。turnStartedAt
      // 已清说明 live 通道已收口过（结果已渲染），静默返回。
      if (
        e instanceof AgentTurnError &&
        (e.status === 524 || e.status === 504 || e.status === 408 || e.status === 599)
      ) {
        if (s.turnStartedAt == null) return
        armTurnBlipWatchdog(set, get, msg)
        return
      }
      // host 的 SSE error 事件（同文本）通常先于 HTTP 响应到达、已滚过
      // 一行——按文本去重，避免同一回合错误出现两行。
      const last = after.entries[after.entries.length - 1]
      const dup = last && last.kind === 'error' && last.text === msg
      set({
        ...after,
        pendingOptimisticUserId: undefined,
        conn: s.conn === 'busy' ? 'ready' : s.conn,
        // unreachable（502/传输断）：agent 正被 host 重启——给恢复提示；
        // rejected：agent 报错，直接显示错误文本。
        statusText:
          e instanceof AgentTurnError && e.kind === 'unreachable'
            ? 'agent 连接异常，正在重启…'
            : msg,
        error: undefined,
        statusWarning: undefined,
        awaitingNext: false,
        turnStartedAt: undefined,
        currentPromptId: undefined,
        entries: dup
          ? after.entries
          : [...after.entries, { id: nid(), kind: 'error', text: msg }],
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

  /**
   * Cancel the running turn WITHOUT stopping subagents — the send-now
   * paths (Composer [发送现在] / double-Enter / Ctrl+Enter) cancel first
   * so the host accepts the next prompt, but a dispatched subagent must
   * keep working (TUI plain CancelTurn → cancelSubagents: false).
   */
  cancel: async () => {
    await transport.cancel({ cancelSubagents: false }, get().sessionId)
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
      // Always send the flag explicitly: absent ⇒ agent default TRUE
      // (stops every running subagent), which would contradict the
      // "subagents keep running" semantics of the plain cancel path
      // (Ctrl+C / "Always continue" preference / send-now).
      await transport.cancel({ cancelSubagents: opts?.cancelSubagents === true }, get().sessionId)
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
    // 会话级 RPC：请求锁定发起时的会话（缺省 = host active，多 tab /
    // 在飞切换时会打错会话）。
    const sid = s.sessionId
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
        await transport.setMode('plan', sid)
        set({ planMode: true, permissionMode: undefined, statusText: '已切换到 plan 模式' })
      } else if (inPlan && !inAuto && !inAlways) {
        // plan → auto (leave plan)
        get().showModeBanner('Switched to mode: Auto')
        await transport.setMode('default', sid)
        await transport.setMode('auto', sid)
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
        await transport.setMode('default', sid)
        await transport.setMode('always-approve', sid)
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
        await transport.setMode('default', sid)
        await transport.setMode('normal', sid)
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
        await transport.setMode('always-approve', sid)
        set({
          yoloMode: true,
          autoMode: false,
          permissionMode: undefined,
          statusText: '已切换到 always-approve 模式',
        })
      } else {
        // always → normal
        get().showModeBanner('Switched to mode: Normal')
        await transport.setMode('normal', sid)
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
      await transport.setMode('plan', s.sessionId)
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
        await transport.setMode('normal', s.sessionId)
        set({
          autoMode: false,
          yoloMode: false,
          permissionMode: undefined,
          statusText: inPlan ? '已退出 auto（plan 保持）' : '已切换到 normal 模式',
        })
      } else {
        await transport.setMode('auto', s.sessionId)
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
        await transport.setMode('normal', s.sessionId)
        set({
          yoloMode: false,
          autoMode: false,
          permissionMode: undefined,
          statusText: inPlan ? '已退出 always-approve（plan 保持）' : '已切换到 normal 模式',
        })
        return
      }
      const ok = await turnOnAlwaysApprove(set, inPlan, s.sessionId)
      if (!ok) {
        appendEntry(set, {
          kind: 'error',
          text: 'host 暂不支持运行时切换 always-approve',
        })
      }
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
    try {
      await transport.respondPermission(requestId, optionId, cancelled, scope, followupMessage)
    } catch (e) {
      // P0: 失败（网络抖动 / ok:false）不得静默——之前无 try/catch，pending
      // 不清理、无 UI 反馈、void 调用产生 unhandled rejection，权限卡停在
      // waiting on you 用户以为没点中。失败时 toast 提示并保留 pending 可重试。
      // 例外：另一标签页已应答 / 超时（host "不存在或已过期"）——卡已无主，
      // 清掉以免僵尸 UI（新 host 还会广播 client_request_resolved 兜底）。
      const msg = e instanceof Error ? e.message : String(e)
      if (/不存在|已过期|not found|expired/i.test(msg)) {
        set({ pending: get().pending.filter((p) => p.requestId !== requestId) })
        return
      }
      get().pushToast(`权限应答失败: ${msg}`)
      return
    }
    set({ pending: get().pending.filter((p) => p.requestId !== requestId) })
    // TUI parity — the prepended "enable always-approve mode" option
    // (position 0 on TUI-class clients) is a two-part action: the shell
    // maps the response to AllowOnce (this request allowed once), and the
    // CLIENT then flips always-approve on (TUI dispatch_permission_select
    // → set_yolo_mode(true): local flag + persist + x.ai/yolo_mode_changed
    // via host /api/set-mode, then drain the remaining queue). Without the
    // flip the badge stays off and the agent keeps prompting.
    if (optionId === ENABLE_ALWAYS_APPROVE_OPTION_ID && !cancelled) {
      const s = get()
      if (s.yoloMode === true) {
        // Defensive (TUI is_yolo guard): the agent is already in
        // always-approve — no flip needed. Still drain: a stale queued
        // request can outlive the flag (multi-tab), and AllowOnce is what
        // the agent would do anyway.
        await drainPendingForYolo(set, get)
      } else {
        const inPlan = s.planMode === true || s.permissionMode === 'plan'
        const ok = await turnOnAlwaysApprove(set, inPlan)
        if (ok) {
          await drainPendingForYolo(set, get)
        } else {
          // Request still allowed once — the session-wide toggle just
          // didn't apply (prompter.rs "worst case").
          get().pushToast('已允许本次请求，但 host 不支持开启 always-approve 模式')
        }
      }
    }
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
        // Arm the grace window: a 'plan' broadcast queued before the
        // approval can still land after it (SSE and this HTTP response are
        // separate channels) — planOnWithinGrace() suppresses it, so the
        // flag we just cleared cannot be resurrected by a stale event.
        planExitApprovedAt = Date.now()
      }
    }
  },

  dismissXai: async (requestId) => {
    await get().respondXai(requestId, { outcome: 'cancelled' })
  },

  requestRecap: async () => {
    try {
      await transport.recap(false, get().sessionId)
      // fire-and-forget：显示等待指示（turn status 行 spinner + 相位
      // 计时），直到 session_recap / session_recap_unavailable 返回。
      // 绑定发起会话：只有该会话活动时显示，切换会话不残留。
      set({ recapPendingFor: get().sessionId, statusText: '正在生成摘要…' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        recapPendingFor: undefined,
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
      const r = await transport.forkSession(opts ?? {}, get().sessionId)
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
      await transport.renameSession(title, get().sessionId)
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
      await transport.cancelSubagent(subagentId, get().sessionId)
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
      await transport.killTask(taskId, get().sessionId)
      set({ statusText: '正在终止后台任务…' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `终止任务失败: ${msg}` }],
      })
    }
  },

  deleteSession: async (sessionId, cwd) => {
    // Capture the verdict BEFORE the delete request: sessionDelete can
    // take a while (worktree cleanup etc.), and the user may switch to
    // that session mid-request — the auto-fallback decision must reflect
    // the session's identity when the delete was issued, not after the
    // await (otherwise a historical delete could spuriously end the
    // newly-focused session and create a fresh one).
    const isCurrent = sessionId === get().sessionId
    try {
      await transport.sessionDelete(sessionId, cwd)
      set({ statusText: `已删除会话 ${sessionId.slice(0, 8)}` })
      void get().refreshSessions()
      void get().refreshWorkspaces()
      // Deleting the ACTIVE session lands in the EMPTY state (no
      // auto-new): reset all session-scoped state and drop the anchor.
      // The host clears its active-session pointer on the same delete,
      // so the next prompt without a sessionId creates a fresh session
      // there. Historical deletes just refresh the list.
      if (isCurrent) get().resetToEmpty()
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

  refreshSessions: async (retry = 1) => {
    try {
      const { sessions } = await transport.listSessions()
      set({ sessions })
      // Busy 转变检测（完成提醒兜底）：某会话从 busy → idle 且不是
      // 当前会话 → 通知 + ✓。第一次拉取只建基线，不误报。
      let next: Record<string, boolean> = {}
      for (const s of sessions) next[s.sessionId] = s.status?.busy === true
      const cur = get()
      for (const [sid, wasBusy] of Object.entries(lastBusySnapshot)) {
        if (wasBusy && next[sid] === false && sid !== cur.sessionId) {
          cur.noteSessionCompleted(sid)
        }
      }
      // 上限：会话数过多时放弃本轮对比、重置为空基线（下轮重新建基线），
      // 防止模块级快照无上限增长。
      if (Object.keys(next).length > 100) next = {}
      lastBusySnapshot = next
    } catch {
      // 启动窗口容错：host 刚重启时 agent 预热 boot（initialize +
      // authenticate）可能超过 fetch 超时，重试一次再放弃，避免首屏
      // 会话列表为空。
      if (retry > 0) {
        await new Promise((r) => setTimeout(r, 4000))
        return get().refreshSessions(retry - 1)
      }
    }
  },

  refreshWorkspaces: async (retry = 1) => {
    set({ workspaceLoading: true })
    try {
      const workspaces = await transport.workspaceList()
      set({ workspaces, workspaceLoading: false })
    } catch {
      // 启动窗口容错：host 刚重启时 agent 预热 boot 可能超过 fetch
      // 超时（502），重试一次再降级，避免首屏侧边栏空白。
      if (retry > 0) {
        await new Promise((r) => setTimeout(r, 4000))
        return get().refreshWorkspaces(retry - 1)
      }
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

  newSession: async (cwd?: string) => {
    // Any in-flight session switch (grace-window callback / async loads)
    // must not re-anchor after a fresh session starts.
    sessionSwitchGen += 1
    clearContinueSessionTimer()
    clearPeerSessionLoad()
    get().stopTopTaskPolling()
    clearSuppressedTools()
    clearStreamBuf()
    // A new session inherits the current GLOBAL permission mode (TUI
    // parity: SessionFlags ride session/new `_meta`; the agent never
    // persists ask/auto/always-approve). Capture before the reset —
    // yoloMode wins over autoMode; with no global record yet, fall back
    // to the config.toml default. Plan mode is per-session on the agent
    // side and always starts fresh.
    const cur = get()
    const defaultFlags = await ensureDefaultModeFlags()
    const curFlags = sessionModeFlags(
      { yoloMode: cur.yoloMode, autoMode: cur.autoMode },
      defaultFlags,
    )
    const inheritMeta = permissionSeedMeta(curFlags)
    // 权限模式是进程级全局状态：复位不清（删除场景同样保留），store
    // 现值即继承值，无需经 flags 回灌。
    resetSessionState(set)
    // New session lands in the CURRENT conversation's workspace: inherit
    // its cwd so "new" starts in the same directory (captured above, before
    // the anchor reset clears it). An explicit cwd (sidebar group
    // right-click "新建会话") wins; empty cwd (no session yet) → host default.
    const startCwd = cwd ?? cur.cwd
    // 窗口期标记：resetSessionState 清锚（sessionId=null）后到 POST 响应
    // 回填前，宿主的 hello/busy 广播（hub 双连接 SSE 重连 / WS 缺口回放）
    // 会穿过所有会话守卫——hello handler 凭此标志只吸收快照、不重锚。
    newSessionInFlight = true
    let res: unknown
    try {
      res = await transport.newSession({
        ...(startCwd ? { cwd: startCwd } : {}),
        ...(inheritMeta ? { meta: inheritMeta } : {}),
      })
    } finally {
      newSessionInFlight = false
    }
    // POST /api/session 响应直接携带新会话 id（host Snapshot）——提前
    // 锚定 sessionId，不等 SSE ready（ready 到达时幂等覆盖）。空状态
    // 发送消息时依赖这一点：newSession 返回后即可继续发 prompt。
    const sid = (res as { sessionId?: unknown } | null)?.sessionId
    if (typeof sid === 'string' && sid) {
      // session/new 响应是权威：新会话必然 idle + 空。POST 窗口期内
      // 可能被旧 hello/busy 污染（conn='busy'、turnStartedAt 残留、
      // loadHistory(S1) 在飞）——锚定时整体复位回合状态，杜绝
      // turnIsLive() 对新会话误判成忙（否则第一条消息会走 enqueue
      // 排队而不是直发，且可能被双 Enter 再次发送）。
      set({
        sessionId: sid,
        cwd: startCwd || undefined,
        conn: 'ready',
        statusText: '就绪',
        awaitingNext: false,
        turnStartedAt: undefined,
        currentPromptId: undefined,
        genRate: undefined,
        // 全新会话无历史可载：上个会话残留的加载失败提示不适用。
        historyLoadError: undefined,
        historyLoading: false,
        historyLoadingMore: false,
        pendingOptimisticUserId: undefined,
        openAssistantId: undefined,
        openThoughtId: undefined,
        liveStream: null,
      })
    }
  },

  resetToEmpty: () => {
    get().stopTopTaskPolling()
    clearSuppressedTools()
    clearStreamBuf()
    resetSessionState(set)
  },

  setEmptyCwd: (cwd) => {
    // 目录属于具体某台 host 的文件系统：按当前 hostId 记忆，切换 host
    // 时互不污染。local 模式 hostId 为空 → 'default' 单键，语义不变。
    const hostKey = get().hostId ?? 'default'
    set((st) => ({
      emptyCwd: cwd,
      emptyCwdByHost: { ...(st.emptyCwdByHost ?? {}), [hostKey]: cwd },
    }))
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
      e.kind !== 'subagent' &&
      e.kind !== 'workflow'
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
    // 打开即回放完整历史：不再因“已有 live 条目”而跳过。磁盘 updates.jsonl
    // 是权威完整来源，live 只是流式尾巴——live 捕获非空只代表“正在输出”，
    // 不代表历史完整。回放成功后以回放结果重建 items（见下方合并逻辑）。
    if (!view || view.fetchState === 'loading' || view.fetchState === 'loaded') {
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
        offset: -SUBAGENT_VIEW_PAGE_SIZE,
        limit: SUBAGENT_VIEW_PAGE_SIZE,
      })
      // 先独立回放出一条基线（磁盘权威），再与现有 live 条目合并：
      // - 回放有内容 → 用它重建视图（丢弃 pre-loading 的 live 子集，避免重复/乱序）
      // - 回放为空（子代理会话无落盘 / 宿主未找到该子代理）→ 保留现有 live
      //   捕获，不丢流。
      let replayed: ScrollEntry[] = []
      for (const env of r.updates ?? []) {
        // 防御（任务 3）：存储包络带 params.sessionId——只有属于该子代理
        // 会话（或未带 sid 的旧格式）的包络才回放。若 x.ai/session/updates
        // 对子代理 sid 解析异常、回退到了别的会话（历史 bug：不同子代理
        // 弹窗拉到同一份内容），错配包络直接丢弃——弹窗显示空态
        // 「未捕获到活动」，绝不渲染出别的会话的对话。
        const envParams = (env as { params?: { sessionId?: unknown } } | null)
          ?.params
        const envSid = envParams?.sessionId
        if (typeof envSid === 'string' && envSid !== childSessionId) continue
        const ev = envelopeToEvent(env)
        if (ev) replayed = subagentViewAppend(replayed, ev)
      }
      // 记录分页游标（包络条数——与宿主负 offset 语义一致，过滤掉的非
      // scrollback 事件不占游标位）：回放填充的视图（loadedCount > 0）
      // 才支持上滑分页。
      const total = r.totalCount ?? (r.updates?.length ?? 0)
      set((st) => {
        const v = st.subagentViews[childSessionId]
        if (!v) return {}
        // 回放为权威基线：有内容则整体替换（含历史中被 live 抢先捕获的子集
        // 一并去重）；回放为空则保留现有 live 捕获，保证正在输出的流不丢。
        const items = replayed.length > 0 ? replayed : v.items
        return {
          subagentViews: {
            ...st.subagentViews,
            [childSessionId]: {
              ...v,
              items,
              fetchState: 'loaded',
              loadedCount: r.updates?.length ?? 0,
              totalCount: total,
            },
          },
        }
      })
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

  loadMoreSubagentView: async (childSessionId): Promise<boolean> => {
    const s = get()
    const view = s.subagentViews[childSessionId]
    if (!view || view.fetchState === 'loading') return false
    const loaded = view.loadedCount ?? 0
    // 只有回放填充的视图提供上滑（纯 live 捕获历史已完整，回放会重复）。
    const hasMore =
      loaded > 0 && (view.totalCount != null ? loaded < view.totalCount : false)
    if (!hasMore) return false
    const cwd = s.cwd
    if (!cwd) return false
    set({
      subagentViews: {
        ...s.subagentViews,
        [childSessionId]: { ...view, fetchState: 'loading' },
      },
    })
    try {
      // 分页游标 = 已消耗的包络条数（loadedCount，宿主负 offset 语义）：
      // 子代理事件流里大量 usage/status 等非 scrollback 包络被过滤，条目
      // 数 ≠ 包络数，用条目数算 offset 会与已加载页重叠。
      const r = await transport.loadSessionHistory(childSessionId, cwd, {
        offset: -(loaded + SUBAGENT_VIEW_PAGE_SIZE),
        limit: SUBAGENT_VIEW_PAGE_SIZE,
      })
      // 回放前记住旧时间线起点：回放 append 的新（更早）页随后移到前面。
      const split = get().subagentViews[childSessionId]?.items.length ?? 0
      for (const env of r.updates ?? []) {
        const envParams = (env as { params?: { sessionId?: unknown } } | null)
          ?.params
        const envSid = envParams?.sessionId
        if (typeof envSid === 'string' && envSid !== childSessionId) continue
        const ev = envelopeToEvent(env)
        if (ev) applySubagentViewEvent(set, childSessionId, ev)
      }
      const after = get().subagentViews[childSessionId]
      if (!after) return false
      let oldItems = after.items.slice(0, split)
      const newItems = after.items.slice(split)
      // 跨页截断缝合：assistant / thought 各半拼回一条（主 scrollback
      // loadMoreHistory 同款）；历史数据缝合后收口，不再停留流式态。
      const lastNew = newItems[newItems.length - 1]
      const firstOld = oldItems[0]
      if (lastNew?.kind === 'assistant' && firstOld?.kind === 'assistant') {
        newItems[newItems.length - 1] = {
          ...lastNew,
          text: lastNew.text + firstOld.text,
          streaming: false,
        }
        oldItems = oldItems.slice(1)
      } else if (lastNew?.kind === 'thought' && firstOld?.kind === 'thought') {
        newItems[newItems.length - 1] = {
          ...lastNew,
          text: lastNew.text + firstOld.text,
          streaming: false,
          displayMode: 'collapsed' as const,
          finishedAt: Date.now(),
        }
        oldItems = oldItems.slice(1)
      }
      // 更早的页在前拼接；不设条目上限——由用户上滑分页控制（不再丢弃最旧）。
      const merged = [...newItems, ...oldItems]
      const fetched = r.updates?.length ?? 0
      const total = r.totalCount ?? view.totalCount ?? loaded + fetched
      const loadedNew = fetched === 0 ? total : Math.min(loaded + fetched, total)
      set({
        subagentViews: {
          ...s.subagentViews,
          [childSessionId]: {
            ...after,
            items: merged,
            fetchState: 'loaded',
            loadedCount: loadedNew,
            totalCount: total,
          },
        },
      })
      return true
    } catch {
      // 加载失败静默：恢复 loaded，下次上滑/自动补页重试（返回 false 让
      // 自动补页停止，避免无滚动条时无限重试）。
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
      return false
    }
  },
}})

// ── prompt-queue session tracking ──────────────────────────────────
// The prompt queue is per-session widget state: every sessionId change
// swaps the queue store's active queue (stash the old session's queue
// under its id, restore the new session's). This single hook covers
// newSession, continueSession, resetToEmpty, hello/ready re-anchors and
// any future path — a queued prompt can never be delivered into another
// session, and it is still there (visible, auto-sendable) when its own
// session becomes active again.
useChatStore.subscribe((state, prev) => {
  if (state.sessionId !== prev.sessionId) {
    usePromptQueue.getState().switchSession(state.sessionId)
  }
})

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
 * Roster corroboration for the turn-status line: the host's session list
 * (`sessions[].status.busy`, refreshed on sessions_changed / on demand)
 * says the given session has an in-flight turn. Used to attribute
 * status-rail events (busy/done) whose sessionId the host may have
 * mis-tagged — the host's sessionIdFrom falls back to the ACTIVE session
 * during multi-session switching (see the module header), so an event
 * tagged like the current session (or untagged) can actually belong to a
 * background session. Envelope-backed events (chunk/thought/tool_call/…)
 * carry the session id from the update envelope and are trustworthy; the
 * synthesized status rails are the ones that need this check.
 */
function rosterSessionBusy(s: ChatState, sessionId?: string): boolean {
  if (!sessionId) return false
  return s.sessions.some(
    (x) => x.sessionId === sessionId && x.status?.busy === true,
  )
}

/**
 * Whether a `busy` notification plausibly belongs to the CURRENT view.
 * Busy events are host-synthesized; their sessionId can be missing or
 * mis-tagged as the active session while the busy turn actually belongs
 * to a background session. Only accept when the current view really has
 * a turn in flight: a live local turn (turnIsLive — send() / adoptTurn /
 * streaming already armed it), a send awaiting its first echo
 * (pendingOptimisticUserId), or the roster corroborating that the
 * current session is busy. Otherwise the busy is another session's —
 * applying it would paint that session's turn status (spinner + phase
 * timer) onto e.g. a completed conversation, stuck until the foreign
 * turn's done arrives.
 */
function busyPlausibleForView(s: ChatState): boolean {
  return (
    turnIsLive(s) ||
    s.pendingOptimisticUserId != null ||
    rosterSessionBusy(s, s.sessionId)
  )
}

/**
 * 从 live 事件提取 shell 盖章的权威回合开始时间（`turnStartMs`，epoch
 * ms）。live wire 载体：chunk / user_chunk / thought 由 host 从
 * params._meta 显式透传为顶层 `turnStartMs`；turn_completed 的 `meta`
 * 即 params._meta（NotificationMeta），直接读它。与回放路径同源 ——
 * agent 在每个流式 update 上盖章。
 */
function liveTurnStartMs(ev: AcpEvent): number | undefined {
  const anyEv = ev as {
    turnStartMs?: unknown
    fullUpdate?: { _meta?: unknown }
    meta?: unknown
    update?: { _meta?: unknown }
  }
  let raw: unknown = anyEv.turnStartMs
  if (raw == null) {
    const meta =
      anyEv.meta ?? anyEv.fullUpdate?._meta ?? anyEv.update?._meta
    if (meta && typeof meta === 'object') {
      const m = meta as Record<string, unknown>
      raw = m.turnStartMs ?? m.turn_start_ms
    }
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  if (typeof raw === 'string') {
    const p = Date.parse(raw)
    if (Number.isFinite(p) && p > 0) return p
  }
  return undefined
}

/**
 * 采纳权威回合开始时间（live 通道）。shell 盖的 turnStartMs 只在回合
 * 锚定期内生效（turnStartedAt 非空，防收口后迟到事件污染下一回合）：
 * 修正 adoptTurn / 断线重连用本地时刻锚定的误差 —— 队列收养的回合
 * 真实开始远早于收养时刻（agent 早就 pop 开跑），不修正会渲染
 * "Worked for 0.0s" 之类的假时长。
 */
function adoptLiveTurnStart(
  set: SetState,
  get: () => ChatState,
  ev: AcpEvent,
): void {
  const ts = liveTurnStartMs(ev)
  if (ts == null || get().turnStartedAt == null) return
  set({ turnStartedAt: ts })
}

/**
 * 从终端事件载体提取回合 pid（agent 在 PromptResponse 与每个
 * SessionNotification 的 `_meta` 上回显客户端 mint 的 promptId）：
 * - done：顶层 `meta` = prompt-result `_meta`（host 原样透传）
 * - prompt_complete：params 顶层 `promptId`/`prompt_id`，或 `_meta` 内
 * - live turn_completed：顶层 `meta` = params._meta
 * 空 / 缺失 = 旧 shell（lost-response fix 之前），无回合身份信息。
 */
function eventPromptId(root: unknown): string | undefined {
  const read = (o: unknown): string | undefined => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined
    const rec = o as Record<string, unknown>
    for (const k of ['promptId', 'prompt_id']) {
      const v = rec[k]
      if (typeof v === 'string' && v) return v
    }
    return undefined
  }
  if (!root || typeof root !== 'object') return undefined
  const o = root as Record<string, unknown>
  return read(o) ?? read(o._meta) ?? read(o.meta)
}

/**
 * 回合身份校验（TUI finalize_turn_from_terminal / arm_driver_turn_end_reconcile
 * 的 exact-pid 匹配语义）：事件带非空 pid、本端也知道当前回合 pid、
 * 两者不符 → 上一个回合的迟到/错标终端事件，调用方必须忽略（否则会
 * 把刚锚定的新回合立即收口——finalize 的清锚副作用 + "Worked for 0.0s"
 * 假标记）。任一缺失 → 无法判定，放行 legacy 行为。
 */
function promptIdMismatch(
  root: unknown,
  currentPid: string | undefined,
): boolean {
  if (!currentPid) return false
  const evPid = eventPromptId(root)
  return evPid != null && evPid !== '' && evPid !== currentPid
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

// ── 流式文本合并缓冲（rAF flush）────────────────────────────
// Pipeline: SSE → streamBuf (rAF) → liveStream → flushLiveStream → entry.text
//
// 移动端思考/回答流渲染卡顿主因：每个 SSE chunk 一次 set() + 一次完整
// 渲染 + 两次强制布局。chunk 文本先落进模块级缓冲，requestAnimationFrame
// 统一落库（每帧至多一次 set()）。顺序保证：handleEvent 入口对"非同类
// 流式事件"强制先 flush——tool_call/chunk/回合终态等收口类事件处理前，
// 缓冲的思考文本必已写入 liveStream（再由边界路径 flushLiveStream 入条目）。
type StreamBufKind = 'thought' | 'assistant'

let streamBufText = ''
let streamBufKind: StreamBufKind | null = null
let streamBufRaf: number | null = null
/** 缓冲内 chunk 携带的 elapsedMs（replay），flush 时"最后一个 chunk 生效"。 */
let streamBufElapsedMs: number | undefined
/** DEV: chunks coalesced into the current streamBuf frame (perf.mark detail). */
let streamBufChunkCount = 0

/** 追加一段流式文本到合并缓冲；首次追加时调度 rAF flush。 */
function appendStreamBuf(
  set: SetState,
  get: () => ChatState,
  kind: StreamBufKind,
  text: string,
  elapsedMs?: number,
): void {
  if (!text) return
  // 缓冲里是另一种流（异常交错，如回答中回补思考）：先落库保序。
  if (streamBufKind != null && streamBufKind !== kind) flushStreamBuf(set, get)
  streamBufText += text
  streamBufKind = kind
  streamBufChunkCount++
  if (elapsedMs != null) streamBufElapsedMs = elapsedMs
  if (streamBufRaf == null) {
    streamBufRaf = requestAnimationFrame(() => {
      streamBufRaf = null
      flushStreamBuf(set, get)
    })
  }
}

/**
 * 把缓冲的流式文本一次性落库（每帧至多一次）。目标条目已被收口/清除时
 * 丢弃缓冲（stop/会话切换后的残留文本不应再入 scrollback）。
 * 落库目标 = liveStream（不直接写 entry.text）。
 */
function flushStreamBuf(set: SetState, get: () => ChatState): void {
  const text = streamBufText
  const kind = streamBufKind
  if (!text || !kind) return
  const bufElapsedMs = streamBufElapsedMs
  const chunkCount = streamBufChunkCount
  streamBufText = ''
  streamBufKind = null
  streamBufElapsedMs = undefined
  streamBufChunkCount = 0
  if (streamBufRaf != null) {
    cancelAnimationFrame(streamBufRaf)
    streamBufRaf = null
  }
  const dev = import.meta.env.DEV
  if (
    dev &&
    typeof performance !== 'undefined' &&
    typeof performance.mark === 'function'
  ) {
    try {
      performance.mark('acp:stream-flush', {
        detail: { textLen: text.length, kind, chunks: chunkCount },
      })
    } catch {
      // Older engines may reject mark options; ignore.
    }
  }
  const s = get()
  // Kind mismatch: buffer targeted thought/assistant but liveStream still
  // points at the other — warn when about to overwrite (DEV).
  if (
    dev &&
    s.liveStream &&
    ((kind === 'thought' && s.openAssistantId === s.liveStream.entryId) ||
      (kind === 'assistant' && s.openThoughtId === s.liveStream.entryId))
  ) {
    console.warn(
      '[acp stream] flushStreamBuf kind/liveStream target mismatch',
      { kind, liveStream: s.liveStream, openThoughtId: s.openThoughtId, openAssistantId: s.openAssistantId },
    )
  }
  if (kind === 'thought') {
    const openThoughtId = s.openThoughtId
    if (
      !openThoughtId ||
      !s.entries.some((e) => e.id === openThoughtId && e.kind === 'thought')
    ) {
      // 已收口/被清除：丢弃缓冲文本。
      return
    }
    set({
      conn: 'busy',
      statusText: 'Thinking…',
      awaitingNext: false,
      openThoughtId,
      openAssistantId: undefined,
      // 落库目标 = liveStream（perf 合并）：entries 流式期间引用不变，
      // 只有正在流的行经 liveText 重渲染——分组/折叠/memo 全跳过。
      liveStream: {
        entryId: openThoughtId,
        text:
          (s.liveStream?.entryId === openThoughtId ? s.liveStream.text : '') +
          text,
        // Last chunk wins (TUI tracker updates on every chunk).
        ...(bufElapsedMs != null ? { elapsedMs: bufElapsedMs } : {}),
      },
    })
    assertStreamInvariants(get(), 'flushStreamBuf:thought')
    return
  }
  // assistant
  const openAssistantId = s.openAssistantId
  if (
    !openAssistantId ||
    !s.entries.some((e) => e.id === openAssistantId && e.kind === 'assistant')
  ) {
    return // 已收口：丢弃缓冲文本。
  }
  set({
    conn: 'busy',
    statusText: 'Responding…',
    awaitingNext: false,
    openAssistantId,
    liveStream: {
      entryId: openAssistantId,
      text:
        (s.liveStream?.entryId === openAssistantId ? s.liveStream.text : '') +
        text,
    },
  })
  assertStreamInvariants(get(), 'flushStreamBuf:assistant')
}

/** 会话/历史切换：丢弃未落库的流式文本与字符统计。 */
function clearStreamBuf(): void {
  streamBufText = ''
  streamBufKind = null
  streamBufElapsedMs = undefined
  streamBufChunkCount = 0
  if (streamBufRaf != null) {
    cancelAnimationFrame(streamBufRaf)
    streamBufRaf = null
  }
}

/**
 * 回合收口（任务 2，done / live turn_completed / 子代理兜底共用）：
 * settle 流式条目、按需追加 "Worked for X" 标记、conn 复位 ready、
 * statusText 清为「待处理」、清空 open 指针与 pending。幂等——重复调用
 * 只重跑同样的 settle（标记由 turnIsLive 守卫，已收口后不再追加）。
 * 原 `done` 分支的收口语义原样搬入，行为不变。
 */
function finalizeTurn(
  set: SetState,
  get: () => ChatState,
  stopReason: string | undefined,
): void {
  // 流式缓冲先落库：收口前的最后一段思考文本不能丢（兜底定时器路径
  // 不经 handleEvent，这里统一保证）。
  flushStreamBuf(set, get)
  const turnStart = get().turnStartedAt
  const failedTurn =
    stopReason === 'error' ||
    stopReason === 'rate_limit' ||
    stopReason === 'cancelled'
  // TUI prompt_origin.rs: no-output turns suppress the marker (had_output
  // → None); bash turns (the `!` shell-mode prompt) suppress it too.
  let bashTurn = false
  let hasOutput = false
  for (let i = get().entries.length - 1; i >= 0; i--) {
    const e = get().entries[i]
    if (e.kind === 'user') {
      bashTurn = (e as { isShell?: boolean }).isShell === true
      break
    }
    if (e.kind === 'assistant' || e.kind === 'thought' || e.kind === 'tool') {
      hasOutput = true
      break
    }
  }
  const marker =
    turnIsLive(get()) && !failedTurn && !bashTurn && hasOutput
      ? turnMarker(turnStart != null ? Date.now() - turnStart : undefined)
      : null
  set((s) => {
    // 收口前把 liveStream 文本并入对应条目（流式期间文本在 liveStream，
    // 回合终态必须落回 entry.text；flushLiveStream 同时清空 liveStream）。
    const flushed = flushLiveStream(s)
    return {
      conn: 'ready',
      // Blue "待处理" until the next user message.
      statusText: '待处理',
      awaitingNext: true,
      openAssistantId: undefined,
      openThoughtId: undefined,
      turnStartedAt: undefined,
      currentPromptId: undefined,
      // Turn end: the host resolved every outstanding permission request
      // (approval timeout / completion), so a non-empty pending queue
      // here is stale — drop it (TUI drain_permission_queue).
      pending: [],
      liveStream: null,
      entries: [
        ...settleTurnEntries(flushed.entries),
        ...(marker ? [marker] : []),
      ],
    }
  })
}

// ── 收养回合开始（server-authoritative drain）───────────────────────
// agent 在回合结束时自动 pop 队首并开下一回合，广播 queue_changed 带
// running_prompt_id；applyQueueChanged 命中本地镜像行后，这里渲染该
// prompt 的用户行（与 send() 的用户行渲染同款：seal 旧流、append user
// entry、conn busy、pendingOptimisticUserId 供 user_chunk echo 吸收）。
// 绝不调 transport.prompt —— 回合已经在 agent 侧运行，本端只收养显示。
// turnIsLive 守卫：若广播晚于第一批 chunk 到达（回合已在本端流式），
// 跳过渲染，避免双锚定 / 用户行顺序错乱。
function adoptTurn(
  set: SetState,
  get: () => ChatState,
  adopted: { id: string; text: string; blocks?: ContentBlock[] },
): void {
  if (turnIsLive(get())) return
  flushStreamBuf(set, get)
  // Seal any leftover thought from prior turn, then append the user row.
  const sealedAsst = sealAssistantStream(get())
  const sealed = sealThought(sealedAsst)
  const userId = nid()
  const userEntry = {
    id: userId,
    kind: 'user' as const,
    text: adopted.text,
    ts: Date.now(),
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
    // 收养回合的身份 = 权威队列广播的 running_prompt_id（agent 侧
    // queue_meta 同 id）——终端事件按它 exact-pid 匹配。
    currentPromptId: adopted.id,
    // 新回合开始：上一回合的 suggestion chips 退役（与 send 同款）。
    followUps: undefined,
    followUpsResponseId: undefined,
    genRate: undefined,
  })
}

// ── 子代理回合收口兜底（任务 2）────────────────────────────────────
// 主回合的终态事件（done/turn_completed/cancelled/prompt_complete）理论
// 上恒带父会话 sid；但若 agent/宿主把父回合终态归属到子代理会话（已知
// child sid），init 守卫会把它路由进子代理迷你 scrollback，主回合永远
// 等不到自己的 done —— 卡在 "Responding…"。这里在已知子代理 sid 的
// 终态事件到达且父回合仍 live、无未决父活动时，武装一个延迟收口：15 秒
// 内父会话有任何推进事件（chunk/thought/tool/…）即取消（正常流程中父
// 会在子代理结束后继续输出，或自己的终态先到），只有父回合确实被遗留
// 时才触发收口。

const SUBAGENT_SETTLE_GRACE_MS = 15_000

/** 回合收口事件类型（FE 侧 turn 终态）。 */
const TURN_TERMINAL_TYPES = new Set([
  'done',
  'turn_completed',
  'cancelled',
  'prompt_complete',
])

/**
 * 父会话自身推进事件：任一到达即视为父回合仍在活动（子代理收口兜底
 * 据此取消）。子代理自身的通知（subagent_spawned/progress/finished）与
 * 连接层事件（hello/ready/status/…）不在此列。
 */
const PARENT_TURN_ACTIVITY_TYPES = new Set([
  'chunk',
  'thought',
  'tool_call',
  'tool_call_update',
  'image',
  'plan',
  'usage',
  'response_started',
  'reasoning_completed',
  'user_message',
  'user_chunk',
  'done',
  'turn_completed',
  'cancelled',
  'prompt_complete',
  'client_request',
  'client_request_resolved',
  'busy',
  'error',
])

/**
 * 子代理会话自身的推进事件：任一到达即视为该子代理仍在活动（多回合
 * 子代理的下一回合）——撤消上一终态武装的兜底。usage/status 等旁路事件
 * 不算（回合终态后紧跟的 usage 提取不能取消刚武装的兜底）。
 */
const SUBAGENT_VIEW_ACTIVITY_TYPES = new Set([
  'chunk',
  'thought',
  'tool_call',
  'tool_call_update',
  'user_message',
  'user_chunk',
  'plan',
  'image',
  'response_started',
  'reasoning_completed',
])

let subagentSettleTimer: number | null = null

function clearSubagentSettleTimer(): void {
  if (subagentSettleTimer != null) {
    window.clearTimeout(subagentSettleTimer)
    subagentSettleTimer = null
  }
}

/** 父回合是否有未决活动（open 流式条目 / 运行中工具 / 运行中 workflow）。 */
function parentTurnHasOpenActivity(s: ChatState): boolean {
  if (s.openAssistantId != null || s.openThoughtId != null) return true
  return s.entries.some(
    (e) =>
      (e.kind === 'tool' && (e.status === 'pending' || e.status === 'in_progress')) ||
      (e.kind === 'workflow' && e.running) ||
      (e.kind === 'thought' && e.streaming),
  )
}

/**
 * 武装兜底：已知子代理会话的收口事件到达且父回合 live、无未决父活动时，
 * 延迟收口父回合（触发时再复核一次同样的条件）。同一等待窗口内重复的
 * 终态事件不重复武装。
 */
function armSubagentTurnSettleFallback(
  set: SetState,
  get: () => ChatState,
): void {
  const s = get()
  if (!turnIsLive(s) || parentTurnHasOpenActivity(s)) return
  if (subagentSettleTimer != null) return
  // 武装时捕获兜底所属的父会话：定时器可能在会话切换之后才触发，而
  // finalizeTurn 作用于当前会话的 conn/entries/streamBuf——跨会话触发
  // 会把刚切换的新会话的活跃回合错误收口。
  const armedSessionId = s.sessionId
  subagentSettleTimer = window.setTimeout(() => {
    subagentSettleTimer = null
    const cur = get()
    // 会话已切换：兜底属于离开的会话，绝不为当前会话收口。
    if (cur.sessionId !== armedSessionId) return
    if (!turnIsLive(cur) || parentTurnHasOpenActivity(cur)) return
    finalizeTurn(set, get, undefined)
  }, SUBAGENT_SETTLE_GRACE_MS)
}

/**
 * HTTP 通道瞬断看门狗（回合级，对应 sendPrompt catch 的路径 2）：POST
 * /api/prompt 的 fetch 在回合中途被网络层拒绝（"Failed to fetch" / 代理
 * reset），但 live 通道（SSE/WS）仍在为同一回合输送事件——错误行是假
 * 警报，回合实际会正常收口，故武装一个兜底：若宽限期内同一回合仍
 * live 且 live 通道已断开（host 真不可达、回合卡死），才补上原错误态
 * （error 行 + conn:'error'）；回合已收口 / 会话已切换 / 新回合已开始 /
 * 通道仍开 → no-op（瞬断自愈或结果已由 live 通道渲染）。
 */
const TURN_BLIP_GRACE_MS = 10_000

let turnBlipTimer: number | null = null

function clearTurnBlipTimer(): void {
  if (turnBlipTimer != null) {
    window.clearTimeout(turnBlipTimer)
    turnBlipTimer = null
  }
}

/**
 * 武装瞬断看门狗。捕获武装时的回合身份（会话 + turnStartedAt）：触发
 * 时同一回合仍 live 才动作——回合已收口 / 新回合已开始 / 会话已切换
 * 都不该补错误态（那会污染已成功收口的视图）。
 */
function armTurnBlipWatchdog(
  set: SetState,
  get: () => ChatState,
  msg: string,
): void {
  if (turnBlipTimer != null) return
  const armedSessionId = get().sessionId
  const armedTurnStart = get().turnStartedAt
  turnBlipTimer = window.setTimeout(() => {
    turnBlipTimer = null
    const cur = get()
    if (cur.sessionId !== armedSessionId || cur.turnStartedAt !== armedTurnStart) {
      return
    }
    if (!turnIsLive(cur)) return
    // 通道仍开：回合还在正常推进（长工具调用、静默期都可能）——不动。
    if (transport.isLiveOpen()) return
    clearStreamBuf()
    set({
      ...sealThought(cur),
      pendingOptimisticUserId: undefined,
      conn: 'error',
      statusText: msg,
      awaitingNext: false,
      turnStartedAt: undefined,
      currentPromptId: undefined,
      entries: [...cur.entries, { id: nid(), kind: 'error', text: msg }],
    })
  }, TURN_BLIP_GRACE_MS)
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
 * 已加载集合里的 user 消息条数。按条数兜底分页的续翻条件用（新页无
 * user 则继续翻，直到碰到上一条 user）。按轮次路径每页必含 user，
 * 不走这条。
 */
function countUserMessages(entries: ScrollEntry[]): number {
  let n = 0
  for (const e of entries) if (e.kind === 'user') n++
  return n
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
 * 自适应分页的最大翻倍步数：页大小 = HISTORY_PAGE_SIZE << min(chained,
 * MAX_PAGE_DOUBLE_STEPS)，即 100 → 200 → 400 → 800 → 1600 封顶。
 */
const MAX_PAGE_DOUBLE_STEPS = 4

/**
 * 单次历史加载的自动翻页上限（累计条数）：loadHistory 找首条 user 消息、
 * loadMoreHistory 连续零 user 页自动续翻共用——防止纯工具归档（全会话
 * 无 user 消息）无限翻页。页大小自适应翻倍时按累计条数封顶（等效原
 * 30 页 × 100 条），而不是按页数。
 */
const MAX_AUTO_FETCH_ENTRIES = 3000

/**
 * loadHistory 首页按「回合」拉取（turnIndex）的参数：始终只拉最后
 * INITIAL_TURNS=1 个 user 回合（不设 limit，避免截断超长回合尾部）。
 * 上一条由用户上滑 loadMoreHistory 按需加载；sticky 在 user 划出视口后
 * 钉当前轮，加载完上一轮后钉新轮。
 */
const INITIAL_TURNS = 1
/**
 * loadMoreHistory 按轮次窗口的单请求上限。超过则 previousTurnWindow 返回
 * null，退化为按条数 offset 分页 + 自动续翻到上一条 user。
 * 首页 loadHistory 不再使用此上限（见上方）。
 */
const INITIAL_TURN_LIMIT = 2000

/**
 * 自适应分页页大小：基础 HISTORY_PAGE_SIZE 起步，每次续翻翻倍，封顶
 * HISTORY_PAGE_SIZE << MAX_PAGE_DOUBLE_STEPS。分页目标固定为「加载到
 * 上一条 user 消息为止」——短工具流段一两页即停，长工具流段也只需
 * 少数几次请求（而不是固定 100 条一页地多次续翻）。
 */
function adaptivePageSize(chained: number): number {
  return HISTORY_PAGE_SIZE << Math.min(chained, MAX_PAGE_DOUBLE_STEPS)
}

/**
 * 分页「还有更早」判定：优先用宿主 totalCount（total > loaded）；totalCount
 * 缺失/为 0 时回退到「整页拉满」（fetched >= 页大小）。否则宿主一旦省略
 * totalCount，hasMore 恒为 false → 按钮不出现、上滑无反应，用户看到的就是
 * 「没有滚动条、点击加载无效」。
 */
function historyHasMorePage(
  total: number | undefined,
  loaded: number,
  fetched: number,
  pageSize = HISTORY_PAGE_SIZE,
): boolean {
  if (fetched <= 0) return false
  if (total != null && total > 0) return total > loaded
  // 无 totalCount 时回退「整页拉满」判定：必须与本次请求的页大小比较
  // （页大小自适应翻倍后不再固定 HISTORY_PAGE_SIZE）。
  return fetched >= pageSize
}

/**
 * 按轮次分页：取「最老已加载轮次的前一轮」在 live timeline 上的绝对
 * 窗口 [promptStarts[k-1], min(promptStarts[k], loadedStart)）。
 *
 * **必须用绝对 offset**（正数行号），禁止 `start - total` 负 offset：
 * live 追加会抬高 totalCount，负 offset 换算出的窗口整体前移，与已加载
 * 区重叠 → 同一轮条目重复 prepend。绝对 offset 在 append-only 下稳定。
 *
 * `loadedStart`：当前已加载区最老行（钳制 end，防止与已加载区交叉）。
 *
 * 返回 null（调用方退化为按条数绝对 offset 分页）：
 * - promptStarts 缺失 / k 越界 / 无更早轮次；
 * - 窗口为空或超过单请求上限（超长回合 → 按条数分页 + 续翻到上一条 user）。
 */
function previousTurnWindow(
  promptStarts: number[] | undefined,
  k: number,
  loadedStart: number,
): { offset: number; limit: number } | null {
  if (!promptStarts || promptStarts.length === 0) return null
  if (k <= 0 || k >= promptStarts.length) return null
  if (loadedStart <= 0) return null
  const start = promptStarts[k - 1]
  // 钳到已加载起点：正常 turn 边界 end === loadedStart；offset 兜底半轮后
  // loadedStart 落在回合中间时，只取 [start, loadedStart) 尚未加载的前缀。
  const end = Math.min(promptStarts[k], loadedStart)
  const limit = end - start
  if (limit <= 0 || limit > INITIAL_TURN_LIMIT) return null
  return { offset: start, limit }
}

/**
 * offset 兜底路径上，把旧 promptStarts[oldIdx] 的边界行号映射到刷新后的
 * promptStarts 下标（live 新回合 append 时数组变长，行号不变）。找不到则
 * 保留 oldIdx（钳到新数组范围）。
 */
function remapTurnIdx(
  oldStarts: number[] | undefined,
  oldIdx: number,
  newStarts: number[] | undefined,
): number {
  if (!newStarts || newStarts.length === 0) return oldIdx
  const boundary = oldStarts?.[oldIdx]
  if (boundary != null) {
    const i = newStarts.indexOf(boundary)
    if (i >= 0) return i
  }
  return Math.min(oldIdx, newStarts.length - 1)
}

/**
 * Display name for a model id via the current catalog (id fallback).
 */
function modelDisplayName(getStore: () => ChatState, modelId: string): string {
  return getStore().models.find((m) => m.modelId === modelId)?.name || modelId
}

/**
 * `模型名(effort)` — parens only when an effort is known.
 */
function modelLabel(name: string, effort?: string | null): string {
  return effort ? `${name}(${effort})` : name
}

/**
 * Replay raw history envelopes through the live event pipeline.
 * Returns the replayed turn's metadata: the current turn's real start
 * time (authoritative `_meta.turnStartMs` from the shell, falling back
 * to the turn's earliest agentTimestampMs) and whether that turn is
 * still OPEN (no turn_completed after its start, or a new user_message
 * after the last completion — stray post-completion thought/chunk alone
 * does not keep the turn open). loadHistory uses this to restore the
 * in-flight turn timer ("回合进行中（已进行 Xs）"). Turn-end markers are
 * rendered per-turn by
 * the `turn_completed` handler: this function injects each closing turn's
 * tracked start into the event so the marker carries the true duration
 * (the `done` event is not persisted, so replay derives the duration
 * from the stored envelope stamps — turnStartMs → the completion's own
 * agentTimestampMs, the same pair the TUI's anchored elapsed reads).
 * A completion whose turn's envelopes all live in an older page (page
 * boundary cut) has no start to pair and falls back to a plain
 * "Turn completed." marker.
 *
 * opts.applyUsage (default true): whether this page may update the
 * context chip. History pages load newest-first, so only the NEWEST page
 * may apply usage — older pages (loadHistory auto-paging / loadMoreHistory)
 * must not rewrite the chip with older token counts.
 *
 * Model switch lines: the host never persists model_changed, but every
 * user_message_chunk carries `_meta.modelId` (the model that served that
 * prompt). A change between consecutive user chunks marks a switch point,
 * and a "模型已从 xx 切换到 xx" line is inserted ahead of that user row
 * (no effort info is persisted, so replay shows model names only).
 * Detection is page-local (pages replay newest-first), so a switch
 * straddling a page boundary is not caught.
 */
function replayUpdates(
  getStore: () => ChatState,
  updates: unknown[],
  opts?: { applyUsage?: boolean },
): { turnStartedAt?: number; turnOpen: boolean } {
  let userBuf = ''
  let userIsCron = false
  let userTs: number | undefined
  let turnStartTs: number | undefined
  /** Whether turnStartTs came from the authoritative _meta.turnStartMs. */
  let turnStartIsMeta = false
  let anyEvent = false
  let sawTurnEnd = false
  /**
   * After turn_completed, only a new user_message opens the next turn.
   * Stray agent_thought/chunk after completion still carry the *old*
   * turnStartMs and must not re-arm turnOpen (that froze Responding…
   * through loadMoreHistory on closed sessions).
   */
  let userAfterEnd = false
  // Model id of the last replayed user_message_chunk (page-local).
  let prevReplayModelId: string | undefined
  // Newest envelope's session-accumulated token count of this page; the
  // usage event is fired once after the loop (last envelope wins).
  let pageMetaUsed: number | undefined
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
    // context chip stays empty after restoring history. Pages are
    // fetched newest-first, so only the newest page applies it (see
    // opts.applyUsage) — otherwise the chip would end up at the OLDEST
    // page's count and every scroll-up page would rewrite it with older
    // values.
    if (opts?.applyUsage !== false) {
      const metaUsed = envelopeTotalTokens(env)
      if (metaUsed != null && metaUsed > 0) pageMetaUsed = metaUsed
    }
    // Model switch point: consecutive user chunks served by different
    // models. Insert the "模型已从 xx 切换到 xx" line BEFORE the
    // buffered user row flushes, so it renders above the first message
    // of the new model.
    const rawUp = (env as RawEnvelope).params?.update
    if (rawUp?.sessionUpdate === 'user_message_chunk') {
      const chunkMeta = rawUp._meta as Record<string, unknown> | undefined
      const mid =
        typeof chunkMeta?.modelId === 'string' && chunkMeta.modelId
          ? chunkMeta.modelId
          : undefined
      if (mid) {
        if (prevReplayModelId && prevReplayModelId !== mid) {
          getStore().appendLocalEntry({
            kind: 'session_event',
            text: `模型已从 ${modelDisplayName(getStore, prevReplayModelId)} 切换到 ${modelDisplayName(getStore, mid)}`,
            warning: true,
          })
        }
        prevReplayModelId = mid
      }
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
      userAfterEnd = false
      // Attach this closing turn's real start (tracked from the envelope
      // meta below) so the marker renders "Worked for X" / "Turn failed
      // in X" with the true duration. `endMs` is the completion's own
      // agentTimestampMs (turnCompletedEvent prefers it over the coarse
      // envelope write stamp — a late-flushed log would otherwise inflate
      // the duration by minutes). Reset the tracker so the NEXT turn's
      // start is captured from its own envelopes — the old
      // first-start→last-end pairing spanned multiple turns whenever a
      // page covered more than one closed turn.
      ev.turnStartedAt = turnStartTs
      turnStartTs = undefined
      turnStartIsMeta = false
    }
    // Authoritative turn start: the shell stamps `_meta.turnStartMs`
    // (epoch ms; the TUI tracker reads it the same way) on every streamed
    // update of the turn. Adopt it whenever it appears — a meta-carrying
    // chunk refines/overrides any agentTs fallback captured earlier in
    // the same turn. The completion envelope itself never re-opens a turn.
    // After turn_completed, ignore turnStartMs on non-user events until a
    // new user_message arrives (stray post-completion thought/chunk keeps
    // the old turn's turnStartMs and must not re-open the turn).
    if (ev.type !== 'turn_completed' && !(sawTurnEnd && !userAfterEnd)) {
      const meta = (env as RawEnvelope).params?._meta as
        | Record<string, unknown>
        | undefined
      const tsMs = meta?.turnStartMs ?? meta?.turn_start_ms
      let parsed: number | undefined
      if (typeof tsMs === 'number' && Number.isFinite(tsMs)) {
        parsed = tsMs
      } else if (typeof tsMs === 'string') {
        const p = Date.parse(tsMs)
        if (Number.isFinite(p)) parsed = p
      }
      if (parsed != null) {
        if (!turnStartIsMeta || parsed !== turnStartTs) {
          turnStartTs = parsed
          turnStartIsMeta = true
        }
      } else if (!turnStartIsMeta) {
        // Fallback: the turn's EARLIEST agent timestamp (user chunks
        // carry the prompt time; a turn-end envelope like retry_state
        // would otherwise be misread as the start). Min-refinement never
        // overrides the authoritative turnStartMs.
        let cand: number | undefined
        const ats = meta?.agentTimestampMs
        if (typeof ats === 'number' && Number.isFinite(ats) && ats > 0) {
          cand = ats
        } else if (typeof ats === 'string') {
          const p = Date.parse(ats)
          if (Number.isFinite(p)) cand = p
        }
        // No agentTs → the coarse envelope write stamp (epoch seconds).
        if (cand == null) cand = envelopeTimestamp(env as RawEnvelope)
        if (cand != null && (turnStartTs == null || cand < turnStartTs)) {
          turnStartTs = cand
        }
      }
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
      if (sawTurnEnd) userAfterEnd = true
      userBuf += ev.text
      if (ev.isCron) userIsCron = true
      if (ev.ts != null) userTs = ev.ts
      continue
    }
    flushUser()
    getStore().handleEvent(ev)
  }
  flushUser()
  // Apply the page's newest token count once (after the loop, so no
  // per-envelope chip flicker; the last envelope of the page is the
  // newest point in time).
  if (pageMetaUsed != null) {
    getStore().handleEvent({ type: 'usage', used: pageMetaUsed })
  }
  // The LAST turn is open when it never completed (no turn_completed in
  // the page), or when a *new user prompt* started after the page's last
  // completion (userAfterEnd). Stray post-completion thought/chunk alone
  // does not keep the turn open.
  return {
    turnStartedAt: turnStartTs,
    turnOpen:
      anyEvent &&
      (sawTurnEnd ? userAfterEnd && turnStartTs != null : true),
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
      return turnCompletedEvent(up, completionEndMs(e))
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
      return turnCompletedEvent(up, completionEndMs(e))
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
 * Completion end stamp: the completion envelope's own `_meta.agentTimestampMs`
 * (ms precision, the agent's turn-end time — the same stamp the TUI's
 * anchored elapsed reads). Falls back to the envelope write timestamp
 * (coarse seconds) for old logs without meta.
 */
function completionEndMs(e: RawEnvelope): number | undefined {
  const meta = (e.params?._meta ?? {}) as Record<string, unknown>
  const ats = meta.agentTimestampMs
  if (typeof ats === 'number' && Number.isFinite(ats) && ats > 0) return ats
  if (typeof ats === 'string') {
    const p = Date.parse(ats)
    if (Number.isFinite(p)) return p
  }
  return envelopeTimestamp(e)
}

/**
 * Build the typed `turn_completed` event from a stored envelope's update.
 * Carries the turn's stop_reason / agent_result (so replay can render the
 * correct marker — TurnFailed / TurnCancelled / Worked for — instead of a
 * blanket "Turn completed.") plus the completion's agentTimestampMs as the
 * turn's end stamp (replayUpdates injects the real start from the meta).
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
 * Merge the live stream into its entry (once, idempotent): writes
 * liveStream.text into the entry (entry.text += text) and clears the
 * stream. Callers run this BEFORE any seal/settle path that must see the
 * final text — sealThought, sealAssistantStream, the turn-end settles,
 * user_message (closes the assistant stream), tool_call (closes the
 * assistant stream). O(n) but only ever runs at low-frequency boundaries,
 * never per chunk.
 *
 * Pipeline stage: liveStream → entry.text (terminal flush of the stream).
 */
function flushLiveStream(s: ChatState): ChatState {
  const ls = s.liveStream
  if (!ls) return s
  if (
    import.meta.env.DEV &&
    typeof performance !== 'undefined' &&
    typeof performance.mark === 'function'
  ) {
    try {
      performance.mark('acp:stream-seal', {
        detail: { textLen: ls.text.length, entryId: ls.entryId },
      })
    } catch {
      // ignore mark option failures
    }
  }
  const next: ChatState = {
    ...s,
    liveStream: null,
    entries: s.entries.map((e) =>
      e.id === ls.entryId && 'text' in e
        ? {
            ...e,
            text: e.text + ls.text,
            // Last chunk wins (TUI tracker updates on every chunk).
            ...(ls.elapsedMs != null ? { elapsedMs: ls.elapsedMs } : {}),
          }
        : e,
    ),
  }
  return next
}

/**
 * Seal an open assistant stream mid-turn (tool_call / plan / send interrupt).
 * Merges liveStream text into its entry via flushLiveStream (once — no
 * double-append), clears openAssistantId, and sets streaming:false on the
 * assistant entry. Idempotent when no assistant is open. Does NOT seal
 * thoughts — callers chain sealThought when needed.
 * settleTurnEntries remains the turn-end path (also sets streaming:false;
 * safe / idempotent).
 */
function sealAssistantStream(s: ChatState): ChatState {
  s = flushLiveStream(s)
  if (!s.openAssistantId) {
    return s.openAssistantId === undefined
      ? s
      : { ...s, openAssistantId: undefined }
  }
  const id = s.openAssistantId
  const next: ChatState = {
    ...s,
    openAssistantId: undefined,
    // liveStream already cleared by flushLiveStream; if a foreign stream
    // somehow remained (should not), drop only if it still targets us.
    liveStream:
      s.liveStream?.entryId === id ? null : s.liveStream,
    entries: s.entries.map((e) =>
      e.id === id && e.kind === 'assistant'
        ? { ...e, streaming: false }
        : e,
    ),
  }
  assertStreamInvariants(next, 'sealAssistantStream')
  return next
}

/**
 * DEV-only stream invariant checks. No-op in production. Never throws —
 * console.warn only so a bad state is visible without breaking the turn.
 */
function assertStreamInvariants(s: ChatState, where?: string): void {
  if (!import.meta.env.DEV) return
  const tag = where ?? '?'
  const ls = s.liveStream
  if (!ls) return
  const entry = s.entries.find((e) => e.id === ls.entryId)
  if (!entry) {
    console.warn(
      `[acp stream] liveStream.entryId missing entry (${tag})`,
      ls.entryId,
    )
    return
  }
  if (entry.kind !== 'thought' && entry.kind !== 'assistant') {
    console.warn(
      `[acp stream] liveStream targets non-stream kind (${tag})`,
      entry.kind,
      ls.entryId,
    )
    return
  }
  // Prefer warn over hard fail for brief seal/race windows.
  if ('streaming' in entry && entry.streaming !== true) {
    console.warn(
      `[acp stream] liveStream targets non-streaming entry (${tag})`,
      ls.entryId,
    )
  }
  // streamBuf still holding a different kind while liveStream is set is
  // checked at flushStreamBuf time (module state not visible here).
}

/**
 * Finish an open thought block when content moves on.
 * Empty placeholder (busy fired but no thought chunks) is removed entirely.
 */
function sealThought(
  s: ChatState,
): Pick<ChatState, 'entries' | 'openAssistantId' | 'openThoughtId' | 'liveStream'> {
  // Live-streamed thought text lives OUT of entries — merge it in before
  // the empty-placeholder check and the finish bookkeeping.
  if (s.openThoughtId && s.liveStream?.entryId === s.openThoughtId) {
    s = flushLiveStream(s)
  }
  if (!s.openThoughtId) {
    return {
      entries: s.entries,
      openAssistantId: s.openAssistantId,
      openThoughtId: s.openThoughtId,
      liveStream: s.liveStream,
    }
  }
  const tid = s.openThoughtId
  const existing = s.entries.find((e) => e.id === tid)
  // Drop empty Thinking… placeholder if agent never sent thought chunks
  // (after flush, sealed text is on the entry — empty means no chunks).
  if (existing?.kind === 'thought' && !existing.text.trim()) {
    return {
      openAssistantId: s.openAssistantId,
      openThoughtId: undefined,
      liveStream: s.liveStream,
      entries: s.entries.filter((e) => e.id !== tid),
    }
  }
  return {
    openAssistantId: s.openAssistantId,
    openThoughtId: undefined,
    liveStream: s.liveStream,
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
 * 条目的可比较时间戳（epoch ms）：user/assistant/image 用 ts，
 * thought/tool/subagent 用 startedAt。无时间字段的条目（session_event、
 * status、error 等）返回 undefined，由调用方跳过。用于 recap 回填的
 * 时间就近定位。
 */
function entryTimestamp(e: ScrollEntry): number | undefined {
  switch (e.kind) {
    case 'user':
    case 'assistant':
    case 'image':
      return e.ts
    case 'thought':
    case 'tool':
    case 'subagent':
      return e.startedAt
    default:
      return undefined
  }
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
 * Apply a permission/plan-mode payload (yolo_mode_changed SSE event, the
 * session_notification tag, and the history-replay carrier) to the mode
 * flags. MERGE semantics: keys absent from the payload leave the local
 * value untouched — a partial broadcast must never wipe the optimistic
 * yoloMode/autoMode set by /auto & friends (the old overwrite-with-
 * undefined behavior is what made the composer badge flicker). The
 * permission channel is orthogonal to plan mode: only an explicit
 * permission_mode 'plan' turns planMode ON; a non-plan permission value
 * never derives planMode OFF — plan is exited via the session-mode
 * channel (modes_update/current_mode_update), the local toggle paths, or
 * the plan-approval flow, matching the TUI's "yolo/auto stay armed
 * underneath plan mode".
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
  // Within the exit_plan_mode grace window a stale pre-exit 'plan' value
  // (SSE vs. the approval HTTP round-trip are separate channels) must
  // neither resurrect planMode nor re-write permissionMode to 'plan'.
  const stalePlan = perm === 'plan' && planOnWithinGrace()
  const patch: Partial<
    Pick<ChatState, 'yoloMode' | 'autoMode' | 'permissionMode' | 'planMode'>
  > = {}
  if (yolo !== undefined) patch.yoloMode = yolo
  if (auto !== undefined) patch.autoMode = auto
  if (perm !== undefined && !stalePlan) patch.permissionMode = perm
  if (perm === 'plan' && !stalePlan) patch.planMode = true
  set(patch)
}

/** Turn always-approve ON (TUI set_yolo_mode(true) pipeline). Mode ids
 *  tried in order across host builds: always_approve → yolo →
 *  always-approve (host /api/set-mode → _x.ai/yolo_mode_changed; the
 *  agent echoes the flags back and the SSE handler refreshes the badge).
 *  Optimistic local flags mirror the echo. Returns true on success. */
async function turnOnAlwaysApprove(
  set: SetState,
  inPlan: boolean,
  sessionId?: string,
): Promise<boolean> {
  for (const modeId of ['always_approve', 'yolo', 'always-approve']) {
    try {
      await transport.setMode(modeId, sessionId)
      set({
        yoloMode: true,
        autoMode: false,
        permissionMode: undefined,
        statusText: inPlan ? '已切换到 plan·always-approve 模式' : '已切换到 always-approve 模式',
      })
      return true
    } catch {
      // try the next candidate id
    }
  }
  return false
}

/** TUI set_yolo_mode(true) queue drain: with always-approve on, every
 *  queued permission request is auto-approved with its first AllowOnce
 *  option (the prepended enable-always-approve row has kind allow_once,
 *  so it qualifies first, exactly like the TUI's drain); a request
 *  without one is cancelled (never an AllowAlways grant). Responds
 *  directly on the transport so the flip never re-fires per drained
 *  request; a failed response stays pending (the user can still answer
 *  it). */
async function drainPendingForYolo(set: SetState, get: () => ChatState): Promise<void> {
  const pending = get().pending
  if (pending.length === 0) return
  const answered = new Set<string>()
  for (const r of pending) {
    const opts = (r.params?.options as
      | Array<{ optionId?: string; kind?: string }>
      | undefined)
    const allow = opts?.find(
      (o) =>
        ALLOW_ONCE_KIND_RE.test(o.kind ?? '') ||
        ALLOW_ONCE_KIND_RE.test(o.optionId ?? ''),
    )
    try {
      await transport.respondPermission(
        r.requestId,
        allow ? allow.optionId : undefined,
        allow ? false : true,
        undefined,
        undefined,
      )
      answered.add(r.requestId)
    } catch {
      // keep it pending — the user can still answer it
    }
  }
  if (answered.size > 0) {
    set({ pending: get().pending.filter((p) => !answered.has(p.requestId)) })
  }
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
  // 子代理结束兜底：迷你视图里还挂着的流式条目（streaming 思考/回答）
  // 立即收口——回放分页截断或终态事件缺失时，表头不再停留 "Thinking…"。
  const childSid = nonBlankStr(fields.child_session_id)
  if (childSid) {
    set((s) => {
      const view = s.subagentViews[childSid]
      if (!view) return {}
      const items = sealSubagentStreaming(view.items)
      if (items === view.items) return {}
      return {
        subagentViews: {
          ...s.subagentViews,
          [childSid]: { ...view, items },
        },
      }
    })
  }
}

/** Non-empty trimmed string, or undefined. */
function nonBlankStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

// ── 子代理迷你 scrollback（subagentViews）──────────────────────────
// 宿主按 withSid 广播所有会话的 session/update 事件；子代理会话
// （child_session_id）的事件流在这里被还原成子代理自己的活动时间线
// （TUI subagent_views 同款）。条目直接构造为主 scrollback 的
// ScrollEntry 模型（tool 条目与 handleEvent 的 tool_call 分支同构）——
// BlockViewer 的迷你时间线复用主渲染体系（scanGroups/projectDisplayRows
// → EntryShell/AccentRail/Bullet），不再自造一套条目与样式。live 事件
// 与按需历史回放（fetchSubagentView）共用同一个处理器。

/**
 * 子代理视图的分页大小（首次回放与上滑分页统一，与主 scrollback 的
 * HISTORY_PAGE_SIZE 同量级）。不设条目上限——完整历史由用户上滑分页获取，
 * 不再丢弃最旧条目。
 */
const SUBAGENT_VIEW_PAGE_SIZE = 100

/**
 * 子代理流式条目即时收口（与主 scrollback sealThought / sealAssistantStream
 * 对齐）：thought → assistant / tool_call / plan 等推进事件到达时立即收口
 * 进行中的思考/回答段，而不是等到回合终态 done——否则运行中的每个
 * thinking 段都挂着 "Thinking…" 表头直到回合结束（TUI finish_thinking
 * on tool start 同款）。无变化时返回原引用（不触发 store 更新）。
 */
function sealSubagentStreaming(items: ScrollEntry[]): ScrollEntry[] {
  let changed = false
  const sealed = items.map((it) => {
    if (it.kind === 'assistant' && it.streaming) {
      changed = true
      return { ...it, streaming: false }
    }
    if (it.kind === 'thought' && it.streaming) {
      changed = true
      return {
        ...it,
        streaming: false,
        displayMode: 'collapsed' as const,
        finishedAt: Date.now(),
        elapsed:
          it.startedAt != null ? formatElapsed(Date.now() - it.startedAt) : it.elapsed,
      }
    }
    return it
  })
  return changed ? sealed : items
}

/** 子代理视图的时间线末尾追加一条（不设条目上限——由用户上滑分页控制）。 */
function subagentViewPush(
  items: ScrollEntry[],
  item: ScrollEntry,
): ScrollEntry[] {
  return [...items, item]
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
 * 子代理事件流 → 主模型 ScrollEntry 条目（不可变 reducer）。仅处理
 * scrollback 相关类型：user/assistant/thought/tool/plan/image + 回合
 * 收口；其余忽略（usage/status/hello/… 与宿主 scrollback 无关）。
 * 回合收口标记用 session_event 条目（主 scrollback 同款形态）。
 */
function subagentViewAppend(
  items: ScrollEntry[],
  ev: AcpEvent,
): ScrollEntry[] {
  switch (ev.type) {
    case 'user_message': {
      const text = ev.text ?? ''
      if (!text.trim()) return items
      return subagentViewPush(items, {
        id: nid(),
        kind: 'user',
        text,
        ts: ev.ts,
        expanded: false,
      })
    }
    case 'user_chunk': {
      if (ev.hideFromScrollback === true) return items
      const text = (ev.displayText ?? ev.text) || ''
      if (!text.trim()) return items
      // 用户插话 = 流切换，先收口挂着的思考/回答段。
      const sealed = sealSubagentStreaming(items)
      // 同一用户回合的连续 chunk 聚合进最后一条 user（主 scrollback 同款）。
      const last = sealed[sealed.length - 1]
      if (last && last.kind === 'user') {
        const next = [...sealed]
        next[next.length - 1] = { ...last, text: last.text + text }
        return next
      }
      return subagentViewPush(sealed, {
        id: nid(),
        kind: 'user',
        text,
        expanded: false,
      })
    }
    case 'chunk': {
      const text = ev.text ?? ''
      if (!text) return items
      const last = items[items.length - 1]
      if (last && last.kind === 'assistant' && last.streaming) {
        const next = [...items]
        next[next.length - 1] = { ...last, text: last.text + text, streaming: true }
        return next
      }
      // 流切换：thinking 段结束进入回答段 → 先收口思考（主 scrollback
      // 流切换 seal 同款），回答段新起一条。
      const sealed = sealSubagentStreaming(items)
      return subagentViewPush(sealed, {
        id: nid(),
        kind: 'assistant',
        text,
        streaming: true,
        ts: ev.ts,
      })
    }
    case 'thought': {
      const text = ev.text ?? ''
      if (!text) return items
      const last = items[items.length - 1]
      if (last && last.kind === 'thought' && last.streaming) {
        const next = [...items]
        next[next.length - 1] = { ...last, text: last.text + text, streaming: true }
        return next
      }
      // 新思考段：先收口前面挂着的流（多段思考/回放防御），再开新条目。
      return subagentViewPush(sealSubagentStreaming(items), {
        id: nid(),
        kind: 'thought',
        text,
        streaming: true,
        displayMode: 'expanded',
        startedAt: Date.now(),
      })
    }
    case 'tool_call': {
      // 工具开始 = 思考/回答段即时收口（TUI finish_thinking on tool
      // start，主 scrollback tool_call 分支 sealThought 同款）——否则
      // 运行中的每段 thinking 都挂着 "Thinking…" 直到回合终态。
      const sealed = sealSubagentStreaming(items)
      const tc = ev.toolCall || {}
      const item = subagentToolItem(tc)
      // 同 toolCallId 重复到达时原地替换，避免双行。
      const idx = item.toolCallId
        ? sealed.findIndex(
            (it) => it.kind === 'tool' && it.toolCallId === item.toolCallId,
          )
        : -1
      if (idx >= 0) {
        const next = [...sealed]
        next[idx] = item
        return next
      }
      return subagentViewPush(sealed, item)
    }
    case 'tool_call_update': {
      // 工具行更新同样视为思考段推进（回放/边界防御），先收口挂着的流。
      const sealed = sealSubagentStreaming(items)
      const tc = ev.toolCallUpdate || {}
      const toolCallId = toolCallIdOf(tc)
      if (toolCallId) {
        const idx = sealed.findIndex(
          (it) => it.kind === 'tool' && it.toolCallId === toolCallId,
        )
        if (idx >= 0) {
          const existing = sealed[idx]
          if (existing.kind === 'tool') {
            // 与主 scrollback 相同：update 的字段合并进 raw，标题/动词重算。
            const merged: ToolCall = { ...(existing.raw || {}), ...tc }
            const next = [...sealed]
            next[idx] = subagentToolItem(merged, existing)
            return next
          }
        }
      }
      // 未找到对应条目（回放分页边界）：按首次 tool_call 追加。
      return subagentViewAppend(sealed, { type: 'tool_call', toolCall: tc })
    }
    case 'plan':
      // plan 展示 = 流切换（主 scrollback plan 分支同样收口思考段）。
      return subagentViewPush(sealSubagentStreaming(items), {
        id: nid(),
        kind: 'plan',
        entries: ev.entries,
      })
    case 'image': {
      const src = imageSrc(ev.data, ev.mimeType)
      if (!src) return items
      return subagentViewPush(sealSubagentStreaming(items), {
        id: nid(),
        kind: 'image',
        data: src,
        mimeType: ev.mimeType,
        ts: ev.ts,
      })
    }
    case 'done':
    case 'turn_completed':
    case 'cancelled': {
      // 回合收口：assistant/thought 停止 streaming（thought 与主 scrollback
      // settleTurnEntries 一致：折叠 + 本地 elapsed），追加回合结束标记——
      // 主 scrollback 同款：turn 标记用 session_event 条目。
      const sealed = sealSubagentStreaming(items)
      const marker: ScrollEntry = {
        id: nid(),
        kind: 'session_event',
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

/** 从 ToolCall 构造主 scrollback 同款的 tool 条目（title/verb/status/raw，
 *  与 handleEvent 的 tool_call / tool_call_update 分支同构）。 */
function subagentToolItem(
  tc: ToolCall,
  prev?: Extract<ScrollEntry, { kind: 'tool' }>,
): Extract<ScrollEntry, { kind: 'tool' }> {
  const status = (tc.status as string) || prev?.status || 'pending'
  const kindName = (tc.kind as string) || prev?.kindName || 'other'
  const running = status === 'pending' || status === 'in_progress'
  return {
    id: prev?.id ?? nid(),
    kind: 'tool',
    toolCallId: toolCallIdOf(tc) ?? prev?.toolCallId,
    title: extractTarget(tc) || (tc.title as string) || kindName,
    verb: toolVerb(kindName, running),
    status,
    kindName,
    expanded: false,
    raw: tc,
    // 活动起点（epoch ms）——主 scrollback 相位计时器同款；运行中才打。
    ...(running && !prev ? { startedAt: Date.now() } : {}),
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
