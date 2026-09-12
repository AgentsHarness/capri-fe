/**
 * 会话归属策略的**唯一判定点**：订阅层（actions/init.ts）与事件分发层
 * （events/sessionNotif.ts）共用，避免出现两套过滤规则（此前订阅层按
 * ev.type 白名单、handler 层各写各的 `ev.sessionId && ...`，对同一类
 * 事件给出相反结论）。
 *
 * 判定顺序：
 *  1. 无归属标记或就是当前会话 → 保留；
 *  2. 全局 kind（客户端级广播）→ 保留；
 *  3. 全局事件类型（检索/git/队列等，见 kinds.GLOBAL_EVENT_TYPES）→ 保留；
 *  4. 会话级但处理器要主动处理外来事件（recap 按会话缓存）→ 保留；
 *  5. 其余外来会话事件 → 丢弃。
 *
 * 子代理子会话（child_session_id）的流事件在订阅层已路由给 subagent view
 * 处理器，不会走到这里；因此这里不设"子会话放行"分支——放行只会把子会话
 * 的 chunk/tool 画进父会话滚动区。
 */
import type { AcpEvent } from '../../../api/types'
import type { WireEvent } from './wire'
import { notifSessionId } from './wire'
import {
  FOREIGN_PROCESSED_TAGS,
  GLOBAL_EVENT_TYPES,
  GLOBAL_TAGS,
} from './kinds'

/** session_notification 载体的 kind 标签（typed 事件没有内层 update）。 */
function kindTagOf(ev: AcpEvent): string | undefined {
  const params = (ev as { params?: Record<string, unknown> }).params
  const update =
    params && typeof params.update === 'object' && params.update !== null
      ? (params.update as Record<string, unknown>)
      : params
  const tag = update?.sessionUpdate
  return typeof tag === 'string' && tag ? tag : undefined
}

/** 外来会话事件是否应当在进入状态机前丢弃。 */
export function dropsForeignEvent(ev: AcpEvent, currentSid?: string | null): boolean {
  const sid = notifSessionId(ev as WireEvent)
  if (!sid || sid === currentSid) return false
  const tag = kindTagOf(ev)
  if (tag && (GLOBAL_TAGS.has(tag) || FOREIGN_PROCESSED_TAGS.has(tag))) return false
  if (GLOBAL_EVENT_TYPES.has(ev.type)) return false
  return true
}
