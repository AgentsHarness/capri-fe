import { fmtBytes } from '../../format'
import { ICON_COL_CLASS } from '../../theme/layout'

/** 占位行上的手动补全按钮：待补全给 [加载]，失败给 [重试]。 */
function LoadButton({ failed, onFill }: { failed: boolean; onFill: () => void }) {
  return (
    <button
      type="button"
      onClick={(ev) => {
        ev.stopPropagation()
        onFill()
      }}
      className="shrink-0 text-[10.5px] text-gn-cyan hover:text-gn-fg hover:underline"
      title={failed ? '重试加载被省略的工具输出' : '加载被省略的工具输出'}
    >
      {failed ? '[重试]' : '[加载]'}
    </button>
  )
}

/**
 * lite 裁掉的工具正文占位行。展开 / 「查看」已经按 [msgSeq, msgSeqEnd]
 * 自动触发补全；[加载] 是手动入口（自动补全失败或还没发出去时点），
 * 失败换成 [重试]，加载中只显示 spinner 文案。
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
  /** 待补全 / 失败时的手动入口。加载中不展示按钮。 */
  onFill?: () => void
  className?: string
}) {
  const loading = state === 'loading'
  const failed = state === 'error'
  const size = fmtBytes(bytes)
  return (
    <div
      className={`flex min-w-0 items-center gap-1.5 py-0.5 font-mono text-[11.5px] leading-[1.5] text-gn-muted ${className}`}
    >
      {/* 与行头的 ◆ 共用图标列：占位行的图标/文案左边界和工具标题行对齐。 */}
      <span
        className={`${ICON_COL_CLASS}${loading ? ' animate-pulse' : ''}`}
        aria-hidden
      >
        {loading ? '⠿' : '·'}
      </span>
      <span className="min-w-0 truncate">
        {loading
          ? `正在加载工具输出 · ${size}…`
          : failed
            ? `工具输出加载失败 · ${size}`
            : `输出已省略 · ${size}`}
      </span>
      {!loading && onFill ? <LoadButton failed={failed} onFill={onFill} /> : null}
    </div>
  )
}

/**
 * `输出已省略` 的正文占位（ToolDetail 空正文分支用）。文案与按钮口径同
 * LiteToolFill；没有 onLoad 时只读。
 */
export function OmittedToolBody({
  onLoad,
  loadState,
  className = 'mt-1',
}: {
  onLoad?: () => void
  loadState?: 'loading' | 'error' | 'filled'
  className?: string
}) {
  const loading = loadState === 'loading'
  const failed = loadState === 'error'
  return (
    <div className={`min-w-0 font-ui text-[12.5px] leading-[1.45] ${className}`}>
      <div className="px-0.5 py-0.5 text-[12px] text-gn-muted">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate">
            {loading ? '正在加载工具输出…' : failed ? '工具输出加载失败' : '输出已省略'}
          </span>
          {!loading && onLoad ? <LoadButton failed={failed} onFill={onLoad} /> : null}
        </span>
      </div>
    </div>
  )
}
