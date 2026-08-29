你在 /Users/benin/ccwork/acp-fe（React 19 + TypeScript + zustand + vitest + Tailwind，capri 项目的 Web 前端）里完成一个范围明确的功能任务。这个项目要把 Web FE 对齐 Grok 的 Rust TUI，TUI 参考源码在 /Users/benin/ccwork/grok-build/crates/codegen/xai-grok-pager，Go host 在 /Users/benin/ccwork/acp-host。

## 任务

在 home（空状态页）加一个「在新 worktree 中开始」的入口：点了之后为选定的工作目录新建一个 git worktree，并把新会话的工作目录切到这个 worktree 上。**这个入口只在满足两个条件时才出现：已经选了工作目录，并且该目录在 git 仓库里。**

## 已确认的现状（可直接采信，动手前自己核对行号）

1. home 空状态组件是 `src/components/scrollback/EmptyState.tsx`（93 行）：两段 figlet 字符画 + 一个「选择工作目录」按钮，点开 `DirectoryPickerModal`（`src/components/DirectoryPickerModal.tsx`），选完写 `store.emptyCwd`（`setEmptyCwd`）。没有「开始」按钮——发一条消息就等于从 `emptyCwd` 开新会话（`newSession` 在 `src/store/chat/actions/session.ts:350`）。
2. worktree 的 transport 方法一共有 12 个，全在 `src/api/rpc/git.ts:126-224`：`gitWorktreeCreate`、`gitWorktreeRemove`、`gitWorktreeApply`、`gitWorktreeCreateFromWorktree`、`gitWorktreeCreateFromWorktreeSync`、`gitWorktreeResumeSession`、`gitWorktreeList`、`gitWorktreeShow`、`gitWorktreeGc`、`gitWorktreeDbStats`、`gitWorktreeDbRebuild`、`gitWorktreeDbPath`。host 侧 12 个路由全部已实现（`acp-host/internal/server/http_ext_git.go:603-610` 等）。**但 FE 目前只有 1 个调用方**：`fork --worktree` 用了 `gitWorktreeResumeSession({sourceCwd, copyMode:'dirty'})`（`src/store/chat/actions/xai.ts:83`，响应字段是 `{sessionId, worktreePath, effectiveCwd}`，camel/snake 两种拼写都做了兼容）。
3. 判断「某个目录是不是 git 仓库」的能力已经有了且零调用方：`transport.gitRepoRoot({ cwd })`（`src/api/rpc/git.ts:118-121`）→ host `POST /api/git/repo-root`（`http_ext_git.go:209-217`，转 `x.ai/git/git_repo_root`，参数只带 `gitRoot`，不带 sessionId，所以不依赖活动会话）。这就是 home 场景要用的探针——注意 home 时**还没有会话**，不能用按会话取 git 信息的那条路（`gitInfo(sessionId, cwd)` 在 `git.ts:6-20`）。
4. worktree 的只读展示已经有了：`TopBar.tsx:121-157` 会显示分支、`wt` 徽标和 `(worktree of <main>)`。

## 要做的改动

**A. 门控显示。** 在 `EmptyState` 里，`emptyCwd` 为空时**完全不渲染**这个新入口（连占位都不要）；`emptyCwd` 有值时用它做 `gitRepoRoot` 探针（结果按 cwd 缓存，别每次 render 都发请求；cwd 变化要重新探测；请求进行中不要出现闪烁式的反复显隐）。探针成功且返回了非空 repo root → 渲染可用入口；探针失败或返回空（不是 git 仓库）→ 入口置灰 + `title` 说明原因（中文，例如「该目录不是 git 仓库」）；不要为了一个非 git 目录渲染出可点击的假入口。

**B. 创建流程。** 点击后调 `gitWorktreeCreate`（先读 `src/api/rpc/git.ts:126-139` 和 host 的 `handleWorktreeCreate`（`http_ext_git.go:301` 起）确认真实参数名与必填项，别照猜写），拿到 worktree 路径后 `setEmptyCwd(worktreePath)`，让后续「发消息即开新会话」的既有流程自然接管——**不要**在这里新开会话或调 `newSession`。状态处理：进行中要有禁用态与文案（按钮不能重复点），失败要在原位显示错误并允许重试，成功后给用户一个明确的可见反馈（本项目现有两种模式：`statusText` 状态行、或 `appendLocalEntry` 往滚动区写一行，选更贴合 EmptyState 场景的那种并在汇报里说明）。
路径的展示与输入：如果 host 参数支持自定义 worktree 名/分支名，就提供一个可选的输入框（留空走 host 默认），不支持就留默认行为并在汇报里写明。**不要**在这里做 worktree 删除/gc 等管理功能，那是另一个任务。

**C. 移动端与样式。** EmptyState 有 `min-[481px]` 断点差异（字号 9px/14px），新入口在窄屏下不能撑破布局、不能遮挡原有的「选择工作目录」行。沿用现有的 class 词表（`text-gn-muted`、`text-gn-cyan`、`gn-prompt-border` 等 theme token），不要引入新颜色字面量。

**D. 测试。** 覆盖：`emptyCwd` 为空时不渲染入口；有 `emptyCwd` 且 `gitRepoRoot` 返回仓库根 → 渲染可用入口；`gitRepoRoot` 返回空或抛错 → 入口置灰且不可点击；点击后确实调用了 `gitWorktreeCreate` 并把返回路径写进 `emptyCwd`；进行中重复点击不会发第二次请求。若组件此前没有测试文件就新建 `src/components/scrollback/EmptyState.test.tsx`。

> 提示：`git status` 里可能出现不属于本任务的改动（其它会话在同一工作区作业）。这是正常的——只按文件路径操作你自己的改动，不要回滚、不要顺手"修好"别人的部分。

## 约束

- 只改这个任务相关的东西：预期落在 `src/components/scrollback/EmptyState.tsx`、它的新测试文件，必要时可以加一个小的 hook 文件（例如 `src/components/scrollback/useWorktreeGate.ts`）；不要顺手重构 `DirectoryPickerModal`、`GitPanel`、store 里别的 action。
- 不要 `git add`、不要 `git commit`，改完留在工作区，由我 review 和提交。
- 不要 `git worktree add` 或任何真的在磁盘上建 worktree 的 shell 命令——所有 git 操作都必须走 transport。
- 完成后必须依次跑并且全部通过：`npx tsc -b`、`npx oxlint`、`npx vitest run`（基线全部绿，不许变红，也不许靠删用例变绿）。
- 最后用中文汇报：改了哪些文件（file:line）、`gitWorktreeCreate` 的真实参数签名（你从 FE 类型和 host handler 两边核对到的结果）、门控的具体判定逻辑、Shell 版本无关（这条不用管）、`npx vitest run` 输出最后 5 行原文。
