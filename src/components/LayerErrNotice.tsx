import { useState } from 'react'
import { X } from 'lucide-react'
import { useChatStore } from '../store/chat'
import type { LayerErr } from '../store/chat/types'

/**
 * hub / host 层错误的顶栏内联提示——挂在 host 切换器右侧：host 名字保持
 * 原样（前面加告警图标），错误文案单独一条跟在右边，不另占整行。
 *
 * - 带层级徽标 hub / host：一眼分清是中继还是这台 host 坏了；
 * - action 为 restart-agent 时提供「重启」按钮（杀进程 + 重新 boot +
 *   恢复上次会话），无需再钻进 host 菜单；
 * - 恢复事件（ready/busy/新回合/重连成功）自动清除对应层，也可手动 ✕。
 *
 * 布局：自身不定宽，由调用方（顶栏）放行内还是整行；消息在窄屏换行、
 * lg 起单行截断（title 兜底全文），窄屏的 ✕ / 重启按钮加大触点。
 */
export function LayerErrNotice({
  layer,
  err,
  className,
}: {
  layer: 'hub' | 'host'
  err: LayerErr
  /** 摆放（行内 / 整行、宽度上限）由调用方的 flex 容器决定。 */
  className?: string
}) {
  const dismissNotice = useChatStore((s) => s.dismissNotice)
  const restartAgent = useChatStore((s) => s.restartAgent)
  const [restarting, setRestarting] = useState(false)

  const tone = err.level === 'error' ? 'text-gn-red' : 'text-gn-warning'

  const onRestart = async () => {
    if (restarting) return
    setRestarting(true)
    await restartAgent()
    setRestarting(false)
  }

  return (
    <div
      role="alert"
      className={`flex min-w-0 items-center gap-1.5 ${tone} ${className ?? ''}`}
    >
      <span
        className={`shrink-0 rounded border px-1.5 font-mono text-[10px] font-bold uppercase leading-[16px] tracking-wider ${
          err.level === 'error'
            ? 'border-gn-red/50 bg-gn-red/25'
            : 'border-gn-warning/50 bg-gn-warning/25'
        }`}
      >
        {layer}
      </span>
      {/* 窄屏整行时撑满余宽换行显示；lg 回到行内（父级 w-auto 上限
          26rem）：flex-initial + truncate 就是原来的单行截断行为。 */}
      <span
        className="min-w-0 flex-1 break-words lg:flex-initial lg:truncate"
        title={err.message}
      >
        {err.message}
      </span>
      {err.action === 'restart-agent' && (
        <button
          type="button"
          onClick={() => void onRestart()}
          disabled={restarting}
          className={`shrink-0 rounded px-2 py-1 hover:bg-gn-bg-highlight disabled:cursor-not-allowed disabled:opacity-50 lg:px-1.5 lg:py-0.5 ${tone}`}
          title="杀掉当前 agent 进程并重新启动（恢复上次会话）"
        >
          {restarting ? '重启中…' : '重启'}
        </button>
      )}
      <button
        type="button"
        onClick={dismissNotice}
        className="shrink-0 rounded p-1.5 opacity-70 hover:bg-gn-bg-highlight hover:opacity-100 lg:p-0.5"
        title="关闭提示"
        aria-label="关闭提示"
      >
        <X size={11} aria-hidden />
      </button>
    </div>
  )
}
