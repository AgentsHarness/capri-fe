import type { ChatState, SetState } from '../types'
import { applySessionLastTurnSummary, applySessionTitle } from '../sessionIdentity'
import { notifSessionId, type WireEvent } from './wire'

/**
 * 会话标题 / 副行摘要事件的唯一分发点：只负责从事件取字段（所属会话、
 * 手动改名字段、字段名拼写），写入规则全部交给 sessionIdentity.ts。
 *
 * 这两种数据按会话存（写 `sessions` 里该会话自己的行，sidebar 的单一
 * live 事实源），不是当前视图数据：别的会话生成标题 / 摘要时本端也要
 * 跟着变。归属守卫为此把它们登记进 FOREIGN_PROCESSED_TAGS（见 kinds.ts）。
 */
export function handleNotifSessionMeta(
  set: SetState,
  get: () => ChatState,
  ev: WireEvent,
  tag: string,
  fields: Record<string, unknown>,
): boolean {
  switch (tag) {
    case 'session_summary_generated':
      // 标题写入收敛到唯一入口（与 session_info / session_info_update
      // 共用同一套覆盖规则）。带 sid 时写该会话自己的 sessions 行。
      applySessionTitle(set, get, fields.session_summary, {
        sessionId: notifSessionId(ev),
      })
      return true
    case 'last_turn_summary':
      // 回合结束后 agent 生成的副行摘要（TUI dashboard row 的第二行）：
      // 覆盖写该会话行的 lastTurnSummary，不进滚动区。旧拼写
      // `last_turn_summary` 与宿主主通道的 `summary` 都见过。
      applySessionLastTurnSummary(
        set,
        get,
        fields.summary ?? fields.last_turn_summary,
        notifSessionId(ev),
      )
      return true
    default:
      return false
  }
}

/**
 * typed `session_info`（`session_info_update` 的归一形态，见 extMisc.ts）
 * 的标题写入：事件字段 → applySessionTitle。
 *
 * `titleIsManual` 的事件不改写本端标题（另一端的手动改名经 roster /
 * 会话列表刷新到达）；外来会话的标题照写它自己的 sessions 行，不碰当前
 * 视图——订阅层为此把 `session_info` 登记进 `GLOBAL_EVENT_TYPES` 放行归属。
 */
export function applySessionInfoTitle(
  set: SetState,
  get: () => ChatState,
  ev: { title?: string; titleIsManual?: boolean; sessionId?: string },
): void {
  applySessionTitle(set, get, ev.title, {
    isManual: ev.titleIsManual === true,
    sessionId: ev.sessionId,
  })
}
