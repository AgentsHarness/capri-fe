# acp-fe

Vite + React + Tailwind 前端：连接本机 `acp-host`（Local 模式）或 `acp-hub`（Hub 多 Host 模式），展示 ACP 流式对话与工具卡片。

## 设计要点

- **不执行** fs/terminal —— 工具由 Host 上的 Agent 自行执行
- UI 只渲染 `session/update`（消息 / 思考 / tool_call）与可选权限审批
- **Host 选择器**（TopBar 左上）：Hub 模式下列出所有已配对 Host，点击切换；选择持久化在 `localStorage`，首次自动选 Hub 默认 Host（或本地 Host）
- Hub 模式下 API 调用带 `?host=<hostId>`（acp-host 忽略该参数，Local 模式不受影响）；`/events` 事件按 `hostId` 过滤，hub 级事件（`hello`、`hosts_changed`）始终透传

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

Host 侧对应实现见 `acp-host/internal/acp/bridge.go`（通知转发、请求转发、`initialize` 能力声明 `x.ai/gitHeadChanged` 等）与 `internal/server/http.go`（`/api/client-response`、`/api/session-fork`、`/api/session-rename`、`/api/recap`、`/api/subagent-cancel`、`/api/task-kill`）。

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
# 终端 1 — Hub
cd ../acp-hub && go run ./cmd/acp-hub          # :8787，日志打印配对码

# 终端 2..N — 每台机器一个 Host
cd ../acp-host && HUB_URL=http://<hub>:8787 HUB_PAIR_CODE=<code> go run ./cmd/acp-host

# 终端 M — 前端指向 Hub
VITE_PROXY_TARGET=http://localhost:8787 npm run dev
```

打开 http://localhost:5173 后从左上角选择 Host。

## 环境

| 变量 | 说明 |
|------|------|
| `VITE_PROXY_TARGET` | Vite 代理目标；默认 `http://localhost:8765`（本机 Host），Hub 模式设为 `http://localhost:8787` |

## 栈

- Vite + React + TypeScript
- Tailwind CSS v4（`@tailwindcss/vite`）
- Zustand
