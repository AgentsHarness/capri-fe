import { transport } from '../../api/client'
import { usePromptQueue } from '../promptQueue'
import type { ChatState, SetState } from './types'
import {
  clearContinueSessionTimer,
  clearHistoryWindowBuffer,
  clearPeerSessionLoad,
  captureAsyncScope,
  isAsyncScopeCurrent,
  runtime,
} from './globals'
import { syncPendingForSession } from './pending'
import { replayHistoryWindowBuffer } from './loadHistory'
import {
  restorePlanMode,
  sessionModesPatch,
} from './modeFlags'
import { applySessionModelState } from './model'
export async function continueSession(
  set: SetState,
  get: () => ChatState,
  sessionId: string,
  cwd: string
): Promise<void> {
    if (get().historyLoading || get().historyLoadingMore) return
    // A previous session's grace-window callback must never fire after we
    // start switching again (it would re-anchor the OLD session's snapshot).
    clearContinueSessionTimer()
    // We are the load initiator — never treat our own session_load_* as a
    // peer rebuild (would double loadHistory).
    clearPeerSessionLoad()
    // 换会话：丢弃上一会话窗口期的缓冲残留（旧会话的事件绝不能在新
    // 会话的快照回放里误渲染；loadHistory 会重建，无需保留）。
    clearHistoryWindowBuffer()
    // Invalidate in-flight async results from a previous switch.
    const myGen = ++runtime.sessionSwitchGen
    const scope = captureAsyncScope(get, sessionId, cwd)
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
      // 状态栏分支属会话态：换会话即清，旧会话的 ⎇ 不能挂在新会话视图上
      // （下方 refreshGitInfo 回来后由本会话的 git-info 重新填充）。
      gitInfo: undefined,
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
      // 方案 A：切会话优先走 session/resume——agent 不重放历史（load
      // 会经 SSE 全量重放整段会话，而重放本就被 historyLoading 丢弃，
      // 纯浪费：带宽、Broadcast 缓冲 drop、hub 上行）。resume 失败
      // （旧 agent 不支持 / 方法不存在等）回退 session/load，行为与
      // 旧版完全一致（含重放 + 多 tab peer 门控）。
      let loaded: {
        models?: unknown
        modes?: unknown
        configOptions?: unknown
        busy?: boolean
      }
      try {
        loaded = await transport.sessionResume({ sessionId, cwd })
      } catch {
        // resume 不可用才回退 session/load，并要求 agent 不要再整段重放历史
        // （noReplay → host 丢弃派生自 session/update 的重放通知）：整段重放
        // 既被 historyLoading 窗口丢掉，又会在 host 的 EventSequencer 里
        // 制造 seq 空洞憋住后续 live 事件。边界事件仍照常透传。
        loaded = await transport.loadSession(sessionId, cwd, { noReplay: true })
      }
      // The user may have switched host / opened another session while we
      // were loading — never write this session's data into that view.
      if (myGen !== runtime.sessionSwitchGen || !isAsyncScopeCurrent(get, scope)) return
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
      // 会话切换：拉取新会话的聚合统计（composer 状态条）。
      void get().refreshSessionStats()
      // Probe the still-running set BEFORE history replay: replayUpdates
      // skips the "Task started" row of any task that is still running
      // (that state lives in the top task strip only — see replayUpdates).
      // Probing first closes the window where the newest page would
      // otherwise render a dangling started row with no completion.
      await get().replayRunningTasks(sessionId, cwd)
      await get().loadHistory(sessionId, cwd)
      if (myGen !== runtime.sessionSwitchGen || !isAsyncScopeCurrent(get, scope)) return
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
      runtime.continueSessionTimer = window.setTimeout(() => {
        runtime.continueSessionTimer = null
        // Another switch happened inside the grace window: do NOT re-anchor
        // this (now stale) session's snapshot.
        if (myGen !== runtime.sessionSwitchGen || !isAsyncScopeCurrent(get, scope)) return
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
        // 方案 A：grace window 期间（快照后 500ms）缓冲的 live 内容
        // 事件在此回放——loadHistory 已回放过快照重建前的事件，这里
        // 补上窗口尾巴（resume 无重放，缓冲里只有真实 live 事件）。
        replayHistoryWindowBuffer(get)
      }, 500)
    } catch (e) {
      if (myGen !== runtime.sessionSwitchGen || !isAsyncScopeCurrent(get, scope)) return
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
        currentStreamStartMs: undefined,
        liveStream: null,
      })
    }
  }

