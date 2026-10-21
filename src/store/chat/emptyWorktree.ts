import { transport } from '../../api/client'

/**
 * 空状态「使用 Worktree」的创建步骤：还没有会话、用户发送首条消息时，
 * 先为所选目录建一个新 git worktree，再把会话目录设到它上面。
 *
 * 创建走 host 的 /api/git/worktree/create（agent `x.ai/git/worktree/create`）：
 * host 在没有活动会话时会给 agent 一个占位 sessionId，所以建会话之前就能
 * 调用（TUI 的 Ctrl+W / 新会话 worktree 模式同样是先建 worktree 再开会话）。
 * `copyMode: 'dirty'` 与 TUI 默认一致——把源工作区未提交的改动带进新
 * worktree，而不是只检出 HEAD。
 */

/** 从 CreateWorktreeResponse（creating / exists）里取 worktree 路径。 */
export function worktreePathFromCreate(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  for (const key of ['worktreePath', 'worktree_path']) {
    const v = o[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return undefined
}

/** 建 worktree 并返回它的路径；响应缺路径时抛错（调用方渲染错误行）。 */
export async function createEmptyStateWorktree(opts: {
  sourcePath: string
  /**
   * worktree 名称（TUI New Worktree 弹窗的 label）；留空由 agent 自动命名
   * （`YYYY-MM-DD-<uuid>`）。agent 负责 slug 化（小写、非字母数字换 `-`）
   * 与重名加后缀，前端只传用户填的原文。
   */
  label?: string
}): Promise<string> {
  const raw = await transport.gitWorktreeCreate({
    sourcePath: opts.sourcePath,
    ...(opts.label ? { label: opts.label } : {}),
    copyMode: 'dirty',
  })
  const path = worktreePathFromCreate(raw)
  if (!path) throw new Error('响应缺少 worktree 路径')
  return path
}
