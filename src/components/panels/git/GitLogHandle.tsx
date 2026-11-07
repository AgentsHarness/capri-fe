import { useEffect, useRef } from 'react'

export function LogColHandle({
  label,
  onDragStart,
  onDrag,
}: {
  label: string
  onDragStart: () => void
  onDrag: (dx: number) => void
}) {
  const drag = useRef<{ startX: number } | null>(null)
  // 面板在拖拽中关掉时还原 body 光标/选中态
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
      aria-label={label}
      tabIndex={0}
      className="group absolute -right-1 top-0 z-10 flex h-full w-2 cursor-col-resize touch-none select-none items-center justify-center"
      onPointerDown={(e) => {
        drag.current = { startX: e.clientX }
        // jsdom 未实现 pointer capture；真实浏览器里丢了 capture 快速拖动会甩丢事件。
        e.currentTarget.setPointerCapture?.(e.pointerId)
        e.preventDefault()
        onDragStart()
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
      onPointerMove={(e) => {
        if (drag.current) onDrag(e.clientX - drag.current.startX)
      }}
      onPointerUp={() => {
        drag.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }}
      onPointerCancel={() => {
        drag.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        onDragStart()
        onDrag(e.key === 'ArrowRight' ? 8 : -8)
      }}
    >
      <span className="h-full w-px bg-gn-prompt-border/70 transition-colors group-hover:bg-gn-cyan group-active:bg-gn-cyan group-focus-visible:bg-gn-cyan" />
    </span>
  )
}
