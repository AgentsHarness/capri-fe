import type { MouseEvent, ReactNode } from 'react'
import { Maximize2 } from 'lucide-react'

/**
 * 弹窗查看器入口（键盘 Enter 的指针等价物）。
 * 可折叠块只在展开后渲染；作为标题 button 的兄弟节点，避免嵌套 button。
 */
const VIEW_BTN_CLASS =
  'inline-flex shrink-0 items-center justify-center gap-1 rounded px-1.5 text-[11px] text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg min-h-9 min-w-9 sm:min-h-0 sm:min-w-0 sm:h-5'

export function ViewButton({
  visible,
  onOpen,
  compact = false,
  className = '',
}: {
  visible: boolean
  onOpen: () => void
  /** 顶栏任务条等紧凑行：不要移动端 min-h-9。 */
  compact?: boolean
  className?: string
}) {
  if (!visible) return null
  return (
    <button
      type="button"
      onClick={(ev: MouseEvent) => {
        ev.stopPropagation()
        ev.preventDefault()
        onOpen()
      }}
      title="查看全文（Enter）"
      className={`${compact ? 'inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg' : VIEW_BTN_CLASS} ${className}`}
    >
      <Maximize2 size={11} strokeWidth={2} aria-hidden />
      查看
    </button>
  )
}

/** 把 HEADER/DENSE 行上的 w-full 换成 flex-1，给右侧「查看」留位。
 *  select-text：标题 button 内的文本参与划选复制（浏览器默认 button
 *  文本不可选，工具/思考头部长路径复制不了）。 */
function foldBtnClass(className: string): string {
  return `${className.replace(/\bw-full\b/g, '').replace(/\s+/g, ' ').trim()} min-w-0 flex-1 select-text`
}

/**
 * 可折叠标题行：左侧 button 立刻折叠，右侧「查看」是兄弟 button。
 */
export function HeaderWithView({
  className,
  title,
  onFold,
  viewVisible,
  onOpen,
  children,
}: {
  className: string
  title?: string
  onFold: () => void
  viewVisible: boolean
  onOpen: () => void
  children: ReactNode
}) {
  return (
    <div className="flex w-full items-center gap-0.5">
      <button
        type="button"
        onClick={(ev) => {
          ev.stopPropagation()
          onFold()
        }}
        className={foldBtnClass(className)}
        title={title}
      >
        {children}
      </button>
      <ViewButton visible={viewVisible} onOpen={onOpen} />
    </div>
  )
}
