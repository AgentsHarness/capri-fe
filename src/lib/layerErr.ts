import type { LayerErr } from '../store/chat/types'

/**
 * 从分层错误栈（hub / host 各最多一条）中挑出要展示的那条：
 * error 优先于 warning，同级取 at 较新（同层新错误本就覆盖旧的）。
 * agent 回合级错误不进这里（它是会话时间线的一部分，由 scrollback
 * 错误行承担）；操作类失败走 toast。
 */
export function pickLayerError(layerErrors: {
  hub?: LayerErr
  host?: LayerErr
}): { layer: 'hub' | 'host'; err: LayerErr } | null {
  const cands: Array<{ layer: 'hub' | 'host'; err: LayerErr }> = []
  if (layerErrors.hub) cands.push({ layer: 'hub', err: layerErrors.hub })
  if (layerErrors.host) cands.push({ layer: 'host', err: layerErrors.host })
  if (cands.length === 0) return null
  const errorCands = cands.filter((c) => c.err.level === 'error')
  const pool = errorCands.length > 0 ? errorCands : cands
  pool.sort((a, b) => b.err.at - a.err.at)
  return pool[0]
}
