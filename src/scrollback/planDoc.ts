import type { PendingReq, ScrollEntry } from '../api/types'

/**
 * plan 正文（plan.md）在前端可见的三条来源：
 *
 * 1. host `/api/session-plan`（权威，直读 agent 会话目录里的 plan.md，
 *    TUI /view-plan 读的就是这个文件）——由弹窗自己拉；
 * 2. 待应答的 `x.ai/exit_plan_mode` 审批请求参数 `planContent`；
 * 3. 滚动区里 `exit_plan_mode` 工具行的输出
 *    （`rawOutput = {type:'ExitPlanMode', PlanReady:{plan_content}}`）——
 *    历史回放也带得回来，所以刷新后仍能看。
 *
 * 本模块只负责 2 / 3。
 */

function planFromRawOutput(ro: unknown): string | undefined {
  if (!ro || typeof ro !== 'object') return undefined
  const o = ro as Record<string, unknown>
  for (const key of ['PlanReady', 'planReady']) {
    const inner = o[key]
    if (inner && typeof inner === 'object') {
      const rec = inner as Record<string, unknown>
      const c = rec.plan_content ?? rec.planContent
      if (typeof c === 'string' && c.trim()) return c
    }
  }
  const direct = o.plan_content ?? o.planContent
  return typeof direct === 'string' && direct.trim() ? direct : undefined
}

/** 最近一条 exit_plan_mode 工具输出里的 plan 正文（新→旧扫描）。 */
export function planDocFromEntries(
  entries: readonly ScrollEntry[],
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind !== 'tool') continue
    const got = planFromRawOutput(e.raw?.rawOutput)
    if (got) return got
  }
  return undefined
}

/** 待应答的 exit_plan_mode 审批请求里的 plan 正文。 */
export function planDocFromRequests(
  reqs: readonly PendingReq[],
): string | undefined {
  for (let i = reqs.length - 1; i >= 0; i--) {
    const r = reqs[i]
    if (r.method !== 'x.ai/exit_plan_mode') continue
    const p = r.params as { planContent?: unknown } | undefined
    const c = p?.planContent
    if (typeof c === 'string' && c.trim()) return c
  }
  return undefined
}
