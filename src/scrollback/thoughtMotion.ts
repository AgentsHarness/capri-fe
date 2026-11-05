/**
 * 流式思考活动区的逐帧运动模型（纯计算）。
 *
 * 正文高度从 1 行平滑长到设置的行数；超过上限后高度固定，靠 scrollTop
 * 缓动把最新一行留在底部。两段用同一条 rAF 驱动，避免高度跳行和滚动
 * 追底各跑一条循环。
 */

/** 一帧向目标逼近：按剩余距离取比例，单帧位移有上限，接近时不抖动。 */
export function easeThoughtValue(
  current: number,
  target: number,
  factor: number,
  maxStep: number,
): number {
  const gap = target - current
  if (Math.abs(gap) <= 0.5) return target
  const step = Math.min(maxStep, Math.max(1, Math.abs(gap) * factor))
  return current + Math.sign(gap) * step
}

/**
 * 给定正文内容高与可见行数上限，返回容器应显示的高度和 scrollTop。
 * scrollTop 只取超出上限的部分；上限内保持 0，正文自然向下展开。
 */
export function thoughtBodyTarget(
  contentHeight: number,
  maxHeight: number,
): { height: number; scrollTop: number } {
  const content = Math.max(0, contentHeight)
  const max = Math.max(0, maxHeight)
  return {
    height: Math.min(content, max),
    scrollTop: Math.max(0, content - max),
  }
}
