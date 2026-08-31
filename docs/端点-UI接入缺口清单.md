# 端点 → UI 接入缺口清单

排查时间：2026-08-31。范围：`capri-fe`（本仓）、`capri-host`（后端 HTTP 端点，`../acp-host`）、`capri-hub`（`../acp-hub`）、`Grok TUI` 参考实现（`../grok-build/crates/codegen`）。

## 1. 结论速览

| 口径 | 数量 |
| --- | --- |
| capri-host 注册的 HTTP 端点（去重） | 202 |
| FE `src/api/rpc/*.ts` 声明的 RPC 方法 | 144 |
| FE 代码里有真实调用链的 host 端点 | 147 |
| **A 类：host 有端点，FE 连 api 层都没声明** | **55** |
| **B 类：FE api 层声明了，但整个 src（含 store）零调用 → UI 无入口** | **45** |
| **合计未接入端点** | **约 100** |
| C 类：只在 store 里调用、需确认 UI 触发路径 | 22（全部已确认可触发，无缺口） |

FE 侧 slash 命令 41 个，TUI 侧 70 个（`xai-grok-pager/src/slash/commands/*.rs`），差集里大部分对应下面这些没接的端点族。

逐条表格（100 行、按 10 个类别分区、带建议入口与优先级）见文末第 10 节附录。

优先建议（按对用户可见价值排序）：

1. **账号/登录族全缺（P0）** — host 有 `/api/auth/*`、`/api/privacy/set-coding-data-retention`、`/api/billing/auto-topup-rule`、`/api/api-key-get|set`，FE 一个都没声明。未登录的 host 在浏览器里没有任何自救入口：`src/components/UsageModal.tsx:336` 只能显示"无 billing 配置（未登录或旧 agent）"。TUI 有 `/login` `/logout` `/privacy`。
2. **扩展面板三处半成品（P1）** — marketplace tab 是写死的占位（`src/components/ExtensionsModal.tsx:1024-1033`，端点 `/api/marketplace/list|action` 已在 `src/api/rpc/tools.ts` 声明）；plugins tab 只读无开关/重载（`PluginItem`，`ExtensionsModal.tsx:709-735`，对应 `/api/plugins/action|reload`）；skills 只有 toggle，增删/配置未接（`/api/skills/add|remove|reset|config|refresh-baseline`）。
3. **反馈通道缺失（P1）** — `/api/feedback`（赞踩 + 文字反馈）、`/api/rollout/survey` 全无。TUI 有 `feedback.rs`。
4. **会话分享与导入（P1）** — `sessionShare → /api/session/share`、`sessionImport → /api/session-import` 已声明零调用；TUI 有 `share.rs`、`import_claude_modal.rs`。
5. **代码智能/逐 hunk 审阅（P1，工作量最大）** — `/api/code/*`（goto/references/status）、`/api/hunk-tracker/*`（8 个）、`/api/review/comment*` 整族未接。注意：TUI 客户端侧也没有逐 hunk accept/reject UI（grep 无 `accept_hunk`/`hunk_action`），属于"两端都未做"的 IDE 型能力，若要接需先定产品边界。
6. **输入补全（P2）** — `/api/suggest`、`/api/suggest-prompt` 已在 `src/api/rpc/assist.ts` 就绪，`src/components/Composer.tsx:516-525` 明确写了"当前不做完整补全 UI — Composer 保持纯手输"。
7. **文件系统与内嵌终端（P2）** — `/api/fs/list|read-file|exists|write-file|delete-file` 未声明；目录选择器现在绕道 `/api/shell` 执行命令（`src/components/DirectoryPickerModal.tsx:2` → `src/api/shell.ts:38`）。`/api/terminal/pty/*` + `list` + `kill` 未声明，浏览器内无交互式终端。

## 2. 排查口径（可复现）

FE 的分层事实：`src/api/rpc/*.ts` 里的对象方法用 `this.fetch(this.url("/api/..."))` 或 `xaiCall(this, "/api/...", body)` 打后端；经 `src/api/rpc/mixins.ts` + `Object.assign(LocalTransport.prototype, rpcMixins)`（`src/api/localTransport.ts:853`）挂到 transport 实例；调用形态只有 `transport.<方法名>(...)` 一种。

三步判定：

1. 从 `../acp-host/internal/server/*.go`（排除 `_test.go`）抓全部 `HandleFunc("VERB /path", s.handler)` → 202 个端点。
2. 从 FE `src/**` 抓所有 `"…api/…"` 字面量，**先剥离块注释与行注释**再判定 → 命中位置在真实代码里才算接入。剥注释很关键：`/api/suggest` 只在 `Composer.tsx` 的注释里出现，不剥就会误判为已接。
3. 对每个 rpc 方法名，在 `src/` 除 `src/api/` 且非测试文件中找引用；零引用即 B 类。有引用但只出现在注释里同样归 B 类。

端点 `/`、`/api/hosts`、`/events` 属模板串拼接（`localTransport.ts:481` `${this.base}/events`、`rpc/hosts.ts:12` `${this.apiBase()}/api/hosts`），是静态扫描的假阳性，已剔除。

## 3. A 类：host 有端点、FE 完全未声明（55）

### 3.1 账号 / 认证 / 隐私 / 计费（13）— 建议 P0

host 侧全部是 `x.ai/*` 直通代理（`../acp-host/internal/server/http_ext_auth.go:136-147`）。

| 端点 | 能力 | TUI 对应 |
| --- | --- | --- |
| `/api/auth/info` | 当前登录身份 | `slash/commands/login.rs` |
| `/api/auth/get-url` `/api/auth/submit-code` `/api/auth/cancel` | 设备码登录三步流 | 同上 |
| `/api/auth/logout` | 登出 | `slash/commands/logout.rs` |
| `/api/auth/check-subscription` | 订阅校验 | `login.rs` |
| `/api/auth/get-bearer-token` | 取 bearer token | — |
| `/api/api-key-get` `/api/api-key-set` | 全局 BYOK key | `api_key` 相关 29 处；FE 只有自定义模型级 `api_key`（`CustomModelsPanel.tsx:296`） |
| `/api/billing/auto-topup-rule` | 自动充值规则 | `views/settings_modal` |
| `/api/privacy/set-coding-data-retention` | 数据留存开关 | `slash/commands/privacy.rs` |
| `/api/rollout/survey` | 投放问卷 | `views/welcome` |
| `/api/feedback` | 文字/赞踩反馈 | `slash/commands/feedback.rs` |

FE 现状：`SettingsModal` 只有 UI / Session / Models / CLI 四个 tab（`src/components/SettingsModal.tsx:25-28`），无 Account 分区。

### 3.2 代码智能与复核（18）— 建议 P1，但需先定边界

`../acp-host/internal/server/http_ext_code.go:422-441`。

- `/api/code/goto-definition`、`goto-references`、`find-definitions`、`find-references`、`status`（5）— 符号跳转；shell 侧实现在 `xai-grok-shell/src/extensions/code_nav.rs`。
- `/api/hunk-tracker/hunks`、`files`、`file-contents`、`summary`、`hunk-action`、`file-action`、`turn-action`、`all-action`（8）— 逐块 accept/reject。
- `/api/review/comment`、`comment-delete`（2）— 行级复核评论（shell 侧在 `extensions/feedback.rs`）。
- `/api/bundle/status`、`sync`、`entry-get`（3）— 索引/打包状态。

判定依据：FE 现有 diff 审阅 `DiffReviewModal.tsx` 完全靠权限响应（`respondXai`，`DiffReviewModal.tsx:188,254`）驱动，未使用任何 hunk-tracker 端点。TUI 客户端里也搜不到 `accept_hunk`/`hunk_action`/`review_comment` 的调用（`hunk` 只出现在 diff 渲染与 changed-files 提示中）。

### 3.3 文件系统（5）— 建议 P2

`/api/fs/list`、`/api/fs/read-file`、`/api/fs/exists`、`/api/fs/write-file`、`/api/fs/delete-file`（`http_ext_fs.go:191-197`）。

FE 用 `/api/shell` 执行命令实现目录列举（`DirectoryPickerModal.tsx:2` + `api/shell.ts:38`）；`FilePickerMenu.tsx` 走 search fuzzy（`/api/search/fuzzy/*`）。专用 fs 端点既没声明也没用，等于放弃了无 shell 权限场景与写文件能力。

### 3.4 终端（6）— 建议 P2

`/api/terminal/list`、`/api/terminal/kill`、`/api/terminal/pty/create`、`pty/load`、`pty/resize`、`pty/input`（`http_ext_terminal.go:269-279`）。

FE 只接了 `terminal/create`、`output`、`release`、`wait-for-exit`（后台命令用，见 `src/api/rpc/tools.ts` 的调用点统计）。PTY 四件套 = 浏览器内交互式终端，整块未接。

### 3.5 云端环境（5）— 建议 P2

`/api/cloud/env/list`、`create`、`update`、`delete`、`/api/cloud/terminate`（`http_ext_cloud.go:129-133`）。FE 无 cloud/sandbox 概念，TUI 侧有对应视图（`app/dispatch/session/lifecycle.rs`、`views/modal_window.rs`）。

### 3.6 明确判定为"不需要 UI / 不算缺口"（8）

| 端点 | 判定依据 |
| --- | --- |
| `/api/folder-trust-request` | agent → 客户端反向请求；FE 已通过 `x.ai/folder_trust/request` 事件卡实现并走 `/api/client-response` 应答（`src/components/FolderTrustCard.tsx:8-31`、`src/store/chat/pending.ts:16`） |
| `/api/capabilities` | 后端注释自述：grok 侧无对应请求分支，真实 agent 会回 -32601 → 降级 `{ok:false}`（`http_ext_misc.go:70`）。FE 需要的能力宣告来自 initialize meta（`src/api/types/events.ts:28`） |
| `/api/debug/agent`、`/api/debug/arm-auto-compact`、`/api/debug/trigger-feedback` | 纯调试（`http_ext_misc.go:72-74`），可选做进 dev 面板，非用户功能 |
| `/api/xai-call` | 任意 `x.ai/*` 通用代理，FE 对每个方法都有专用端点，无需再接 |
| `/api/session/state` | 与 FE 已用的 `/api/session-state` 是同一能力的两个入口（host 注释明确区分：前者直通 agent，后者读宿主侧状态），FE 用后者即够 |
| `/api/pr/status` | host 侧代理 `x.ai/pr/status`（`http_ext_git.go:623`），但 TUI 客户端也没有 PR 展示，属后端预留 |

## 4. B 类：FE 已声明、代码零调用（45）

### 4.1 `src/api/rpc/tools.ts`（13）— 建议 P1

| 方法 | 端点 | 缺口 |
| --- | --- | --- |
| `marketplaceList` / `marketplaceAction` | `/api/marketplace/list` / `action` | marketplace tab 写死"占位"文案（`ExtensionsModal.tsx:1026`）。运行时佐证：`src/components/ExtensionsModal.test.tsx:211-218` 断言该 tab 只渲染占位文案且无状态过滤条（`npx vitest run src/components/ExtensionsModal.test.tsx` → 21 passed） |
| `pluginsList` | `/api/plugins/list` | plugins tab 数据来自 `GET /api/extensions`，未走专用列表端点 |
| `pluginsAction` | `/api/plugins/action` | 插件行只有 enabled/disabled 徽标，无开关（`PluginItem`，`ExtensionsModal.tsx:709-735`） |
| `pluginsReload` | `/api/plugins/reload` | hooks 有 reload（`ExtensionsModal.tsx:384`），plugins 没有 |
| `pluginsNotifyUpdates` | `/api/plugins/notify-updates` | 无更新提醒 |
| `skillsAdd` / `skillsRemove` / `skillsReset` / `skillsConfig` / `skillsRefreshBaseline` | `/api/skills/*` | skills tab 只接了 `skillsList` + `skillsToggle`（`ExtensionsModal.tsx:320,335`） |
| `mcpSetup` | `/api/mcp/setup` | 需要填参数模板的 MCP 无法在 web 完成初始化 |
| `mcpAuthStatus` | `/api/mcp/auth-status` | MCP 面板已接 `mcpList`/`mcpToggle`/`mcpToggleTool`/`mcpAdd`/`mcpRemove`/`mcpAuthTrigger`（经 store，`src/store/chat/actions/xai.ts:499-511`、`McpPanel.tsx:42-45`）与 `mcpCall`/`mcpReadResource`（`McpPanel.tsx:311,333`）；缺的是触发授权后回查认证状态这一步 |

### 4.2 `src/api/rpc/sessions.ts`（16）

| 方法 | 端点 | 判定 |
| --- | --- | --- |
| `sessionShare` | `/api/session/share` | **P1** 真缺口，TUI 有 `share.rs`（886 处 share 引用） |
| `sessionImport` | `/api/session-import` | **P1** 真缺口，TUI 有 `import_claude_modal.rs` |
| `sessionRepair` | `/api/session-repair`（`dryRun?`） | **P2** 会话历史修复，适合放进 ErrorBanner/诊断入口 |
| `sessionRehydrate` | `/api/session-rehydrate`（`sourceCwd`/`repoRoot`/`worktreePath`） | **P2** worktree 迁移后找回会话 |
| `sessionResolveWorktreeResume` | `/api/session-resolve-worktree-resume` | **P2** 与已用的 `gitWorktreeResumeSession` 同族，缺"本地已存在该 worktree 时怎么选"这一步 |
| `sessionClose` | `/api/session-close` | **P3** web 关 tab 即离开，价值低 |
| `sessionLoadHistory` | `/api/session-load-history`（`beforeId` 游标，gateway 型会话专用） | **P2** FE 分页现在只走 `/api/session-updates`，gateway 型会话的历史可能取不到 |
| `sessionUpdateMcpServers` | `/api/session-update-mcp-servers` | **P3** 会话中途热更新 MCP 列表 |
| `sessionAddLocalWorkspace` | `/api/session-add-local-workspace` | **P2** 多根工作区，FE 完全没有该概念（见 `workspacesList`） |
| `workspacesList` | `/api/workspaces/list` | 同上，**P2** |
| `subagentGet` | `/api/subagent/get` | **P2** FE 子代理详情走的是 `loadSessionHistory(child_session_id)`（`src/store/chat/actions/viewerOpen.ts:123,214`、`BlockViewer.tsx:828`），专用端点未用 |
| `subagentListRunning` | `/api/subagent/list-running` | 已有等价路径：`sessionRunningTasks`（`src/store/chat/actions/livePoll.ts:19,32`），**P3** 冗余 |
| `sessionUsage` | `/api/session/usage` | 已有等价：`sessionStats`（`SessionStatsBar.tsx:20`）+ `usageReport`/`billing`（`UsageModal.tsx:38,54`），**P3** 冗余 |
| `sessionsListExt` | `/api/sessions/list` | 已有等价：`listSessions`（`/api/sessions`）+ `workspaceListRecent`，**P3** 冗余 |
| `sessionSummariesSessionList` | `/api/session-summaries/session-list` | 同上，**P3** 冗余 |
| `commandsList` | `/api/commands-list` | **非缺口**：agent 宣告的 slash 命令已经由 ACP `available_commands_update` 推送进入 `src/components/composer/useSlashMenu.ts:54`，端点只是拉取式冗余 |

### 4.3 `src/api/rpc/git.ts`（14）— 建议 P2

GitPanel 实际只用了 8 个：`gitStatus`、`gitBranches`、`gitDiscard`、`gitCheckout`、`gitStash`、`gitUnstage`、`gitStage`、`gitCommit`（`src/components/GitPanel.tsx:198,219,371,400,420,601,616,704,732`）。

未接：`gitCheckoutCommit`、`gitCheckoutSessionHead`、`gitCurrentCommit`、`gitStageContent`（按内容块暂存）、`gitWorktreeList`、`gitWorktreeShow`、`gitWorktreeRemove`、`gitWorktreeGc`、`gitWorktreeApply`、`gitWorktreeCreateFromWorktree`、`gitWorktreeCreateFromWorktreeSync`、`gitWorktreeDbStats`、`gitWorktreeDbRebuild`、`gitWorktreeDbPath`。

其中值得先做的是一个 worktree 管理入口（列/切/清理）：TUI dashboard 已经维护 `worktrees` 映射来标注受管目录（`xai-grok-pager/src/views/dashboard/state.rs:881-927`），而 FE 目前只有"在新 worktree 中开始"这一个动作（`src/components/scrollback/useWorktreeGate.ts:6-8` → `forkSession({worktree:true})`）。`gitWorktreeDb*` 三个是运维自检，P3。

### 4.4 `src/api/rpc/assist.ts`（2）— 建议 P2

`suggest` → `/api/suggest`、`suggestPrompt` → `/api/suggest-prompt`。方法已就绪、类型齐全，UI 明确未做（`src/components/Composer.tsx:516-525`）。

## 5. C 类复核：仅 store 引用的 22 个方法都有可触发路径

逐条追到 UI 或自动流程，均**不算缺口**：

| rpc 方法 | store 调用点 | UI/自动触发 |
| --- | --- | --- |
| `gitWorktreeResumeSession` | `chat/actions/xai.ts:246` | `/fork --worktree`（`src/commands/registry.ts:441`）与消息级 Fork 按钮（`AssistantEntry.tsx:137`） |
| `permissionsReset` | `chat/actions/modes.ts:255` | slash `permissions-reset`（`registry.ts:700`）+ `ApprovalStrip.tsx:554` 按钮 |
| `respondClientRequest` | `chat/actions/modes.ts:315` | `respondXai` ← `DiffReviewModal.tsx:188,254` 等反向请求卡 |
| `memoryRewrite` | `chat/actions/xai.ts:188` | slash `remember`（`registry.ts:832`） |
| `schedulerDelete` | `chat/actions/xai.ts:471` | `StatusChips.tsx:723,904` 定时任务删除按钮 |
| `listTasks` / `taskOutput` | `chat/actions/liveTasks.ts:73,13` | `BlockViewer.tsx:80,142-144` 后台任务视图轮询 |
| `sessionRunningTasks` | `chat/actions/livePoll.ts:19,32` | 回合中自动轮询 |
| `queueStatus` / `queueClear` / `queueEdit` / `queueRemove` / `queueReorder` / `queueHoldEdit` / `queueReleaseEdit` | `src/store/promptQueue.ts` | 队列条与编辑器（`src/components/composer/QueueStrip.tsx`、`useQueueNav.ts`、`Composer.tsx`） |
| `listSessions` / `loadSession` / `sessionResume` / `workspaceList` / `workspaceListRecent` / `loadSessionHistory` | `chat/actions/session.ts`、`continueSession.ts`、`loadHistory.ts` | 会话列表、恢复、历史分页自动流程 |

方法名引用统计已剔除注释命中，避免"注释里提到 = 已接"的误判。

## 6. hub 侧端点（补充核查，均已接入）

`../acp-hub/cmd/capri-hub/main.go` 注册的 hub 专有端点逐个核对：`GET /api/hosts`、`POST /api/hosts/{id}/rename`、`DELETE /api/hosts/{id}`、`GET /api/pairing`、`POST /api/pairing/rotate`、`GET|PUT /api/prefs`、`POST /api/ws-ticket`、`GET /api/events`、`GET /ws/fe` 均有 FE 调用点（`src/api/rpc/hosts.ts:12,38,63,87,109,172,212`、`src/api/localTransport.ts:520,543`），UI 入口在 `HostActions.tsx`（改名/解绑/配对码）与 `historyPins.ts`（prefs 同步）。

未使用：`POST /api/pair`、`GET /api/info`、`GET /health`。`POST /api/pair` 是 host 端配对码兑换（host→hub），本就不该由 FE 调；`/api/info` 与 `/health` 属部署探针。

## 7. 与既有《FE-vs-TUI 差异审查报告》的关系

`docs/FE-vs-TUI-差异审查报告.md` 从功能视角点到过同族问题（第 18 行"worktree 管理（wire 已有 12 个方法但无 UI）"、3.6 节"hooks/plugins 只读、marketplace 纯占位"）。本文的贡献是把口径换成端点级穷举（202 个 host 端点 + 144 个 FE rpc 方法逐个比对），并把此前完全没提过的整族缺口列出：账号/认证/隐私/计费 13 个、代码智能与逐 hunk 审阅 18 个、`/api/fs/*` 5 个、PTY 终端 6 个、云端环境 5 个。

需要修正旧报告的一处：**hooks 已不是只读**。`src/components/ExtensionsModal.tsx:384`（`hooksAction({action:{type:'reload'}})`）与 `:402`（启停）已实装，本轮 `npx vitest run src/components/ExtensionsModal.test.tsx` 21 项全通过（含 `hooksAction` 调用断言）。plugins 与 marketplace 的只读/占位判定仍然成立。

## 8. 排查手段的边界

- 判定基于静态调用链（端点字面量 + rpc 方法名引用，已剥离注释），没有逐个真点一遍 UI。marketplace 占位这一条有 jsdom 渲染测试作为运行时佐证，其余高优先项（账号族、fs/PTY、code/hunk）因 FE 侧根本没有引用，静态即可定论。
- 未改任何 UI 代码，因此未做浏览器回归。
- `x.ai/*` 协议方法全集（含无 HTTP 端点的那些）的覆盖度校对在 `../grokbuild-协议覆盖度校对-fe-host.xlsx`，那是另一条口径。

## 9. 建议落地顺序

1. Account 分区（SettingsModal 新 tab）：登录/登出/身份 + 隐私开关 + 全局 API key + 自动充值规则，顺带把 `/api/auth/check-subscription` 结果并进 UsageModal。
2. 扩展面板补齐：marketplace tab 接 `marketplaceList/Action` 去占位；plugins 行加 enabled 开关 + reload；skills 行加删除/查看配置。
3. 反馈入口：消息级赞踩 + 文字反馈接 `/api/feedback`，`/api/rollout/survey` 做首启问卷。
4. 会话分享（`/api/session/share`，入口放 SessionInfoModal 与消息菜单）+ Claude 会话导入（`/api/session-import`，入口放 home 空状态）。
5. worktree 管理入口（list/show/remove/gc）+ `sessionResolveWorktreeResume` 的"本地已有 worktree"分支。
6. 输入补全（`/api/suggest`）与目录选择改走 `/api/fs/*`。
7. 再评估是否要浏览器内 PTY 与逐 hunk 审阅：这两块 TUI 客户端也没有，属新增能力而非对齐缺口。

## 10. 附录：100 个未接入端点逐条表（按类别分区）

FE 状态列含义：**A** = host 有端点、FE 连 `src/api/rpc` 都没声明；**B** = FE 已声明该 rpc 方法（括号内是方法名），但全仓零调用。

### 区域 1 · 账号 / 认证 / 隐私 / 计费 / 反馈（13）

| 端点 | FE 状态 | 建议 UI 入口 | 优先级 |
| --- | --- | --- | --- |
| `/api/auth/info` | A | SettingsModal 新 Account tab 显示身份 | P0 |
| `/api/auth/get-url` | A | Account tab「登录」按钮第一步，拿设备码 URL | P0 |
| `/api/auth/submit-code` | A | 登录弹窗内的 code 输入框 | P0 |
| `/api/auth/cancel` | A | 登录弹窗「取消」 | P1 |
| `/api/auth/logout` | A | Account tab「登出」 | P1 |
| `/api/auth/check-subscription` | A | Account tab / UsageModal 顶部订阅态 | P1 |
| `/api/auth/get-bearer-token` | A | 仅调试复制令牌，无用户价值 | P3 |
| `/api/api-key-get` | A | Account tab 的全局 BYOK key 读取 | P1 |
| `/api/api-key-set` | A | Account tab 的全局 BYOK key 写入/清除 | P1 |
| `/api/privacy/set-coding-data-retention` | A | Account tab 隐私开关（对齐 TUI `/privacy`） | P1 |
| `/api/feedback` | A | 消息行操作条（`AssistantEntry.tsx:120` 的 Fork 按钮旁）赞踩+文字 | P1 |
| `/api/billing/auto-topup-rule` | A | UsageModal 的 CreditsRows 区块（`UsageModal.tsx:336` 附近） | P2 |
| `/api/rollout/survey` | A | 首启问卷弹窗（App.tsx 挂载，仿 FolderTrustCard） | P2 |

### 区域 2 · 代码智能 / 逐 hunk 审阅 / 复核评论 / bundle（18）

| 端点 | FE 状态 | 建议 UI 入口 | 优先级 |
| --- | --- | --- | --- |
| `/api/code/goto-definition` | A | 工具详情与 diff 里符号 cmd/ctrl+点击跳转 | P2 |
| `/api/code/goto-references` | A | 同上，右键「查引用」 | P2 |
| `/api/code/find-definitions` | A | 符号搜索面板（可与 ContentSearchModal 合并） | P2 |
| `/api/code/find-references` | A | 同上 | P2 |
| `/api/code/status` | A | SessionInfoModal 的索引/LSP 健康行 | P2 |
| `/api/hunk-tracker/hunks` | A | DiffReviewModal 逐块视图 | P2 |
| `/api/hunk-tracker/files` | A | DiffReviewModal 文件列表 | P2 |
| `/api/hunk-tracker/file-contents` | A | DiffReviewModal 全文对照 | P2 |
| `/api/hunk-tracker/summary` | A | GitPanel 顶部「本轮改动 N 块」摘要 | P2 |
| `/api/hunk-tracker/hunk-action` | A | 每块上的 Accept / Reject | P2 |
| `/api/hunk-tracker/file-action` | A | 文件头「接受全部」 | P2 |
| `/api/hunk-tracker/turn-action` | A | 回合级「接受本轮改动」 | P2 |
| `/api/hunk-tracker/all-action` | A | 全局「全部接受/全部回退」 | P2 |
| `/api/review/comment` | A | 选中文本 → 加评论（SelectionBox 已有选区） | P2 |
| `/api/review/comment-delete` | A | 评论行的删除 | P2 |
| `/api/bundle/status` | A | ContextModal 的 bundle 索引状态 | P3 |
| `/api/bundle/sync` | A | 同上的「同步」按钮 | P3 |
| `/api/bundle/entry-get` | A | bundle 条目详情展开 | P3 |

### 区域 3 · 文件系统（5）

| 端点 | FE 状态 | 建议 UI 入口 | 优先级 |
| --- | --- | --- | --- |
| `/api/fs/list` | A | DirectoryPickerModal（现在绕道 `/api/shell`） | P1 |
| `/api/fs/read-file` | A | BlockViewer / InlineImages 读附件与图片 | P2 |
| `/api/fs/exists` | A | FilePickerMenu 与路径校验 | P2 |
| `/api/fs/write-file` | A | 编辑类入口（暂无，随 fs 面板一起做） | P2 |
| `/api/fs/delete-file` | A | 同上 | P2 |

### 区域 4 · 终端（6）

| 端点 | FE 状态 | 建议 UI 入口 | 优先级 |
| --- | --- | --- | --- |
| `/api/terminal/list` | A | 终端管理面板/StatusChips 的在跑终端列表 | P2 |
| `/api/terminal/kill` | A | 同列表的行内 kill | P2 |
| `/api/terminal/pty/create` | A | 浏览器内交互终端（xterm 面板） | P2 |
| `/api/terminal/pty/load` | A | 同上，恢复既有 PTY | P2 |
| `/api/terminal/pty/resize` | A | 同上，容器尺寸变化 | P2 |
| `/api/terminal/pty/input` | A | 同上，键盘输入 | P2 |

### 区域 5 · 云端环境（5）

| 端点 | FE 状态 | 建议 UI 入口 | 优先级 |
| --- | --- | --- | --- |
| `/api/cloud/env/list` | A | EmptyState 新建会话时的环境下拉 | P2 |
| `/api/cloud/env/create` | A | 同上「新建环境」表单 | P2 |
| `/api/cloud/env/update` | A | 环境行「编辑」 | P2 |
| `/api/cloud/env/delete` | A | 环境行「删除」 | P2 |
| `/api/cloud/terminate` | A | 运行中沙箱的「停止」 | P2 |

### 区域 6 · Git 与 worktree（15）

| 端点 | FE 状态 | 建议 UI 入口 | 优先级 |
| --- | --- | --- | --- |
| `/api/git/current-commit` | B（`gitCurrentCommit`） | GitPanel 头部显示 HEAD 短 sha | P2 |
| `/api/git/checkout-commit` | B（`gitCheckoutCommit`） | GitPanel 分支菜单里「按 commit 切」 | P2 |
| `/api/git/checkout-session-head` | B（`gitCheckoutSessionHead`） | RewindPicker「同时把工作区回到该点」 | P2 |
| `/api/git/stage-content` | B（`gitStageContent`） | DiffReviewModal 逐块暂存 | P2 |
| `/api/git/worktree/list` | B（`gitWorktreeList`） | 新 worktree 管理面板（或 GitPanel 新 tab） | P2 |
| `/api/git/worktree/show` | B（`gitWorktreeShow`） | 同上面板展开详情 | P2 |
| `/api/git/worktree/apply` | B（`gitWorktreeApply`） | 同上面板「应用改动」 | P2 |
| `/api/git/worktree/remove` | B（`gitWorktreeRemove`） | 同上面板「删除」 | P2 |
| `/api/git/worktree/gc` | B（`gitWorktreeGc`） | 同上面板「清理」 | P3 |
| `/api/git/worktree/create-from-worktree` | B（`gitWorktreeCreateFromWorktree`） | worktree 行「从此派生」 | P3 |
| `/api/git/worktree/create-from-worktree-sync` | B（`gitWorktreeCreateFromWorktreeSync`） | 同上带同步 | P3 |
| `/api/git/worktree/db/stats` | B（`gitWorktreeDbStats`） | 诊断面板 | P3 |
| `/api/git/worktree/db/rebuild` | B（`gitWorktreeDbRebuild`） | 诊断面板 | P3 |
| `/api/git/worktree/db/path` | B（`gitWorktreeDbPath`） | 诊断面板 | P3 |
| `/api/pr/status` | A | TUI 客户端亦无 PR 展示，属后端预留 | P3 |

### 区域 7 · 扩展生态（skills / plugins / marketplace / mcp）（13）

| 端点 | FE 状态 | 建议 UI 入口 | 优先级 |
| --- | --- | --- | --- |
| `/api/marketplace/list` | B（`marketplaceList`） | ExtensionsModal marketplace tab 去占位 | P1 |
| `/api/marketplace/action` | B（`marketplaceAction`） | 同上，安装/卸载按钮 | P1 |
| `/api/plugins/action` | B（`pluginsAction`） | PluginsTab 行内 enabled 开关（现只读） | P1 |
| `/api/plugins/reload` | B（`pluginsReload`） | PluginsTab 头部 reload（hooks 已有同款） | P1 |
| `/api/plugins/list` | B（`pluginsList`） | 现数据来自 `GET /api/extensions`，接专用端点拿更全字段 | P2 |
| `/api/plugins/notify-updates` | B（`pluginsNotifyUpdates`） | 更新提醒徽标 | P2 |
| `/api/skills/add` | B（`skillsAdd`） | SkillsTab 头部「新建技能」 | P2 |
| `/api/skills/remove` | B（`skillsRemove`） | 技能行「删除」 | P2 |
| `/api/skills/reset` | B（`skillsReset`） | SkillsTab 危险操作区 | P3 |
| `/api/skills/config` | B（`skillsConfig`） | 技能行「配置」 | P2 |
| `/api/skills/refresh-baseline` | B（`skillsRefreshBaseline`） | SkillsTab 头部「刷新基线」 | P2 |
| `/api/mcp/setup` | B（`mcpSetup`） | McpPanel 需要参数模板的服务器初始化表单 | P2 |
| `/api/mcp/auth-status` | B（`mcpAuthStatus`） | McpPanel 授权后回查状态 | P2 |

### 区域 8 · 会话与子代理（17）

| 端点 | FE 状态 | 建议 UI 入口 | 优先级 |
| --- | --- | --- | --- |
| `/api/session/share` | B（`sessionShare`） | SessionInfoModal「分享」+ 消息菜单 | P1 |
| `/api/session-import` | B（`sessionImport`） | EmptyState「导入 Claude 会话」 | P1 |
| `/api/session-repair` | B（`sessionRepair`） | ErrorBanner 的「修复会话」动作 | P2 |
| `/api/session-rehydrate` | B（`sessionRehydrate`） | worktree 丢失后的恢复引导 | P2 |
| `/api/session-resolve-worktree-resume` | B（`sessionResolveWorktreeResume`） | `/fork --worktree` 时「本地已有 worktree」选择分支 | P2 |
| `/api/session-load-history` | B（`sessionLoadHistory`） | gateway 型会话的历史分页（现只走 `/api/session-updates`） | P2 |
| `/api/session-add-local-workspace` | B（`sessionAddLocalWorkspace`） | 会话内「添加工作目录」 | P2 |
| `/api/workspaces/list` | B（`workspacesList`） | 多根工作区选择器 | P2 |
| `/api/subagent/get` | B（`subagentGet`） | BlockViewer 子代理详情头信息（现走 `loadSessionHistory`） | P2 |
| `/api/session-close` | B（`sessionClose`） | 关 tab 即离开，价值低 | P3 |
| `/api/session-update-mcp-servers` | B（`sessionUpdateMcpServers`） | 会话中途热更新 MCP | P3 |
| `/api/subagent/list-running` | B（`subagentListRunning`） | 已被 `sessionRunningTasks` 覆盖 | P3 |
| `/api/session/usage` | B（`sessionUsage`） | 已被 `sessionStats`+`usageReport` 覆盖 | P3 |
| `/api/sessions/list` | B（`sessionsListExt`） | 已被 `/api/sessions` 覆盖 | P3 |
| `/api/session-summaries/session-list` | B（`sessionSummariesSessionList`） | 已被 workspace-list 覆盖 | P3 |
| `/api/commands-list` | B（`commandsList`） | 已由 ACP `available_commands_update` 推送，非缺口 | P3 |
| `/api/session/state` | A | 与已用的 `/api/session-state` 同能力，非缺口 | P3 |

### 区域 9 · 输入辅助（2）

| 端点 | FE 状态 | 建议 UI 入口 | 优先级 |
| --- | --- | --- | --- |
| `/api/suggest` | B（`suggest`） | Composer 输入暂停后的补全候选行 | P2 |
| `/api/suggest-prompt` | B（`suggestPrompt`） | 同上，generation 轮换 | P2 |

### 区域 10 · 内部 / 调试 / 反向请求（6）

| 端点 | FE 状态 | 判定 | 优先级 |
| --- | --- | --- | --- |
| `/api/folder-trust-request` | A | agent→客户端反向请求，FE 已用事件卡 + `/api/client-response` 应答 | 非缺口 |
| `/api/capabilities` | A | 后端自述 grok 无分支，恒回 -32601 | 非缺口 |
| `/api/debug/agent` | A | 调试专用，可选进 dev 面板 | P3 |
| `/api/debug/arm-auto-compact` | A | 同上 | P3 |
| `/api/debug/trigger-feedback` | A | 同上 | P3 |
| `/api/xai-call` | A | 通用 `x.ai/*` 代理，FE 每个方法都有专用端点 | 非缺口 |

### 分类计数

| 区域 | 条数 | 其中 A / B |
| --- | --- | --- |
| 1 账号·认证·隐私·计费·反馈 | 13 | 13 / 0 |
| 2 代码智能·hunk·review·bundle | 18 | 18 / 0 |
| 3 文件系统 | 5 | 5 / 0 |
| 4 终端 | 6 | 6 / 0 |
| 5 云端环境 | 5 | 5 / 0 |
| 6 Git 与 worktree | 15 | 1 / 14 |
| 7 扩展生态 | 13 | 0 / 13 |
| 8 会话与子代理 | 17 | 1 / 16 |
| 9 输入辅助 | 2 | 0 / 2 |
| 10 内部·调试·反向 | 6 | 6 / 0 |
| **合计** | **100** | **55 / 45** |
