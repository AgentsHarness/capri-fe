/** Pause between scroll-up page loads (also shields the anchor-restore
 *  scroll event from chaining the next page immediately). */
export const TOP_PAGE_COOLDOWN_MS = 400

/** 距内容顶多少 px 以内算「已经顶到边界」。旧实现用 80px 触发带：已加载
 *  内容很短时 scrollTop 长期停在 0~40px，任何一次微小滚动都算「到顶」，
 *  于是阅读过程中被反复误触发翻页。 */
export const TOP_EDGE_PX = 4
/** 顶到边界后还要继续上推多少像素才真的翻页（pull-to-load）。触控板一次
 *  轻扫 / 惯性尾巴远不到这个量。 */
export const PULL_TRIGGER_PX = 80
/** 上推累加器的空闲窗口：两次上推间隔超过它即视为新的一下的手势（同时解开
 *  「一次手势最多一页」的门闩）。 */
export const PULL_IDLE_MS = 350
/** 刚滚到边界后要先停这么久才开始累计上推。没有这一条，「一路滚到顶」的
 *  那几下会被当成上拉，读长会话时到顶即误翻页；有了它，到顶 → 停一下 →
 *  再拉才翻页。 */
export const PULL_DWELL_MS = 100

/** Touch gesture distance (px) past the top edge that counts as a
 *  deliberate pull for older history. */
export const TOUCH_UP_SWIPE_PX = 96

/** prepend 落地后「锚点看门狗」的存活窗口：这期间图片 / mermaid / 长
 *  markdown 的晚到撑高会二次挪动视口（实测首屏后 1~2s 还在长），窗口内按
 *  同一锚点重放恢复。 */
export const ANCHOR_SETTLE_MS = 5000
/**
 * 触发翻页的那一下滚轮，其动量会在我们写完 scrollTop 之后继续作用几十毫秒
 * （实测 1022 → 981 滑行 ~70ms），把补偿掉的部分又吃回去。这段时间内逐帧
 * 纠偏，并且不把这几下来回滚动的事件当成「用户接管」。
 */
export const ANCHOR_MOMENTUM_MS = 400
/** 小于该漂移不纠正（亚像素 / 边框取整）。 */
export const ANCHOR_DRIFT_TOLERANCE_PX = 2

/** Hover bg for collapsed header-style: blend(bg_base, bg_dark, 0.5). */
export const HOVER_BG =
  'color-mix(in srgb, var(--color-gn-bg-dark) 50%, var(--color-gn-bg-base))'
