import type { AcpEvent } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { extractSessionUpdate } from '../entries'
import { handleNotifCore } from './notifCore'
import { handleNotifHooks } from './notifHooks'
import { handleNotifMemory } from './notifMemory'
import { handleNotifApps } from './notifApps'
import type { WireEvent } from './wire'

export function handleSessionNotification(
  set: SetState,
  get: () => ChatState,
  ev: AcpEvent,
): void {
  const wire = ev as WireEvent
  const { tag, fields } = extractSessionUpdate(wire.params)
  if (!tag) return
  if (handleNotifCore(set, get, wire, tag, fields)) return
  if (handleNotifHooks(set, get, wire, tag, fields)) return
  if (handleNotifMemory(set, get, wire, tag, fields)) return
  if (handleNotifApps(set, get, wire, tag, fields)) return
}
