import type { AcpEvent } from '../../api/types'
import type { ChatState, SetState } from './types'
import {
  dropLiveCoveredBySnapshot,
  LIVE_STREAM_HISTORY_GAP_TOAST,
  LIVE_STREAM_HISTORY_GAP_TOAST_ID,
  LIVE_STREAM_HISTORY_GAP_TOAST_MS,
  liveStreamPrefixMissingFromHistory,
  runtime,
} from './globals'
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
import { TYPED_CARRIER_TAGS } from './events/kinds'

/**
 * After replaying an in-flight session, the first live chunk/thought that
 * is not already in the snapshot decides whether we joined mid-block.
 * Agent persistence still holds the current complete block in memory, so
 * history cannot supply the prefix that already went out on the live
 * channel. Toast once: wait for the stream to end, then reopen.
 */
function maybeToastLiveStreamHistoryGap(ev: AcpEvent): void {
  if (!runtime.historyLiveJoinCheck) return
  if (ev.type !== 'chunk' && ev.type !== 'thought') return
  if ((ev as { sessionId?: string }).sessionId == null) return
  runtime.historyLiveJoinCheck = false
  if (!liveStreamPrefixMissingFromHistory(ev)) return
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
  maybeToastLiveStreamHistoryGap(ev)
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
  handleExtEvent(set, get, ev)
}
