你在 /Users/benin/ccwork/acp-fe（React 19 + TS + zustand + vitest，capri 的 Web 前端）里把 workflow 相关的斜杠命令**对齐 TUI 语义**。参考实现在 /Users/benin/ccwork/grok-build/crates/codegen/xai-grok-pager（TUI）与 …/xai-grok-shell（agent），Go host 在 /Users/benin/ccwork/acp-host。

## 核心问题：FE 现在把单复数的语义搞反了

TUI 里这是两个不同的命令：

- **`/workflows`（复数）= 浏览已安装的 workflow 目录**：`xai-grok-pager/src/slash/commands/workflows.rs`，run 返回 `Action::OpenExtensionsModal { tab: ExtensionsTab::Workflows, trigger: SlashCommand }`，description 是 "Browse installed workflows"。
- **`/workflow`（单数）= 真正的操作命令**：`xai-grok-pager/src/slash/commands/workflow.rs`。文件头注释写得很清楚：它注册为 builtin 是为了**遮蔽** agent 广播的 `/workflow`（`apply_acp_commands` 会丢弃同名项），于是精确的 `runs` 形式可以打开 TUI 的运行面板，而**其它所有形式原样透传给 shell 不变**（launch、manage ops、裸调用的文本概览）。它还实现了参数建议：先列 agent 广播的 workflow 名（来自 ACP catalog），再列 manage ops；选中 launch 名只填充 `/workflow <name> ` 而不启动；选中 pause/resume/stop/save 会列出本会话的 run handle，避免裸动词误选 run。文件里能看到 `WORKFLOW_OPS`、`is_manage_op`（`pause|resume|stop|save`）、`LaunchFlag::{AgentBudget, Effort}`、`LaunchValueProvider::{Opaque, ReasoningEffort}`。

FE 现状只有一个 `/workflows`，打开的是**运行面板**（`src/commands/registry.ts:514-518` → `setWorkflowPanelOpen(true)`，面板是 `src/components/WorkflowPanel.tsx`，两级 list/detail + phase rail + agent roster + `p/r/x/s` 快捷键，其文件头注释已经写明控制走 prompt 路径是因为 ACP 没有 workflow 控制方法）。也就是说 FE 的 `/workflows` 实际对应 TUI 的 `/workflow runs`，而目录浏览这一层 FE 完全没有。

## 已确认的可用能力

1. shell 侧确实有 `workflow` builtin（`xai-grok-shell/src/session/slash_commands.rs:296`，gate 相关见同文件 `BuiltinGate::WorkflowLaunches` / `WorkflowManagement` / `WorkflowProjection::ExactName` 那段），并且会在 gate 通过时随 `available_commands_update` 广播；FE 对广播命令的 pass-through 通道已存在（`src/commands/registry.ts:634-645`，把 `/name args` 原文当 prompt 发）。
2. `transport.workflowsList({sessionId})` 已实现（`src/api/rpc/tools.ts:403-405` → host `POST /api/workflows/list` → `x.ai/workflows/list`，`acp-host/internal/server/http_ext_ecosystem.go:171`）但**零调用方**——目录浏览正好缺的就是这个数据源。host 另有 `POST /api/commands/list`（同文件 `:181`）。
3. FE 的扩展面板 `src/components/ExtensionsModal.tsx` 有 4 个 tab（`ExtensionsTab = 'hooks' | 'plugins' | 'skills' | 'marketplace'`，定义在 `src/store/chat/typesPublic.ts:27`；tab 列表在 `ExtensionsModal.tsx:14` 的 `TABS`，分发在 `:352-356`），store 侧 `openExtensions(tab)`（`src/store/chat/types.ts:666-667`，registry 里 `openExtensionsCmd` 在用）。
4. `src/commands/skills.ts` 里有 `cachedSkills()` 这种「缓存一份 agent 侧目录给命令菜单用」的先例，可以参考它的缓存/刷新方式来实现 workflow 目录缓存。

## 要做的改动

**A. 取证。** 完整读 TUI `slash/commands/workflow.rs`（含它所有 phase 的参数建议逻辑、`WORKFLOW_OPS` 常量内容、launch flag 的解析与取值来源），并读 `xai-grok-shell` 里 workflow builtin 的 resolve/执行处，确认 shell 接受的**确切语法**（`/workflow <name> [args] [--agent-budget N] [--effort X]`？`pause <run>`？`runs` 是不是也进 shell？）。同时实测一下 host 的 `POST /api/workflows/list` 返回结构（从 `http_ext_ecosystem.go` 的 handler 往回读，别猜字段名）。结论写进汇报，作为 B/C 的依据。
**B. `/workflow`（单数）。** 在 FE 注册这个命令，行为对齐：`runs` → 打开现有运行面板（`setWorkflowPanelOpen(true)`）；manage ops（`pause` / `resume` / `stop` / `save`）→ 复用 store 里已有的 `workflowControl` / 保存脚本能力（`src/store/chat/actions/goal.ts:75-80` 附近与 `WorkflowPanel.tsx:73-74` 用的那两个 action），并在缺少 run handle 时给出中文提示而不是猜一个；其它形式（launch 与裸调用）→ **原样透传** `/workflow <args>` 给 agent（复用 agent 命令那条 pass-through 路径，busy 时进队列）。无参数时的表现按 A 步取证的 shell 语义决定（透传裸 `/workflow` 让 agent 给概览，或 FE 自己用目录数据给概览），选一种并说明依据。
**C. `/workflows`（复数）改成语义正确的那个。** 打开扩展面板的**新增 `workflows` tab**，内容是 workflow 目录浏览（数据源 `transport.workflowsList`，走 `openExtensions('workflows')`，`ExtensionsTab` 联合类型与 `TABS`、tab 分发处都要加）。为兼容现有使用习惯，`/workflows` 保留一个「同时/改天打开面板」的入口是**不必要**的——直接改语义，但要把运行面板的入口保住：确认 `/workflow runs` 可用，并检查现有指向面板的按钮/快捷键（grep `setWorkflowPanelOpen`）不因此失效。目录 tab 的行内容按 A 步实测的字段来（name / description / source / path 之类），要有空态与请求失败态，风格对齐同面板其它 tab。
**D. 命令菜单（可选）。** 如果 FE 斜杠菜单有低成本的方式给 `/workflow` 提供第二参数建议（看 `src/components/composer/useSlashMenu.ts` 与 `SlashMenu.tsx` 现在的结构，以及 `cachedSkills()` 那类缓存），就做；否则不做，汇报里写清接入点。
**E. 测试。** registry 层：`/workflow runs` 打开面板、`/workflow pause <id>` 走 control、`/workflow deep-research foo` 原样透传（断言发出的文本）、`/workflows` 打开的是 extensions 的 workflows tab；组件层：extensions 面板 workflows tab 的加载/空/错误三态。

> 提示：`git status` 里可能出现不属于本任务的改动（其它会话在同一工作区作业）。这是正常的——只按文件路径操作你自己的改动，不要回滚、不要顺手"修好"别人的部分。

## 约束

- 只改本任务相关文件。**不要动** `ContextModal.tsx`、`SessionInfoModal.tsx`、`McpPanel.tsx`、`ApprovalStrip.tsx`、`WorkflowPanel.tsx` 的内部逻辑（挂载点/入口可以动）。`registry.ts` 只加/改 workflow 相关条目。
- 不要 `git add` / `git commit`。
- 验证全绿：`npx tsc -b`、`npx oxlint`、`npx vitest run`（基线全绿，不许变红、不许靠删用例变绿）。
- 最终用中文汇报：A 步取证到的确切语法与 list 返回结构（各带 file:line）、B/C 每条的最终实现与依据、运行面板入口最终有哪几个、改了/新增了哪些 file:line、测试输出最后 5 行原文。
