import type { HostInfo } from '../api/types'

/**
 * Host list live status (hub registry mirror of the host_status
 * heartbeat). Precedence: offline > booting/unready > thinking (busy) >
 * pending > idle. Old hubs ship none of busy/booting/pendingCount —
 * returns undefined so the UI falls back to the plain online dot.
 */
export type HostState =
  | 'thinking'
  | 'pending'
  | 'booting'
  | 'idle'

export function hostState(h: HostInfo): HostState | undefined {
  if (!h.online) return undefined
  const live = h.busy !== undefined || h.booting !== undefined || h.pendingCount !== undefined
  if (!live) return undefined
  if (h.booting || h.ready === false) return 'booting'
  if (h.busy) return 'thinking'
  if ((h.pendingCount ?? 0) > 0) return 'pending'
  return 'idle'
}

/** Human label per state (list secondary line / tooltip). */
export function hostStateLabel(s: HostState | undefined): string | undefined {
  switch (s) {
    case 'thinking':
      return '思考中'
    case 'pending':
      return '待处理'
    case 'booting':
      return '启动中'
    case 'idle':
      return '空闲'
    default:
      return undefined
  }
}