import type { SessionInfo, WorkspaceGroup } from '../api/types'

/**
 * 空状态「工作目录」下拉的候选目录：侧边栏已有的工作区（保持
 * workspace-list-recent 的先后顺序），再补上 live 会话里还没成组的新目录。
 * 去重、去掉空串，截断到 `limit` 条。
 */
export function recentWorkspaceDirs(
  workspaces: WorkspaceGroup[],
  sessions: SessionInfo[],
  limit = 8,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (cwd: string | undefined) => {
    const p = cwd?.trim()
    if (!p || seen.has(p)) return
    seen.add(p)
    out.push(p)
  }
  for (const g of workspaces) push(g.cwd)
  for (const s of sessions) push(s.cwd)
  return out.slice(0, limit)
}
