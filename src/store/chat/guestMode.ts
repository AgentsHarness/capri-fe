import { pushToast } from '../toast'
import type { ChatState } from './types'

/**
 * 访客（只读分享）的最小判定与入口守卫。
 *
 * 单独成文件、只依赖 toast 与类型：写操作的 action 模块只引它，不会因为
 * 这条守卫顺带把 transport / loadHistory 拖进依赖图（测试里 mock 传输层
 * 的模块不需要为此补一堆桩）。
 *
 * 前端守卫只为给出「访客模式为只读」的即时反馈；真正的边界在 hub
 * （白名单中继 + 事件过滤）。
 */

export function isGuestState(s: Pick<ChatState, 'guestIdentity'>): boolean {
  return s.guestIdentity != null
}

/**
 * 访客标识的模块级镜像。chat store 之外的模块（historyPins 等）不能
 * import chat store —— store 本身 import 它们，会形成循环依赖；而它们
 * 只需要回答「现在是不是访客」这一个问题。
 *
 * 唯一写入点是 guestActions.setGuestIdentity（store 里那份身份才是真相）。
 */
let guestActive = false

export function setGuestActive(active: boolean): void {
  guestActive = active
}

export function isGuestActive(): boolean {
  return guestActive
}

/** 入口守卫：访客下拒绝写操作并提示。返回 true = 已拦截。 */
export function blockGuestWrite(
  s: Pick<ChatState, 'guestIdentity'>,
  message = '访客模式为只读',
): boolean {
  if (!isGuestState(s)) return false
  pushToast(message, { id: 'guest-readonly', type: 'info' })
  return true
}
