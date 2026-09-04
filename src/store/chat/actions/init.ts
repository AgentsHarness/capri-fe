import type { StoreApi } from 'zustand'
import { transport } from '../../../api/client'
import { applyQueueChanged } from '../../promptQueue'
import { usePins } from '../../historyPins'
import type { ChatState, SetState } from '../types'
import {
  bufferHistoryWindowEvent,
  clearContinueSessionTimer,
  clearPeerSessionLoad,
} from '../globals'
import {
  applyCollapsedEditBlocksFromCache,
  applyModeFlags,
  ensureDefaultModeFlags,
  loadGlobalModeFlags,
  loadPlanModes,
  MODE_FLAGS_KEY,
  PLAN_FLAGS_KEY,
  saveModeFlags,
  savePlanMode,
} from '../modeFlags'
import { onUiSettingsChange, onUiSettingsReady } from '../../settings'
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
import { handleResyncRebuild } from '../resync'

export function initChat(
  set: SetState,
  get: () => ChatState,
  api: StoreApi<ChatState>,
): () => void {
    const unsub = transport.onEvent((ev) => {
      const s = get()
      // hub 慢消费者 resync：必须在下方 historyLoading 窗口过滤之前
      // 拦截——落进窗口缓冲的话，重放阶段（historyLoading 已落回
      // false）会再次触发重建，形成重建循环。防抖（重建进行中忽略
      // 新 resync）在 handleResyncRebuild 内。
      if (ev.type === 'resync') {
        handleResyncRebuild(get)
        return
      }
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
        if (!isTurnEnd && !isClientRequest && !isSessionLoadBoundary) {
          // 方案 A 窗口期缓冲：切 busy 会话时，快照拉取期间到达的
          // 本会话 live 内容事件（chunk/thought/user_chunk/…）不再
          // 直接丢弃——loadHistory 重建后按统一 epoch-ms 边界与稳定
          // 事件键去重回放。没有可比较时间戳的工具/计划/图片等事件也
          // 保留，不能静默丢失。终态 / client_request / 会话加载边界事件
          // 仍放行实时处理（见上）。
          if (evSid == null || evSid === s.sessionId) {
            bufferHistoryWindowEvent(ev)
          }
          return
        }
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
      // 全局广播事件族：模式变更（yolo_mode_changed / modes_update）、会话列表（sessions_changed）、
      // 宿主变更（hosts_changed）、偏好变更（prefs_changed）、MCP 工具/服务变更、
      // 调度任务生命周期（created/deleted/fired）、会话回退通知（session_rewound）等属于
      // 跨会话或全局关注的事件，即使宿主或中间层附带了 sessionId 也不得按
      // 单会话过滤规则在顶层拦截丢弃。
      const isGlobalEvent =
        ev.type === 'yolo_mode_changed' ||
        ev.type === 'modes_update' ||
        ev.type === 'sessions_changed' ||
        ev.type === 'hosts_changed' ||
        ev.type === 'prefs_changed' ||
        ev.type === 'mcp_tools_changed' ||
        ev.type === 'mcp_servers_updated' ||
        ev.type === 'scheduled_task_created' ||
        ev.type === 'scheduled_task_deleted' ||
        ev.type === 'scheduled_task_fired' ||
        ev.type === 'session_rewound' ||
        ev.type === 'git_head_changed' ||
        ev.type === 'permissions_reset' ||
        // 检索引擎状态流：host 用 agent 自报的 sessionId（模糊搜索是字面量
        // "agent"，非会话 UUID）打标签，按会话过滤必然全量丢弃。消费方
        // （@ 选择器）自己用 searchId 认权威，见 events/extMisc.ts。
        ev.type === 'search_fuzzy_status'
      if (
        !isGlobalEvent &&
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
    // session — a hint for maybeReseed, not the live badge source.
    // Plan mode is per-session. Skipped while history is (re)building
    // so a mid-replay persist cannot clobber live-known flags.
    const unsubMode = api.subscribe((s, prev) => {
      if (s.historyLoading || s.historyLoadingMore) return
      if (
        s.permissionMode !== prev.permissionMode ||
        s.yoloMode !== prev.yoloMode ||
        s.autoMode !== prev.autoMode
      ) {
        // Only persist a confirmed non-ask. Hello-ask paints
        // yoloMode/autoMode false — writing that used to shadow
        // config.toml on maybeReseed. Explicit ask writes go through
        // persistConfirmedPermission (setMode / settings).
        if (s.yoloMode === true || s.autoMode === true) {
          saveModeFlags({
            permissionMode: s.permissionMode,
            yoloMode: s.yoloMode,
            autoMode: s.autoMode,
          })
        }
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
      // capri-fe.host 残留），左上角固定显示 Localhost。
      set({
        hosts: [],
        selectedHostId: undefined,
        hostId: undefined,
        hostName: 'Localhost',
      })
    }
    // Prefetch `[ui]` permission default for maybeReseed / session/new.
    // Do not paint the composer badge from config — wait for the agent echo.
    // hub 模式交给 selectHost：settings 是 host 级的，host 选定之前那次预取
    // 只会赶上 setHost 的 abort 风暴（实测两次 ERR_ABORTED）。local 模式没有
    // host 选择这一步，这里自己取，并延到宏任务——StrictMode 的
    // setup→cleanup→setup 会在同步阶段 disconnect 一次，直接调用必被 abort
    // （与下面 pinsSyncTimer 同一个理由）。
    let uiPrefetchTimer: ReturnType<typeof setTimeout> | undefined
    if (mode !== 'hub') {
      uiPrefetchTimer = setTimeout(() => void ensureDefaultModeFlags(), 0)
    }
    // TUI live flip: rematerialize Edit rows when collapsed_edit_blocks
    // arrives (history often replays before GET /api/settings) or when
    // the user toggles it in /settings.
    onUiSettingsReady(() => applyCollapsedEditBlocksFromCache(set))
    const unsubUi = onUiSettingsChange(() => applyCollapsedEditBlocksFromCache(set))
    // 置顶/待办偏好从 hub 拉取并合并（localStorage 是离线缓存；host
    // 报过的 HUB_URL 是持久层，见 historyPins.ts）。无 hub 地址时跳过。
    // 延迟到宏任务：StrictMode 的 effect 双调用（setup → cleanup →
    // setup）会在同步阶段立刻 disconnect 一次，直接调用会被它 abort
    // （"[pins] hub 同步失败 AbortError"），延迟后只有最终的连接在飞。
    // id 必须留着在 cleanup 里清：否则首次挂载的定时器在 cleanup 之后
    // 照样触发（多同步一次），卸载场景更是在 transport.disconnect()
    // 之后触发，必然被 abort 并打一行控制台错误。
    const pinsSyncTimer = setTimeout(() => {
      void usePins.getState().syncPrefsFromHub()
    }, 0)
    // 多 Tab 同步：监听 storage 事件，当另一标签页（同源）切换了全局权限模式
    // （yoloMode / autoMode / normal）或当前会话的 planMode 时，本标签页立即同步。
    const onStorage = (e: StorageEvent) => {
      if (e.key === MODE_FLAGS_KEY) {
        const flags = loadGlobalModeFlags()
        if (flags.yoloMode === true || flags.autoMode === true) {
          applyModeFlags(set, flags as Record<string, unknown>)
        } else {
          set({
            yoloMode: false,
            autoMode: false,
            permissionMode: undefined,
          })
        }
      } else if (e.key === PLAN_FLAGS_KEY) {
        const curSid = get().sessionId
        if (curSid) {
          const planModes = loadPlanModes()
          const shouldBePlan = planModes[curSid]
          if (typeof shouldBePlan === 'boolean' && shouldBePlan !== get().planMode) {
            set({
              planMode: shouldBePlan,
              ...(shouldBePlan ? {} : get().permissionMode === 'plan' ? { permissionMode: undefined } : {}),
            })
          }
        }
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', onStorage)
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', onStorage)
      }
      clearTimeout(pinsSyncTimer)
      clearTimeout(uiPrefetchTimer)
      unsub()
      unsubMode()
      unsubUi()
      clearContinueSessionTimer()
      clearPeerSessionLoad()
      get().stopTopTaskPolling()
      transport.disconnect()
    }
  }
