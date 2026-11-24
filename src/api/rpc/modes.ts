import type { TransportCore } from '../transport'
import { newIdempotencyKey } from '../idempotency'

/** 权限/模式控制：yolo/auto 模式切换、plan 模式、权限规则重置。 */
export const modesRpc = {
  async setMode(this: TransportCore, modeId: string, sessionId?: string, idempotencyKey?: string) {
    const res = await this.fetch(this.url('/api/set-mode'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modeId,
        // 可选：目标会话（缺省 = host active 会话；permission 模式分支
        // 在 host 侧仍是全局 yolo_mode_changed 语义）。
        ...(sessionId ? { sessionId } : {}),
      }),
    }, { idempotencyKey: idempotencyKey ?? newIdempotencyKey() })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'set mode failed')
    return data
  },

  async togglePlanMode(this: TransportCore,
    sessionId?: string,
    idempotencyKey?: string,
  ): Promise<{ ok?: boolean; planMode?: boolean }> {
    const res = await this.fetch(this.url('/api/toggle-plan-mode'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    }, { idempotencyKey: idempotencyKey ?? newIdempotencyKey() })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'toggle plan mode failed')
    }
    return data
  },

  async permissionsReset(this: TransportCore, sessionId?: string, idempotencyKey?: string): Promise<void> {
    const res = await this.fetch(this.url('/api/permissions-reset'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    }, { idempotencyKey: idempotencyKey ?? newIdempotencyKey() })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'permissions reset failed')
    }
  },
}
