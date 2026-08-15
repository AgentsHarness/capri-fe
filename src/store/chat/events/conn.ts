import type { AcpEvent, PendingReq } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { runtime } from '../globals'
import {
  partitionPendingRequests,
} from '../pending'
import {
  alreadyReseeded,
  consumeAgentInstance,
  currentAgentStamp,
  maybeReseedPermissionMode,
  permissionModeFromSnapshot,
  resolveDisplayModeFlags,
  restorePlanMode,
  sessionModesPatch,
} from '../modeFlags'
import {
  busyPlausibleForView,
} from '../turn'
import { applySessionModelState } from '../model'
export function handleConnEvent(
  set: SetState,
  get: () => ChatState,
  ev: AcpEvent,
): boolean {
  switch (ev.type) {
      case 'hello': {
        // Hub-level hello (capri-hub): registry info, no session state —
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
            // boot 错误只进横幅（下方 setLayerError），statusText 不写
            // 错误文本（stat/composer 不参与）——清空防残留旧文案。
            statusText: ev.error ? '' : ev.ready ? '就绪' : '启动中…',
            homeDir: ev.homeDir,
            hostId: ev.hostId,
            hostName: ev.hostName,
          })
          get().setLayerError(
            'host',
            ev.error
              ? { level: 'error', message: ev.error, at: Date.now() }
              : undefined,
          )
          break
        }
        const modelSnap = applySessionModelState(ev.models, ev.agentInfo)
        const reqs = ev.pendingRequests || []
        // 迟到的旧会话 hello：resetSessionState 清锚之后、newSession 响应
        // 回填之前（runtime.newSessionInFlight = 建会话 POST 在飞；或空状态发消息
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
          (get().pendingOptimisticUserId != null || runtime.newSessionInFlight)
        // Pending is host-global (all sessions' clientReqs). Scope to the
        // session this hello is announcing so another conversation's
        // permission / question never paints on the active view. Untagged
        // rows (old host) are attributed to the announced active session.
        const pendingSnap = suppressAnchor
          ? { pending: [] as PendingReq[], xaiRequests: [] as PendingReq[] }
          : partitionPendingRequests(reqs, ev.sessionId, {
              includeUntagged: true,
            })
        const { saved: permSaved } = consumeAgentInstance(ev.agentStartedAt)
        const permSnap = permissionModeFromSnapshot(ev.permissionMode)
        set({
          conn: ev.ready ? 'ready' : ev.error ? 'error' : 'connecting',
          // boot 错误只进横幅（下方 setLayerError），statusText 不写
          // 错误文本（stat/composer 不参与）——清空防残留旧文案。
          statusText: ev.error ? '' : ev.ready ? '就绪' : '启动中…',
          ...(suppressAnchor
            ? {}
            : { sessionId: ev.sessionId, cwd: ev.cwd }),
          homeDir: ev.homeDir,
          hostId: ev.hostId,
          hostName: ev.hostName,
          pending: pendingSnap.pending,
          xaiRequests: pendingSnap.xaiRequests,
          modes: ev.modes,
          ...modelSnap,
          // 徽标只信 agent 回声：hello 非 ask 是权威；ask 仅在本 agent
          // 实例已经成功 setMode 过时保留那次写入。config.toml 不预涂。
          ...resolveDisplayModeFlags(permSaved, permSnap, {
            confirmedWrite: alreadyReseeded(currentAgentStamp()),
          }),
          ...restorePlanMode(ev.sessionId),
          ...(sessionModesPatch(get, ev.modes) ?? {}),
        })
        get().setLayerError(
          'host',
          ev.error
            ? { level: 'error', message: ev.error, at: Date.now() }
            : undefined,
        )
        void maybeReseedPermissionMode(set, get, {
          saved: permSaved,
          snapshotMode: ev.permissionMode,
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
              // 系统恢复（busy/ready/新回合）：清空分层横幅。
              layerErrors: {},
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
            // 系统恢复（busy/ready/新回合）：清空分层横幅。
            layerErrors: {},
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
          // 系统恢复（busy/ready/新回合）：清空分层横幅。
          layerErrors: {},
          ...modelSnap,
          // 权限徽标不从 localStorage 回灌——只信 hello / yolo_mode_changed。
          // plan 是会话态，从 per-session 副本补充。
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
          // layer banners.
          layerErrors: {},
        })
        break
      }
      case 'hub_conn': {
        // 与 hub 的 WS 连接状态（仅 hub 模式，localTransport 本地发出）。
        // 断线 → hub 层 warning；重连成功只清这条（id='hub-ws'），
        // 不影响 host 离线等其他 hub 层错误。
        if (ev.online) {
          const cur = get().layerErrors.hub
          if (cur?.id === 'hub-ws') get().setLayerError('hub', undefined)
        } else if (!get().layerErrors.hub) {
          get().setLayerError('hub', {
            id: 'hub-ws',
            level: 'warning',
            message: '与 hub 的连接已断开，重连中…',
            at: Date.now(),
          })
        }
        break
      }
    default:
      return false
  }
  return true
}
