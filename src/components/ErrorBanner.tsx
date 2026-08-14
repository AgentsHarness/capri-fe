import { useState } from 'react'
import { useChatStore } from '../store/chat'
import type { LayerErr } from '../store/chat/types'

/**
 * Top error banner — 全局状态错误的唯一权威位置（hub / host 层）。
 *
 * - 一次只显示一条：error 优先于 warning，同级取 at 较新；
 * - 带层级徽标 [hub] / [host]，让用户一眼分清是谁坏了；
 * - action 为 restart-agent 时提供「重启 Agent」按钮（杀进程 + 重新
 *   boot + 恢复上次会话），无需再钻进 host 菜单；
 * - 恢复事件（ready/busy/新回合/重连成功）自动清除对应层，也可手动 ✕。
 *
 * agent 回合级错误不进这里（它是会话时间线的一部分，由 scrollback
 * 错误行承担）；操作类失败走 toast。三条通道互不重叠。
 */
function pickLayerError(layerErrors: {
  hub?: LayerErr
  host?: LayerErr
}): { layer: 'hub' | 'host'; err: LayerErr } | null {
  const cands: Array<{ layer: 'hub' | 'host'; err: LayerErr }> = []
  if (layerErrors.hub) cands.push({ layer: 'hub', err: layerErrors.hub })
  if (layerErrors.host) cands.push({ layer: 'host', err: layerErrors.host })
  if (cands.length === 0) return null
  // error 优先于 warning；同级取较新（同层新错误本就覆盖旧的）。
  const errorCands = cands.filter((c) => c.err.level === 'error')
  const pool = errorCands.length > 0 ? errorCands : cands
  pool.sort((a, b) => b.err.at - a.err.at)
  return pool[0]
}

export function ErrorBanner() {
  const layerErrors = useChatStore((s) => s.layerErrors)
  const dismissNotice = useChatStore((s) => s.dismissNotice)
  const restartAgent = useChatStore((s) => s.restartAgent)
  const [restarting, setRestarting] = useState(false)

  const picked = pickLayerError(layerErrors)
  if (!picked) return null
  const { layer, err } = picked
  const isError = err.level === 'error'

  const onRestart = async () => {
    if (restarting) return
    setRestarting(true)
    await restartAgent()
    setRestarting(false)
  }

  return (
    <div
      role="alert"
      className={`flex items-center gap-2 border-b px-3 py-1.5 text-[12px] leading-snug select-none sm:px-4 ${
        isError
          ? 'border-gn-red/30 bg-gn-red/10 text-gn-red'
          : 'border-gn-warning/30 bg-gn-warning/10 text-gn-warning'
      }`}
    >
      <span
        className={`shrink-0 rounded px-1 py-px font-mono text-[10px] uppercase tracking-wider ${
          isError ? 'bg-gn-red/20' : 'bg-gn-warning/20'
        }`}
      >
        {layer}
      </span>
      <span className="min-w-0 flex-1 break-words">{err.message}</span>
      {err.action === 'restart-agent' && (
        <button
          type="button"
          onClick={() => void onRestart()}
          disabled={restarting}
          className={`shrink-0 rounded border px-2 py-0.5 transition-opacity enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${
            isError
              ? 'border-gn-red/40 hover:bg-gn-red/15'
              : 'border-gn-warning/40 hover:bg-gn-warning/15'
          }`}
          title="杀掉当前 agent 进程并重新启动（恢复上次会话）"
        >
          {restarting ? '重启中…' : '重启 Agent'}
        </button>
      )}
      <button
        type="button"
        onClick={dismissNotice}
        className="shrink-0 rounded px-1.5 leading-[18px] opacity-70 hover:bg-gn-bg-highlight hover:opacity-100"
        title="关闭提示"
        aria-label="关闭提示"
      >
        ✕
      </button>
    </div>
  )
}
