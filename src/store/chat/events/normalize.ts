/**
 * SessionUpdate 的归一入口：把多种载荷形状收敛成唯一的
 * `{type:'session_notification', params:<带 sessionUpdate 标签的载荷>}` 形状，
 * 使每个 kind 只有**一个**消费点，且消费点只面对一套字段名。
 *
 * 覆盖的形状：
 *  1. host dispatch 的 typed kind 事件 `{type:<kind>, update, sessionId?}`
 *     —— 主通道，绝大多数 kind 走这里；
 *  2. x.ai 独立通道的 typed 事件 `{type:<kind>, params}`（task_* / monitor /
 *     background_tasks / yolo_mode_changed / follow_ups）；
 *  3. 宿主归一过的顶层载荷 `{type:'scheduled_task_*', task/rawTask/rawParams/
 *     taskId/reason/nextFireAt, sessionId?}` —— 没有 params 也没有 update。
 *
 * 顺带做两件入口级清洗（消费点不再各写各的）：
 *  - 顶层 snake_case → 追加 camelCase 别名（不动原键、不覆盖已有键、不递归）；
 *  - 归属与回放序号（sessionId / msgSeq）原样转交。
 *
 * 不在这里做业务判断：是否回放、是否当前会话由消费方用 event 上透出的
 * sessionId / msgSeq 决定（见 attribution.ts）。
 */
import type { AcpEvent } from '../../../api/types'
import type { WireEvent } from './wire'
import { TYPED_CARRIER_TAGS } from './kinds'

const TRANSPORT_ONLY_KEYS = new Set(['type', 'sessionId', 'msgSeq', 'update', 'params'])

function camelKey(k: string): string {
  return k.replace(/_+([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/**
 * 顶层 snake_case → 追加 camelCase 别名（浅层）。
 * 只补不覆盖：payload 已有 camelCase 键时保留原值；嵌套对象与数组不动
 * （tool_call 的 rawOutput 可能很大，深拷贝代价与收益不成比例；嵌套里的
 * 双拼读取仍在消费点就地容错，见消费清单文档）。
 */
export function withCamelAliases(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  let added = false
  const out: Record<string, unknown> = { ...payload }
  for (const k of Object.keys(payload)) {
    if (!k.includes('_')) continue
    const alias = camelKey(k)
    if (alias === k || alias in out) continue
    out[alias] = payload[k]
    added = true
  }
  return added ? out : payload
}

function wrap(
  payload: Record<string, unknown>,
  ev: AcpEvent,
  tag: string,
): AcpEvent {
  const raw = ev as WireEvent & { update?: unknown }
  const withTag =
    typeof payload.sessionUpdate === 'string'
      ? payload
      : { sessionUpdate: tag, ...payload }
  const sid =
    typeof raw.sessionId === 'string' && raw.sessionId
      ? raw.sessionId
      : typeof withTag.sessionId === 'string' && withTag.sessionId
        ? withTag.sessionId
        : undefined
  return {
    type: 'session_notification',
    method: 'session/update',
    params: withCamelAliases(withTag),
    ...(sid ? { sessionId: sid } : {}),
    ...(typeof raw.msgSeq === 'number' ? { msgSeq: raw.msgSeq } : {}),
  } as AcpEvent
}

/** typed / 顶层载荷形状的事件 → 统一的 session_notification 形状（其余原样返回）。 */
export function normalizeSessionEvent(ev: AcpEvent): AcpEvent {
  const raw = ev as WireEvent & { update?: unknown }
  // 1) update 形状（host dispatch 主通道）
  const update = raw.update
  if (update && typeof update === 'object' && !Array.isArray(update)) {
    const u = update as Record<string, unknown>
    if (typeof u.sessionUpdate === 'string') {
      // 回合终态有独立语义与字段（turnEnd 处理 stopReason/agentResult/meta），
      // 保持原形状不动。
      if (ev.type === 'turn_completed') return ev
      return wrap(u, ev, String(u.sessionUpdate))
    }
  }
  // 2) x.ai 独立通道 / 宿主归一形状：只对登记过的 kind 归一（其余 typed 事件
  //    有各自更早的处理器：conn / userStream / tools / turnEnd / sessionCtrl）
  const type = String(ev.type)
  if (!TYPED_CARRIER_TAGS.has(type)) return ev
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(ev as Record<string, unknown>)) {
    if (!TRANSPORT_ONLY_KEYS.has(k)) rest[k] = v
  }
  const params = raw.params
  const inner =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : undefined
  return wrap({ ...rest, ...(inner ?? {}) }, ev, type)
}
