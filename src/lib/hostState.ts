import type { HostInfo } from '../api/types'

/**
 * Host list live status (hub registry mirror of the host_status
 * heartbeat). Precedence: offline > booting/unready > thinking (busy) >
 * pending > idle.
 */
export type HostState =
  | 'thinking'
  | 'pending'
  | 'booting'
  | 'idle'

export function hostState(h: HostInfo): HostState | undefined {
  if (!h.online) return undefined
  if (h.booting || h.ready === false) return 'booting'
  if (h.busy) return 'thinking'
  if ((h.pendingCount ?? 0) > 0) return 'pending'
  return 'idle'
}

/**
 * 顶栏两个状态点用的状态。错误/警告是覆盖层，优先级高于活跃状态：
 * 错误 > 警告 > 正忙 > 空闲（在线）> 离线。
 */
export type HostSignal = 'error' | 'warning' | 'busy' | 'idle' | 'offline'

export function hostSignal(h: Pick<HostInfo, 'online' | 'busy'>): HostSignal {
  if (!h.online) return 'offline'
  return h.busy ? 'busy' : 'idle'
}

/**
 * 除当前 Host 外其余 Host 的聚合状态：任意一台正忙 → 正忙；否则任意一台
 * 在线 → 空闲；没有其他 Host 或全部离线 → 离线。
 */
export function otherHostsSignal(hosts: HostInfo[], currentHostId?: string): HostSignal {
  let online = false
  for (const h of hosts) {
    if (h.hostId === currentHostId || !h.online) continue
    if (h.busy) return 'busy'
    online = true
  }
  return online ? 'idle' : 'offline'
}

export function hostSignalLabel(s: HostSignal): string {
  switch (s) {
    case 'error':
      return '错误'
    case 'warning':
      return '警告'
    case 'busy':
      return '正忙'
    case 'idle':
      return '空闲'
    case 'offline':
      return '离线'
  }
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