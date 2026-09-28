import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** 内容宽度与可用宽度相差 1px 以内算放得下（subpixel 舍入）。 */
const FIT_SLACK_PX = 1

/**
 * 投影：把当前渲染换成完整标签后，这行的内容宽度。
 *
 * 显示的标签越短，就得把两段文本的宽度差补回去；否则判定会抖：换成短名后
 * 内容立刻「放得下」，换回完整名字又溢出，来回跳。投影始终以完整标签为
 * 基准，判定与当前显示哪一个无关。
 */
export function projectFullWidth(
  contentW: number,
  showingFull: boolean,
  labelDeltaPx: number,
): number {
  return showingFull ? contentW : contentW + Math.max(0, labelDeltaPx)
}

/** 完整标签放得下吗。 */
export function fitsFullWidth(contentW: number, availW: number): boolean {
  return contentW <= availW + FIT_SLACK_PX
}

/**
 * 行内容宽度：取参与布局的子元素右边界相对行左边界的最大值。
 *
 * 行是 max-w-[75%] 的绝对定位 flex，内容比上限宽时会往右溢出（可见内容
 * 超出盒子），所以不能只看盒子的 clientWidth。data-probe 是宽度探针自身
 * （绝对定位），要跳过——它只是量文本宽度用的。
 */
function rowContentWidth(row: HTMLElement): number {
  const left = row.getBoundingClientRect().left
  let w = row.clientWidth
  for (const child of Array.from(row.children)) {
    if (child.hasAttribute('data-probe')) continue
    w = Math.max(w, child.getBoundingClientRect().right - left)
  }
  return w
}

/**
 * composer 底栏模式标签该显示完整名还是短名。
 *
 * 宽裕时用 TUI 全名（'always-approve'），实测放不下才退到短名（'always'）。
 * 按屏幕宽度猜是不够的：模型名长度同样占这行的宽度，所以两边都实测——可用
 * 宽度取行的 clientWidth（被 max-w-[75%] 钉住），内容宽度取参与布局的子元素
 * 右边界；完整/短名的文本宽度由调用方在同一行内渲染的两个绝对定位探针量出
 * （探针打 data-probe，既不影响布局也不计入内容宽度）。
 *
 * contentKey：内容宽度还取决于模型名 / token 数 / 其它 flag，而这些变化不
 * 一定改变行盒子尺寸（内容溢出时盒子被上限钉住，ResizeObserver 看不到），
 * 所以调用方把这些值的签名作为依赖传进来。
 */
export function useFittedModeLabel(args: {
  rowRef: RefObject<HTMLElement | null>
  fullProbeRef: RefObject<HTMLElement | null>
  shortProbeRef: RefObject<HTMLElement | null>
  full: string
  short: string
  contentKey: string
}): string {
  const { rowRef, fullProbeRef, shortProbeRef, full, short, contentKey } = args
  const [showFull, setShowFull] = useState(true)
  const showFullRef = useRef(showFull)
  showFullRef.current = showFull

  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return
    const measure = () => {
      const showingFull = showFullRef.current
      const delta =
        (fullProbeRef.current?.getBoundingClientRect().width ?? 0) -
        (shortProbeRef.current?.getBoundingClientRect().width ?? 0)
      const contentW = projectFullWidth(rowContentWidth(row), showingFull, delta)
      const next = fitsFullWidth(contentW, row.clientWidth)
      setShowFull((prev) => (prev === next ? prev : next))
    }
    measure()
    // 窗口缩放、栏宽变化（侧栏开合、旋屏）都会改可用宽度。
    window.addEventListener('resize', measure)
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(row)
    const box = row.offsetParent
    if (ro && box instanceof HTMLElement) ro.observe(box)
    return () => {
      window.removeEventListener('resize', measure)
      ro?.disconnect()
    }
  }, [rowRef, fullProbeRef, shortProbeRef, full, short, contentKey])

  return showFull ? full : short
}
