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
  flushStreamBufBeforeEvent(set, get, ev)
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
