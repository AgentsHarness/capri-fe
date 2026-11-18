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
 * 行是 right-2、max-w-[calc(100%-0.5rem)] 的绝对定位 flex，模型名被 flex
 * 收缩时内容会截断在一个比完整名字窄的盒子里，所以不能只看盒子的
 * clientWidth（模型名多出来的宽度由调用方用 modelNameRef 补回）。
 * data-probe 是宽度探针自身（绝对定位），要跳过——它只是量文本宽度用的。
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
 * 行的可用宽度：取行自己的 max-width 上限，而不是当前 clientWidth。
 *
 * 行是 right 定位、宽度 auto 的绝对定位 flex：内容窄时盒子会收缩到内容
 * 宽度，此时 clientWidth 等于当前内容。拿它判断「完整名放不放得下」会让
 * 已经缩成短名的行永远回不到全名（投影后的完整宽度必然大于它自己的短名
 * 宽度）。
 *
 * 可用宽度 = containing block 宽度 - 行的右侧偏移（`right-2`），再受
 * max-width 上限约束。底栏的 max-width 是 `calc(100% - 0.5rem)`，与右侧
 * 偏移同值，所以 calc 不用单独解析；其它非 % / px 上限也按 right 偏移算。
 * 取不到时退回 clientWidth（jsdom 无布局）。
 */
export function rowAvailableWidth(row: HTMLElement): number {
  const box = row.offsetParent
  if (!(box instanceof HTMLElement)) return row.clientWidth
  const cs = getComputedStyle(row)
  const right = Number.parseFloat(cs.right)
  let avail = box.clientWidth - (Number.isFinite(right) ? right : 0)
  const maxW = cs.maxWidth
  if (maxW.endsWith('%')) {
    const pct = Number.parseFloat(maxW)
    if (Number.isFinite(pct)) avail = Math.min(avail, (box.clientWidth * pct) / 100)
  } else if (maxW.endsWith('px')) {
    const px = Number.parseFloat(maxW)
    if (Number.isFinite(px)) avail = Math.min(avail, px)
  }
  return avail > 0 ? avail : row.clientWidth
}

/**
 * composer 底栏模式标签该显示完整名还是短名。
 *
 * 按实测宽度决定：宽裕时用 TUI 全名（'always-approve'），实测放不下才退到
 * 短名（'always'）。不按视口宽度一刀切——窗口很窄但底栏实际放得下时仍显示
 * 完整名。模型名长度同样占这行的宽度，所以两边都实测——可用宽度取行的
 * max-width 上限（见 rowAvailableWidth），内容宽度取参与布局的子元素右边界；
 * 完整/短名的文本宽度由调用方在同一行内渲染的两个绝对定位探针量出（探针
 * 打 data-probe，既不影响布局也不计入内容宽度）。
 *
 * 模型名本身可能已被 flex 截断（模型槽现在只按行上限收缩）。截断后的右边界
 * 不再是完整模型名的宽度，所以还要用 modelNameRef 的
 * `scrollWidth - clientWidth` 把少掉的那段补回来；否则模式名会误以为行里
 * 还有空间。
 *
 * contentKey：内容宽度还取决于模型名 / token 数 / 其它 flag，而这些变化不
 * 一定改变行盒子尺寸（内容溢出时盒子被上限钉住，ResizeObserver 看不到），
 * 所以调用方把这些值的签名作为依赖传进来。
 */
export function useFittedModeLabel(args: {
  rowRef: RefObject<HTMLElement | null>
  fullProbeRef: RefObject<HTMLElement | null>
  shortProbeRef: RefObject<HTMLElement | null>
  /** 模型名 span：被截断时用 scrollWidth-clientWidth 补回完整宽度。 */
  modelNameRef: RefObject<HTMLElement | null>
  full: string
  short: string
  contentKey: string
}): string {
  const {
    rowRef,
    fullProbeRef,
    shortProbeRef,
    modelNameRef,
    full,
    short,
    contentKey,
  } = args
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
      const name = modelNameRef.current
      const modelDelta = name
        ? Math.max(0, name.scrollWidth - name.clientWidth)
        : 0
      const contentW = projectFullWidth(
        rowContentWidth(row) + modelDelta,
        showingFull,
        delta,
      )
      const next = fitsFullWidth(contentW, rowAvailableWidth(row))
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
  }, [
    rowRef,
    fullProbeRef,
    shortProbeRef,
    modelNameRef,
    full,
    short,
    contentKey,
  ])

  return showFull ? full : short
}
