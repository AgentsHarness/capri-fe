你在 /Users/benin/ccwork/acp-fe（React 19 + TS + zustand + vitest，capri 的 Web 前端）里修正 `/loop` 的实现方式。参考实现是 Grok 的 Rust TUI（/Users/benin/ccwork/grok-build/crates/codegen/xai-grok-pager）与 agent 侧（…/xai-grok-shell）。

## 问题

FE 的 `/loop` 现在是自己拼一句中文自然语言指令让 agent 去调 `scheduler_create`（`src/commands/registry.ts:368-398`）。但 shell 本身就实现了 `/loop`：`PROMPT_COMMANDS`（`xai-grok-shell/src/session/slash_commands.rs:388-396`，`gate: BuiltinGate::Scheduler`，`argument_hint: "[interval] <prompt>"`，`ModelAuthoredEligibility::Denied`），服务端会在收到以 `/loop` 开头的 prompt 时**直接执行内建命令**（`session/acp_session_impl/slash_exec.rs:5` 的 `execute_builtin_slash_command`，调用点在 `session/acp_session_impl/turn.rs:431`），并且它会随 `available_commands_update` 广播（gate 通过时）。

而 FE 的命令合并规则是「本地命令永远赢」：`mergedSlashCommands()` 会跳过与本地命令同名的 agent 广播命令（`src/commands/registry.ts:620-633`）。所以 agent 那个功能完整的 `/loop` 被 FE 自造的那句中文永久遮蔽了——agent 收到的不是 `/loop 5m …` 原文，而是一句自由发挥的指令。

## 已确认的对照信息

1. TUI 侧 `/loop` 的完整实现在 `xai-grok-pager/src/slash/commands/loop_cmd.rs`：它 import 了 shell/tools 侧的 `SCHEDULER_CREATE_TOOL_NAME`、`loop_schedule_instruction`、`loop_usage_message`、`LoopFireMode`（`xai_grok_tools::implementations::grok_build`），有 `required_tools = [SCHEDULER_CREATE_TOOL_NAME]`；参数解析 `parse_loop_args`（`:20-30`）只把**形如 `^\d+[smhd]$` 且数字非 0** 的首 token 当 interval（`is_interval_token`，`:33-41`），否则整串都算 prompt 交给模型推导；还有 `interval_to_human`（`:44+`）产出人类可读文案，以及 `ScheduledTaskPreview` 这个即时预览结构。
2. TUI 的 required_tools 门控依赖 agent 广播的 `AvailableCommandsUpdate.meta.tools`（`xai-grok-shell/src/session/slash_commands.rs:465-481` 的 `build_tools_meta`，注释写明 pager 会 drain 它并用 `CommandRegistry::set_available_tools` 门控 `/loop` 这类依赖工具的命令）。FE 目前**没有**这套门控（`SlashCommand` 类型没有 `required_tools` 字段）。
3. FE 已有的相关能力：调度任务的展示与删除是真的（`transport.schedulerDelete` → `store/chat/actions/xai.ts:283`，host `POST /api/scheduler-delete`，`src/api/rpc/sessions.ts:430-438`；状态区 `StatusChips.tsx:898` 有删除入口；`store/chat/events/tools.ts:112` 注释说明 scheduler/goal/workflow 不会变成工具行）。运行中队列 `usePromptQueue`（`src/store/promptQueue.ts`）与 `/loop` 的 busy 分支在 registry 里是手写的。

## 要做的改动

**A. 取证。** 读 TUI `loop_cmd.rs` 全文 + shell 的 `/loop` resolve/执行路径，弄清 agent 侧真执行 `/loop` 时收到的**确切输入格式**（是原样 `/loop <args>` 文本进 prompt 通道？还是要求别的形状？fire mode 怎么指定？无 scheduler 工具时 agent 会回什么）。把结论写进汇报，并据此决定 B 的做法。
**B. 不再自造指令。** 把 FE 的 `/loop` 改成发送 `/loop <args>` **原文**（与 agent 广播命令的 pass-through 路径完全一致——复用 `mergedSlashCommands` 里 agent 命令那个 `run` 的实现方式，busy 时走队列），删除拼中文指令那段。若 A 步取证表明原文透传在 host/agent 上走不通（例如 host 的 prompt 通道会吞掉 slash 前缀、或 agent 不解析客户端发来的 `/loop`），就保留 prompt 路径但改用 `loop_schedule_instruction` 的等价文案，并在汇报里给出走不通的证据。**不要两头下注，选一种并说明依据。**
**C. 参数校验与反馈对齐 TUI。** 用 TUI 的规则做 interval 校验（`^\d+[smhd]$` 且非 0；不匹配首 token 时不要把整串当错误，而是像 TUI 一样交给 agent 自己判断）；给出人类可读的回执（`interval_to_human` 的中文化，例如「每 5 分钟 · <prompt>」），用 `note()` 或 `statusText`（选更贴合现有命令风格的一种并说明）。`/loop` 无参数时用 `loop_usage_message` 的等价中文用法提示（现在的实现已有类似文案，保持风格统一即可）。
**D. 门控（可选，别勉强）。** 如果实现 `required_tools` 门控的改动很小（消费 `commands_update` 里已解析的 `_meta`，见 `src/store/chat/events/extMisc.ts:373-400`，给 `SlashCommand` 加个可选字段，菜单里对不可用命令给出原因），就做；如果牵扯面比你预估的大，就**不要做**，改为在汇报里写清 `meta.tools` 现在被解析成了什么、丢在哪里、以后加门控要动哪几处。

> 提示：`git status` 里可能出现不属于本任务的改动（其它会话在同一工作区作业）。这是正常的——只按文件路径操作你自己的改动，不要回滚、不要顺手"修好"别人的部分。

## 约束

- 只改本任务相关文件（预期集中在 `src/commands/registry.ts` 的 `/loop` 条目 + 它的测试 `src/commands/registry.test.ts`）。**不要动** `ContextModal.tsx`、`SessionInfoModal.tsx`、`McpPanel.tsx`、`ApprovalStrip.tsx`、`store/chat/store.ts`。如果 D 步要做，允许动 `src/store/chat/events/extMisc.ts` 与 `SlashCommand` 类型。
- 不要 `git add` / `git commit`。
- 验证全绿：`npx tsc -b`、`npx oxlint`、`npx vitest run`（基线全绿，不许变红、不许靠删用例变绿）。
- 最终用中文汇报：A 步取证结论（含 agent 侧确切输入格式与门控条件的 file:line）、B 步最终选了哪条路径及依据、改了哪些 file:line、D 步做没做及原因、测试输出最后 5 行原文。
