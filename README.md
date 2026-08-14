# capri-fe

Vite + React + Tailwind 前端：连接本机 `capri-host`（Local 模式）或 `capri-hub`（Hub 多 Host 模式），展示 ACP 流式对话与工具卡片。

## 设计要点

- **不执行** fs/terminal —— 工具由 Host 上的 Agent 自行执行
- UI 只渲染 `session/update`（消息 / 思考 / tool_call）与可选权限审批
- **Host 选择器**（TopBar 左上）：Hub 模式下列出所有已配对 Host，点击切换；选择持久化在 `localStorage`，首次自动选 Hub 默认 Host（或本地 Host）
- Hub 模式下 API 调用带 `?host=<hostId>`（capri-host 忽略该参数，Local 模式不受影响）；`/events` 事件按 `hostId` 过滤，hub 级事件（`hello`、`hosts_changed`）始终透传

## x.ai 扩展（对齐 Grok Build TUI）

| 组 | 事件 / 方法 | 前端呈现 |
|----|------------|---------|
| 会话生命周期 | `x.ai/session_notification`（subagent / response / auto_compact / session_recap 等 tag） | 滚动区 subagent 卡片、session_event 行（压缩、摘要） |
| 后台任务 | `x.ai/task_backgrounded` / `task_completed` / `monitor_event` | `bg_task` 卡片 + kill 按钮（`x.ai/task/kill`） |
| 权限与交互 | `x.ai/yolo_mode_changed`、`x.ai/ask_user_question`、`x.ai/exit_plan_mode` | prompt 行 mode 标记、QuestionModal、PlanApproval 条 |
| Git | `x.ai/git_head_changed` | TopBar 分支徽标 |
| MCP | `x.ai/mcp/server_status` / `tools_changed` / `servers_updated` | mcp 面板（TopBar 按钮） |
| 会话管理 | `x.ai/sessions/changed`、`x.ai/models/update`、`session/fork`、`session/rename`、`x.ai/recap` | 历史列表自动刷新、history 菜单 recap/fork/rename |
| 调度任务 | `x.ai/scheduled_task_fired` / `inject_prompt` | 滚动区 status 行 |

## TUI 移植能力（斜杠命令与 Composer）

- **斜杠命令**：输入 `/` 弹出模糊菜单（↑/↓ + Enter/Tab 执行），或直接输入 `/cmd args` 回车。
  支持 `/new /clear /resume /model /effort /theme /compact /rewind /delete /rename /fork /recap /session-info /loop /plan /normal /copy /timestamps /help`。
- **prompt 历史**：空输入按 `↑` 回忆最近 50 条（localStorage 持久化）。
- **中途发送**：回合进行中 Enter 排队（胶囊提示，可展开管理），double-Enter 发队首，`Ctrl+Enter` 取消当前回合立即发送。
- **shell 模式**：空输入输入 `!` 进入（前缀显示为 `! `），Enter 把命令作为 prompt 发给 agent（用户行以 `$` 前缀展示）；空输入 Backspace/Esc 退出。
- **图片**：粘贴/拖拽图片 → `[Image: …]` chip（缩略图预览），提交为 ACP image 内容块；agent 回复中的图片经 SSE `image` 事件内联渲染（滚动区 / BlockViewer / read 工具预览）。
- **会话管理**：侧栏行 hover ✕ 删除（二次确认）、compact / rewind（RewindPicker 模态，`x.ai/rewind/points` + `execute`）。
- **任务面板**：⠋N 胶囊展开双分区面板（运行中 + 调度任务），调度任务来自 `scheduled_task_created/deleted` 通知，删除走 `_x.ai/scheduler/delete`。
- **权限与取消**：权限卡键盘化（↑↓/j/k、Tab 循环、`1-9` 直接选、Enter 确认、Esc park、`Ctrl+C` 取消）、always 范围调整（←/→）、权限规则重置（`_x.ai/permissions/reset`）；回合中 Esc / [stop] 打开取消面板（1-4：取消 / 停后台任务 / 清队列 / 继续运行）。
- **模式切换**：Composer 中 `Shift+Tab` 循环 Normal → Plan → Always-approve（plan 优先 `_x.ai/toggle_plan_mode`，回退 `session/set_mode`；always-approve 尝试多候选 id），prompt 徽标显示 plan/always-approve/auto。
- **goal 与工作流**：GoalChip 面板管理（状态/暂停/恢复/清除，提示词路径）；`/workflows` 运行面板（display name/status/phase/进度 + 暂停/恢复/停止，本地乐观 + `workflow_updated` 校正）。
- **diff 审查**：`x.ai/diff_review` 请求 → DiffReviewModal（逐文件批准/拒绝 + 意见，回执 `{approved, comments}`）；通知态只读展示。
- **记忆系统**：`/memory`（只读列表，来自 `memory_files` 事件）、`/flush`（`_x.ai/memory/flush`）、`/dream`、`/remember`（提示词路径）。
- **MCP 管理**：`/mcps` 面板（事件流状态 + `/api/mcp/list` 合并，启停/删除/认证触发/添加服务器表单）。
- **扩展与设置**：`/hooks` `/plugins` `/skills` `/marketplace` 打开扩展模态（`GET /api/extensions` 读 `~/.grok`，hooks 启停为只读提示）；F2 / `/settings` 打开设置模态（`GET /api/settings` config.toml 只读展示）。
- **计费**：`/billing` 查看额度/账单（`_x.ai/billing`）。

Host 侧对应实现见 `capri-host/internal/acp/bridge.go`（通知转发、请求转发、`initialize` 能力声明 `x.ai/gitHeadChanged` 等）与 `internal/server/http.go`（`/api/client-response`、`/api/session-fork`、`/api/session-rename`、`/api/recap`、`/api/subagent-cancel`、`/api/task-kill`，以及 TUI 移植新增的 `/api/session-delete`、`/api/compact`、`/api/rewind-points`、`/api/rewind-execute`、`/api/scheduler-delete`、`/api/billing`、`/api/memory-flush`、`/api/memory-rewrite`、`/api/toggle-plan-mode`、`/api/permissions-reset`、`/api/mcp/list`、`/api/mcp-toggle`、`/api/mcp-add`、`/api/mcp-remove`、`/api/mcp-auth-trigger`、`/api/extensions`、`/api/settings`）。

## 开发

```bash
# 终端 1 — Host（本地模式）
cd ../acp-host && go run ./cmd/acp-host

# 终端 2 — 前端
cd acp-fe
npm install
npm run dev
```

打开 http://localhost:5173 。Vite 已将 `/api`、`/events` 代理到 `http://localhost:8765`。

## Hub 多 Host 模式

```bash
# 终端 1 — Hub（生产务必设置 FE_TOKEN）
cd ../acp-hub && FE_TOKEN=dev-secret go run ./cmd/acp-hub          # :8787，日志打印配对码

# 终端 2..N — 每台机器一个 Host
cd ../acp-host && HUB_URL=http://<hub>:8787 HUB_PAIR_CODE=<code> go run ./cmd/acp-host

# 终端 M — 前端指向 Hub（密钥由用户在页面上输入，不要打进构建）
VITE_PROXY_TARGET=http://localhost:8787 npm run dev
```

打开 http://localhost:5173 后从左上角选择 Host。

Hub 设置了 `FE_TOKEN` 时：

1. 前端启动探测 `/api/hosts`，若 `401` 则弹出**访问密钥**输入框
2. 用户输入与 Hub 相同的密钥；仅写入本机 `localStorage.acp-fe-token`
3. 之后 API 带 `Authorization: Bearer …`，SSE 带 `?token=`（`EventSource` 无法设 header）

**不要**把密钥编进 `VITE_*` 或静态资源；生产构建应无 token 环境变量。

## 环境

| 变量 | 说明 |
|------|------|
| `VITE_PROXY_TARGET` | Vite 代理目标；默认 `http://localhost:8765`（本机 Host），Hub 模式设为 `http://localhost:8787` |

## 栈

- Vite + React + TypeScript
- Tailwind CSS v4（`@tailwindcss/vite`）
- Zustand

## 友情链接

- [Linux.do](https://linux.do)
