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

## 待办

| 编号 | 任务 | 卡在哪 | 动的仓库 |
|---|---|---|---|
| [04](04-home-worktree.md) | home 支持新建 worktree | 12 个 `gitWorktree*` 只有 1 个有调用方；入口要按「选了目录 + 是 git 仓库」门控 | FE |
| [05](05-btw.md) | `/btw` 旁路提问 | agent / host / `transport.btw` 三层全通，只差 FE 命令与区块；host 还漏传 sessionId | FE + host |
| [06](06-follow-up-behavior.md) | `follow_up_behavior` 设置无效 | host 写入通道静默丢弃未知键 | host + FE |
| [07](07-default-selected-permission.md) | `default_selected_permission` 缺失 | TUI 有该设置（审批弹窗默认光标），FE 游标恒为第 0 项 | FE |
| [08](08-question-timeout.md) | ask question timeout 缺失 | `[toolset.ask_user_question]` 既不在 host 的 settings 安全子集也不在写白名单 | FE + host |
| [09](09-view-plan.md) | `/view-plan` | 有 `/plan` 与审批卡，缺「查看当前 plan」入口 | FE |
| [10](10-loop.md) | `/loop` 被本地实现降级 | FE 本地命令遮蔽了 shell 广播的真 `/loop`，且缺 interval 校验与预览 | FE |
| [11](11-remember.md) | `/remember` / `/dream` | 真端点 `memoryRewrite` + host `/api/memory-rewrite` 都在，零调用方 | FE |
| [12](12-export.md) | `/export` | 无导出能力；历史分页加载导致 transcript 完整性需要显式取舍 | FE |
| [13](13-workflow-s.md) | `/workflow` 与 `/workflows` 语义反了 | FE 的复数对应 TUI 的单数 `runs`；缺目录 tab 与单数命令 | FE |
| [14](14-imagine.md) | `/imagine` / `/imagine-video` | agent 不广播该命令（名字被 pager 烧掉），FE 必须本地复刻 instruction | FE |

## 派工时的统一约束

- 一次只做一个任务，前一个验收通过再放下一个（任务之间有文件重叠，尤其 `src/commands/registry.ts` 与 `SettingsModal.tsx`）。
- 执行方的验证门槛写在各任务书里：FE 是 `npx tsc -b` + `npx oxlint` + `npx vitest run`（当前基线 100 files / 1035 tests 全绿），host 是 `go build ./...` + `go test ./internal/...`。不许变红、不许靠删用例变绿。
- 子代理一律不提交；由 review 方按文件路径精确 `git add`（工作区可能同时有其它会话的改动，绝不 `git add -A`）。
- 任务书里标注「可选」「取证后再定」的部分是有意留的口子：取证结论若与任务书的假设冲突，以代码为准并在汇报里说明。
