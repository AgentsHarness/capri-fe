你在 /Users/benin/ccwork/acp-fe（React 19 + TS + zustand + vitest，capri 的 Web 前端）里把 `/remember`（顺带 `/dream`）从「拼中文 prompt」改成走真端点。参考实现：Rust TUI 在 /Users/benin/ccwork/grok-build/crates/codegen/xai-grok-pager，Go host 在 /Users/benin/ccwork/acp-host。

## 问题

FE 的 `/remember <笔记>` 现在只是拼一句中文发给 agent（`src/commands/registry.ts:555-565`，`sendPrompt('请记住：${note}（写入记忆）')`），`/dream` 同样走 prompt 路径并且注释已经过期（`:546-552` 写着「FE 目前无法有意义地调用 memory-rewrite」）。实际上真通道早就建好了、只是没人用：

- host：`POST /api/memory-rewrite`（路由 `acp-host/internal/server/http.go:112`，handler `:1566+`，注释写明 `rawText` 必填）→ `bridge.MemoryRewrite`（`internal/acp/bridge.go:4157-4170`，`x.ai/memory/rewrite`，参数 `{sessionId, rawText, contextSummary}`）。另有 `POST /api/memory-flush`（`http.go:111`）对应 `bridge.MemoryFlush`。
- FE：`transport.memoryRewrite(sessionId, rawText, contextSummary?)` 已实现（`src/api/rpc/tools.ts:218-231`）但**零调用方**；`transport.memoryFlush` 已经在用（`/flush` 命令 → `memoryFlush`）。

## TUI 的对照行为（要对齐的目标）

`/remember` 无参数 → `Action::EnterRememberMode`（`xai-grok-pager/src/slash/commands/remember.rs:32-38`）；有参数 → `Action::SendRememberNote(text)`。真实写入路径在 `app/dispatch/notes.rs:462-505+` 的 `send_remember_note`：注释写明「Send a raw remember note for LLM-powered rewriting via `x.ai/memory/rewrite`」，有会话时走 rewrite 并弹一个 **`RememberNoteReview` 审阅弹窗**（结构含 `raw_content` / `enhanced_content` / `showing_enhanced`，Tab 在原文与改写稿之间切换）让用户**确认后才落盘**；无会话时退化为「只有原文、无改写、Tab 禁用」的审阅弹窗。另外 composer 里还有 `#` 前缀的 remember 快捷输入模式（TUI 侧，`# 笔记` 等价于 `/remember`）。FE 完全没有这条链。

## 要做的改动

**A. 取证。** 读 TUI `notes.rs` 的 `send_remember_note` 全流程 + `RememberNoteReview` 弹窗（搜 `RememberNoteReview`，看它有哪些操作：确认保存走哪个 action、取消、Tab 切换、以及最终写入是调 memory 工具还是又一个 ext 方法）。同时读 host `handleMemoryRewrite` 的响应形状（它把 agent 的什么返回给前端）与 agent 侧 `x.ai/memory/rewrite` 的实现（在 `xai-grok-shell` 里搜 `memory/rewrite`），确认「改写结果」是不是就在这次响应里回来、以及**保存动作**是否有独立端点。把结论写进汇报——这决定 C 的形态。
**B. `/remember` 走真端点。** 有参数时：调 `transport.memoryRewrite(当前会话 id, 笔记原文)`（注意 `sessionId` 必须是显式的当前会话，别依赖 host 的活动会话回落）。无参数时的语义按 A 步结论定：能进「输入即笔记」的轻量模式就做（复用 composer 现有输入态），做不动就明确报用法错误，**不要**保留现在这种「无参数才报错、有参数发中文指令」的半吊子。
**C. 确认弹窗。** 参照 TUI 做 FE 版审阅弹窗：展示原文与改写稿（有改写时默认显示改写稿，可切换），确认后写入、取消则不落盘。如果 A 步发现 `memory/rewrite` 本身就是「改写 + 落盘」一步到位、没有独立的确认/保存端点，那么**不要**造一个假的二次确认，改为：直接调用 + 把结果作为一条本地滚动区反馈（`appendLocalEntry`）呈现，并在汇报里说明为什么省掉了确认环节。新建 `src/components/RememberReviewModal.tsx`（或你判断更合适的名字）+ 测试。
**D. `#` 前缀（可选）。** 只有在 composer 现有扩展点里改动很小才做（看 `src/components/composer/` 那几个 hook，尤其 `useAtPicker.ts` / `useSlashMenu.ts` 的模式）；否则别做，汇报里写清接入点和成本。
**E. `/dream` 与过期注释。** 按 A 步取证决定 `/dream` 是否也能走真端点（`xai-grok-shell` 里搜 consolidation / dream 的 ext 方法或工具名）；能走就走，不能走就保持 prompt 路径。无论哪种，都要把 `registry.ts:546-552` 和 `:528-540`（`/memory on|off` 那段注释）里已经**与事实不符**的注释改成正确的当前状态描述——注释不能继续宣称能力不存在。
**F. 测试。** 覆盖：有参数时确实调 `memoryRewrite` 且带当前 sessionId、失败时错误可见、确认/取消路径（若 C 保留了确认）、无参数时的行为；`registry.test.ts` 的 fake store 风格保持不变。

> 提示：`git status` 里可能出现不属于本任务的改动（其它会话在同一工作区作业）。这是正常的——只按文件路径操作你自己的改动，不要回滚、不要顺手"修好"别人的部分。

## 约束

- 只改本任务相关文件（`src/commands/registry.ts` 的 memory 段、新弹窗组件与测试、必要时 `src/store/chat/` 里新增一个 action）。**不要动** `ContextModal.tsx`、`SessionInfoModal.tsx`、`McpPanel.tsx`、`ApprovalStrip.tsx`、`MemoryModal.tsx` 的现有逻辑（需要它的纯函数就 import）。
- 不要 `git add` / `git commit`。
- 验证全绿：`npx tsc -b`、`npx oxlint`、`npx vitest run`（基线全绿，不许变红、不许靠删用例变绿）。
- 最终用中文汇报：A 步取证（rewrite 是否含落盘、确认端点存在与否、各带 file:line）、B/C/D/E 各自的最终决定与依据、改了/新增了哪些 file:line、测试输出最后 5 行原文。
