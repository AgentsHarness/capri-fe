import type { SessionInfo, WorkspaceGroup, WorkspaceSummary } from '../../api/types'

/**
 * 侧边栏的一行 —— `sessions` 的 live 行（行内容的唯一事实源）+ 分组用的
 * 完整 cwd。
 *
 * `workspaces` 只负责三件事：工作区分组、排序/分页的成员表、以及 live 行
 * 缺失字段的兜底（标题 / 副行摘要 / 活动时间 / 持久化档位）。行的渲染不再
 * 逐处合并两份数据——先经本模块投影成 `SessionRow`，组件只读这一份。
 *
 * contextUsed / contextSize 是上下文进度条的数据，来自 live 行（与
 * session-info 的同名两字段一致）；缺失时不出进度条。
 */
export type SessionRow = SessionInfo & {
  cwd: string
  contextUsed?: number
  contextSize?: number
}

/** live 行可能携带的上下文占用字段（`SessionInfo` 未声明，投影时读出）。 */
type ContextCensus = { contextUsed?: number; contextSize?: number }

/**
 * workspace 摘要 → 兜底行：只带持久化字段。live 行覆盖上来时用它补
 * 缺失的标题 / 副行摘要 / 活动时间 / reasoningEffort。
 */
export function summaryToSessionRow(
  summary: WorkspaceSummary,
  fallbackCwd = '',
): SessionRow {
  return {
    sessionId: summary.sessionId,
    cwd: summary.cwd || fallbackCwd,
    title: summary.title,
    lastTurnSummary: summary.lastTurnSummary,
    updatedAt: summary.updatedAt,
    reasoningEffort: summary.reasoningEffort,
  }
}

/**
 * 按 sessionId 建行索引：先铺 workspace 摘要（兜底行），再用 live 行覆盖。
 *
 * - 标题 / 副行摘要：live 非空白时优先，空白回退摘要；
 * - 运行态与 census（status / bgRunning / bgCount / hasTasks）只认 live；
 * - updatedAt 用 live，缺失时用摘要；
 * - 只出现在 live 里的会话也进索引（cwd 用 live，缺失为空串）；
 * - 只在摘要里的会话保留（分页窗口外 / roster 尚未拉到的行不能凭空消失）。
 */
export function buildSessionRowIndex(
  sessions: SessionInfo[],
  workspaces: WorkspaceGroup[],
): Map<string, SessionRow> {
  const byId = new Map<string, SessionRow>()
  for (const g of workspaces) {
    for (const summary of g.sessions) {
      byId.set(summary.sessionId, summaryToSessionRow(summary, g.cwd))
    }
  }
  for (const live of sessions) {
    const prev = byId.get(live.sessionId)
    const ctx = live as SessionInfo & ContextCensus
    byId.set(live.sessionId, {
      ...prev,
      ...live,
      cwd: live.cwd || prev?.cwd || '',
      title: live.title?.trim() ? live.title : prev?.title,
      lastTurnSummary: live.lastTurnSummary?.trim()
        ? live.lastTurnSummary
        : prev?.lastTurnSummary,
      updatedAt: live.updatedAt || prev?.updatedAt,
      status: live.status,
      bgRunning: live.bgRunning,
      bgCount: live.bgCount,
      hasTasks: live.hasTasks,
      contextUsed: ctx.contextUsed,
      contextSize: ctx.contextSize,
      reasoningEffort: live.reasoningEffort?.trim()
        ? live.reasoningEffort
        : prev?.reasoningEffort,
    })
  }
  return byId
}
