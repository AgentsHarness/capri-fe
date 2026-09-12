import type { AcpEvent } from '../../../api/types'

/** AcpEvent plus the optional wire fields every handler reads. */
export type WireEvent = AcpEvent & {
  sessionId?: string
  params?: Record<string, unknown>
  /** 回放归一化序号（host msgSeq 契约）——仅历史回放事件携带，live 无。
   *   hook 路由用它按批次判定 replay（TUI `meta.is_replay`）。 */
  msgSeq?: number
}

/**
 * 事件的会话归属：typed kind / withSid 广播在顶层 `sessionId`，generic
 * `session_notification` 与历史回放载体在 `params.sessionId`。
 */
export function notifSessionId(ev: WireEvent): string | undefined {
  const top = ev.sessionId
  if (typeof top === 'string' && top) return top
  const p = ev.params
  const nested = p && typeof p.sessionId === 'string' ? p.sessionId : undefined
  return nested || undefined
}

/**
 * 归属守卫：事件声明了会话、且不是当前视图锚定的会话时不进本视图。
 * 视图尚未锚定（current 为空）而事件带 sid 同样算外来——与既有
 * `ev.sessionId && ev.sessionId !== get().sessionId` 语义一致。
 */
export function isForeignSession(ev: WireEvent, current?: string | null): boolean {
  const sid = notifSessionId(ev)
  return sid != null && sid !== current
}
