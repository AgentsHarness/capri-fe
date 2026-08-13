import type { AcpEvent } from '../../../api/types'
import type { ChatState, McpServerInfo, SetState } from '../types'
import { applyModeFlags } from '../modeFlags'
import { extractSessionUpdate } from '../entries'
import { applyMcpInitProgress } from '../followUps'
import { handleTaskBackgrounded, handleTaskCompleted } from '../tasks'
import { wireTaskId } from '../util'

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
        const p = ev.params ?? {}
        const branch = p.branch == null ? undefined : String(p.branch)
        set({
          gitInfo: {
            branch: branch === '' ? '(detached)' : branch,
            isWorktree: !!p.isWorktree,
            mainRepo: p.mainRepo == null ? undefined : String(p.mainRepo),
          },
        })
        break
      }
      case 'yolo_mode_changed':
        // 客户端级全局广播（agent 对发送客户端的所有会话生效）：无条件
        // 应用，所有会话的显示同步（订阅器落全局记录）。sessionId 标记
        // （host withSid 约定）不代表会话级变更，不做过滤。
        // The agent sends snake_case ({yolo_mode, auto_mode, permission_mode});
        // accept both spellings (camelCase first for host-normalized paths).
        // applyModeFlags merges (absent keys never wipe local flags) and
        // keeps planMode armed underneath permission broadcasts.
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
