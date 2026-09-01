import { fmtBytes } from '../../format'

/**
 * lite 裁掉的工具正文占位行。host 只是没把正文发过来（不是没有正文），
 * 所以这里不能用各 kind 的 "(no content)" 空态：说清省了多少字节、怎么
 * 拿回来（展开 / 点「加载」都会按该条目的 [msgSeq, msgSeqEnd] 区间按需
 * 回拉 detail=full），补全中给行内 spinner，失败给就地重试。
 */
export function LiteToolFill({
  bytes,
  state,
  onFill,
  className = '',
}: {
  bytes: number
  /** 补全态；缺省 = 还没拉过。 */
  state?: 'loading' | 'error' | 'filled'
  /** 手动重试 / 加载（缺省 = 只读占位，例如键盘展开已在补全中）。 */
  onFill?: () => void
  className?: string
}) {
  const loading = state === 'loading'
  const failed = state === 'error'
  const size = fmtBytes(bytes)
  return (
    <div
      className={`flex min-w-0 items-center gap-1.5 px-2 py-0.5 font-mono text-[11.5px] leading-[1.5] text-gn-muted ${className}`}
    >
      {loading ? (
        <span className="animate-pulse shrink-0" aria-hidden>
          ⠿
        </span>
      ) : (
        <span className="w-3 shrink-0 text-center" aria-hidden>
          ·
        </span>
      )}
      <span className="min-w-0 truncate">
        {loading
          ? `正在加载工具输出 · ${size}…`
          : failed
            ? `工具输出加载失败 · ${size}`
            : `输出已省略 · ${size}（点击展开加载）`}
      </span>
      {onFill ? (
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation()
            onFill()
          }}
          className="shrink-0 rounded border border-gn-prompt-border px-1 text-[10.5px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg"
          title={failed ? '重试加载被省略的工具输出' : '加载被省略的工具输出'}
        >
          {failed ? '重试' : '加载'}
        </button>
      ) : null}
    </div>
  )
}
