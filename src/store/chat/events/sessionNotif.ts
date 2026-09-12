import type { AcpEvent } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { extractSessionUpdate } from '../entries'
import { handleNotifCore } from './notifCore'
import { handleNotifHooks } from './notifHooks'
import { handleNotifMemory } from './notifMemory'
import { handleNotifApps } from './notifApps'
import type { WireEvent } from './wire'
import { dropsForeignEvent } from './attribution'
import { NOOP_TAGS, TYPED_PATH_KINDS, UNCONSUMED_KINDS } from './kinds'

/**
 * SessionUpdate 的唯一分发点（见 docs/SessionUpdate-消费清单.md）。
 *
 *  1. 归属守卫：除全局 kind 与「处理器要主动处理外来事件」的 kind（recap）
 *     外，非当前会话的事件在此统一丢弃——各 handler 不再各写各的
 *     `ev.sessionId && ...`（那是两个过滤层给出相反结论的根源）。
 *  2. 显式空操作：NOOP_TAGS 在此一次性 ack，不落到具体 handler（见 kinds.ts
 *     的逐条理由），避免"没 case"与"有意忽略"看起来一样。
 *  3. 未消费 kind 的开发期提示：没有任何 handler 认领（也不在
 *     NOOP/UNCONSUMED 清单里）时，DEV 下打一条告警——host 新增建卡 kind 时
 *     前端不再是静默丢弃。
 */
export function handleSessionNotification(
  set: SetState,
  get: () => ChatState,
  ev: AcpEvent,
): boolean {
  const wire = ev as WireEvent
  const { tag, fields } = extractSessionUpdate(wire.params)
  if (!tag) return false
  if (dropsForeignEvent(wire, get().sessionId)) return true
  if (NOOP_TAGS.has(tag)) return true
  // 登记在案的未消费 kind 是明确决策（见 kinds.ts 的理由），不告警。
  if (UNCONSUMED_KINDS.has(tag)) return true
  // typed 流式链路消费的 kind（chunk/tool/plan/usage_update）即使以
  // generic 形状到达也只做已知标记，不告警（它们的 live/回放路径在别处）。
  if (TYPED_PATH_KINDS.has(tag)) return false
  if (handleNotifCore(set, get, wire, tag, fields)) return true
  if (handleNotifHooks(set, get, wire, tag, fields)) return true
  if (handleNotifMemory(set, get, wire, tag, fields)) return true
  if (handleNotifApps(set, get, wire, tag, fields)) return true
  maybeWarnUnconsumed(tag)
  return false
}

/** 只告警一次/一种 kind：DEV 下提示"这个 kind 没有任何消费点"。 */
const warned = new Set<string>()
function maybeWarnUnconsumed(tag: string): void {
  if (!import.meta.env.DEV || warned.has(tag)) return
  warned.add(tag)
  // eslint-disable-next-line no-console
  console.warn(
    `[sessionUpdate] 未消费的 kind: ${tag} —— 若为宿主新建模的 kind，` +
      '请在 events/notif*.ts 补消费点，或登记进 events/kinds.ts 的 NOOP/UNCONSUMED 清单',
  )
}

/** 测试用：重置告警去重集合。 */
export function resetUnconsumedWarningsForTest(): void {
  warned.clear()
}
