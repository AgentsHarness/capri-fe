你在两个本地仓库里实现一个缺失能力：capri Web 前端 `/Users/benin/ccwork/acp-fe`（React 19 + TS + zustand + vitest）和 Go host `/Users/benin/ccwork/acp-host`。参考实现：Rust TUI 在 `/Users/benin/ccwork/grok-build/crates/codegen/xai-grok-pager`，agent 侧在 `…/xai-grok-shell`、`…/xai-grok-agent`、`…/xai-grok-config-types`。

## 任务

对齐 TUI 的 ask_user_question 超时能力：让 FE 能配置 `[toolset.ask_user_question].timeout_enabled` / `timeout_secs`，并在提问卡片上如实呈现超时行为。

## 已确认的现状

1. TUI 侧这是真设置：remote settings 键 `ask_user_question_timeout_enabled: Option<bool>` / `ask_user_question_timeout_secs: Option<u64>`（`xai-grok-config-types/src/lib.rs:811-819`，注释写明对应 `[toolset.ask_user_question] timeout_enabled` / `timeout_secs`）；pager 有 `Action::SetAskUserQuestionTimeoutEnabled`，注释「Toggles the ask_user_question timeout. SHELL-owned; persisted to `[toolset.ask_user_question].timeout_enabled`. Applies to new sessions.」（`xai-grok-pager/src/app/actions.rs:496-497`，分发在 `app/dispatch/router.rs:1089-1091`、setter 在 `app/dispatch/settings/setters.rs:369` 附近）；pager 侧还有个镜像字段 `app_view.rs:1207-1210` 从 config 播种。超时策略本身是注入进工具的（`xai-grok-agent/src/builder.rs:617` 注释「(timeout policy) into the ask_user_question tool」）。
2. FE 侧完全没有：`src/components/QuestionModal.tsx`（483 行）里 grep `timeout` / 倒计时 / setTimeout 全零命中——它渲染 `x.ai/ask_user_question` 的卡片（Tab / j-k / 1-9 / Enter / Space / Esc 一套键盘交互，文件头注释有说明），四种应答 outcome 是 `accepted` / `chat_about_this` / `skip_interview` / `cancelled`。
3. host 侧看不见这个 section：`GET /api/settings` 只返回 config.toml 的**安全子集 `{ui, session, models, cli}` 的标量值**（`acp-host/internal/server/http.go:1737-1743` 与 `settingsPayload`），`[toolset]` 不在里面；`POST /api/settings` 的白名单只有 4 个键（`internal/acp/ui_settings.go:9-14` + `http.go:1745-1776` 的固定 struct），而且未知键是**静默丢弃**（不报错）。
4. 超时判定发生在 agent 侧，所以「到点自动怎么应答」不是 FE 的责任；FE 的责任是：能配置、并且不要把没有依据的倒计时画给用户看。

## 要做的改动

**A. 先取证，这决定后面怎么做。** 三件事必须查清并写进汇报：
   1. agent 发给客户端的 `x.ai/ask_user_question` 请求参数里**到底有没有** deadline / timeout / 剩余时间字段。查 `xai-grok-shell` 里构造这个 ext request 的地方（搜 `ask_user_question`、`AskUserQuestion`、timeout），以及超时到点后 agent 怎么收尾（自动选默认项？回 `cancelled`？直接继续？）——把 file:line 和结论写清楚。
   2. `[toolset.ask_user_question]` 这两个键的**真实 TOML 位置与类型**（`timeout_secs` 的范围/默认值，是否有 clamp），从 config 解析代码里读出来，不要猜。
   3. host 现在有没有任何地方读 `[toolset]`（`acp-host` 里 grep `toolset`）。
**B. host 暴露读写。** `settingsPayload` 增加 `toolset` 段（只放这两个键，标量，不要整段 dump——保持它「安全子集」的原语义，并在注释里说明为什么只挑这两个）；`POST /api/settings` 支持写这两个键（沿用现有白名单双层校验风格：struct 字段 + `writable*Keys` 校验函数，bool 用现成的 `requireBool`，secs 要新增一个范围校验函数，非法值返回中文错误）。补 Go 用例：能写进 config.toml 的 `[toolset.ask_user_question]` 且 GET 能读回；非法 secs（负数/0/超界/字符串）被拒。
**C. FE 设置项。** `SettingsPatch` / `SettingsPayload` 类型（`src/api/transport.ts`、`src/api/types/settings.ts`）加这两个键；在 `SettingsModal.tsx` 里加一行开关 + 一个秒数输入（复用现有控件风格，别造新样式），提示文案要如实说明「只影响新会话」（对齐 TUI 的 Applies to new sessions）。
**D. FE 提问卡片。** 按 A 步的取证结果做**诚实呈现**：如果请求参数里带了 deadline，就在卡片上显示剩余时间并在到点后按 agent 的收尾语义处理；如果没带，就**不要**造一个假倒计时，只在卡片上显示「本会话提问超时 N 秒后自动放弃」这类基于配置的静态提示（且只有 `timeout_enabled` 为真时显示），并在汇报里说明为什么这样选。错误/超时路径不能把卡片卡死。
**E. 测试。** FE：设置项读写用例；QuestionModal 在「有 deadline」和「只有静态配置」两种输入下的渲染断言（含 timeout 关闭时不显示提示）。host：上面 B 的用例。

> 提示：`git status` 里可能出现不属于本任务的改动（其它会话在同一工作区作业）。这是正常的——只按文件路径操作你自己的改动，不要回滚、不要顺手"修好"别人的部分。

## 约束

- 只改本任务相关文件。**不要动** `src/components/ContextModal.tsx`、`SessionInfoModal.tsx`、`McpPanel.tsx`、`ApprovalStrip.tsx`、`src/commands/registry.ts`（别的任务在改）。host 侧落在 `internal/server/http.go`、`internal/acp/ui_settings.go` 及测试。
- 如果 A 步取证表明 agent 侧根本没有超时实现（只有配置读取但没有实际 timeout 行为），**停下来不要硬编**，直接汇报取证结论并给出建议（FE 只暴露配置，或这项应该等 agent 实现），这比造一个假功能更有价值。
- 不要 `git add` / `git commit`。
- 验证全绿：host `go build ./...` + `go test ./internal/...`；FE `npx tsc -b` + `npx oxlint` + `npx vitest run`（基线全绿，不许变红、不许靠删用例变绿）。
- 最终用中文汇报：A 步三条取证结论（各带 file:line）、两仓库改了哪些 file:line、D 步最终选了哪种呈现及理由、两侧测试输出最后 5 行原文。
