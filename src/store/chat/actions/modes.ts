import { transport } from '../../../api/client'
import type { ChatState, SetState } from '../types'
import {
  bumpReseedGen,
  currentReseedGen,
  drainPendingForYolo,
  ENABLE_ALWAYS_APPROVE_OPTION_ID,
  markPlanExitApproved,
  turnOnAlwaysApprove,
} from '../modeFlags'
import { appendEntry } from '../entries'
import { pushToast } from '../../toast'

export function modeActions(set: SetState, get: () => ChatState) {
  return {
  cycleMode: async () => {
    const cycle = bumpReseedGen()
    const s = get()
    // 会话级 RPC：请求锁定发起时的会话（缺省 = host active，多 tab /
    // 在飞切换时会打错会话）。
    const sid = s.sessionId
    const prev = {
      planMode: s.planMode,
      permissionMode: s.permissionMode,
      yoloMode: s.yoloMode,
      autoMode: s.autoMode,
      statusText: s.statusText,
    }
    const inPlan = s.planMode === true || s.permissionMode === 'plan'
    const perm = (s.permissionMode || '').toLowerCase()
    const inAlways =
      s.yoloMode === true ||
      perm === 'always-approve' ||
      perm === 'always_approve' ||
      perm === 'yolo'
    const inAuto = s.autoMode === true || perm === 'auto'
    const paint = (banner: string, patch: typeof prev) => {
      get().showModeBanner(banner)
      set(patch)
    }
    const persist = async (run: () => Promise<void>) => {
      try {
        await run()
      } catch (e) {
        if (cycle !== currentReseedGen()) return
        set(prev)
        appendEntry(set, {
          kind: 'error',
          text: `切换模式失败: ${e instanceof Error ? e.message : String(e)}`,
        })
      }
    }
    if (!inPlan && !inAuto && !inAlways) {
      // normal → plan
      paint('Switched to mode: Plan', {
        ...prev,
        planMode: true,
        permissionMode: undefined,
        statusText: '已切换到 plan 模式',
      })
      await persist(() => transport.setMode('plan', sid))
    } else if (inPlan && !inAuto && !inAlways) {
      // plan → auto (leave plan)
      paint('Switched to mode: Auto', {
        planMode: false,
        autoMode: true,
        yoloMode: false,
        permissionMode: undefined,
        statusText: '已切换到 auto 模式',
      })
      await persist(async () => {
        await transport.setMode('default', sid)
        await transport.setMode('auto', sid)
      })
    } else if (inPlan && inAuto) {
      // plan·auto → always (leave plan)
      paint('Switched to mode: Always-Approve', {
        planMode: false,
        yoloMode: true,
        autoMode: false,
        permissionMode: undefined,
        statusText: '已切换到 always-approve 模式',
      })
      await persist(async () => {
        await transport.setMode('default', sid)
        await transport.setMode('always-approve', sid)
      })
    } else if (inPlan) {
      // plan·always → normal (leave plan)
      paint('Switched to mode: Normal', {
        planMode: false,
        autoMode: false,
        yoloMode: false,
        permissionMode: undefined,
        statusText: '已切换到 normal 模式',
      })
      await persist(async () => {
        await transport.setMode('default', sid)
        await transport.setMode('normal', sid)
      })
    } else if (inAuto) {
      // auto → always
      paint('Switched to mode: Always-Approve', {
        ...prev,
        yoloMode: true,
        autoMode: false,
        permissionMode: undefined,
        statusText: '已切换到 always-approve 模式',
      })
      await persist(() => transport.setMode('always-approve', sid))
    } else {
      // always → normal
      paint('Switched to mode: Normal', {
        ...prev,
        autoMode: false,
        yoloMode: false,
        permissionMode: undefined,
        statusText: '已切换到 normal 模式',
      })
      await persist(() => transport.setMode('normal', sid))
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
    const prev = { planMode: s.planMode, permissionMode: s.permissionMode }
    set({ planMode: true, permissionMode: undefined, statusText: '已切换到 plan 模式' })
    try {
      await transport.setMode('plan', s.sessionId)
    } catch (e) {
      set(prev)
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
    const prev = {
      autoMode: s.autoMode,
      yoloMode: s.yoloMode,
      permissionMode: s.permissionMode,
    }
    try {
      if (inAuto) {
        set({
          autoMode: false,
          yoloMode: false,
          permissionMode: undefined,
          statusText: inPlan ? '已退出 auto（plan 保持）' : '已切换到 normal 模式',
        })
        await transport.setMode('normal', s.sessionId)
      } else {
        set({
          autoMode: true,
          yoloMode: false,
          permissionMode: undefined,
          statusText: inPlan ? '已切换到 plan·auto 模式' : '已切换到 auto 模式',
        })
        await transport.setMode('auto', s.sessionId)
      }
    } catch (e) {
      set(prev)
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
    const prev = {
      yoloMode: s.yoloMode,
      autoMode: s.autoMode,
      permissionMode: s.permissionMode,
    }
    try {
      if (inAlways) {
        set({
          yoloMode: false,
          autoMode: false,
          permissionMode: undefined,
          statusText: inPlan ? '已退出 always-approve（plan 保持）' : '已切换到 normal 模式',
        })
        await transport.setMode('normal', s.sessionId)
        return
      }
      const ok = await turnOnAlwaysApprove(set, inPlan, s.sessionId)
      if (!ok) {
        set(prev)
        appendEntry(set, {
          kind: 'error',
          text: 'host 暂不支持运行时切换 always-approve',
        })
      }
    } catch (e) {
      set(prev)
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
      pushToast(`权限应答失败: ${msg}`)
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
          pushToast('已允许本次请求，但 host 不支持开启 always-approve 模式')
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
        markPlanExitApproved()
      }
    }
  },

  dismissXai: async (requestId) => {
    await get().respondXai(requestId, { outcome: 'cancelled' })
  },
  } satisfies Partial<ChatState>
}
