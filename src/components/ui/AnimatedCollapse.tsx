import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useFePrefs } from '../../store/historyPins'

/**
 * 高度过渡容器：展开时从 0 缓动到内容高，收起时先保留当前内容再缓动到 0，
 * 过渡结束后卸载；内容在展开态自身变高/变矮（正文补全、答案流式增长）也走
 * 同一条 height 过渡。
 *
 * 高度用 ResizeObserver 同步到 CSS 变量；无 RO 环境退回 height:auto（无
 * 高度动画但内容照常显示）。外层高度写 px 而不是 auto，才能让 height
 * 过渡在两个方向都成立。
 */
export function AnimatedCollapse({
  open,
  children,
  className,
  contentClassName,
  animate = true,
}: {
  open: boolean
  children: ReactNode
  className?: string
  contentClassName?: string
  /** false = 内容变化不播放高度过渡（流式正文自己管高度时用）。 */
  animate?: boolean
}) {
  const uiMotion = useFePrefs((s) => s.fePrefs.uiMotion) !== false
  const motion = animate && uiMotion
  const [mounted, setMounted] = useState(open)
  const [expanded, setExpanded] = useState(open)
  const boxRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  // 收起动画期间继续摆最后一次展开时的内容，避免正文提前消失只剩空框。
  const lastChildren = useRef<ReactNode>(children)
  if (open) lastChildren.current = children

  // 从收起切到展开：先挂载出 0 高容器，下一帧再放开 height，过渡才有起点。
  if (open && !mounted) setMounted(true)
  if (!open && expanded) setExpanded(false)
  // 不播过渡时没有 transitionend 可等，收起后立即卸载。
  if (!open && mounted && !motion) setMounted(false)

  useLayoutEffect(() => {
    if (!mounted) return
    const box = boxRef.current
    const inner = innerRef.current
    if (!box || !inner) return
    if (typeof ResizeObserver === 'undefined') return
    const sync = () => {
      box.style.setProperty('--gn-collapse-h', `${inner.offsetHeight}px`)
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [mounted])

  useLayoutEffect(() => {
    if (!open || !mounted || expanded) return
    if (!motion || typeof requestAnimationFrame === 'undefined') {
      setExpanded(true)
      return
    }
    const frame = requestAnimationFrame(() => setExpanded(true))
    return () => cancelAnimationFrame(frame)
  }, [open, mounted, expanded, motion])

  // 减少动态效果时 CSS 过渡被禁用，没有 transitionend 可等，直接卸掉。
  useEffect(() => {
    if (open || !mounted || typeof window === 'undefined') return
    if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    setMounted(false)
  }, [open, mounted])

  if (!mounted) return null
  return (
    <div
      ref={boxRef}
      className={`gn-collapse${motion ? '' : ' gn-collapse-instant'}${className ? ` ${className}` : ''}`}
      data-open={expanded ? '1' : '0'}
      aria-hidden={!open}
      onTransitionEnd={(ev) => {
        if (ev.target !== ev.currentTarget || ev.propertyName !== 'height') return
        if (!open) setMounted(false)
      }}
      onTransitionCancel={(ev) => {
        if (ev.target !== ev.currentTarget || ev.propertyName !== 'height') return
        if (!open) setMounted(false)
      }}
    >
      {/* flow-root 让子内容的 margin 计入 offsetHeight，否则底部会被裁掉。 */}
      <div
        ref={innerRef}
        className={contentClassName ? `flow-root ${contentClassName}` : 'flow-root'}
      >
        {open ? children : lastChildren.current}
      </div>
    </div>
  )
}
