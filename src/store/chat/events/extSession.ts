import type { AcpEvent } from '../../../api/types'
import type { ChatState, McpServerInfo, SetState } from '../types'
import { runtime } from '../globals'
import { applyModeFlags } from '../modeFlags'
import { extractSessionUpdate } from '../entries'
import { applyMcpInitProgress } from '../followUps'
import { handleTaskBackgrounded, handleTaskCompleted } from '../tasks'
import { wireTaskId } from '../util'

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
      case 'task_backgrounded':
        handleTaskBackgrounded(get, set, extractSessionUpdate(ev.params).fields)
        break
      case 'task_completed':
        handleTaskCompleted(get, set, extractSessionUpdate(ev.params).fields)
        break
      case 'monitor_event': {
        const { fields } = extractSessionUpdate(ev.params)
        const taskId = wireTaskId(fields.task_id, fields.taskId)
        const entryId = taskId ? get().bgTaskIndex[taskId] : undefined
        // event_text is raw stdout (TUI appends to BgTaskState.stdout).
        const text =
          (typeof fields.event_text === 'string' && fields.event_text) ||
          (typeof fields.eventText === 'string' && fields.eventText) ||
          ''
        if (entryId && text) {
          set({
            entries: get().entries.map((e) =>
              e.id === entryId && e.kind === 'bg_task'
                ? {
                    ...e,
                    output: (e.output ?? '') + text,
                    // Keep a short tail on the row detail for glanceability.
                    detail: text.trim().split('\n').filter(Boolean).slice(-1)[0] || e.detail,
                  }
                : e,
            ),
          })
        }
        break
      }
      case 'git_head_changed': {
        applyGitHeadChanged(
          set,
          get,
          (ev.params ?? {}) as Record<string, unknown>,
          (ev as { sessionId?: string }).sessionId,
        )
        break
      }
      case 'yolo_mode_changed':
        // 客户端级全局广播（agent 对发送客户端的所有会话生效）：无条件
        // 应用，所有会话的显示同步（订阅器落全局记录）。sessionId 标记
        // （host withSid 约定）不代表会话级变更，不做过滤。
        // The agent sends snake_case ({yolo_mode, auto_mode, permission_mode});
        // accept both spellings (camelCase first for host-normalized paths).
        // applyModeFlags keeps planMode armed underneath permission
        // broadcasts; a named permissionMode (ask/auto/always-approve)
        // is authoritative for the yolo/auto flags when those keys are
        // absent, so a lone permission_mode:ask cannot leave the
        // composer stuck on always-approve.
        applyModeFlags(set, (ev.params ?? {}) as Record<string, unknown>)
        break
      case 'mcp_server_status': {
        const p = ev.params ?? {}
        const name = p.name ? String(p.name) : ''
        if (!name) break
        const existing = get().mcpServers.find((s) => s.name === name)
        const row: McpServerInfo = {
          name,
          source: existing?.source ?? (p.source ? String(p.source) : undefined),
          status: p.status ? String(p.status) : existing?.status,
          reason: p.reason ? String(p.reason) : existing?.reason,
          detail: p.detail ? String(p.detail) : existing?.detail,
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
        applyMcpInitProgress(set, ev.params)
        break
      }
      case 'mcp_tools_changed':
      case 'mcp_servers_updated':
        set({ mcpVersion: get().mcpVersion + 1 })
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
