/**
 * SessionUpdate kind 的单一事实来源：归一入口（normalize.ts）、归属守卫
 * （handleSessionNotification / init.ts 订阅层）、开发期未消费告警与覆盖度
 * 测试全部读这里，禁止在各处再维护第二份清单。
 *
 * 清单来源：
 *  - 扩展 kind：grok-build `crates/codegen/xai-grok-shell/src/extensions/notification.rs`
 *    的 `SessionUpdate` 枚举（53 变体，含 `#[serde(other)] Unknown`）。
 *  - 官方 kind：ACP `agent-client-protocol-schema` 的 `SessionUpdate`
 *    （grok 实际引用 10 个；`usage_update` 协议里有、grok 不发射，host 保留兜底 case）。
 *  - 另有三个 x.ai 通道事件与 SessionUpdate 共用同一处置管线（模式广播、
 *    回合结束建议、旧版别名），一并登记，避免它们各自在 ext 通道里再注册一份。
 *
 * 变更流程：host 新增建卡 kind → 这里登记 + 在 notif* 里给出消费或列入
 * NOOP/UNCONSUMED，`kindsCoverage.test.ts` 会拦住漏登记。
 */

/** 官方 ACP `SessionUpdate`（grok 侧在用 + 兜底）。 */
export const ACP_STANDARD_KINDS = [
  'agent_message_chunk',
  'user_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  // 协议标准 kind；grok 把 usage 塞在 turn_completed/response_completed 的
  // `_meta.totalTokens` 里发，host 保留该 case 仅为兼容其它 ACP 客户端。
  'usage_update',
] as const

/** xAI 扩展 `SessionUpdate`（52 个有效变体 + `Unknown` 兜底）。 */
export const EXTENSION_KINDS = [
  // 执行流
  'turn_completed',
  'response_started',
  'response_completed',
  'reasoning_completed',
  'tool_call_delta_chunk',
  // 任务与调度
  'background_tasks',
  'task_backgrounded',
  'task_completed',
  'monitor_event',
  'scheduled_task_created',
  'scheduled_task_fired',
  'scheduled_task_deleted',
  // 交互与控制
  'pending_interaction',
  'interaction_resolved',
  'diff_review',
  'feedback_request',
  'retry_state',
  'relay_sync_status',
  'auto_recovery_started',
  'auto_recovery_exhausted',
  // Hook / 插件 / 子代理
  'hook_run_started',
  'hook_execution',
  'hook_annotation',
  'hooks_changed',
  'plugins_changed',
  'plugin_updates_installed',
  'subagent_spawned',
  'subagent_progress',
  'subagent_finished',
  // 压缩 / 记忆 / 图片
  'auto_compact_started',
  'auto_compact_completed',
  'auto_compact_failed',
  'auto_compact_cancelled',
  'auto_continue_completed',
  'memory_flush_started',
  'memory_flush_completed',
  'memory_capture_activity',
  'memory_dream_queued',
  'memory_dream_started',
  'memory_dream_completed',
  'memory_session_saved',
  'memory_files',
  'image_compressed',
  'image_dropped',
  // 会话状态
  'session_status',
  'session_summary_generated',
  'session_recap',
  'session_recap_unavailable',
  'last_turn_summary',
  'model_auto_switched',
  'model_changed',
  'goal_updated',
  'workflow_updated',
  // 计划审阅信号（TUI 用它们开/关「回合后计划审阅」、提交已批准计划）。
  // FE 的审阅卡走 x.ai/exit_plan_mode client_request，是另一条路径；
  // 当前 shell 检出里这三个变体只有枚举与 serde 测试，没有生产者。
  // 登记在 UNCONSUMED，等 wire 上真的出现再按 TUI 形态接。
  'plan_kept',
  'plan_cleared',
  'plan_executing',
  // 实际应答模型（后端把请求路由到别的模型时的显示名）。显示用，
  // 不改变会话选择；同样暂无生产者。
  'served_model',
  // 单回合用量（TUI 只有 headless reducer 消费）。会话用量走
  // session_status 快照。
  'turn_usage',
  // 仅持久化（host 不建卡，走 generic 兜底）
  'compaction_checkpoint',
  'rewind_marker',
  // serde(other) 兜底：未识别 kind 的形状被丢弃
  'unknown',
] as const

/**
 * 与 SessionUpdate 共用处置管线的 x.ai 通道事件。
 * - `yolo_mode_changed`：权限模式是客户端级广播（host 故意不打 sessionId），
 *   但 x.ai 载体回放时同样以 `sessionUpdate` 标签出现，两者形状一致。
 * - `follow_ups`（旧拼写 `followups`）：回合结束建议 chips，live 走 typed
 *   事件、回放走 x.ai carrier 的 session_notification 标签。
 */
export const SHARED_CHANNEL_TAGS = ['yolo_mode_changed', 'follow_ups', 'followups'] as const

/** 归一入口认得的全部标签（typed 事件 → session_notification 的唯一判据）。 */
export const SESSION_UPDATE_TAGS: ReadonlySet<string> = new Set<string>([
  ...ACP_STANDARD_KINDS,
  ...EXTENSION_KINDS,
  ...SHARED_CHANNEL_TAGS,
])

/**
 * 需要由归一入口转交的 typed 事件类型（其余 typed 事件在 handleChatEvent
 * 的更早链路上有各自处理器：conn / userStream / tools / turnEnd /
 * sessionCtrl / ext）。
 *
 * 这些 kind 此前在 extSession / extMisc 里各注册了一份（params 形状），
 * 与 notif* 里的 update 形状重复；归一后只保留 notif* 一处。
 */
export const TYPED_CARRIER_TAGS: ReadonlySet<string> = new Set<string>([
  'task_backgrounded',
  'task_completed',
  'monitor_event',
  'background_tasks',
  'yolo_mode_changed',
  'scheduled_task_created',
  'scheduled_task_deleted',
  'scheduled_task_fired',
  'follow_ups',
  'followups',
])

/**
 * 由 typed 流式链路消费、不经 notif* 分发的 kind：
 *  - `agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk` →
 *    events/userStream.ts（live typed chunk/thought/user_chunk）；
 *  - `tool_call` / `tool_call_update` / `plan` → events/tools.ts；
 *  - `usage_update` → 仅回放解析（envelopeParse），live 由 host 合成的
 *    `usage` 事件承担。
 * 它们若以 generic 形状到达分发层，视为已知 kind（不触发未消费告警）。
 */
export const TYPED_PATH_KINDS: ReadonlySet<string> = new Set<string>([
  'agent_message_chunk',
  'agent_thought_chunk',
  'user_message_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'usage_update',
  // 官方信息类：live 由 host 建卡为同名 typed 事件（commands_update /
  // config_options_update / session_info，见 events/extMisc.ts），回放由
  // envelopeParse 转成同一批 typed 事件——都不经 notif* 分发。
  'available_commands_update',
  'config_option_update',
  'session_info_update',
  // host 侧与 session_info_update 合并建卡的旧版别名（bridge.go
  // `case "session_info_update", "session_info"`），typed 事件同样是
  // `session_info`，由 extMisc 消费。
  'session_info',
])

/** 会话归属：全局 kind（客户端级/机器级广播，归属守卫放行）。 */
export const GLOBAL_TAGS: ReadonlySet<string> = new Set<string>([
  // 权限模式是 agent 对发送客户端全量生效的进程级状态。
  'yolo_mode_changed',
])

/**
 * 会话级、但处理器要**主动处理外来会话事件**的 kind：recap 按会话缓存
 * （跨会话到达时缓存下来，切回该会话时由 loadHistory 就近回填），所以
 * 不能按「非当前会话」丢弃。
 */
export const FOREIGN_PROCESSED_TAGS: ReadonlySet<string> = new Set<string>([
  'session_recap',
  'session_recap_unavailable',
])

/**
 * 显式空操作：已确认形状、不产生任何前端状态/渲染，保留消费点是为了
 * 语义自解释（避免看起来"漏接"）。理由逐条写在下面。
 */
export const NOOP_TAGS: ReadonlySet<string> = new Set<string>([
  // 流式工具参数增量：最终整包 tool_call 会覆盖，逐包渲染只会抖。
  'tool_call_delta_chunk',
  // 反向请求的挂起/解除提示：权限卡与提问卡由 client_request /
  // client_request_resolved 驱动（ApprovalStrip / QuestionModal），
  // 这条只是 TUI 的 ⏳ NeedsInput 状态位，web 无对应展示位。
  'pending_interaction',
  'interaction_resolved',
  // relay（leader/follower）同步状态：web 走 hub 连接状态提示，不用它。
  'relay_sync_status',
  // 单条模型响应完成：host 实测从不发 typed（updates.jsonl 里回合终态恒为
  // turn_completed），回放也只认 turn_completed。
  'response_completed',
  // 记忆的 flush / dream / 会话结束保存：wire 通知对「手工命令」与「后台
  // 自动运行」共用同一 tag（shell memory_dream.rs / memory_capture.rs），
  // TUI 只在手工 /flush、/dream 的 RPC 响应上渲染结果行，后台一律静默
  // （docs 13-memory.md「Memory Notifications」+ pager apply_session_event
  // 的 `_ => false`）。FE 同此：结果行由 actions 从 RPC 响应生成。
  'memory_flush_started',
  'memory_flush_completed',
  'memory_dream_queued',
  'memory_dream_started',
  'memory_dream_completed',
  'memory_session_saved',
])

/**
 * 未消费（有意）：不注册 case、不产生状态。
 * 前三个是「仅持久化」语义；last_turn_summary 走另一条数据链。
 */
export const UNCONSUMED_KINDS: ReadonlyMap<string, string> = new Map([
  ['compaction_checkpoint', '仅写 updates.jsonl、不上 live 通道；回退 UI 走 session_rewound'],
  ['rewind_marker', '同上，宿主不建卡 → generic → 回放 default 直落'],
  ['unknown', 'serde(other) 前向兼容兜底，形状已在 agent 侧丢弃'],
  ['last_turn_summary', 'send-only 不持久化；侧边栏副标题走 roster lastTurnSummary'],
  ['plan_kept', 'FE 的计划审阅卡走 x.ai/exit_plan_mode client_request；当前 shell 无生产者'],
  ['plan_cleared', '同上；计划模式进出由 current_mode_update 恢复'],
  ['plan_executing', '同上；接受计划走同一张审阅卡的 RPC 响应'],
  ['served_model', '实际应答模型的显示名，暂无生产者；会话模型显示走模型目录'],
  ['turn_usage', '单回合用量，仅 TUI headless 消费；会话用量走 session_status'],
])

/**
 * 弱实现（按方案 D6 保持现状）：只落一行 session_event 或只 bump 版本，
 * 不做浮层/卡片/面板。见 docs/SessionUpdate-全量适配方案.md 的 D6。
 */
export const WEAK_KINDS: ReadonlySet<string> = new Set<string>([
  'feedback_request',
  'auto_recovery_started',
  'auto_recovery_exhausted',
  'hooks_changed',
  'plugins_changed',
  'plugin_updates_installed',
])

/**
 * 订阅层（actions/init.ts）的全局事件白名单：即使宿主/中间层带了
 * sessionId 也不按单会话规则在顶层丢弃——它们的消费方自己认权威
 * （检索状态用 searchId、git 用 payload.sessionId、队列按会话 stash）。
 *
 * 注意：`scheduled_task_*` 不在其中——它们是**会话级**状态（每个会话一份
 * 任务列表），外来会话的事件必须丢弃；此前登记为全局导致别的会话的定时
 * 任务会写进当前视图。
 */
export const GLOBAL_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'yolo_mode_changed',
  'modes_update',
  'sessions_changed',
  'hosts_changed',
  'subscribers_changed',
  'prefs_changed',
  'mcp_tools_changed',
  'mcp_servers_updated',
  'session_rewound',
  'git_head_changed',
  'permissions_reset',
  // 检索引擎状态流：host 用 agent 自报的 sessionId（模糊搜索是字面量
  // "agent"，非会话 UUID）打标签，按会话过滤必然全量丢弃。
  'search_fuzzy_status',
])

/**
 * 宿主已建卡、FE 有意不消费的 typed 事件：handleChatEvent 的兜底链
 * （handleExtEvent）返回 false 后直接丢弃，DEV 告警要跳过它们。
 *
 * 共同点：都在 `handleXaiNotification` 里有显式转发分支，是老 host 走
 * generic `ext_notification` 时同样静默的那一批（extMisc.ts 顶部的理由）；
 * 新 host 改发 typed 后，静默必须显式登记，否则和"漏接"无法区分。
 */
export const SILENT_HOST_EVENT_TYPES: ReadonlyMap<string, string> = new Map([
  // 仅在其专属面板显示、web 无对应面板：文件监视 / 终端 / 检索面板。
  // extMisc.ts 的 ext_notification 分支对同一批理由已写过一遍。
  ['fs_notify', '文件监视面板状态，web 无该面板'],
  ['fs_index', '同上（索引进度）'],
  ['fs_index_delta', '同上（增量索引）'],
  ['search_content_status', '检索面板状态，web 的 /search 走 HTTP'],
  ['pty_notification', '终端面板通知，web 无终端面板'],
  ['session_updates_chunk', '历史分页的流式块，FE 走 HTTP /api/session-updates'],
  // leader / relay 内部状态：web 的 leader 关系由 hub 连接状态呈现。
  ['leader_reconnected', 'leader 重连内部信号，hub 连接状态已覆盖'],
  ['leader_version_mismatch', '同上（版本不一致由分层错误提示呈现）'],
  ['log', '宿主日志转发，不进滚动区'],
  // 已有替代数据源。
  ['git_worktree_status', 'git_head_changed 已带 worktree 字段'],
  ['config_changed', 'SettingsModal 打开时自拉 config，无需增量通知'],
  ['settings_update', '同上（宿主设置变更）'],
])
