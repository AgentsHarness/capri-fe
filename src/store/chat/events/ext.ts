import type { AcpEvent } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { handleExtSessionEvent } from './extSession'
import { handleExtMiscEvent } from './extMisc'

export function handleExtEvent(
  set: SetState,
  get: () => ChatState,
  ev: AcpEvent,
): boolean {
  return handleExtSessionEvent(set, get, ev) || handleExtMiscEvent(set, get, ev)
}
