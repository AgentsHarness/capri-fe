你在 /Users/benin/ccwork/acp-fe（React 19 + TS + zustand + vitest + Tailwind，capri 的 Web 前端）里实现 `/view-plan`。参考实现是 Grok 的 Rust TUI，在 /Users/benin/ccwork/grok-build/crates/codegen/xai-grok-pager；Go host 在 /Users/benin/ccwork/acp-host（已确认 host **没有**任何 plan 相关端点，`/api/plan`、`/api/view-plan` 都不存在）。

## 任务

新增 `/view-plan` 命令：查看**当前会话已保存的 plan**，用弹窗呈现。

## 已确认的现状

1. TUI 有 `view-plan`，别名 `show-plan` / `plan-view`（`xai-grok-pager/src/slash/commands/view_plan.rs:11-18`），run 返回 `Action::ShowPlan`（同文件 `:31-33`），命令是 `session_scoped`（无会话时报错）。分发在 `app/dispatch/router.rs:1062`（`Action::ShowPlan => dispatch_show_plan(app)`）。
2. 一个关键交互细节：TUI 在已经处于 plan mode 时再执行 `/plan` 会提示「Already in plan mode. Use /view-plan to view the current plan.」（`app/dispatch/modes.rs:31,50`，测试 `dispatch/tests/modes.rs:262`）。也就是说 `/view-plan` 是**在 plan 模式里也要能用**的只读查看入口。
3. FE 现状：有 `/plan`（`src/commands/registry.ts:399-402` → `togglePlanMode()`），有 `src/components/PlanApproval.tsx`（这是 agent 主动请求批准计划时弹的卡，不是用户主动查看入口）；plan 数据 FE 本来就有——滚动区里有 `kind: 'plan'` 的条目（`src/api/types/scroll.ts:123`），并且 `src/store/chat/format.ts:104` 的 `planTodos(entries)` 已经把 plan 条目映射成 todo items + counts（注释说明 cancelled 不计入 total，与状态条徽标一致），`PlanEntry` 的渲染在 `src/components/scrollback/kinds/` 里。
4. FE 的弹窗已有一套现成模式可复用：`src/components/ContextModal.tsx`、`src/components/SessionInfoModal.tsx`（fixed inset-0 + `role="dialog"` + `aria-modal` + 点背景关闭 + Esc 关闭 + `panelRef.current?.focus()` + 打开时取数），store 侧是一组 `xxxOpen` / `openXxx` / `closeXxx`（见 `src/store/chat/store.ts:215-222` 与 `src/store/chat/types.ts`）。

## 要做的改动

**A. 取证 plan 的数据源。** 先确认 TUI 的 `ShowPlan` 到底渲染的是什么（读 `dispatch_show_plan` 及其视图），以及 FE 侧「当前 plan」的权威来源是哪一个：滚动区最后一条 `kind:'plan'` 条目、还是 store 里已有的 todo/counts 派生态（搜 `planTodos` 的调用方，看状态条徽标用的是哪份数据）。两边对齐后在汇报里写清结论。**不要**为了这个任务在 host 新增端点。
**B. 命令。** 注册 `/view-plan`，并带上 `aliases: ['show-plan', 'plan-view']` 对齐 TUI；无活动会话或当前没有 plan 时给出中文提示（用同文件的 `err()` / `note()` helper，风格对齐 `/rename`、`/delete` 那种「无活动会话」的写法）。顺带把 `/plan` 在「已进入 plan 模式」时的反馈改成提示用 `/view-plan`（对齐 A 步第 2 条的 TUI 行为）——只加提示文案，不改 `/plan` 的切换语义。
**C. 弹窗。** 新建 `src/components/PlanViewerModal.tsx`，复用 B/A 步确定的数据源渲染：计划标题（如果有）、todo 列表（状态图标复用 `src/components/scrollback/` 里已有的 todo 渲染，不要重画一套）、进度计数徽标（用 `planTodos` 的 counts，语义与状态条一致）。store 加 `planViewerOpen` / `openPlanViewer` / `closePlanViewer`，并在 `App.tsx` 挂载（参照现有 `<SessionInfoModal />` 的位置）。键盘：Esc 关闭；滚动可用。样式全部走现有 theme token class。
**D. 测试。** 新建 `src/components/PlanViewerModal.test.tsx`：无 plan 时的空态、有 plan 时渲染全部条目与计数、Esc 关闭；`registry.test.ts` 里加 `/view-plan` 置 `planViewerOpen` 的用例（注意该文件的 mock 风格——它是构造一个 fake store 对象来断言 action 被调用，照现有写法扩展，别改测试架构）。

> 提示：`git status` 里可能出现不属于本任务的改动（其它会话在同一工作区作业）。这是正常的——只按文件路径操作你自己的改动，不要回滚、不要顺手"修好"别人的部分。

## 约束

- 只改本任务相关文件（预期：`src/commands/registry.ts` 只加命令 + 必要的 `/plan` 提示、新增弹窗组件与其测试、`src/store/chat/types.ts` + store 里加三个成员、`App.tsx` 挂载）。**不要动** `ContextModal.tsx`、`SessionInfoModal.tsx`、`McpPanel.tsx`、`ApprovalStrip.tsx`、`PlanApproval.tsx` 的现有逻辑（能复用其纯函数就 import 复用，不改它）。
- 不要 `git add` / `git commit`。
- 验证全绿：`npx tsc -b`、`npx oxlint`、`npx vitest run`（基线全绿，不许变红、不许靠删用例变绿）。
- 最终用中文汇报：A 步取证结论（TUI 与 FE 各自的 plan 数据源、file:line）、改了/新增了哪些 file:line、`/plan` 提示最终文案、测试输出最后 5 行原文。
