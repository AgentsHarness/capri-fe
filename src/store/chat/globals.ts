import type { AcpEvent } from '../../api/types'
import type { ChatState } from './types'
import { eventAgentTimestampMs, replayEventKeys } from './envelopeParse'

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
  newSessionInFlightGeneration: undefined as number | undefined,
  lastLiveQueueChangedAt: 0,
  /**
   * 切会话窗口期（historyLoading）缓冲的 live 内容事件：快照拉取期间
   * 到达的本会话 chunk/thought/user_chunk 不丢弃，loadHistory 快照
   * 重建后按统一的 epoch-ms 边界与稳定事件键去重回放（见
   * loadHistory.ts）。终态/请求类事件不进缓冲（historyLoading 门控本就放行
   * 实时处理）。
   */
  historyWindowBuffer: [] as AcpEvent[],
  /**
   * 最近一次快照末尾 envelope 的 agent 时间戳（epoch ms）。窗口期缓冲
   * 回放用它做时间兜底；historyLoading 落回 false 之后，hello 刷新路径
   * 的 hub gap-pull 仍用同一水位丢掉已在快照里的 live 事件。
   */
  historySnapTail: undefined as number | undefined,
  /** Stable semantic keys for the envelopes included in the current snapshot. */
  historySnapEventKeys: new Map<string, number>(),
}

/** 缓冲上限：超限丢弃新事件（窗口正常只有几十条，防异常场景膨胀）。 */
export const HISTORY_WINDOW_BUFFER_CAP = 2000

export type AsyncScope = {
  generation: number
  selectedHostId?: string
  hostId?: string
  sessionId?: string
  cwd?: string
}

/** Capture the identity that owns a host/session-scoped request. */
export function captureAsyncScope(
  get: () => ChatState,
  sessionId?: string,
  cwd?: string,
): AsyncScope {
  const s = get()
  return {
    generation: runtime.sessionSwitchGen,
    selectedHostId: s.selectedHostId,
    hostId: s.hostId,
    ...(sessionId != null ? { sessionId } : {}),
    ...(cwd != null ? { cwd } : {}),
  }
}

/** Return false unless the request still owns the current host/session view. */
export function isAsyncScopeCurrent(
  get: () => ChatState,
  scope: AsyncScope,
): boolean {
  const s = get()
  return (
    scope.generation === runtime.sessionSwitchGen &&
    scope.selectedHostId === s.selectedHostId &&
    scope.hostId === s.hostId &&
    (scope.sessionId == null || scope.sessionId === s.sessionId) &&
    (scope.cwd == null || scope.cwd === s.cwd)
  )
}

/**
 * Live content types that, if already in the history snapshot, would paint
 * a second copy of the last turn after a page refresh (hello → loadHistory
 * then hub gap-pull). Control events (hello/ready/done/client_request/…)
 * must not be gated — they have no snapshot counterpart, or the terminal
 * path is already idempotent.
 */
const SNAPSHOT_LIVE_DEDUP_TYPES = new Set([
  'chunk',
  'thought',
  'user_chunk',
  'user_message',
  'image',
])

/**
 * Drop a live/gap-pull event already covered by the just-loaded snapshot.
 * History replay envelopes have no sessionId and must pass; only wire
 * events (hello-path gap-pull after historyLoading falls) are filtered.
 *
 * 与 replayHistoryWindowBuffer 同一套：先语义键（带计数），再
 * agentTimestampMs ≤ snapTail。不用 eventId 集合——N 会在同一会话里撞车，
 * 刷新后新事件会被静默吞掉。
 */
export function dropLiveCoveredBySnapshot(ev: AcpEvent): boolean {
  if (!SNAPSHOT_LIVE_DEDUP_TYPES.has(ev.type)) return false
  if ((ev as { sessionId?: string }).sessionId == null) return false
  const keys = replayEventKeys(ev)
  for (const key of keys) {
    const count = runtime.historySnapEventKeys.get(key) ?? 0
    if (count > 0) {
      runtime.historySnapEventKeys.set(key, count - 1)
      return true
    }
  }
  const tail = runtime.historySnapTail
  if (tail == null) return false
  const ts = eventAgentTimestampMs(ev)
  return ts != null && ts <= tail
}

export function bufferHistoryWindowEvent(ev: AcpEvent): void {
  if (runtime.historyWindowBuffer.length >= HISTORY_WINDOW_BUFFER_CAP) return
  runtime.historyWindowBuffer.push(ev)
}

/** 换会话/加载失败：丢弃上一会话窗口期的缓冲残留。 */
export function clearHistoryWindowBuffer(): void {
  runtime.historyWindowBuffer = []
  runtime.historySnapTail = undefined
  runtime.historySnapEventKeys.clear()
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
