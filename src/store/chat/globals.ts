/** Shared module-level session/runtime state (was file-private in chat.ts). */
import type { AcpEvent } from '../../api/types'

/** 会话完成提醒去重窗口：同一会话在此窗口内只通知一次。 */
export const NOTICE_DEDUP_WINDOW_MS = 30_000

/**
 * Cross-module mutable bindings. ES module live bindings cannot be
 * assigned from importers, so the handful of lets that both the store
 * and event/pending helpers mutate live on this object.
 */
export const runtime = {
  lastBusySnapshot: {} as Record<string, boolean>,
  displayedAnnouncementFingerprints: new Map<string, string>(),
  continueSessionTimer: null as ReturnType<typeof setTimeout> | null,
  peerSessionLoadSid: null as string | null,
  sessionSwitchGen: 0,
  newSessionInFlight: false,
  lastLiveQueueChangedAt: 0,
  /**
   * 切会话窗口期（historyLoading）缓冲的 live 内容事件：快照拉取期间
   * 到达的本会话 chunk/thought/user_chunk 不丢弃，loadHistory 快照
   * 重建后（及 grace window 结束时）按 agentTimestampMs 与快照末尾
   * 写盘时间戳的关系回放（见 loadHistory.ts）。终态/请求类事件不进
   * 缓冲（historyLoading 门控本就放行实时处理）。
   */
  historyWindowBuffer: [] as AcpEvent[],
  /** 最近一次快照（/api/session-updates）末尾 envelope 的写盘时间戳。 */
  historySnapTail: undefined as number | undefined,
}

/** 缓冲上限：超限丢弃新事件（窗口正常只有几十条，防异常场景膨胀）。 */
export const HISTORY_WINDOW_BUFFER_CAP = 2000

export function bufferHistoryWindowEvent(ev: AcpEvent): void {
  if (runtime.historyWindowBuffer.length >= HISTORY_WINDOW_BUFFER_CAP) return
  runtime.historyWindowBuffer.push(ev)
}

/** 换会话/加载失败：丢弃上一会话窗口期的缓冲残留。 */
export function clearHistoryWindowBuffer(): void {
  runtime.historyWindowBuffer = []
  runtime.historySnapTail = undefined
}

export function clearContinueSessionTimer() {
  if (runtime.continueSessionTimer != null) {
    clearTimeout(runtime.continueSessionTimer)
    runtime.continueSessionTimer = null
  }
}

export function clearPeerSessionLoad() {
  runtime.peerSessionLoadSid = null
}
