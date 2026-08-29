你在两个本地仓库里完成一个跨端功能任务：capri Web 前端 `/Users/benin/ccwork/acp-fe`（React 19 + TypeScript + zustand + vitest + Tailwind）和它的 Go host `/Users/benin/ccwork/acp-host`。这个项目是把 Web FE 对齐 Grok 的 Rust TUI，TUI 参考源码在 `/Users/benin/ccwork/grok-build/crates/codegen/xai-grok-pager`，agent 侧在 `/Users/benin/ccwork/grok-build/crates/codegen/xai-grok-shell`。

## 任务

实现 `/btw`：在**不打断当前回合**的前提下问一个旁路问题，答案以独立区块出现在滚动区里。三层链路里 agent 和 host 早就通了，只有 FE 没接，另外 host 有个小缺陷要顺手修掉。

## 已确认的现状（可直接采信，动手前自己核对行号）

1. **agent 侧已实现**：`x.ai/btw` → `xai-grok-shell/src/agent/mvp_agent/acp_agent.rs:2283` 路由到 `crate::extensions::feedback::handle`，处理函数 `handle_btw` 在 `xai-grok-shell/src/extensions/feedback.rs:41-79`。请求参数 `{ sessionId: string（必填非空）, question: string }`（camelCase）；走 `SessionCommand::SideQuestion` 但**不占用 prompt 队列**；成功响应是 `{"answer": "<markdown 文本>"}`；找不到会话返回 invalid_params（`session not found: <id>`），采样失败映射成 sampling error。
2. **host 侧已有端点**：`POST /api/btw`（路由 `acp-host/internal/server/http_ext_session.go:471`，handler 同文件 `:133-145`）。**缺陷**：handler 的 body struct 只声明了 `Question`，转发时 `sessionId` 硬编成空串（`s.xaiCall(w, r, "x.ai/btw", map[string]any{"sessionId": "", ...})`）。空串会被 `Bridge.XaiCall`（`acp-host/internal/acp/bridge.go:3784-3801`）填成 **host 的活动会话**，所以浏览器正在看别的会话（多标签页、恢复的历史会话）时，问题会打到错误的会话上。
3. **FE 侧差最后一段**：`transport.btw` 已经写好（`src/api/rpc/assist.ts:6-8`，`{question}` → `POST /api/btw`）但**零调用方**；`src/commands/registry.ts` 里没有 `/btw` 命令；滚动区也没有 btw 这个区块类型。
4. TUI 的呈现方式可以做参照：`xai-grok-pager/src/scrollback/blocks/btw.rs` 是一个带金色 accent 的区块，折叠态只显示 `/btw <问题>` 一行，展开显示完整 markdown 答案；响应的错误态会一直停留到用户按 Esc（`app/dispatch/notes.rs:851-884`）。
5. FE 的滚动区扩展成本很低：区块 kind 联合类型在 `src/api/types/scroll.ts`（现有 14 个 kind，如 `session_event`、`credit_limit`、`workflow`），分发是一个 if 链（`src/components/scrollback/EntryView.tsx:171-184`），具体视图在 `src/components/scrollback/kinds/`（`MiscEntries.tsx` 里放了若干小区块）。markdown 渲染已有现成组件 `src/components/Markdown.tsx`。本地注入条目用 `useChatStore.getState().appendLocalEntry(...)`（`src/store/chat/store.ts`，注释写明它只进滚动区、永远不会发给 agent）。

## 要做的改动

**A. host（`/Users/benin/ccwork/acp-host`，改动要极小）。** 给 `handleBtw` 的 body struct 加 `SessionID string \`json:"sessionId"\``，转发时用它替换硬编的空串（空串仍然允许，保持向后兼容——沿用 `sessionKey(acp.WireSessionID, body.SessionID)` 这个既有约定，参考同文件其它 handler 与 `http_ext.go:62-70` 的注释）。给 host 的 Go 测试补一个用例：显式带 sessionId 时透传该值、不带时仍然落到活动会话（先看 `internal/server/` 里现有 ext handler 测试怎么写、用什么 fake，照抄那套结构，别自造测试框架）。

**B. FE transport。** `transport.btw` 增加可选 `sessionId` 参数并透传给 `/api/btw`（`src/api/rpc/assist.ts`），类型上保持向后兼容。

**C. FE 命令。** 在 `src/commands/registry.ts` 注册 `/btw`：`argHint: '<question>'`，无参数时报用法错误（用同文件的 `err()` helper，中文文案风格对齐现有命令，比如 `/loop` 的写法）。要点：
   - **busy（回合进行中）时必须照常发出去**，这是 `/btw` 的全部意义——不要走 `sendPrompt` 的排队分支，不要进 prompt 队列。
   - 调用时显式带上 `useChatStore.getState().sessionId`；没有活动会话时报错而不是发请求。
   - 请求进行中要有可见的等待反馈（本项目现有两种：`statusText` 状态行，或滚动区里一条进行中的条目——注意 btw 是异步回来的，可能晚于用户切走会话，参照 `/recap` 的 `recapPendingFor` 按会话绑定的做法，别让它跨会话残留）。
   - 失败时把错误显示出来（`err()` 路径），不要静默。

**D. FE 区块。** 新增一个 `btw` kind 的滚动区块（不要退化成两条纯文本 status），对齐 TUI 的呈现：头部一行 `/btw <问题>`，下面是 markdown 渲染的答案，默认折叠、可展开（折叠/展开的现有交互参照 `src/scrollback/toolDetail.ts`、`useLoadChrome.ts` 之类已有实现，复用而不是新造），错误态要能在区块里直接看到。颜色沿用 theme token，不引入新的颜色字面量。注意 `/copy` 命令会取「最近一条 assistant」，btw 答案不该被它抄走（所以确实不该复用 assistant kind）。

**E. 测试。** FE：`src/commands/registry.test.ts`（或新文件）覆盖无参数报错、有参数会调 `transport.btw` 且带上当前 sessionId、busy 状态下不进队列；btw 区块的渲染测试（折叠只显示问题、展开显示答案、错误态可见）。host：上面 A 说的 Go 用例。

> 提示：`git status` 里可能出现不属于本任务的改动（其它会话在同一工作区作业）。这是正常的——只按文件路径操作你自己的改动，不要回滚、不要顺手"修好"别人的部分。

## 约束

- 严格按 A→B→C→D→E 做，只碰本任务相关文件；不要顺手重构 registry 或滚动区里别的东西。
- **不要动这些文件**（别的任务正在改或刚改完）：`src/components/ContextModal.tsx`、`src/components/SessionInfoModal.tsx`、`src/components/McpPanel.tsx`、`src/store/chat/store.ts` 里与 session-info 相关的部分。registry.ts 你要改，但只加 `/btw` 命令和必要的 import，不要重排现有条目。
- 不要 `git add`、不要 `git commit`，两个仓库的改动都留在工作区，由我 review 和提交。
- 验证必须全部通过：FE 侧 `npx tsc -b`、`npx oxlint`、`npx vitest run`（基线全绿，不许变红，不许靠删用例变绿）；host 侧在 `/Users/benin/ccwork/acp-host` 跑 `go build ./...` 和 `go test ./internal/...`。
- 最后用中文汇报：两个仓库各自改了哪些文件（file:line）、btw 区块的折叠/展开交互最终怎么做的、等待反馈用的是哪种机制、FE 与 host 的测试结果最后 5 行原文。
