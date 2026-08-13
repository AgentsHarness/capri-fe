import {
  loadJSON,
  loadStr,
  removeKey,
  saveJSON,
  saveStr,
} from '../../lib/storage'
import { transport } from '../../api/client'
import { ensureUiSettings, uiBool, uiSettingsLoaded } from '../settings'
import type { ChatState, ModeFlags, SetState } from './types'

/** Global permission-mode flags (single object, all sessions share it). */
export const MODE_FLAGS_KEY = 'acpfe.modeFlags'
/** Per-session plan-mode copies (replay/current_mode_update is the authority). */
export const PLAN_FLAGS_KEY = 'acpfe.planModes'

/**
 * Normalize mode flags for persistence: default-y permission values need
 * no record. A saved permissionMode 'ask'/'default'/'normal' would sit in
 * the record shadowing nothing itself (the composer filters those) but a
 * stale 'ask' written over optimistic flags would suppress the composer
 * badge after a resume even when the agent is actually always-approve.
 * Also applied on read so old records written before this rule clean up.
 */
export function normalizeModeFlags(flags: ModeFlags): ModeFlags {
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

export function loadGlobalModeFlags(): ModeFlags {
  const parsed = loadJSON<unknown>(MODE_FLAGS_KEY, {})
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  // 白名单提取：只认权限三字段，其余一律忽略——旧格式（per-session
  // map）或未知结构读出来就是 {}，绝不把杂散 key 展开进 store。
  const o = parsed as Record<string, unknown>
  return normalizeModeFlags({
    yoloMode: typeof o.yoloMode === 'boolean' ? o.yoloMode : undefined,
    autoMode: typeof o.autoMode === 'boolean' ? o.autoMode : undefined,
    permissionMode: typeof o.permissionMode === 'string' ? o.permissionMode : undefined,
  })
}

/** Persist the GLOBAL permission-mode flags (shared by every session). */
export function saveModeFlags(flags: ModeFlags): void {
  saveJSON(MODE_FLAGS_KEY, normalizeModeFlags(flags))
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

// ── client-global default permission mode (config.toml ui.permission_mode) ──
// Seeds NEW sessions (session/new `_meta`) AND the composer badge when
// the host hello snapshot is still the spawn default `ask`. Host records
// permMode only on set-mode / yolo_mode_changed — it resets to ask on
// agent spawn and never copies `[ui] permission_mode`, so treating hello
// `ask` as authority would hide a config default of always-approve.
// Precedence mirrors the TUI's load_permission_mode: permission_mode >
// legacy approval_mode > yolo=true.

/** Map a settings `ui` section to permission flags ({} = no default). */
export function permissionFlagsFromUi(ui?: Record<string, unknown>): ModeFlags {
  if (!ui) return {}
  const perm = typeof ui.permission_mode === 'string' ? ui.permission_mode : undefined
  if (perm === 'always-approve') {
    return { yoloMode: true, autoMode: false, permissionMode: 'always-approve' }
  }
  if (perm === 'auto') {
    return { yoloMode: false, autoMode: true, permissionMode: 'auto' }
  }
  // 'default' / 'ask' / unknown → no client default (agent's own default).
  if (perm === undefined) {
    const legacy = typeof ui.approval_mode === 'string' ? ui.approval_mode : undefined
    if (legacy === 'always-approve') {
      return { yoloMode: true, autoMode: false, permissionMode: 'always-approve' }
    }
    if (legacy === 'auto') {
      return { yoloMode: false, autoMode: true, permissionMode: 'auto' }
    }
    if (ui.yolo === true) {
      return { yoloMode: true, autoMode: false, permissionMode: 'always-approve' }
    }
  }
  return {}
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
 * Effective flags for a NEW session / badge: the current global
 * permission mode wins; with none known yet, fall back to config.toml.
 */
export function sessionModeFlags(saved: ModeFlags, defaults: ModeFlags): ModeFlags {
  return saved.yoloMode !== undefined || saved.autoMode !== undefined ? saved : defaults
}

/**
 * Composer / store flags after a hello snapshot. Host non-ask is
 * authority. Snapshot `ask` is the unseeded spawn default — keep last
 * known non-ask (or the config.toml default) so the badge matches TUI
 * launch (`[ui] permission_mode = always-approve` shows immediately).
 */
export function resolveDisplayModeFlags(
  saved: ModeFlags,
  defaults: ModeFlags,
  snap: ModeFlags,
): ModeFlags {
  if (snap.yoloMode === true || snap.autoMode === true) return snap
  const known = sessionModeFlags(saved, defaults)
  if (known.yoloMode === true || known.autoMode === true) {
    return {
      yoloMode: known.yoloMode === true,
      autoMode: known.autoMode === true && known.yoloMode !== true,
      permissionMode: known.yoloMode === true ? 'always-approve' : 'auto',
    }
  }
  return snap
}

/** TUI [ui] collapsed_edit_blocks — read from the shared settings cache. */
export function collapsedEditBlocks(): boolean {
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
// TUI re-applies `[ui] permission_mode` at launch and shows the chip
// immediately. FE mirrors that: a new `agentStartedAt` (including first
// contact) drops the stale localStorage copy, then maybeReseed pushes
// last-known non-ask flags or the config.toml default back onto the
// agent AND the composer badge. A hello snapshot of auto / always-approve
// stays authoritative (another client already seeded). Snapshot `ask` is
// the unseeded spawn default — it must NOT wipe a config default of
// always-approve (host never records session/new `_meta` seeds).
export const LAST_AGENT_STARTED_KEY = 'acpfe.lastAgentStartedAt'

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
export const RESEED_STAMP_KEY = 'acpfe.permissionReseededFor'

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
 * After hello: if the painted mode is last-known / config.toml non-ask
 * while the host snapshot is still ask (fresh spawn, or host never
 * recorded a session/new `_meta` seed), push it to the agent so the
 * host mirror and the composer badge stay in sync. TUI-parity re-seed.
 *
 * setMode runs at most once per agent instance. Shift+Tab bumps
 * `reseedGen` so an in-flight re-seed cannot overwrite a user cycle.
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
  const display = resolveDisplayModeFlags(opts.saved, defaults, snap)
  if (display.yoloMode !== true && display.autoMode !== true) return
  const cur = get()
  if (cur.yoloMode !== display.yoloMode || cur.autoMode !== display.autoMode) {
    set(display)
  }
  const seed = permissionSeedMeta(display)
  if (!seed) return
  const stamp = currentAgentStamp()
  if (alreadyReseeded(stamp)) return
  if (gen !== reseedGen) return
  try {
    if (seed.yoloMode) {
      for (const modeId of ['always-approve', 'always_approve', 'yolo']) {
        try {
          await transport.setMode(modeId, get().sessionId)
          if (gen === reseedGen) markReseeded(stamp)
          return
        } catch {
          /* try next host-build id */
        }
      }
    } else {
      await transport.setMode('auto', get().sessionId)
      if (gen === reseedGen) markReseeded(stamp)
    }
  } catch {
    /* display already applied; seed is best-effort */
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
