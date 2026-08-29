import type { TransportCore } from '../transport'

/** goal 跟踪控制（host 拥有 goal 引擎，/api/goal/* 端点）。 */
export const goalRpc = {
  async goalSet(this: TransportCore, objective: string, tokenBudget?: number, sessionId?: string) {
    const res = await this.fetch(this.url('/api/goal/set'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective,
        ...(tokenBudget && tokenBudget > 0 ? { tokenBudget } : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'goal set failed')
    return data
  },

  async goalStatus(this: TransportCore, sessionId?: string) {
    const res = await this.fetch(this.url('/api/goal/status'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'goal status failed')
    return data
  },

  async goalPause(this: TransportCore, sessionId?: string) {
    const res = await this.fetch(this.url('/api/goal/pause'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'goal pause failed')
    return data
  },

  async goalResume(this: TransportCore, sessionId?: string) {
    const res = await this.fetch(this.url('/api/goal/resume'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'goal resume failed')
    return data
  },

  async goalClear(this: TransportCore, sessionId?: string) {
    const res = await this.fetch(this.url('/api/goal/clear'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'goal clear failed')
    return data
  },
}
