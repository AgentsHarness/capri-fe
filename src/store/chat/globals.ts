import type { AcpEvent } from '../../api/types'
import type { ChatState } from './types'
import { eventAgentTimestampMs, replayEventKeys } from './envelopeParse'

/** Toast when the replayed snapshot lacks the head of the live answer stream. */
export const LIVE_STREAM_HISTORY_GAP_TOAST_ID = 'live-stream-history-gap'

export const LIVE_STREAM_HISTORY_GAP_TOAST =
  '这段回答的前半段在切回本会话前就已推送，回放历史里没有它。等本次直播结束后重新打开会话可看到完整回答。'

export const LIVE_STREAM_HISTORY_GAP_TOAST_MS = 6_000

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
   * git_head_changed 落地代数：refreshGitInfo 在飞期间若 HEAD 事件先到，
   * 响应不得用事件前的探盘结果盖掉新分支（外部 checkout 的常见竞态）。
   */
  gitInfoEpoch: 0,
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
  /**
   * Generation-stream coverage of the current snapshot (`chunk:<ss>` /
   * `thought:<ss>`). Used to detect a mid-block join: agent persistence
   * holds the in-progress complete block in memory until it ends, so a
   * history page taken while that block is still pending has no key.
   */
  historySnapStreamKeys: new Set<string>(),
  /**
   * Wall clock (Date.now) when the current loadHistory flipped
   * historyLoading. A live stream whose streamStartMs predates this
   * started before we subscribed.
   */
  historyLoadStartedAt: undefined as number | undefined,
  /**
   * One-shot after an in-flight snapshot replay: the first live assistant
   * chunk decides whether the answer's head is missing. Thought chunks
   * leave it armed (their head is not worth reporting) but are recorded in
   * `historyLiveStreamSeen`.
   */
  historyLiveJoinCheck: false,
  /**
   * Generation streams (streamStartMs) that already produced live content
   * since this load. A thought seen live on a stream proves its assistant
   * text block starts after we subscribed — the head cannot be missing.
   */
  historyLiveStreamSeen: new Set<number>(),
  /**
   * Streams already reported as missing their head (`sessionId:chunk:ss`).
   * Switching away and back mid-answer leaves the same gap; do not interrupt
   * again with the same notice.
   */
  historyGapToastedKeys: new Set<string>(),
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
  runtime.historySnapStreamKeys.clear()
  runtime.historyLoadStartedAt = undefined
  runtime.historyLiveJoinCheck = false
  runtime.historyLiveStreamSeen.clear()
}

export function liveReplayStreamKey(ev: AcpEvent): string | undefined {
  if (ev.type !== 'chunk' && ev.type !== 'thought') return undefined
  const ss = ev.streamStartMs
  if (typeof ss !== 'number' || !Number.isFinite(ss)) return undefined
  return `${ev.type}:${ss}`
}

/** 记录接入后已直播过的流：同流的正文段必然从接入之后才开始。 */
export function noteLiveStreamSeen(ev: AcpEvent): void {
  const ss = (ev as { streamStartMs?: number }).streamStartMs
  if (typeof ss === 'number' && Number.isFinite(ss)) {
    runtime.historyLiveStreamSeen.add(ss)
  }
}

/** 单路流的缺口只提醒一次（切走再切回，缺口还是那一个）。 */
const LIVE_GAP_TOAST_KEYS_CAP = 32

export function claimLiveGapToast(sessionId: string, ev: AcpEvent): boolean {
  const key = liveReplayStreamKey(ev)
  if (key == null) return false
  const id = `${sessionId}:${key}`
  const seen = runtime.historyGapToastedKeys
  if (seen.has(id)) return false
  seen.add(id)
  if (seen.size > LIVE_GAP_TOAST_KEYS_CAP) {
    const oldest = seen.values().next().value
    if (oldest != null) seen.delete(oldest)
  }
  return true
}

/**
 * 回放的快照没有正在直播的**正文回答**的前半段。
 *
 * 只判 assistant 正文：思考块缺开头不影响用户读到的回答，而推理模型
 * 大部分时间都在思考——按思考流判定，几乎每次切进运行中的会话都会弹。
 * 同一路流在接入后先看到过直播内容（思考段）时，正文段是接入之后才
 * 开始的，前半段并不缺。
 */
export function liveStreamPrefixMissingFromHistory(ev: AcpEvent): boolean {
  if (ev.type !== 'chunk') return false
  if ((ev as { sessionId?: string }).sessionId == null) return false
  const key = liveReplayStreamKey(ev)
  if (key == null) return false
  if (runtime.historySnapStreamKeys.has(key)) return false
  const ss = (ev as { streamStartMs?: number }).streamStartMs
  const loadAt = runtime.historyLoadStartedAt
  if (typeof ss !== 'number' || loadAt == null) return false
  if (runtime.historyLiveStreamSeen.has(ss)) return false
  return ss < loadAt
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
