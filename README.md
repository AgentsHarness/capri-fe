# acp-fe

Vite + React + Tailwind 前端：通过 **Local** 模式连接本机 `acp-host`，展示 ACP 流式对话与工具卡片。

## 设计要点

- **不执行** fs/terminal —— 工具由 Host 上的 Agent 自行执行
- UI 只渲染 `session/update`（消息 / 思考 / tool_call）与可选权限审批
- Host 选择器已预埋（当前仅 Local 单 Host；多 Host 走 `acp-hub`）

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
# 终端 1 — Host
cd ../acp-host && go run ./cmd/acp-host

# 终端 2 — 前端
cd acp-fe
npm install
npm run dev
```

打开 http://localhost:5173 。Vite 已将 `/api`、`/events` 代理到 `http://localhost:8765`。

## 环境

| 变量 | 说明 |
|------|------|
| （默认） | 经 Vite proxy 连本机 Host |
| 未来 `VITE_HUB_URL` | Hub 模式（未实现） |

## 栈

- Vite + React + TypeScript
- Tailwind CSS v4（`@tailwindcss/vite`）
- Zustand
