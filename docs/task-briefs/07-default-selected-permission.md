你在 /Users/benin/ccwork/acp-fe（React 19 + TypeScript + zustand + vitest + Tailwind，capri 的 Web 前端）里实现一个缺失的设置项。这个项目要把 FE 对齐 Grok 的 Rust TUI，TUI 源码在 /Users/benin/ccwork/grok-build/crates/codegen/xai-grok-pager，agent 侧在 …/xai-grok-shell。

## 任务

补上 TUI 的 `[ui].default_selected_permission` 设置项，并让它真正生效——控制**审批弹窗里默认选中哪一行**。

## 已确认的现状

1. TUI 有这个设置，枚举定义在 `xai-grok-pager-render/src/appearance/permission_cursor.rs:40-63`，四个取值（canonical 字符串）：`always_allow_all_sessions`（未设置/无法识别时的等效默认）、`allow_once`、`allow_command_always`、`reject`。语义注释很关键：`allow_command_always` 预选的是**本次提示词范围内的** always-allow 行（per-command / per-tool / per-domain / per-edit-session），**绝不是**全局允许一切；全局那个是 `always_allow_all_sessions`。setter 与持久化在 `xai-grok-pager/src/app/dispatch/settings/setters.rs:782-842`，设置面板的分发在 `app/dispatch/settings/ui.rs:819-821, 1000-1007`。
2. **它是 pager 的客户端本地设置，不落 agent 配置**（持久化在 pager 自己的 `[ui]` 配置里，不经过 ACP）。所以 FE 这一项不应该走 `POST /api/settings`（host 白名单只有 4 个键，见 `acp-host/internal/acp/ui_settings.go:9-14`），而是 FE 自己持久化。
3. FE 现状：全库 grep `default_selected_permission` 零命中；审批条 `src/components/ApprovalStrip.tsx:49` 是 `const [sel, setSel] = useState(0)`，即永远预选第 0 个选项。选项来自 `req.params.options`（`ApprovalStrip.tsx:68`），并且文件里已经有识别「always 类选项」的工具函数（`isAlwaysOption`，用在 `:104-107`）和 `remember_tool_approvals` 的过滤逻辑（`:69` 附近注释）。FE 的本地持久化工具在 `src/lib/storage.ts`（`loadBool`/`saveBool`，`src/commands/registry.ts:9` 在用）和 FE prefs（`src/store/historyPins.ts` 的 `useFePrefs`，`SettingsModal.tsx` 里的 `FePrefsSection` 在用）。

## 要做的改动

**A. 取证。** 先读 `src/components/ApprovalStrip.tsx` 全文，弄清 `options` 的 wire 结构（每个 option 有哪些字段、kind/optionId 之类怎么区分 allow-once / always / reject，`deriveMcp` 与 `isAlwaysOption` 的判据是什么），以及 `sel` 这个游标在键盘交互（数字键、Tab、Enter）里怎么被消费。类型定义在 `src/api/types/`（搜 `Option`、`xaiRequests`）。把结论写进汇报。

**B. 存储。** 加一个 FE 本地设置项，值域就是 A 步映射得到的四个 canonical 字符串；默认 `always_allow_all_sessions`（对齐 TUI 的 fallback）。持久化用项目现成的机制（`src/lib/storage.ts` 那套 key 命名风格，参考 `MULTILINE_KEY = 'acpfe.multiline'`），**不要**走 `/api/settings`。

**C. 设置 UI。** 在 `SettingsModal.tsx` 的 `FePrefsSection`（FE 本地偏好区）里加一行四选一，风格对齐现有的胶囊行（`PERM_CHOICES` / `FOLLOW_UP_CHOICES` 那两块）。文案与提示用中文，必须把「这是审批弹窗里默认光标落在哪一行」讲清楚，避免和上面的 `permission_mode` 混淆（两者正交：permission_mode 决定会不会问，这一项决定问的时候默认选哪个）。如果 `FePrefsSection` 不合适放，就放到「本端行为」区并说明理由。

**D. 生效。** 新的审批请求到达时，`sel` 的初值不再恒为 0，而是按该设置解析出的目标选项在**当前这组 options 里**的下标：找不到对应选项时回落到 0（并保持现有行为不变）。多问题/多请求排队时（`st.pending[0]` 那个路径，`:250` 附近注释）要按每个请求自己的 options 重新解析，别把上一个请求的游标带过来。设置变更后已经在显示的审批不需要强制重排（下一条生效即可），但要在汇报里说明你选的语义。

**E. 测试。** 覆盖：默认（未设置）时游标落在 always-allow-all-sessions 对应行、没有该行时回落 0；设置成 `reject` / `allow_once` / `allow_command_always` 时游标落在对应行；`allow_command_always` 不会选中全局 always 行（这条最容易写错，务必单独断言）；设置项在 UI 里能改并被持久化。

> 提示：`git status` 里可能出现不属于本任务的改动（其它会话在同一工作区作业）。这是正常的——只按文件路径操作你自己的改动，不要回滚、不要顺手"修好"别人的部分。

## 约束

- 只改这个任务相关的文件（预期：`src/components/ApprovalStrip.tsx`、`src/components/SettingsModal.tsx`、`src/lib/storage.ts` 或新增一个小的 FE prefs 模块、以及对应测试文件）。**不要动** `src/components/ContextModal.tsx`、`SessionInfoModal.tsx`、`McpPanel.tsx`、`src/commands/registry.ts`、`src/store/chat/store.ts`。
- 不要 `git add` / `git commit`，改动留在工作区由我 review。
- 验证必须全绿：`npx tsc -b`、`npx oxlint`、`npx vitest run`（基线全绿，不许变红、不许靠删用例变绿）。
- 最终用中文汇报：A 步取证到的 option 结构与各 always 判据、改了哪些 file:line、游标解析的最终实现与回落规则、测试输出最后 5 行原文。
