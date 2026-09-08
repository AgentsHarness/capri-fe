import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'

/**
 * 顶栏 chip 与行内动作共用的下拉面板：触发元素只给一个 ref，面板按视口
 * 定位（fixed），所以放在 overflow 容器里（运行任务条、scrollback 行）也
 * 不会被裁掉。
 */
export function ChipDropdown({
  open,
  onClose,
  children,
  label,
  widthClass,
  anchorRef,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  label: string
  widthClass?: string
  anchorRef: RefObject<HTMLElement | null>
}) {
  // Viewport-pinned placement (same measure-and-clamp pattern as the
  // composer model picker): a pure `absolute right-0` anchor assumes the
  // trigger chip sits flush right, but on mobile the chip cluster wraps —
  // the goal chip often lands mid-row, pushing a w-96 panel past the
  // LEFT edge of the screen. Measure the chip and clamp so both edges
  // stay inside the viewport; re-place on resize/scroll.
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = () => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const pad = 8
      const gap = 4 // mt-1
      const vw = window.innerWidth
      // Match the panel's width classes: w-96 capped by max-w-[92vw]
      // (w-80 / w-64 fallbacks keep the same viewport math).
      const width = Math.min(
        widthClass === 'w-96' ? 384 : widthClass === 'w-80' ? 320 : widthClass === 'w-64' ? 256 : 384,
        Math.floor(vw * 0.92),
      )
      // Prefer right-aligning to the chip (TUI goal-detail sits under
      // the status item), then shift left so the panel never leaves the
      // screen on either side.
      const left = Math.max(pad, Math.min(r.right - width, vw - pad - width))
      setPos({ left, top: r.bottom + gap, width })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchorRef, widthClass])

  // 面板渲染后按实测高度校正一次：调用方不只有顶栏 chip，还有 scrollback
  // 里的任务行——行落在视口下半部时，向下开会整块掉出屏幕。放不下就改贴
  // 触发元素上沿；上下都放不下时 next 收敛到 pad，第二次比较即相等，不死循环。
  useLayoutEffect(() => {
    if (!open || !pos) return
    const h = panelRef.current?.offsetHeight ?? 0
    const vh = window.innerHeight
    const pad = 8
    const gap = 4
    if (pos.top + h <= vh - pad) return
    const anchorTop = anchorRef.current?.getBoundingClientRect().top
    if (anchorTop == null) return
    const next = Math.max(pad, anchorTop - gap - h)
    if (Math.abs(next - pos.top) > 1) setPos({ ...pos, top: next })
  }, [open, pos, anchorRef])

  if (!open) return null
  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-30 cursor-default"
        aria-label="close"
        onClick={onClose}
      />
      {pos ? (
        <div
          ref={panelRef}
          className={`fixed z-40 max-h-[55vh] max-w-[92vw] overflow-y-auto gn-menu ${widthClass ?? 'w-80'}`}
          style={{ left: pos.left, top: pos.top, width: pos.width }}
        >
          <div className="px-3 pb-1 pt-1.5 text-[10px] uppercase tracking-wider text-gn-gutter">
            {label}
          </div>
          {children}
        </div>
      ) : null}
    </>
  )
}
