import { useEffect, useState, type RefObject } from 'react'

export type AnchoredMenuPos = {
  bottom: number
  right: number
  maxH: number
  width: number
}

type Options = {
  /** 菜单开关；关闭时清空定位并摘掉监听。 */
  open: boolean
  /** 触发按钮：菜单右对齐到它的右边缘，并在上方展开。 */
  anchorRef: RefObject<HTMLElement | null>
  /** 菜单包裹层：点击层内不关闭，其内部滚动不触发重新定位。 */
  menuRef: RefObject<HTMLElement | null>
  setOpen: (open: boolean) => void
  /** 高度按按钮上方剩余空间收缩时的下限 / 上限。 */
  minHeight: number
  maxHeight: number
  maxWidth: number
  /** 按钮与菜单之间的间距。 */
  gap: number
  /** 距视口边缘的安全边距。 */
  pad: number
}

/**
 * composer 弹层（模式 / 模型菜单）共用的视口定位与关闭行为：上方展开、
 * 右侧对齐按钮、按剩余空间收最大高度，resize / 外层 scroll 时重算，
 * 外部 mousedown 与 Escape 关闭。菜单尺寸不写死在 CSS 里，否则底栏贴底时
 * 会被 body { overflow:hidden } 裁掉。
 */
export function useAnchoredMenu({
  open,
  anchorRef,
  menuRef,
  setOpen,
  minHeight,
  maxHeight,
  maxWidth,
  gap,
  pad,
}: Options): AnchoredMenuPos | null {
  const [pos, setPos] = useState<AnchoredMenuPos | null>(null)

  useEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = () => {
      const btn = anchorRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const bottom = Math.max(pad, vh - r.top + gap)
      const maxH = Math.max(minHeight, Math.min(maxHeight, r.top - pad))
      const width = Math.min(maxWidth, vw - pad * 2)
      let left = r.right - width
      left = Math.max(pad, Math.min(left, vw - pad - width))
      const right = vw - left - width
      setPos({ bottom, right, maxH, width })
    }
    place()
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return
      }
      place()
    }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, anchorRef, menuRef, setOpen, minHeight, maxHeight, maxWidth, gap, pad])

  return pos
}
