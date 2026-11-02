/**
 * `[ui] page_flip_on_send` 的 DOM 侧换算（TUI `scrollback/state/pin_reserve.rs`）。
 *
 * TUI 把刚发出的 prompt 顶对齐后，在转录尾部补一段留白（pin reserve），
 * 让「prompt 顶 == 滚动底」成立。没有这段留白，顶对齐的 scrollTop 会被
 * 浏览器钳到真实尾部 —— 发送后翻页看起来完全没生效。留白随回答长高而
 * 收缩，回答写满一页（{@link pinReserveConsumed}）后解除、回到贴底跟随。
 */

/** 显式回底手势（G 键）先广播它，持有留白的视图据此解除补白。 */
export const PIN_RELEASE_EVENT = 'gn:pin-release'

/** 让 target 成为滚动底所需的底部留白（px）。 */
export function pinReservePad(
  target: number,
  clientHeight: number,
  contentHeight: number,
): number {
  return Math.max(0, Math.round(target + clientHeight - contentHeight))
}

/** 回答已写满一页（留白遮不住）：该解除钉住、回到跟随。 */
export function pinReserveConsumed(
  target: number,
  clientHeight: number,
  contentHeight: number,
): boolean {
  return contentHeight - clientHeight > target
}

/** prompt 顶边对齐到可读区顶（workspace bar 下沿）所需的 scrollTop。 */
export function pinScrollTarget(
  scrollTop: number,
  entryTop: number,
  boxTop: number,
  barHeight: number,
): number {
  return Math.max(0, Math.round(scrollTop + entryTop - boxTop - barHeight))
}
