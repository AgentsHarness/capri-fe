import type { AcpEvent } from '../../../api/types'
import type { ChatState, McpServerInfo, SetState } from '../types'
import { runtime } from '../globals'
import { applyMcpInitProgress } from '../followUps'
import { isForeignSession } from './wire'

function strField(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/**
 * Apply `x.ai/git_head_changed` to the status-bar gitInfo.
 * TUI `handle_git_head_changed` routes by payload session id; a
 * notification for another session (or a subagent) must not paint
 * this view. Envelope sessionId is the host withSid tag — payload
 * sessionId wins when both are present (active-session fallback can
 * mis-tag the envelope).
 */
export function applyGitHeadChanged(
  set: SetState,
  get: () => ChatState,
  params: Record<string, unknown> | undefined,
  envelopeSessionId?: string,
): void {
  const p = params ?? {}
  const sid =
    strField(p.sessionId) || strField(p.session_id) || envelopeSessionId || undefined
  if (sid && sid !== get().sessionId) return
  const raw = p.branch
  const branch = raw == null ? undefined : String(raw)
  runtime.gitInfoEpoch += 1
  const prev = get().gitInfo
  const isWorktree = !!(p.isWorktree ?? p.is_worktree)
  const mainRepoRaw = p.mainRepo ?? p.main_repo
  const mainRepo = mainRepoRaw == null ? undefined : String(mainRepoRaw)
  const downgrade = prev?.isWorktree === true && !isWorktree && !mainRepo
  set({
    gitInfo: {
      branch: branch === '' ? '(detached)' : branch,
      isWorktree: downgrade ? true : isWorktree,
      mainRepo: downgrade ? (prev.mainRepo ?? undefined) : mainRepo,
    },
  })
}

export function handleExtSessionEvent(
  set: SetState,
  get: () => ChatState,
  ev: AcpEvent,
): boolean {
  switch (ev.type) {
      // task_backgrounded / task_completed / monitor_event / background_tasks /
      // yolo_mode_changed 已由归一入口（events/normalize.ts）转交到
      // events/sessionNotif.ts 的唯一分发点——本文件不再重复注册。
      case 'git_head_changed': {
        applyGitHeadChanged(
          set,
          get,
          (ev.params ?? {}) as Record<string, unknown>,
          (ev as { sessionId?: string }).sessionId,
        )
        break
      }
      case 'mcp_server_status': {
        // 会话级：MCP 服务列表随会话切换清空，别的会话的状态不能画进来。
        if (isForeignSession(ev as never, get().sessionId)) break
        const p = ev.params ?? {}
        const name = p.name ? String(p.name) : ''
        if (!name) break
        const existing = get().mcpServers.find((s) => s.name === name)
        const status = p.status ? String(p.status) : existing?.status
        // `reason` 每条事件都带（成功转移也有：首次握手完成 = initialized），
        // `detail` 只在失败事件里出现。带 status 的事件是完整快照，缺失的
        // detail 视为「本轮无诊断」清掉，否则恢复健康后旧的握手错误会一直挂着。
        const fullSnapshot = p.status != null
        const row: McpServerInfo = {
          ...existing,
          name,
          source: existing?.source ?? (p.source ? String(p.source) : undefined),
          status,
          reason: p.reason
            ? String(p.reason)
            : fullSnapshot
              ? undefined
              : existing?.reason,
          detail: p.detail
            ? String(p.detail)
            : fullSnapshot
              ? undefined
              : existing?.detail,
        }
        set({
          mcpServers: [
            ...get().mcpServers.filter((s) => s.name !== name),
            row,
          ],
        })
        break
      }
      case 'mcp_init_progress': {
        // x.ai/mcp/init_progress → mcp_init_progress (host bridge.go
        // forwards params verbatim; shell emits camelCase {total,
        // connected, sessionId} — acp_session_impl/mcp.rs). The TUI
        // status-bar chip is `MCP (connected/total)`; the startup seed
        // total==0 renders "Starting session…". No scrollback row.
        // 会话级（params.sessionId 是 agent 自报的会话）：别的会话的初始化
        // 进度不能改写本会话的 MCP 芯片。
        if (isForeignSession(ev as never, get().sessionId)) break
        applyMcpInitProgress(set, ev.params)
        break
      }
      case 'mcp_tools_changed':
      case 'mcp_servers_updated':
        set({ mcpVersion: get().mcpVersion + 1 })
        void get().syncMcpServers()
        break
      case 'sessions_changed':
        void get().refreshSessions()
        void get().refreshWorkspaces()
        break
      case 'hosts_changed':
        // Hub-level: a host paired / came online / dropped off.
        void get().refreshHosts()
        break
    default:
      return false
  }
  return true
}
