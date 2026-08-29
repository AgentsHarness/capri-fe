import type { TransportCore } from '../transport'

/** 用量与计费：billing credits 配置、usage report 聚合。 */
export const usageRpc = {
  async billing(this: TransportCore, sessionId?: string): Promise<import('../types').BillingConfigResponse> {
    const res = await this.fetch(this.url('/api/billing'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `billing failed (${res.status})`)
    }
    const result = data.result ?? {}
    return result && typeof result === 'object' ? result : {}
  },

  async usageReport(this: TransportCore,
    opts: { cwd?: string; sessionId?: string; from?: number; to?: number } = {},
  ): Promise<import('../types').UsageReportData> {
    const res = await this.fetch(this.url('/api/usage-report'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `usage report failed (${res.status})`)
    }
    const result = data.result ?? {}
    return result && typeof result === 'object' ? result : {}
  },
}
