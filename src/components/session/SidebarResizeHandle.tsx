import { useEffect, useRef } from 'react'
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '../../lib/sidebarWidth'

/**
 * 桌面会话侧边栏右缘的拖拽手柄：按住左右拖动改宽度，聚焦后左右箭头
 * 每次 8px 微调（与 Git 面板列宽手柄同一交互口径）。
 *
 * 只负责把「期望宽度」交给调用方，钳制与持久化在 store 的
 * `setSidebarWidth` 里做。拖动期间由调用方关掉 width 过渡，否则每帧
 * 都被 200ms 缓动追着走。
 */
export function SidebarResizeHandle({
  width,
  onResize,
  onDragStart,
  onDragEnd,
}: {
  width: number
  onResize: (width: number) => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  const stopDrag = () => {
    if (!drag.current) return
    drag.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    onDragEnd()
  }

  // 拖拽中侧边栏被卸载（折叠/切 host）时还原 body 光标与选中态。
  useEffect(
    () => () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    },
    [],
  )

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="调整会话侧边栏宽度"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      title="拖动调整侧边栏宽度"
      className="group absolute inset-y-0 right-0 z-30 flex w-1.5 cursor-col-resize touch-none select-none items-center justify-end"
      onPointerDown={(e) => {
        drag.current = { startX: e.clientX, startWidth: width }
        // jsdom 未实现 pointer capture；真实浏览器里丢了 capture，快速
        // 拖出侧边栏后事件会断。
        e.currentTarget.setPointerCapture?.(e.pointerId)
        e.preventDefault()
        onDragStart()
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
      onPointerMove={(e) => {
        if (drag.current) {
          onResize(drag.current.startWidth + (e.clientX - drag.current.startX))
        }
      }}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        onResize(width + (e.key === 'ArrowRight' ? 8 : -8))
      }}
    >
      {/* 这条 1px 线就是侧边栏的右边框（aside 不再单独画 border-r），
          平常是分隔线颜色，hover/拖动/键盘聚焦时变青色；贴右缘而非
          居中，才能和边框线重合。z-30 高于列表 sticky 组头的 z-20。 */}
      <span className="h-full w-px bg-gn-prompt-border/60 transition-colors group-hover:bg-gn-cyan group-active:bg-gn-cyan group-focus-visible:bg-gn-cyan" />
    </span>
  )
}
