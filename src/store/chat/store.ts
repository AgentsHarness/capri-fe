import { loadStr, saveBool } from '../../lib/storage'
import { create } from 'zustand'
import { transport } from '../../api/client'
import { usePromptQueue } from '../promptQueue'
import type { ChatState, SetState } from './types'
import { CANCEL_SUBAGENTS_PREF_KEY, loadCancelSubagentsPref } from './cancelPref'
import { formatSessionInfo } from './format'
import { handleChatEvent } from './events'
import {
  continueSession as loadContinueSession,
  loadHistory as loadSessionHistory,
  loadMoreHistory as loadOlderHistory,
} from './sessionLoad'
import { sendPrompt } from './send'
import { appendEntry, type EntryWithoutId } from './entries'
import { initChat } from './actions/init'
import { goalActions } from './actions/goal'
import { hostActions } from './actions/hosts'
import { noticeActions } from './actions/notices'
import { livePollActions } from './actions/livePoll'
import { cancelActions } from './actions/cancel'
import { modeActions } from './actions/modes'
import { xaiActions } from './actions/xai'
import { liveTaskActions } from './actions/liveTasks'
import { sessionActions } from './actions/session'
import { viewerActions } from './actions/viewer'

export const useChatStore = create<ChatState>((setRaw, get, api) => {
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
  currentStreamStartMs: undefined,
  lastCompletedTurn: undefined,
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
  workspaceRecentLimit: 50,
  workspaceRecentLoadingMore: false,
  workspaceRecentHasMore: false,
  // 本地记忆的展示模式偏好（默认 recent 分页；用户切到全量后记住）。
  workspaceListMode: loadStr('capri-fe-workspace-mode') === 'full' ? 'full' : 'recent',
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
  layerErrors: {},
  xaiRequests: [],
  subagentIndex: {},
  pendingSubagentFinishes: {},
  subagentChildIndex: {},
  subagentViews: {},
  bgTaskIndex: {},
  topTasks: [],
  completedNotices: {},
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
  // Global Ctrl+C ladder (useScrollbackKeys): the Composer mirrors its
  // local draft length here; clearComposerDraft bumps the nonce the
  // Composer watches to clear its buffer.
  composerDraftLen: 0,
  composerClearNonce: 0,
  clearComposerDraft: () =>
    set((s) => ({ composerClearNonce: s.composerClearNonce + 1 })),
  cancelPanelOpen: false,
  openCancelPanel: () => set({ cancelPanelOpen: true }),
  closeCancelPanel: () => set({ cancelPanelOpen: false }),
  cancelSubagentsPref: loadCancelSubagentsPref(),
  setCancelSubagentsPref: (stop) => {
    saveBool(CANCEL_SUBAGENTS_PREF_KEY, stop)
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
  queuePanelOpen: true,
  setQueuePanelOpen: (open) =>
    set({
      queuePanelOpen:
        typeof open === 'function' ? open(get().queuePanelOpen) : open,
    }),
  planMode: false,

  // ── goal mode — HOST-ENGINE control (TUI /goal parity) ─────────────
  // The host owns the goal tracker (capri-host goal.go): these actions call
  // /api/goal/* directly instead of the old prompt path (the wire has no
  // goal control methods, and the prompt path only worked when the agent
  // happened to have an update_goal tool). Responses carry the current
  // goal state, applied to goalState immediately; the host also
  // broadcasts goal_updated events on every state change.
  ...goalActions(set, get),
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

  // Content search modal (TUI /search panel).
  contentSearchOpen: false,
  contentSearchPrefill: '',
  openContentSearch: (query) =>
    set({ contentSearchOpen: true, contentSearchPrefill: query ?? '' }),
  closeContentSearch: () =>
    set({ contentSearchOpen: false, contentSearchPrefill: '' }),

  // @ file picker engine state (TUI fuzzy file search) — the Composer
  // owns the open/change/close lifecycle; only the status event and the
  // lifecycle write it.
  fileSearch: null,

  init: () => initChat(set, get, api),
  ...hostActions(set, get),

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

  /** 写入/清除某一层的错误（undefined = 清除该层）。 */
  setLayerError: (layer, err) =>
    set((s) => ({ layerErrors: { ...s.layerErrors, [layer]: err } })),
  /** Dismiss the top error/status banner (user acknowledged the message). */
  dismissNotice: () => set({ layerErrors: {} }),

  loadHistory: (sessionId, cwd) => loadSessionHistory(set, get, sessionId, cwd),

  // ── 会话完成提醒（非当前会话 turn 跑完）───────────────────────────
  // Live turn_completed 事件带 sessionId：别的会话跑完时置对勾 +
  // 系统通知（未授权则页面 toast）。同一会话 30s 窗口内不重复通知。
  ...noticeActions(set, get),
  continueSession: (sessionId, cwd) => loadContinueSession(set, get, sessionId, cwd),

  loadMoreHistory: (anchorId, chainedPages) =>
    loadOlderHistory(set, get, anchorId, chainedPages),

  ...livePollActions(set, get),
  handleEvent: (ev) => handleChatEvent(set, get, ev),

  send: (text, blocks, opts) => sendPrompt(set, get, text, blocks, opts),

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
  ...cancelActions(set, get),
  ...modeActions(set, get),

  ...xaiActions(set, get),

  ...liveTaskActions(set, get),

  ...sessionActions(set, get),

  ...viewerActions(set, get),
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
