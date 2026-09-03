import { fmtBytes } from '../../format'

/**
 * lite 裁掉的工具正文占位行。展开 / 「查看」已经按 [msgSeq, msgSeqEnd]
 * 触发补全，所以这里只展示省略规模和加载中 spinner；按钮只在失败时给
 * 就地 [重试]，加载中和尚未返回时都不出现。
 */
export function LiteToolFill({
  bytes,
  state,
  onFill,
  className = '',
}: {
  bytes: number
  /** 补全态；缺省 = 还没拉过（展开瞬间、请求尚未打上 loading）。 */
  state?: 'loading' | 'error' | 'filled'
  /** 失败就地重试。加载中 / 待补全不展示按钮。 */
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
            : `输出已省略 · ${size}`}
      </span>
      {failed && onFill ? (
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation()
            onFill()
          }}
          className="shrink-0 text-[10.5px] text-gn-cyan hover:text-gn-fg hover:underline"
          title="重试加载被省略的工具输出"
        >
          [重试]
        </button>
      ) : null}
    </div>
  )
}
