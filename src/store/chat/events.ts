import type { AcpEvent } from '../../api/types'
import type { ChatState, SetState } from './types'
import { flushStreamBufBeforeEvent } from './stream'
import { handleConnEvent } from './events/conn'
import { handleUserStreamEvent } from './events/userStream'
import { handleToolEvent } from './events/tools'
import { handleTurnEndEvent } from './events/turnEnd'
import { handleSessionCtrlEvent } from './events/sessionCtrl'
import { handleSessionNotification } from './events/sessionNotif'
import { handleExtEvent } from './events/ext'

export function handleChatEvent(
  set: SetState,
  get: () => ChatState,
  ev: AcpEvent,
): void {
  // resync 由 transport/init 层处理（全量重建，见 store/chat/resync.ts），
  // 不是聊天事件；任何其他路径漏到这里都直接忽略，绝不参与流缓冲/分发。
  if (ev.type === 'resync') return
  const raw = ev as { update?: unknown }
  if (raw.update && typeof raw.update === 'object') {
    const u = raw.update as { sessionUpdate?: unknown }
    if (typeof u.sessionUpdate === 'string' && ev.type !== 'turn_completed') {
      ev = {
        type: 'session_notification',
        method: 'session/update',
        params: u,
      } as AcpEvent
    }
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
