# capri-fe 前端与 Agent 协议耦合状态审计

审计对象：`acp-fe`（FE）、`acp-host`（host）。所有结论带 `文件:行号` 证据，行号以审计时的代码为准。

## 一、链路与总账

数据流向是三跳，前端只认识第一跳：

```
FE ──HTTP /api/* + SSE/WS──> capri-host ──ACP JSON-RPC(stdio)──> agent 进程
```

- FE 从不直接讲 ACP：所有请求经 `src/api/localTransport.ts:1335` 的 `fetch`，由 host 转成 agent RPC。传输层还有 local / hub 两种模式（`src/api/transport.ts:62`），这只影响「FE 连哪台 host」，与 agent 无关。
- host 侧是唯一翻译层：`internal/acp/bridge.go`（5691 行）+ `internal/server/http*.go`。
- host 对 agent 的 ACP 面极窄：`handleAgentRequest` 只受理 `session/request_permission`，对 `fs/read_text_file|write_text_file`、`terminal/*` 一律回 `-32601`（`internal/acp/bridge.go:2661-2672`），并在 `initialize` 里把 `clientCapabilities.fs/terminal` 全部声明为 `false`（`internal/acp/types.go:181-188`）。

端点总账（host 注册的 239 个 `/api/*`，`internal/server/http.go:99`）：

| 类别 | 数量 | 含义 |
|---|---|---|
| 转发到标准 ACP 方法 | 12 | `session/*`、`session/prompt`、`session/cancel` 等 |
| 转发到 Grok 私有 `x.ai/*` | 174 | 含 fire-and-forget 的 `_x.ai/*` 通知型 |
| host 本地能力（不产生 agent 调用） | 47 | git 本地命令、`/api/shell`、设置、agents/personas、goal 引擎、统计 |
| 混合（本地 + 触发一个 agent 调用） | 6 | 如 `/api/agent-restart`、`/api/session-updates` |

一句话结论：**FE 与 capri-host 的协议耦合很轻（只有一层 HTTP 调用封装），而 capri-host 与 Grok 的耦合极重（每 14 个端点里只有 1 个走标准 ACP）。** 所以「能否无缝换 agent」的决定权几乎全在 host，FE 的问题集中在少数几处主动拒绝/白名单和无能力协商。

## 二、耦合状态总表（按能力域）

| 能力域 / 界面 | FE 封装 | 背后 agent 面 | 耦合度 | 换 agent 后的直接表现 |
|---|---|---|---|---|
| 核心对话（文本/思考/图片） | `events/userStream.ts:136-565` | 标准 `session/update` 的 `agent_message_chunk` / `agent_thought_chunk` | 低（骨架可复用） | 正常；思考时长、turn 时长依赖 `_meta.agentTimestampMs/streamStartMs`，缺失只是不显示时长 |
| 发送 / 停止 / 回合错误 | `rpc/prompt.ts:44/100` | 标准 `session/prompt`、`session/cancel` | 低 | 正常；`AgentTurnError('rejected'\|'unreachable')` 分级已做（`transport.ts:20-36`） |
| 工具行骨架（图标/标题/状态） | `store/chat/tools.ts:12-28` | 标准 `tool_call` / `tool_call_update` 的 `title/kind/status` | 中 | 能显示，动词/分组退化到 `Ran N tools`（`glyphs.ts:90`、`verbGroup.ts:227`） |
| 工具展开详情 | `scrollback/toolDetail.ts:1277-1654` | Grok `rawOutput` 的 Rust enum：`{Bash:{output,exit_code}}`、`EditsApplied`、`Grep`… | 高 | 全部落到 generic 分支，只显原文前几行 |
| 权限卡片 | `components/ApprovalStrip.tsx:72-118` | 标准 `session/request_permission` | 低 | 正常（scope/always 高级交互依赖 Grok option `meta`，退化为普通选项） |
| 问答 / 计划 / 差异审查卡 | `store/chat/pending.ts:12-18` | Grok 私有 `x.ai/ask_user_question`、`x.ai/exit_plan_mode`、`x.ai/diff_review` | 高 | 白名单外自动拒绝，卡片不出现且 agent 收到错误应答 |
| 会话列表 / 侧边栏分组 | `rpc/sessions.ts:149/169/202` | `session/list` + `x.ai/session_summaries/*` | 中 | 已做三级降级（`actions/session.ts:206-232`），侧边栏不白屏但分组信息变少 |
| 历史回放 / 上滑分页 | `rpc/sessions.ts:268` | host 本地归一化（读 agent 的 `updates.jsonl`），失败回退 `_x.ai/session/updates` | 高 | 非 Grok agent 无该文件格式且无该扩展，历史加载走错误路径 |
| 模式 / 模型切换 | `rpc/modes.ts:5`、`rpc/tools.ts:525` | `session/set_mode`、`session/set_config_option`、（权限模式）`_x.ai/yolo_mode_changed` | 中 | 模式/模型 id 由 agent 广告，能切换；权限模式徽标失效 |
| 后台任务 / 子代理 | `store/chat/tasks.ts:115-172`、`subagentEvent.ts:147-330` | Grok `task_backgrounded`/`subagent_spawned` 等约 10 个 kind | 高 | 顶栏任务条、子代理时间线整体空 |
| Git / worktree 面板 | `rpc/git.ts:83-389` | 32 个 `x.ai/git/*`；11 个 host 本地 git 命令 | 高 | 面板报错或空仓；worktree 门控失效 |
| MCP 面板 | `rpc/tools.ts:7/121/104` | `x.ai/mcp/*` | 高 | 空列表 + 错误行 |
| 记忆（/memory、/flush、/dream） | `rpc/memory.ts:30-73` | `_x.ai/memory/*` | 高 | 空列表 |
| 扩展生态（hooks/skills/workflows/plugins/marketplace） | `rpc/tools.ts:359-591` | `x.ai/hooks\|skills\|workflows\|plugins\|marketplace/*` | 高 | 空列表（逐字段守卫，不崩） |
| 队列 / 转向 / btw / follow-ups / 调度 / rewind / compact / recap | `rpc/queue.ts`、`actions/xai.ts` | `x.ai/queue/*`、`x.ai/btw`、`x.ai/follow_ups`、`x.ai/scheduler/*` 等 | 高 | 功能项静默失效 |
| 用量 / 计费 | `rpc/usage.ts:19/5` | `x.ai/session/usage`、`x.ai/billing` | 高 | 全 0/空，credits chip 隐藏 |
| 用量账本 / 上下文计数 | `events/tools.ts:362-386` | host 从 `_meta.totalTokens` 合成 | 中 | 标准 `usage_update` 有兜底 case，但 Grok 不发它 |
| 目录选择器 / host 设置 / agents / personas / goal | `api/shell.ts:31`、`rpc/agents.ts:72` | 47 个 host 本地端点 | 无 | 正常可用 |
| 侧边栏置顶 / 待办 / FE 偏好 | `rpc/hosts.ts:220/258` | `/api/prefs`（host/hub 本地） | 无 | 正常可用 |

FE 里另有一批没有任何消费方的死封装（换了 agent 也不影响界面，属协议面漂移）：`plugins/*`、`marketplace/*`、`skills add|remove|reset|config`、`mcp/setup|auth-status`、`terminal create|output|release|wait-for-exit`、`session import|repair|rehydrate|close|share`、`git init|push|pull|fetch` 等。真正驱动界面的端点比注册的 239 少得多。

## 三、设计得好的部分（可复用的解耦资产）

这部分是审计里最重要的正面发现——**「可插拔」的正确形状已经存在**，只是尚未被用作 agent 适配点。

| 资产 | 位置 | 为什么算好 |
|---|---|---|
| FE 对 ACP 零知识 | `src/api/transport.ts`、`rpc/mixins.ts:16-31` | 换协议只动 host，FE 的调用姿势不变 |
| 事件 kind 单一事实源 | `events/kinds.ts:1-100`（ACP 11 + xAI 52 + 共享 3） | 新增 kind 只改一处；`kindsCoverage.test.ts` 强制登记，防止清单分叉 |
| 单一归一入口 | `events/normalize.ts:38-60` | typed / 顶层 / `params` 三种载荷收敛为一，顶层补 camelCase 别名 |
| 信封解包与深查找 | `rpc/core.ts:59-133` | `findField/findArrayField/findObjectField` 递归 `result/data/payload`，双拼读取是既有惯例 |
| 逐端点归一函数 | `sessions.ts:23/85/286`、`tasks.ts:172-262`、`lib/memory.ts:44-74` | 已有「把 agent 数据转成 FE 领域对象」的习惯，只是散落在 rpc 层 |
| 未知输入不崩 | `extMisc.ts:245-251`、`toolDetail.ts:1564-1654`、`EntryView.tsx:201` | 未知方法降级一行、未知工具走 generic、未知 entry 返回 null |
| host 的历史归一化 | `internal/acp/session_history.go:19-40`、`lite.go:1-30` | 自己算 `msgSeq` 不依赖 agent 的 `eventId`；首屏投影 |
| host 的 ID 合成 | `internal/acp/synth_tool_call.go:1-30` + `bridge.go:2237-2280` | 补齐缺失 `toolCallId`，纯通用适配逻辑 |
| kind 分发的前向兼容 | `bridge.go:1857` 的 `dispatchSessionUpdateKind`，未建模 kind 走 `default: return false` → generic `session_notification` | 新 kind 不会被丢掉 |
| 错误分级 | `transport.ts:20-36` | agent 拒绝回合与 agent 不可达分开处理 |
| 降级链 | `actions/session.ts:206-232`、`McpPanel.tsx:90` | 局部失败不扩散 |

## 四、强耦合点清单（按危害排序）

| # | 耦合点 | 位置 | 危害 | 建议 |
|---|---|---|---|---|
| 1 | 启动握手强制认证广告：agent 若 `initialize` 不返回 `authMethods`，boot 直接失败 | `bridge.go:1306-1342` | 致命：非 Grok agent 起不来，全 UI 只剩 bootError。ACP 里 `authenticate` 是可选的 | 无 authMethods 时跳过 authenticate |
| 2 | 前端自动拒绝白名单外的交互请求 | `store/chat/pending.ts:12-18`、`pending.ts:93` | 致命：新 agent 的任何非 Grok 交互请求（含标准 ACP 之外的 elicitation）被 FE 主动回错误 | 白名单改为「注册 + 未知请求降级为通用卡片/原文展示」，禁止自动拒绝 |
| 3 | client 侧 fs/terminal 能力被硬关 | `bridge.go:2661-2672`、`types.go:181-188` | 严重：若新 agent 按 ACP 标准分工依赖客户端做文件 IO，它的读写工具全失败 | 按配置暴露真实能力；或把「纯 agent 执行模式」写进 capability map 让 agent 知情 |
| 4 | 历史依赖 agent 的私有落盘格式 | `session_history.go`（`grokHome()` + `sessionUpdatesFile`）、`http.go:985` | 严重：`/api/session-updates` 是 FE 首屏时间线的主路径，非 Grok agent 无该文件，回退 `_x.ai/session/updates` 也不存在 | 抽出 history provider 接口；或 host 自建事件历史 |
| 5 | 无能力协商：FE 完全不读 `agentCapabilities`，host 存下但从不门控 | `api/types/events.ts:30/549`、`bridge.go:1022` | 严重：没有「按能力隐藏入口」，只有「点了才发现失败」 | host 下发 capability map，FE 据此隐藏/降级面板 |
| 6 | 人机身份冒充 Grok pager | `bridge.go:1092/1105`、`initCapabilitiesMeta` 的 5 个 `x.ai/*` 键（`bridge.go:1134-1155`） | 中：agent 可能按 clientType 分支行为 | 按被适配 agent 选择 clientType |
| 7 | 工具详情绑定 Grok 工具输出 schema | `toolDetail.ts:1277-1654`、`toolPaths.ts:186-236`、`toolHeaderExtra.ts:99-300` | 中：不崩，但信息密度层整体退化 | 在渲染前加一层 tool-result adapter（按 agent profile 选实现） |
| 8 | 工具名 / kind 映射表散落 4 处 | `theme/glyphs.ts:60-91`、`theme/toolFamily.ts:16-59`、`store/chat/tools.ts:71-115/135-188`、`verbGroup.ts:192-229` | 中：新 agent 的工具名全部落 generic | 合并为一张可注入的工具元数据表 |
| 9 | 字段名刚性点（无兜底） | `sessions.ts:689-691`、`git.ts:168`、`agents.ts:76` | 中：面板级错误 | 沿用仓库既有的双拼 + `typeof` 守卫惯例 |
| 10 | 未知 kind / typed event 静默丢弃 | `sessionNotif.ts:43-58`、`init.ts:204`、`extMisc.ts:576-578` | 低-中：无可见反馈，排查困难 | DEV 告警升格为可选的「未支持能力」提示 |
| 11 | 协议版本不校验 | `bridge.go:29`、`bridge.go:1029-1032` | 低（当前良性） | 纳入能力协商 |

## 五、换成「通用 ACP agent」后的存活矩阵

| 层 | 判定 |
|---|---|
| 存活（纯标准 ACP + host 本地） | 核心对话、图片、发送/停止、权限卡片、工具行骨架、计划 todo、标准 mode/config/commands 更新、host 设置、agents/personas、目录选择器、侧边栏置顶待办 |
| 降级（能用，信息变少） | 会话列表分组、思考/turn 时长、工具展开详情、用户名/系统注入 prompt 分类、上下文计数 |
| 失效（面板空或报错） | 问答卡、计划审阅、差异审查、后台任务、子代理、Git/worktree、MCP、记忆、hooks/skills/workflows/plugins、队列、btw、follow-ups、调度、rewind/compact/recap、用量/计费 |
| 阻断（今天根本起不来） | 不广告 `authMethods` 的 agent（见强耦合点 1） |

即：**「能聊天」可以做到开箱即用，「能像 Grok 一样密」需要 host 补适配层。**

## 六、要做到无缝切换，需要补的三层

现有设计已经有正确的骨架，缺的是能力声明、适配器归属、分层契约这三件事。

**1. 能力层：capability map**

host 在 boot 后探测被适配 agent（读 `agentCapabilities` + 逐域试调 `x.ai/*` 探针），产出 `{domain: supported | absent, tier}` 随 `/api/status` 与 `hello` 下发。FE 已有 `capabilities` / `agentCapabilities` 字段和 `unknown` 类型，接上即可；各面板入口按它决定显示或隐藏。

**2. 契约层：Tier 0 最小必需契约**

把 FE 依赖的 wire 面写成一份正式契约，分档：

- **Tier 0（任何 agent 必须满足）**：`initialize`（可无 authMethods）、`session/new`（返回 `sessionId`）、`session/prompt`、`session/update` 的 6 个标准 kind（`agent_message_chunk` / `user_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan`）、`session/request_permission`、`session/cancel`。host 负责把任何 agent 的等价物翻译成这些。
- **Tier 1（可选域，缺失即隐藏）**：git、mcp、memory、tasks/subagent、queue、usage、extensions。
- **Tier 2（Grok 专属，可为空）**：`background_tasks`、`subagent_*`、`memory_*`、`hook_*`、`scheduled_task_*` 等 52 个扩展 kind。

FE 侧对应地把 `events/kinds.ts` 从「全量枚举」改为「按 capability profile 装配」。

**3. 适配层：agent adapter**

两个可选落点，建议放在 host：新增 `internal/acp/adapters/<agent>`，每个适配器负责 ① 把该 agent 的 `session/update` / 工具输出归一成 Tier 0 形状，② 把 FE 的 `/api/*` 域调用映射到该 agent 有能力的方法（缺失则返回 `not_supported` 而不是 502）。FE 保持今天的样子不动。

如果倾向于让 FE 承担多 agent 适配，则把 `rpc/*` 的归一函数（`parseTaskSnap`、`normalizeMemoryListing`、toolDetail 的 schema 分派）收敛成一组可替换的 profile，`kinds.ts` 作为装配点。

## 七、落地优先级

1. 放宽 authenticate（强耦合点 1）——「任何 agent 都能连」的前置条件，改动最小、收益最大。
2. 取消 `pending.ts` 白名单的自动拒绝，改为未知请求降级展示（强耦合点 2）。
3. 由 host 下发 capability map，FE 各面板入口按它隐藏/降级（强耦合点 5）——完成后「换 agent」从「大面积报错」变成「干净的精简界面」。
4. 历史读取抽成 provider 接口，去掉对 agent 私有落盘格式的依赖（强耦合点 4）。
5. 再逐个域补 Tier 1 适配器（git → mcp → memory → tasks），每补一个域，界面就多恢复一块。

## 八、ACP 版本演进与 v2 影响评估

调查日期 2026-09-27。资料来自 agentclientprotocol.com（announcements / updates / protocol/v2 迁移指南）、GitHub `agentclientprotocol/agent-client-protocol` 的 `schema/v1|v2/meta.json`，以及 crates.io 上两个 crate 的实际源码。

### 8.1 协议现状：v1 稳定，v2 仍在草稿

| 事实 | 依据 |
|---|---|
| 稳定版是 v1（`protocolVersion: 1`） | 官网 updates 页；`agent-client-protocol-schema` 1.9.1 `src/version.rs:24-26` `LATEST = V1` |
| v2 自 2026-07-20 起为 Draft | 官网 announcement「ACP v2 is available in Draft」 |
| v2 在 SDK 里靠 feature 开关暴露，默认不可用 | schema 1.9.1 `src/version.rs:16-22`：`V2` 需 `unstable_protocol_v2`；启用后连 `LATEST` 都被移除，强制显式选版本 |
| v1 这一年已通过 RFD 吸收大量能力 | session/list、session/resume、session/close、session/delete、session_info_update、usage_update、messageId、session config options、elicitation、tool call name、`$/cancel_request`、logout |
| 官方要求 v1/v2 并存 | 迁移指南「Supporting v1 and v2 side by side」：不应用 v2 替换 v1，按连接协商 |

### 8.2 两端当前的版本落点

| 端 | 落点 | 证据 |
|---|---|---|
| capri-host | 硬编码 v1 | `bridge.go:29` `protocolVersion = 1`，`bridge.go:987` 随 `initialize` 发出 |
| host 的版本协商 | 不一致只记日志继续 | `bridge.go:1026-1032`（`log.Printf(... continuing)`） |
| Grok agent | v1，且 schema 落后 | `grok-build/Cargo.toml:118` `agent-client-protocol = "0.10.4"`；`Cargo.lock:43-46` 对应 `agent-client-protocol-schema` 0.11.4，其 `LATEST` 也是 V1，且无 v2 分支 |

结论：**两侧都在 v1，版本上没有错位，适配是"同版本、异构扩展"的关系。**

### 8.3 host 对 v1 标准方法的实际使用率

| v1 标准方法 | host 是否使用 | 证据 |
|---|---|---|
| `initialize` | 是 | `bridge.go:986` |
| `authenticate` | 是 | `bridge.go:1346` |
| `session/new` | 是 | `bridge.go:1236` |
| `session/load` | 是 | `bridge.go:4415` |
| `session/resume` | 是 | `bridge.go:4615` |
| `session/list` | 是 | `bridge.go:4064` |
| `session/close` | 是 | `bridge.go:4719`、`idle_unload.go:227` |
| `session/prompt` | 是 | `bridge.go:3322` |
| `session/cancel` | 是 | `bridge.go:3511` |
| `session/set_mode` | 是 | `bridge.go:3619` |
| `session/set_config_option` | 是 | `bridge.go:3666`（失败回退 `session/set_model`） |
| `session/request_permission` | 是 | `bridge.go:2674` |
| `session/update` | 是 | `bridge.go:1660` |
| `session/delete` | 否（走 `_x.ai/session/delete`） | `bridge.go:5354`；Grok 侧 `session/delete` 零实现 |
| `elicitation/create` | 否（走 `x.ai/ask_user_question`） | host 全仓 0 引用；Grok 侧 `elicitation/create` 仅用于 MCP 反向调用 |
| `usage_update` | 仅兜底 case，Grok 不发 | `bridge.go:1857` 的 dispatch；Grok 侧 0 引用，host 改从 `_meta.totalTokens` 合成 |
| `logout` | 否（走 `x.ai/auth/logout`） | host 全仓 0 引用 |
| `$/cancel_request` | 否 | host 全仓 0 引用 |
| `fs/*`、`terminal/*`（客户端方法） | 明确拒绝 | `bridge.go:2661-2672` 回 `-32601` |

即：v1 的 13 个 agent 方法里 host 用了 11 个（未用的只有 `session/delete` 与 `logout`），v1 后半年新增的可选标准能力（elicitation、usage_update、`$/cancel_request`）则一律用私有扩展顶替。

### 8.4 v2 会动到什么

| v2 变化 | 对 host/FE 的冲击 | 证据 |
|---|---|---|
| `session/prompt` 响应不再结束回合，改为返回 `messageId`；回合结束移到 `state_update`（`running`/`idle`/`requires_action` + stopReason） | **大改**：host 现在把 prompt 响应当作回合结束，FE 的 busy/done/worked-for 全建立在 Grok `turn_completed` 上 | 迁移指南「The new prompt lifecycle」 |
| `session/update` 变体重构：`tool_call` 移除（首次 `tool_call_update` 即创建）、`plan`→`plan_update`(planId)、`current_mode_update` 移除、新增 `*_message` 整体 upsert、`tool_call_content_chunk`、`terminal_update`/`terminal_output_chunk` | **大改**：`dispatchSessionUpdateKind`（`bridge.go:1857`）与 FE `events/kinds.ts` 的 kind 表都要跟着重写 | 迁移指南「`session/update` variant changes」 |
| diff 结构化为 `changes`（add/delete/modify/move/copy + fileType/mimeType）+ 可选 `git_patch` | **中改**：FE 的工具 diff 渲染（`toolDetail.ts:887-1042`）建立在 Grok `oldText/newText` 上 | 迁移指南「Diff content」 |
| `session/request_permission` 参数重构：`title` 必填 + 可选 `description` + `subject` 联合体，不再裸传 `toolCall` | **中改**：FE `ApprovalStrip.tsx:72-118` 读的是 `params.toolCall` | 迁移指南「Permission requests」 |
| `session/load` 删除，`session/resume` 增加 `replayFrom` | **中改**：host 现有 load/resume 两条路径可合并 | 迁移指南「Session setup and lifecycle」 |
| `session/set_mode` 与 `modes` 字段删除，模式并入 config option（`category: "mode"`） | **小改**：host 少一条 set_mode 路径 | 迁移指南「Session modes become config options」 |
| `authenticate`→`auth/login`、`logout`→`auth/logout`，auth 描述符 `id`→`methodId` 且 `type` 必填 | **小改** | 迁移指南「Authentication」 |
| `initialize` 两侧字段统一为 `capabilities`/`info`，`info` 必填；能力标记从布尔改为对象（存在即支持） | **小改** | 迁移指南「Initialization」 |
| 客户端 `fs/*`、`terminal/*` 整体删除，改由 MCP 提供客户端工具 | **零成本，且是我方优势**：host 现在就把这两类声明为 false 并拒绝（`types.go:181-188`），v2 把它变成了标准做法 | 迁移指南「Client file system and terminal execution removed」 |
| 枚举与 tagged union 全面开放，`_` 前缀保留给实现自定义 | **收益**：Grok 的 174 个 `x.ai/*` 端点与 `_meta` 机制在 v2 继续合法，官方还明确要求接收方保留未知变体 | 迁移指南「Extensibility and forward compatibility」 |
| `usage_update`、`session_info_update`、`available_commands_update`、`config_option_update` 保持不变 | **零成本** | 迁移指南「`session/update` variant changes」 |

### 8.5 「能力能保留多少」的两个口径

**口径一：Grok 现有能力面（升级 v2 后会不会丢）**

- 174 个 `x.ai/*` 私有端点：与 ACP 版本解耦（v2 明确保留自定义方法与 `_meta`），**形式保留 100%**。
- 47 个 host 本地端点：与 agent 无关，保留 100%。
- 12 个标准 ACP 端点：方法语义变了 2 个（`session/load`、`session/set_mode` 被删，均有官方替代），其余需按 v2 形状改代码。
- 结论：**能力面约 100% 形式保留，其中约 10% 的标准面（12 个端点 + dispatch/回合语义）需要重写**。丢不掉的是 Grok 私有面，反而最需要动的是标准面。

**口径二：换非 Grok agent 时界面能活下来多少（可移植率）**

按能力域（第三节表格的 19 个域）分档：

| 档位 | 今天（v1, host 现状） | host 适配 v2 后 |
|---|---|---|
| 完全可移植 | 7/19 ≈ 37% | 9/19 ≈ 47% |
| 部分可移植（能用但缩水） | 7/19 ≈ 37% | 6/19 ≈ 32% |
| 仅 Grok 可用 | 5/19 ≈ 26% | 4/19 ≈ 21% |

v2 净增益：历史回放（`session/resume` + `replayFrom` 取代读私有落盘）、用量账本（`usage_update`）、问答卡（标准 elicitation）、回合状态（`state_update`）、结构化 diff、terminal 展示面；这些正是今天 FE 里最依赖 Grok 私有字段的部分。

按端点（239 个 `/api/*`）口径：

| 类别 | 数量 | 今天 | host 适配 v2 后 |
|---|---|---|---|
| host 本地（与 agent 无关） | 47 | 可用 | 可用 |
| 标准 ACP 承载 | 12 | 可移植 | 可移植（需迁移） |
| `x.ai/*` 但有标准对应物 | 约 13 | 不可移植 | 可移植（需改用标准） |
| `x.ai/*` 无标准对应物 | 约 161 | 仅 Grok | 仅 Grok |
| 混合 | 6 | 部分 | 部分 |

即端点口径下可移植率约 **27%（今天）→ 33%（v2 后）**；该口径被 Git（32 个 `x.ai/git/*`）、hunk-tracker、code、auth 这类大而专的面板拉低。

**一个反直觉的结论**：v2 本身对"保留率"的抬升有限（按域 +10 个百分点）。真正的大头是**v1 已经稳定、host 却仍在用 `x.ai` 顶替的那几项**——标准 elicitation（取代 `x.ai/ask_user_question`）、`session/delete`、`usage_update`、`messageId`。这些不需要等 v2 就能拿到的可移植性，目前被 host 的私有扩展路径挡着。

### 8.6 与 v2 相关的风险与建议

1. **版本协商必须先修**：host 对 `protocolVersion` 不一致只记日志继续（`bridge.go:1026-1032`）。未来 v2-only agent 到来时，host 会继续按 v1 语义发 `session/load`、期待 prompt 响应带 `stopReason`、期待 `session/new` 返回 `modes`，全部**静默错位而非报错**。应先做到"不认识就明确拒绝并给出可读错误"。
2. **v2 适配可以等，v1 标准采纳不该等**：elicitation / session-delete / usage_update / messageId 都能在 v1 落地，且都是"换 agent 才能用上"的关键项。
3. **v2 的删除面对我方是利好**：client `fs/*`、`terminal/*` 被 v2 删除，而 host 现在就是拒绝这两类的立场，升级时不需要补任何东西。
4. **排期参考**：SDK crate `agent-client-protocol` 已到 2.2.0（2026-09-18），但 v2 仍由 `unstable_protocol_v2` feature 开关控制，官方明说不要在生产默认开启。等它去掉 feature 门再动手；期间先做 1。
5. **Grok 侧是 v1-only 且 schema 落后**（0.10.4 → schema 0.11.4，落后当前 1.9.1 约 10 个小版本）。若期望 Grok 提供 v2 能力，需要上游先升 SDK。
