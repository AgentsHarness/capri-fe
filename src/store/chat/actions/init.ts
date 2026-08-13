import type { StoreApi } from 'zustand'
import { transport } from '../../../api/localTransport'
import { applyQueueChanged } from '../../promptQueue'
import { usePins } from '../../../components/historyPins'
import type { ChatState, SetState } from '../types'
import {
  clearContinueSessionTimer,
  clearPeerSessionLoad,
} from '../globals'
import {
  ensureDefaultModeFlags,
  permissionSeedMeta,
  saveModeFlags,
  savePlanMode,
} from '../modeFlags'
import {
  armSubagentTurnSettleFallback,
  clearSubagentSettleTimer,
  PARENT_TURN_ACTIVITY_TYPES,
  SUBAGENT_VIEW_ACTIVITY_TYPES,
  TURN_TERMINAL_TYPES,
} from '../turn'
import {
  applySubagentViewEvent,
} from '../subagent'

export function initChat(
  set: SetState,
  get: () => ChatState,
  api: StoreApi<ChatState>,
): () => void {
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
    const unsubMode = api.subscribe((s, prev) => {
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
    // Prefetch config.toml `[ui] permission_mode` and paint the composer
    // badge immediately when no live flags are known yet (hello may
    // arrive later and overlay a host snapshot / re-seed).
    void ensureDefaultModeFlags().then((defaults) => {
      const seed = permissionSeedMeta(defaults)
      if (!seed) return
      const s = get()
      if (s.yoloMode === true || s.autoMode === true) return
      // Explicit ask (hello already applied yolo/auto = false) — leave it.
      if (s.yoloMode === false || s.autoMode === false) return
      set({
        yoloMode: seed.yoloMode,
        autoMode: seed.autoMode,
        permissionMode: seed.yoloMode ? 'always-approve' : 'auto',
      })
    })
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
  }
