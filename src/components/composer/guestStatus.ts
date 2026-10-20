import type { GuestSessionState } from '../../api/types'

/**
 * 访客状态行里「等管理员应答」那一段文案。
 *
 * 访客看到的状态行和管理员是同一条（同一份 statusText、同一套活动标签），
 * 唯一不同在这里：管理员卡在审批/提问/计划时会看到卡片本身，访客看到的
 * 只有一句——他等的不是 agent，而是另一个人类（会话所有者）。
 */

const WAITING_SUBJECT: Record<
  NonNullable<GuestSessionState['pendingInput']>['kind'],
  string
> = {
  permission: '权限',
  question: '提问',
  plan: '计划',
  folder_trust: '目录信任',
  diff_review: '改动审阅',
  mcp_elicit: 'MCP 表单',
  other: '请求',
}

/**
 * 待处理请求对应的一句话；没有待处理请求时返回 undefined（调用方据此
 * 退回管理员那套 statusText 渲染）。
 */
export function guestWaitingLabel(state: GuestSessionState | undefined): string | undefined {
  const pending = state?.pendingInput
  if (!pending) return undefined
  const subject = WAITING_SUBJECT[pending.kind] ?? WAITING_SUBJECT.other
  const suffix = pending.count > 1 ? `（共 ${pending.count} 项）` : ''
  return `正在等待 Human 响应${subject}${suffix}`
}

/**
 * 等待计时起点：host 收到请求的时刻，不是本页看到它的时刻——重连或换设备
 * 不会把等待时间清零。host 没带该字段时返回 undefined（不显示计时）。
 */
export function guestWaitingSince(state: GuestSessionState | undefined): number | undefined {
  return state?.pendingInput?.receivedAt
}
