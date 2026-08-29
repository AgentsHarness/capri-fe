import type { TransportCore } from '../transport'
import { unwrapExtResult, xaiCall } from './core'

/** busy 期间的插话/辅助输入：/btw 小话、interject 插话、suggest 补全建议。 */
export const assistRpc = {
  async btw(this: TransportCore, opts: { question: string }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/btw', opts))
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
