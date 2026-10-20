import type { AcpEvent } from '../../api/types'
import type { ChatState, SetState } from './types'
import {
  claimLiveGapToast,
  dropLiveCoveredBySnapshot,
  LIVE_STREAM_HISTORY_GAP_TOAST,
  LIVE_STREAM_HISTORY_GAP_TOAST_ID,
  LIVE_STREAM_HISTORY_GAP_TOAST_MS,
  liveStreamPrefixMissingFromHistory,
  noteLiveStreamSeen,
  runtime,
} from './globals'
import { TURN_TERMINAL_TYPES } from './turn'
import { pushToast } from '../toast'
import { flushStreamBufBeforeEvent } from './stream'
import { handleConnEvent } from './events/conn'
import { handleUserStreamEvent } from './events/userStream'
import { handleToolEvent } from './events/tools'
import { handleTurnEndEvent } from './events/turnEnd'
import { handleSessionCtrlEvent } from './events/sessionCtrl'
import { handleSessionNotification } from './events/sessionNotif'
import { handleExtEvent } from './events/ext'
import { normalizeSessionEvent } from './events/normalize'
import { SILENT_HOST_EVENT_TYPES, TYPED_CARRIER_TAGS } from './events/kinds'

/**
 * 切进进行中的会话后，第一条 live 正文决定快照是否缺了它的前半段。
 *
 * 只有 assistant 正文值得提示：思考块缺开头不改变用户读到的回答，而推理
 * 模型大半时间都在思考，按思考流判定等于每次切会话都弹一次。同一路流在
 * 接入后先看到过思考段时，正文段是接入之后才开始的，前半段并不缺。
 * 回合终态撤掉一次性检测：此后可能还有 gap-pull 回放的旧 chunk，不能
 * 拿它误报（也可能根本不会再有正文）。
 */
function maybeToastLiveStreamHistoryGap(
  get: () => ChatState,
  ev: AcpEvent,
): void {
  if (!runtime.historyLiveJoinCheck) return
  if (TURN_TERMINAL_TYPES.has(ev.type)) {
    runtime.historyLiveJoinCheck = false
    return
  }
  if (ev.type !== 'chunk' && ev.type !== 'thought') return
  const sid = (ev as { sessionId?: string }).sessionId
  if (sid == null || sid !== get().sessionId) return
  if (ev.type === 'thought') {
    noteLiveStreamSeen(ev)
    return
  }
  runtime.historyLiveJoinCheck = false
  if (!liveStreamPrefixMissingFromHistory(ev)) return
  if (!claimLiveGapToast(sid, ev)) return
  pushToast(LIVE_STREAM_HISTORY_GAP_TOAST, {
    id: LIVE_STREAM_HISTORY_GAP_TOAST_ID,
    type: 'warning',
    durationMs: LIVE_STREAM_HISTORY_GAP_TOAST_MS,
  })
}

export function handleChatEvent(
  set: SetState,
  get: () => ChatState,
  ev: AcpEvent,
): void {
  // resync 由 transport/init 层处理（全量重建，见 store/chat/resync.ts），
  // 不是聊天事件；任何其他路径漏到这里都直接忽略，绝不参与流缓冲/分发。
  if (ev.type === 'resync') return
  // Page refresh of a completed turn: hello → loadHistory paints the
  // snapshot, then hub gap-pull replays the same last-turn live events
  // after historyLoading drops. Those frames carry sessionId + the
  // original agentTimestampMs ≤ snapTail — drop them so the last
  // message is not appended a second time. Snapshot replay has no
  // sessionId and is unaffected.
  if (dropLiveCoveredBySnapshot(ev)) return
  maybeToastLiveStreamHistoryGap(get, ev)
  const raw = ev as { update?: unknown; sessionId?: unknown; msgSeq?: unknown }
  if (raw.update && typeof raw.update === 'object') {
    const u = raw.update as { sessionUpdate?: unknown }
    if (typeof u.sessionUpdate === 'string' && ev.type !== 'turn_completed') {
      ev = normalizeSessionEvent(ev)
    }
  }
  // x.ai 独立通道 / 宿主归一形状的 kind 事件：同样收敛到唯一入口（见
  // events/normalize.ts）。其余 typed 事件在下方各自更早的链路上处理。
  if (TYPED_CARRIER_TAGS.has(String(ev.type))) {
    ev = normalizeSessionEvent(ev)
  }
  // 归一化之后再判：流式缓冲的「同类不 flush」必须按**真正会被派发的**
  // 事件形状决定。若在改写之前判，一个 type:'chunk' 但带 envelope
  // update 的事件会被当成同类流跳过 flush，随后却走 session_notification
  // 分支落一行非流式内容——缓冲文本的顺序就错到它后面去了。
  flushStreamBufBeforeEvent(set, get, ev)
  if (handleConnEvent(set, get, ev)) return
  if (handleUserStreamEvent(set, get, ev)) return
  if (handleToolEvent(set, get, ev)) return
  if (handleTurnEndEvent(set, get, ev)) return
  if (handleSessionCtrlEvent(set, get, ev)) return
  if (ev.type === 'session_notification') {
    handleSessionNotification(set, get, ev)
    return
  }
  if (handleExtEvent(set, get, ev)) return
  maybeWarnUnhandledTyped(String(ev.type))
}

/**
 * 没有任何 handler 认领的 typed 事件：DEV 下每类型提示一次，已登记进
 * SILENT_HOST_EVENT_TYPES 的跳过（见 kinds.ts 的逐条理由）。宿主新增
 * 一个 `x.ai/*` 转发分支时，这里会替我们发出信号，而不是无声丢弃。
 */
const warnedTyped = new Set<string>()
function maybeWarnUnhandledTyped(type: string): void {
  if (!import.meta.env.DEV || warnedTyped.has(type)) return
  if (SILENT_HOST_EVENT_TYPES.has(type)) return
  warnedTyped.add(type)
  // eslint-disable-next-line no-console
  console.warn(
    `[chatEvent] 未处理的 typed 事件: ${type} —— 若为宿主新增的转发，` +
      '请在 store/chat/events/ 补消费点，或登记进 events/kinds.ts 的 SILENT_HOST_EVENT_TYPES',
  )
}

/** 测试用：重置告警去重集合。 */
export function resetUnhandledTypedWarningsForTest(): void {
  warnedTyped.clear()
}
