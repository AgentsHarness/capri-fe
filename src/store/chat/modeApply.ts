import { transport } from '../../api/localTransport'
import type { ChatState, SetState } from './types'
import { planOnWithinGrace } from './modePersist'

/** Global permission-mode flags (single object, all sessions share it). */
export const ENABLE_ALWAYS_APPROVE_OPTION_ID = 'enable-always-approve'

/** Wire kind of the ACP AllowOnce option (serde snake_case — the fake
 *  host ships `"kind": "allow_once"`; the prompter's option ids are the
 *  kebab form `allow-once`). Matches both. */
export const ALLOW_ONCE_KIND_RE = /^allow[-_]once$/i

/** Known non-plan permission modes (a `permissionMode` payload with one of
 *  these means the agent is NOT in plan mode). */
export const NON_PLAN_MODES = new Set([
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
export function extractModeFlags(
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
export function sessionModesPatch(
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

export function applyModeFlags(set: SetState, p: Record<string, unknown>): void {
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
export async function turnOnAlwaysApprove(
  set: SetState,
  inPlan: boolean,
  sessionId?: string,
): Promise<boolean> {
  set({
    yoloMode: true,
    autoMode: false,
    permissionMode: undefined,
    statusText: inPlan ? '已切换到 plan·always-approve 模式' : '已切换到 always-approve 模式',
  })
  for (const modeId of ['always-approve', 'always_approve', 'yolo']) {
    try {
      await transport.setMode(modeId, sessionId)
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
export async function drainPendingForYolo(set: SetState, get: () => ChatState): Promise<void> {
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
