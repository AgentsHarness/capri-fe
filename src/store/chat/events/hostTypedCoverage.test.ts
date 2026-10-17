import { describe, expect, it } from 'vitest'
import { SILENT_HOST_EVENT_TYPES, SESSION_UPDATE_TAGS, TYPED_CARRIER_TAGS } from './kinds'

/**
 * 宿主 typed 事件的镜像清单：与 acp-host `internal/acp/bridge.go` 里所有
 * `kType: "<name>"` 字面量一一对应（含 handleXaiNotification 的显式转发
 * 分支与 dispatchSessionUpdateKind 的派生事件）。
 *
 * 这张清单是手工镜像，跨仓库无法自动同步；它存在的意义是：宿主新增
 * 转发分支、FE 忘了跟时，这里会红，而不是等到线上无声丢弃。更新规则——
 * 宿主加了 typed 事件 → 这里加一行 + 在下面两个集合里选一个归属。
 */
const HOST_TYPED_EVENTS = [
  // 连接 / 会话锚定
  'hello',
  'ready',
  'status',
  'busy',
  'done',
  'cancelled',
  'failed',
  'error',
  // 流式内容
  'chunk',
  'thought',
  'user_chunk',
  'user_message',
  'image',
  'text',
  'tool_call',
  'tool_call_update',
  'plan',
  'usage',
  'gen_rate',
  // 会话元信息
  'modes_update',
  'config_options_update',
  'commands_update',
  'session_info',
  'session_interjection',
  'sessions_changed',
  'session_rewound',
  'session_load_started',
  'session_load_finished',
  // 反向请求
  'client_request',
  'client_request_resolved',
  // 任务 / 定时 / 子代理
  'background_tasks',
  'task_backgrounded',
  'task_completed',
  'monitor_event',
  'scheduled_task_created',
  'scheduled_task_deleted',
  'scheduled_task_fired',
  'scheduled_task_inject_prompt',
  'subagent_spawned',
  'subagent_progress',
  'subagent_finished',
  // 模型 / 队列 / 权限 / git
  'model',
  'models_update',
  'queue_changed',
  'yolo_mode_changed',
  'permissions_reset',
  'git_head_changed',
  // 记忆 / hook / 插件 / 目标 / 工作流
  'hooks_changed',
  'plugins_changed',
  'plugin_updates_installed',
  'goal_updated',
  'workflow_updated',
  'mcp_server_status',
  'mcp_tools_changed',
  'mcp_servers_updated',
  'mcp_init_progress',
  'announcements_update',
  'prefs_changed',
  'hosts_changed',
  'search_fuzzy_status',
  'follow_ups',
  'ext_notification',
  'prompt_complete',
  'session_updates_chunk',
  // 宿主有显式转发分支、FE 有意静默（SILENT_HOST_EVENT_TYPES）。
  'fs_notify',
  'fs_index',
  'fs_index_delta',
  'search_content_status',
  'pty_notification',
  'leader_reconnected',
  'leader_version_mismatch',
  'log',
  'git_worktree_status',
  'config_changed',
  'settings_update',
] as const

/**
 * FE 有消费点的宿主 typed 事件（`store/chat/events/**` 里的 case，或
 * 更早链路上的处理器）。新增宿主事件时，要么进这里（并补消费点），
 * 要么进 `SILENT_HOST_EVENT_TYPES`（并写理由）。
 */
const FE_CONSUMED_TYPED = new Set<string>([
  'hello', 'ready', 'status', 'busy', 'done', 'cancelled', 'failed', 'error',
  'chunk', 'thought', 'user_chunk', 'user_message', 'image', 'text',
  'tool_call', 'tool_call_update', 'plan', 'usage', 'gen_rate',
  'modes_update', 'config_options_update', 'commands_update', 'session_info',
  'session_interjection', 'sessions_changed', 'session_rewound',
  'session_load_started', 'session_load_finished',
  'client_request', 'client_request_resolved',
  'background_tasks', 'task_backgrounded', 'task_completed', 'monitor_event',
  'scheduled_task_created', 'scheduled_task_deleted', 'scheduled_task_fired',
  'scheduled_task_inject_prompt',
  'subagent_spawned', 'subagent_progress', 'subagent_finished',
  'model', 'models_update', 'queue_changed', 'yolo_mode_changed',
  'permissions_reset', 'git_head_changed',
  'hooks_changed', 'plugins_changed', 'plugin_updates_installed',
  'goal_updated', 'workflow_updated',
  'mcp_server_status', 'mcp_tools_changed', 'mcp_servers_updated',
  'mcp_init_progress', 'announcements_update', 'prefs_changed',
  'hosts_changed', 'search_fuzzy_status', 'follow_ups',
  // 未建模的 kind 由 normalized session_notification 兜底（notif* 有 case
  // 或登记进 NOOP/UNCONSUMED）。
  'ext_notification', 'prompt_complete',
])

/**
 * 宿主 typed 事件没被任何 FE 代码认领时，只能是显式登记的静默，
 * 或者是这里点名的那一个（分页块由 HTTP 端点承担）。其余组合都是漏接。
 */
describe('宿主 typed 事件覆盖度（镜像 bridge.go）', () => {
  it('每个宿主 typed 事件都有消费点或显式静默登记', () => {
    const missing = HOST_TYPED_EVENTS.filter(
      (t) => !FE_CONSUMED_TYPED.has(t) && !SILENT_HOST_EVENT_TYPES.has(t),
    )
    expect(missing).toEqual([])
  })

  it('静默清单里的每一项都确实是宿主 typed 事件（防拼写/残留）', () => {
    const known = new Set<string>(HOST_TYPED_EVENTS)
    const stray = [...SILENT_HOST_EVENT_TYPES.keys()].filter((t) => !known.has(t))
    expect(stray).toEqual([])
  })

  it('静默清单与 sessionUpdate kind 注册表不重叠', () => {
    const overlap = [...SILENT_HOST_EVENT_TYPES.keys()].filter(
      (t) => SESSION_UPDATE_TAGS.has(t) || TYPED_CARRIER_TAGS.has(t),
    )
    expect(overlap).toEqual([])
  })
})
