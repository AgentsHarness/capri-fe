# 待办任务书（FE 对齐 TUI）

这些是把 `docs/FE-vs-TUI-差异审查报告.md` 的调查结论拆成可独立交付的任务后，逐条写好的实施任务书。每份都自带：已核实的现状（精确到 file:line，含 TUI / host 侧对照）、要做的改动、测试要求、以及不越界的约束。派子代理执行时直接把整份文件当作 prompt 投喂即可。

## 已完成

| 项 | 提交 | 结果 |
|---|---|---|
| `/context` 模型显示错 + 信息不全 | `5563b20` | 请求显式带 `sessionId`（此前 host 回落成它的活动会话，多 tab 下模型与 token 会取自别的会话）；补 TUI 的 `Turns · Tool calls · Compactions` 页脚 |
| `/session-info` 弹窗化并对齐 TUI 内容 | `f9e416b` | 命令接上此前"已存在但零调用方"的 `SessionInfoModal`；弹窗并行合并 host 薄记录 + `x.ai/session/info` + `/api/status`，按 TUI `session_info_fields` 行序补齐 Conversation ID / Model Hash / API Backend / Turn / Shell version；删除滚动区文本路径 |
| MCP 面板"没有信息" | `d2713e1` | 头部计数与状态区改吃合并后的 `rows`（原先吃只在变化时推送的事件流）；`mcpVersion` 变化触发重取；补回 `displayName` / `sourceLabel` / `authRequired` / `setupRequired` / `toolCount`；空态归位 |
| `/recap`、设置里的 `permission_mode` | 无需改动 | 调查确认二者已是完整真链路：`/recap` → `POST /api/recap` → `session_recap` 事件；`permission_mode` 三选一同时写 `[ui]` 配置并应用到当前会话 |
| `/compat` | 不做 | 它不是斜杠命令，是 config.toml 的 `[compat.<vendor>.<surface>]` 布尔表（vendor ∈ cursor/claude/codex，surface ∈ skills/rules/agents/mcps/hooks/sessions） |
| 04 home 新建 worktree | `6cf40e5`（host 配套 `9ef215a`） | 空状态页出现「在新 worktree 中开始」（按「已选目录 + git 仓库」门控，`gitRepoRoot` 探针按 cwd 缓存）；host `worktree/create` 无活动会话时给唯一占位 sessionId，home 场景不再 404 |
| 05 `/btw` 旁路提问 | `377eed0`（host `8372db8`） | FE 命令 + 金色滚动区块（默认折叠/展开、错误常驻可见），busy 直发不进队列、按会话绑定；host 透传显式 sessionId（多标签页不再打错会话） |
| 06 `follow_up_behavior` 设置无效 | `44cdb98`（host `f80a958`） | 取证确认 FE 键名/取值与 agent canonical 一致（queue/steer，每回合读取）；host 进写白名单 + 未知键 400 前置检查；FE 只需补用例 |
| 07 `default_selected_permission` 缺失 | `5cf690e` | FE 本地持久化（localStorage）四取值；审批游标按「YOLO 身份排除 → kind → optionId → 标签」解析，`allow_command_always` 绝不选全局行 |
| 08 ask question timeout 缺失 | `2f25507`（host `712526d`） | 取证：agent wire **无 deadline 字段**（到点 agent 自行 resolve）→ 卡片只做基于配置的静态提示不造假倒计时；host 暴露/写入 `[toolset.ask_user_question]` 两键（1–86400 校验） |
| 09 `/view-plan` | `88476a6` | 弹窗读 store `todos/todoCounts`（与状态条徽标同源，plan 事件不进滚动区已核实）；别名 `show-plan`/`plan-view`；`/plan` 重入提示改用 `/view-plan` |
| 10 `/loop` 被本地实现降级 | `1a3bd2b` | 删自造中文指令，改 `/loop <args>` 原文透传（shell PROMPT_COMMANDS 通道拦截展开，与 TUI 逐字一致）；interval 校验/回执对齐 TUI；`required_tools` 门控因 host 丢弃 update 级 meta.tools 未做（取证说明） |
| 11 `/remember` / `/dream` | `1494204` | `/remember` 走 `memory-rewrite` 真端点（改写不落盘，全链路无保存端点 → 滚动区反馈，不造假确认弹窗）；`/dream`、`/memory on|off` 改发内置 slash 命令 |
| 12 `/export` | `772954a` | 纯前端；TUI 三段式 Markdown 结构（工具一行摘要、思考块跳过）；无参数剪贴板/有参数下载；文件名安全化；未加载历史如实标注（分页加载语义） |
| 13 `/workflow` 与 `/workflows` 语义反了 | `d0567f9` | `/workflow` 单数对齐：`runs` 开运行面板、manage ops（pause/resume/stop/save，runId 或名称匹配，不猜 run）、其余原样透传；`/workflows` 改扩展面板 workflows 目录 tab（`workflowsList`，加载/错误/空三态） |
| 14 `/imagine` / `/imagine-video` | `1d277c6` | 本地复刻 `imagine_instruction`（agent 把这两个名字烧成保留名不广播）；显示文本与发送内容分离（send 的 text/blocks）；busy 走队列；video 版按取证确认工具存在即注册 |

## 待办

全部完成（04–14 分四批 × 3/3/3/2 并行 worktree 执行，逐批审查合并于 main，FE 基线 106 files / 1151 tests、host 全绿）。

## 派工时的统一约束

- 一次只做一个任务，前一个验收通过再放下一个（任务之间有文件重叠，尤其 `src/commands/registry.ts` 与 `SettingsModal.tsx`）。
- 执行方的验证门槛写在各任务书里：FE 是 `npx tsc -b` + `npx oxlint` + `npx vitest run`（当前基线 100 files / 1035 tests 全绿），host 是 `go build ./...` + `go test ./internal/...`。不许变红、不许靠删用例变绿。
- 子代理一律不提交；由 review 方按文件路径精确 `git add`（工作区可能同时有其它会话的改动，绝不 `git add -A`）。
- 任务书里标注「可选」「取证后再定」的部分是有意留的口子：取证结论若与任务书的假设冲突，以代码为准并在汇报里说明。
