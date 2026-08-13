import type { AcpEvent } from '../../../api/types'

/** AcpEvent plus the optional wire fields every handler reads. */
export type WireEvent = AcpEvent & {
  sessionId?: string
  params?: Record<string, unknown>
}
