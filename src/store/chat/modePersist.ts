import {
  loadJSON,
  loadStr,
  removeKey,
  saveJSON,
  saveStr,
} from '../../lib/storage'
import { transport } from '../../api/client'
import { ensureUiSettings, refreshUiSettings, uiBool, uiSettingsLoaded } from '../settings'
import { isEditToolKind } from '../../theme/toolFamily'
import type { ChatState, ModeFlags, SetState } from './types'
import { KEY } from '../../lib/keys'

/** Global permission-mode flags (single object, all sessions share it). */
export const MODE_FLAGS_KEY = KEY.modeFlags
/** Per-session plan-mode copies (replay/current_mode_update is the authority). */
export const PLAN_FLAGS_KEY = KEY.planModes

/**
 * Normalize mode flags for persistence: only a confirmed non-ask write
 * (yolo/auto true) or an explicit ask write (`confirmedAsk`) is a record.
 * Hello-ask echos land as `{ yoloMode: false, autoMode: false }` — those
 * are the agent's default, not a client write, and must not shadow
 * config.toml on maybeReseed. Applied on read so old false-only records
 * clean up to {}.
 */
export function normalizeModeFlags(flags: ModeFlags): ModeFlags {
  const out: ModeFlags = {}
  if (flags.yoloMode === true) out.yoloMode = true
  if (flags.autoMode === true) out.autoMode = true
  if (
    typeof flags.permissionMode === 'string' &&
    flags.permissionMode &&
    flags.permissionMode !== 'ask' &&
    flags.permissionMode !== 'default' &&
    flags.permissionMode !== 'normal'
  ) {
    out.permissionMode = flags.permissionMode
  }
  if (!out.yoloMode && !out.autoMode && flags.confirmedAsk === true) {
    out.confirmedAsk = true
  }
  return out
}

export function loadGlobalModeFlags(): ModeFlags {
  const parsed = loadJSON<unknown>(MODE_FLAGS_KEY, {})
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  // 白名单提取：只认权限字段，其余一律忽略——旧格式（per-session
  // map）或未知结构读出来就是 {}，绝不把杂散 key 展开进 store。
  const o = parsed as Record<string, unknown>
  return normalizeModeFlags({
    yoloMode: typeof o.yoloMode === 'boolean' ? o.yoloMode : undefined,
    autoMode: typeof o.autoMode === 'boolean' ? o.autoMode : undefined,
    permissionMode: typeof o.permissionMode === 'string' ? o.permissionMode : undefined,
    confirmedAsk: o.confirmedAsk === true,
  })
}

/** Persist the GLOBAL permission-mode flags (shared by every session). */
export function saveModeFlags(flags: ModeFlags): void {
  const n = normalizeModeFlags(flags)
  if (n.yoloMode !== true && n.autoMode !== true && n.confirmedAsk !== true) {
    // Empty / hello-ask: drop the key so sessionModeFlags falls through
    // to config.toml instead of treating false booleans as a write.
    removeKey(MODE_FLAGS_KEY)
    return
  }
  saveJSON(MODE_FLAGS_KEY, n)
}

/**
 * Persist a client-confirmed permission write (setMode / settings /
 * yolo_mode_changed echo). Non-ask → yolo/auto flags; ask/normal →
 * `confirmedAsk` so a later maybeReseed does not re-push config.toml.
 */
export function persistConfirmedPermission(flags: ModeFlags): void {
  if (flags.yoloMode === true || flags.autoMode === true) {
    saveModeFlags({
      yoloMode: flags.yoloMode,
      autoMode: flags.autoMode,
      permissionMode: flags.permissionMode,
    })
    return
  }
  saveModeFlags({ confirmedAsk: true })
}

/** The global permission-mode flags this client last knew ({} when unknown). */
export function restoreModeFlags(): ModeFlags {
  return loadGlobalModeFlags()
}

export function loadPlanModes(): Record<string, boolean> {
  const parsed = loadJSON<Record<string, boolean>>(PLAN_FLAGS_KEY, {})
  return parsed && typeof parsed === 'object' ? parsed : {}
}

/** Persist one session's plan-mode copy (replay is the authority, this is a hint). */
export function savePlanMode(sessionId: string, planMode: boolean): void {
  const map = loadPlanModes()
  map[sessionId] = planMode
  saveJSON(PLAN_FLAGS_KEY, map)
}

/** Clear one session's plan-mode copy. */
export function clearPlanMode(sessionId?: string): void {
  if (!sessionId) return
  const map = loadPlanModes()
  if (sessionId in map) {
    delete map[sessionId]
    saveJSON(PLAN_FLAGS_KEY, map)
  }
}

/** Restore one session's plan-mode copy ({} when unknown). */
export function restorePlanMode(sessionId?: string): Partial<Pick<ChatState, 'planMode'>> {
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
export const PLAN_EXIT_GRACE_MS = 1500
export let planExitApprovedAt = 0
export function planOnWithinGrace(): boolean {
  return Date.now() - planExitApprovedAt < PLAN_EXIT_GRACE_MS
}

// ── client-global default permission mode (config.toml [ui]) ──
// Used to SEED the agent (session/new `_meta` / maybeReseed setMode).
// The composer badge does NOT read this — it only shows agent-confirmed
// state (hello / yolo_mode_changed / a setMode that already succeeded).
// Parse contract = TUI `permission_mode_from_ui_if_set`: any of the three
// keys present is an explicit setting; precedence permission_mode >
// approval_mode > yolo; unknown / "default" / yolo=false → Ask.

const UI_PERMISSION_MODE_KEYS = ['permission_mode', 'approval_mode', 'yolo'] as const

const ASK_FLAGS: ModeFlags = { yoloMode: false, autoMode: false }
const YOLO_FLAGS: ModeFlags = {
  yoloMode: true,
  autoMode: false,
  permissionMode: 'always-approve',
}
const AUTO_FLAGS: ModeFlags = {
  yoloMode: false,
  autoMode: true,
  permissionMode: 'auto',
}

function uiHas(ui: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(ui, key)
}

/** Map a settings `ui` section to permission flags ({} = no key set). */
export function permissionFlagsFromUi(ui?: Record<string, unknown>): ModeFlags {
  if (!ui) return {}
  if (!UI_PERMISSION_MODE_KEYS.some((k) => uiHas(ui, k))) return {}

  if (typeof ui.permission_mode === 'string') {
    if (ui.permission_mode === 'always-approve') return { ...YOLO_FLAGS }
    if (ui.permission_mode === 'auto') return { ...AUTO_FLAGS }
    return { ...ASK_FLAGS }
  }

  if (typeof ui.approval_mode === 'string') {
    // TUI legacy: only "always-approve" is AlwaysApprove; everything else Ask.
    return ui.approval_mode === 'always-approve' ? { ...YOLO_FLAGS } : { ...ASK_FLAGS }
  }

  if (ui.yolo === true) return { ...YOLO_FLAGS }
  // Key present (including yolo = false) → explicit Ask, so a remote /
  // last-known always-approve cannot win.
  return { ...ASK_FLAGS }
}

export type PermissionModeLabel = 'ask' | 'auto' | 'always-approve'

/** Canonical label for flags — same function the settings row and `_meta` share. */
export function permissionLabelFromFlags(flags: ModeFlags): PermissionModeLabel {
  if (flags.yoloMode === true) return 'always-approve'
  if (flags.autoMode === true) return 'auto'
  return 'ask'
}

/** Effective default the next seed will use (no key → agent Ask). */
export function effectivePermissionLabelFromUi(
  ui?: Record<string, unknown>,
): PermissionModeLabel {
  return permissionLabelFromFlags(permissionFlagsFromUi(ui))
}

export let cachedDefaultModeFlags: ModeFlags | undefined
export let cachedDefaultFlagsPromise: Promise<ModeFlags> | null = null

/**
 * Fetch the client-global default permission flags (host /api/settings,
 * shared cache in settings.ts). A FAILED fetch is NOT cached: the abort
 * window during host-switch / reconnect (abortInflight kills in-flight
 * fetches) must not permanently lose the config default — the next
 * caller simply retries. Only a resolved settings payload marks the
 * default as loaded.
 */
/** Keep the permission-default cache in lockstep after a settings write. */
export function syncDefaultModeFlagsFromUi(ui: Record<string, unknown>): void {
  cachedDefaultModeFlags = permissionFlagsFromUi(ui)
  cachedDefaultFlagsPromise = Promise.resolve(cachedDefaultModeFlags)
}

export function ensureDefaultModeFlags(): Promise<ModeFlags> {
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
 * Re-read `[ui]` for the CURRENT host and re-derive the permission default.
 * Called on host selection: the eager boot prefetch runs before a host is
 * chosen (hub mode) and gets cancelled by the setHost abort storm anyway,
 * and a `[ui]` section cached from another host must not leak across.
 */
export function refreshDefaultModeFlags(): Promise<void> {
  return refreshUiSettings().then((ui) => {
    if (ui) syncDefaultModeFlagsFromUi(ui)
  })
}

/**
 * hello 快照的权威权限模式（host 记录，canonical ask/auto/always-approve）
 * → store flags。无条件映射：ask 也显式给出（清掉 stale 的 yolo/auto），
 * 因为 host 的记录就是 agent 的真实状态——agent 内存态、经 host 每次
 * 变更与回显更新、随 agent 重启复位为 ask。缺字段（老 host / hub 直连）
 * 返回 {} 不干预。
 */
export function permissionModeFromSnapshot(mode: unknown): ModeFlags {
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
 * Seed source for maybeReseed: last-known *write* to this client, else
 * the config.toml default. Not used to paint the badge.
 *
 * `yoloMode: false` / `autoMode: false` is NOT a write — that is the
 * hello-ask echo (agent default). Treating it as last-known used to
 * shadow a config.toml `always-approve` / `auto` and skip reseed, so
 * the composer badge never appeared.
 */
export function sessionModeFlags(saved: ModeFlags, defaults: ModeFlags): ModeFlags {
  if (saved.yoloMode === true || saved.autoMode === true) return saved
  if (saved.confirmedAsk === true) return ASK_FLAGS
  return defaults
}

/**
 * Live badge flags. Only agent-confirmed state:
 * - hello / yolo_mode_changed non-ask is authority
 * - hello ask: keep a write already accepted by THIS agent instance
 *   (`confirmedWrite` + saved non-ask); otherwise apply ask
 * Never paints config.toml. A failed / in-flight seed stays ask.
 */
export function resolveDisplayModeFlags(
  saved: ModeFlags,
  snap: ModeFlags,
  opts?: { confirmedWrite?: boolean },
): ModeFlags {
  if (snap.yoloMode === true || snap.autoMode === true) return snap
  if (opts?.confirmedWrite) {
    if (saved.yoloMode === true) return { ...YOLO_FLAGS }
    if (saved.autoMode === true) return { ...AUTO_FLAGS }
  }
  return snap
}

/** TUI [ui] collapsed_edit_blocks — read from the shared settings cache. */
export function collapsedEditBlocks(): boolean {
  return uiBool('collapsed_edit_blocks', false)
}

/**
 * Last rematerialized flag. Starts as the `uiBool` default (false) so a
 * history replay that lands before GET /api/settings can be flipped once
 * the cache arrives (TUI `apply_collapsed_edit_blocks_flip`).
 */
let lastAppliedCollapsedEditBlocks = false

function remapEditExpanded(
  entries: ChatState['entries'],
  oldExpanded: boolean,
  newExpanded: boolean,
): { entries: ChatState['entries']; changed: boolean } {
  let changed = false
  const next = entries.map((e) => {
    if (e.kind !== 'tool' || !isEditToolKind(e.kindName)) return e
    // Still on the old policy default — a user ←/→ / click away from it
    // survives (TUI: gesture is indistinguishable from "folded back to
    // the old default" and those do flip).
    if (!!e.expanded !== oldExpanded) return e
    changed = true
    // displayMode 与 expanded 布尔同步镜像（toolDisplayMode 读侧优先
    // displayMode，只写布尔会把钉在三态档上的行洗错）。
    return {
      ...e,
      expanded: newExpanded,
      displayMode: newExpanded
        ? ('expanded' as const)
        : ('collapsed' as const),
    }
  })
  return { entries: changed ? next : entries, changed }
}

/**
 * TUI `apply_collapsed_edit_blocks_flip`: rematerialize Edit rows still
 * sitting on the old policy default. Does not merge / unmerge already
 * landed rows (TUI tracker: ingestion-time only).
 */
export function applyCollapsedEditBlocksFlip(
  set: SetState,
  oldFlag: boolean,
  newFlag: boolean,
): void {
  if (oldFlag === newFlag) return
  lastAppliedCollapsedEditBlocks = newFlag
  const oldExpanded = !oldFlag
  const newExpanded = !newFlag
  set((s) => {
    const main = remapEditExpanded(s.entries, oldExpanded, newExpanded)
    let views = s.subagentViews
    let viewsChanged = false
    for (const [sid, view] of Object.entries(s.subagentViews)) {
      const r = remapEditExpanded(view.items, oldExpanded, newExpanded)
      if (!r.changed) continue
      if (!viewsChanged) {
        views = { ...s.subagentViews }
        viewsChanged = true
      }
      views[sid] = { ...view, items: r.entries }
    }
    if (!main.changed && !viewsChanged) return {}
    return {
      ...(main.changed ? { entries: main.entries } : {}),
      ...(viewsChanged ? { subagentViews: views } : {}),
      // Collapsed Edits join verb groups; drop stale group-expansion ids
      // (TUI `clear_group_expansion` on the same flip).
      expandedGroups: new Set(),
    }
  })
}

/** Rematerialize if the cached `[ui]` flag moved since last apply. */
export function applyCollapsedEditBlocksFromCache(set: SetState): void {
  const next = collapsedEditBlocks()
  if (next === lastAppliedCollapsedEditBlocks) return
  applyCollapsedEditBlocksFlip(set, lastAppliedCollapsedEditBlocks, next)
}

/**
 * Permission seeds for session/new|load `_meta` (TUI absent-key ≠ off:
 * only send when a flag is actually known). yolo wins over auto — the
 * two are mutually exclusive on the wire. A false-only record (= ask,
 * the agent's own default) is NOT a seed: the restart re-seed used to
 * map it through setMode(seed.yoloMode ? 'always-approve' : 'auto'),
 * silently switching an always-approve-configured agent to auto.
 */
export function permissionSeedMeta(
  flags: ModeFlags,
): { yoloMode: boolean; autoMode: boolean } | undefined {
  if (flags.yoloMode !== true && flags.autoMode !== true) return undefined
  return {
    yoloMode: flags.yoloMode === true,
    autoMode: flags.autoMode === true && flags.yoloMode !== true,
  }
}

// ── agent-restart follow ────────────────────────────────────────────
// The agent's permission mode lives in ITS process memory only — host
// restart resets the host mirror to ask (it does not read config.toml).
// maybeReseed pushes last-known / config.toml onto the agent; the
// composer badge updates only after setMode succeeds (or hello already
// reported non-ask). Painting before the write is a false always-approve.
export const LAST_AGENT_STARTED_KEY = KEY.lastAgentStartedAt

export function consumeAgentInstance(agentStartedAt: number | undefined): {
  restarted: boolean
  saved: ModeFlags
} {
  const saved = restoreModeFlags()
  if (typeof agentStartedAt !== 'number' || agentStartedAt <= 0) {
    return { restarted: false, saved }
  }
  let prev: string | null = loadStr(LAST_AGENT_STARTED_KEY)
  if (prev === String(agentStartedAt)) {
    return { restarted: false, saved }
  }
  saveStr(LAST_AGENT_STARTED_KEY, String(agentStartedAt))
  removeKey(MODE_FLAGS_KEY)
  return { restarted: true, saved }
}

export let reseedGen = 0
/** Agent stamp we already pushed a config/last-known seed for. Shared
 *  across reloads so a refresh does not fire another setMode (that RPC
 *  was serializing with Shift+Tab and making cycleMode feel lagged). */
export const RESEED_STAMP_KEY = KEY.permissionReseededFor

export function currentAgentStamp(): string | null {
  return loadStr(LAST_AGENT_STARTED_KEY)
}

export function alreadyReseeded(stamp: string | null): boolean {
  if (!stamp) return false
  return loadStr(RESEED_STAMP_KEY) === stamp
}

export function markReseeded(stamp: string | null): void {
  if (!stamp) return
  saveStr(RESEED_STAMP_KEY, stamp)
}

/**
 * After hello: if the host snapshot is still ask, push last-known /
 * config.toml non-ask onto the agent. The badge stays ask until setMode
 * succeeds — Shift+Tab bumps `reseedGen` so an in-flight seed cannot
 * overwrite a user cycle. At most one setMode per agent instance.
 */
export async function maybeReseedPermissionMode(
  set: SetState,
  get: () => ChatState,
  opts: { saved: ModeFlags; snapshotMode: unknown },
): Promise<void> {
  const gen = ++reseedGen
  const defaults = await ensureDefaultModeFlags()
  if (gen !== reseedGen) return
  const snap = permissionModeFromSnapshot(opts.snapshotMode)
  if (snap.yoloMode === true || snap.autoMode === true) {
    markReseeded(currentAgentStamp())
    return
  }
  const seedFrom = sessionModeFlags(opts.saved, defaults)
  const seed = permissionSeedMeta(seedFrom)
  if (!seed) return
  const stamp = currentAgentStamp()
  if (alreadyReseeded(stamp)) return
  if (gen !== reseedGen) return
  const paint = (flags: ModeFlags) => {
    if (gen !== reseedGen) return
    markReseeded(stamp)
    set({ ...flags })
    // historyLoading skips the store subscriber — persist here so the
    // successful write survives a refresh even if replay is in flight.
    persistConfirmedPermission(flags)
  }
  try {
    if (seed.yoloMode) {
      for (const modeId of ['always-approve', 'always_approve', 'yolo']) {
        try {
          await transport.setMode(modeId, get().sessionId)
          paint(YOLO_FLAGS)
          return
        } catch {
          /* try next host-build id */
        }
      }
    } else {
      await transport.setMode('auto', get().sessionId)
      paint(AUTO_FLAGS)
    }
  } catch {
    /* leave the badge as the agent echo; do not paint a failed write */
  }
}

export function bumpReseedGen(): number {
  return ++reseedGen
}

export function currentReseedGen(): number {
  return reseedGen
}

export function markPlanExitApproved(): void {
  planExitApprovedAt = Date.now()
}
