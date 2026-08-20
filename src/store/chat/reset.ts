import type { ChatState } from './types'
import { clearSubagentSettleTimer, clearTurnBlipTimer } from './turn'
import { runtime, clearHistoryWindowBuffer } from './globals'

/**
 * 清空当前会话的全部本地状态，落到"无会话"空状态（sessionId 置空，
 * 直到宿主 ready(newSessionId) 到达前，session 级事件一律丢弃，防止
 * 跨会话串扰）。newSession 与"删除当前会话落到空状态"共用同一份 reset。
 * 权限模式（yolo/auto/permissionMode）是进程级全局状态，跟随 agent
 * 广播，**不随会话复位**；planMode 是会话态，随复位清空（由下次
 * replay/load 恢复）。
 */
export function resetSessionState(set: (partial: Partial<ChatState>) => void): void {
  // Every reset invalidates async work even when it is not followed by a
  // session/new request (for example, the New button's empty state).
  runtime.sessionSwitchGen += 1
  set({
    entries: [],
    liveStream: null,
    currentStreamStartMs: undefined,
    lastCompletedTurn: undefined,
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
    sessionStats: undefined,
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
    historyLoadedAt: undefined,
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
