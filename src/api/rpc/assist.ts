import type { TransportCore } from '../transport'
import { unwrapExtResult, xaiCall } from './core'

/** busy 期间的插话/辅助输入：/btw 小话、interject 插话、suggest 补全建议。 */
export const assistRpc = {
  async btw(this: TransportCore, opts: { question: string; sessionId?: string }): Promise<unknown> {
    // sessionId 可选：显式给出时透传（/btw 问答始终落在发起会话上，即使
    // 浏览器已切到别的会话）；缺省省略该键 → host 沿用活动会话。
    const body: Record<string, unknown> = { question: opts.question }
    if (opts.sessionId) body.sessionId = opts.sessionId
    return unwrapExtResult(await xaiCall(this, '/api/btw', body))
  },

  async interject(this: TransportCore, opts: { text: string }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/interject', opts))
  },

  async suggest(this: TransportCore, opts: {
    text: string
    cwd?: string
    cursor?: number
    limit?: number
    generation?: number
    includeAi?: boolean
    aiModel?: string
    tokenOnly?: boolean
  }): Promise<unknown> {
    const body: Record<string, unknown> = { text: opts.text }
    if (opts.cwd) body.cwd = opts.cwd
    if (opts.cursor !== undefined) body.cursor = opts.cursor
    if (opts.limit !== undefined) body.limit = opts.limit
    if (opts.generation !== undefined) body.generation = opts.generation
    if (opts.includeAi !== undefined) body.includeAi = opts.includeAi
    if (opts.aiModel) body.aiModel = opts.aiModel
    if (opts.tokenOnly !== undefined) body.tokenOnly = opts.tokenOnly
    return unwrapExtResult(await xaiCall(this, '/api/suggest', body))
  },

  async suggestPrompt(this: TransportCore, opts: { generation?: number } = {}): Promise<unknown> {
    const body: Record<string, unknown> = {}
    if (opts.generation !== undefined) body.generation = opts.generation
    return unwrapExtResult(await xaiCall(this, '/api/suggest-prompt', body))
  },
}
