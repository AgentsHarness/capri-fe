/**
 * 逐帧追底：内容持续增长时把 scrollTop 从当前位置缓动到目标位置，
 * 避免整行硬跳。同一个元素同时只有一个 rAF 循环，重复调用只更新目标。
 */

type SmoothOptions = {
  /** 每帧走剩余距离的比例（0–1），越大追得越快。 */
  factor?: number
  /** 单帧最大位移（px），防止积压很大时一帧跳很远。 */
  maxStep?: number
  /** 返回 false 时立刻停止（用户上滑 / 组件卸载）。 */
  isActive?: () => boolean
}

type SmoothState = {
  raf: number | null
  target: number
  opts: SmoothOptions
}

const states = new WeakMap<HTMLElement, SmoothState>()

/** 停止该元素正在进行的平滑滚动。 */
export function cancelSmoothScroll(el: HTMLElement | null | undefined): void {
  if (!el) return
  const state = states.get(el)
  if (!state) return
  if (state.raf != null) {
    cancelAnimationFrame(state.raf)
    state.raf = null
  }
}

/**
 * 缓动到 `target`。目标按元素的真实最大 scrollTop 钳制；
 * 若元素本身不可滚动则直接返回。
 */
export function smoothScrollTop(
  el: HTMLElement,
  target: number,
  opts: SmoothOptions = {},
): void {
  const max = el.scrollHeight - el.clientHeight
  if (max <= 0) return

  let state = states.get(el)
  if (!state) {
    state = { raf: null, target, opts }
    states.set(el, state)
  }
  state.target = Math.max(0, Math.min(max, target))
  state.opts = opts
  if (state.raf != null) return

  const tick = () => {
    const current = states.get(el)
    if (!current) return
    current.raf = null
    if (current.opts.isActive && !current.opts.isActive()) return

    const limit = Math.max(0, el.scrollHeight - el.clientHeight)
    const goal = Math.min(current.target, limit)
    const gap = goal - el.scrollTop
    if (Math.abs(gap) <= 0.5) {
      el.scrollTop = goal
      return
    }

    const factor = current.opts.factor ?? 0.4
    const maxStep = current.opts.maxStep ?? 48
    let step = gap * factor
    if (step > maxStep) step = maxStep
    else if (step < -maxStep) step = -maxStep
    if (Math.abs(step) < 1) step = gap > 0 ? 1 : -1

    el.scrollTop += step
    current.raf = requestAnimationFrame(tick)
  }

  state.raf = requestAnimationFrame(tick)
}
