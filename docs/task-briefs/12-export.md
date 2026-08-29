你在 /Users/benin/ccwork/acp-fe（React 19 + TS + zustand + vitest + Tailwind，capri 的 Web 前端）里实现 `/export`。参考实现是 Grok 的 Rust TUI，在 /Users/benin/ccwork/grok-build/crates/codegen/xai-grok-pager。

## 任务

实现 `/export [filename]`：把当前会话的 transcript 导出成 Markdown——无参数时复制到剪贴板，有参数时下载为 `.md` 文件。纯前端实现，**不要在 host 新增端点**（已确认 host 没有任何 export 端点）。

## 已确认的现状

1. TUI 侧行为规格在 `xai-grok-pager/src/slash/commands/export.rs`（文件头注释即规格说明）：`/export [filename]`，`session_scoped`，无活动会话时报 `No active session to export`；**空参数 → 整段 transcript 复制到剪贴板**；有参数 → 写 UTF-8 `.md` 文件，支持 `~` 展开、带空格的路径、自动创建父目录；`suggest_args` 用 `list_path_completions(ctx.cwd, args_query)` 做路径补全。先完整读这个文件，把它的 Markdown 结构（标题、角色标签、时间戳、工具调用怎么呈现、思考块要不要导出）抄下来作为 FE 的对齐目标；如果它复用了一个共享的 transcript 组装函数（而不是内联拼字符串），把那个函数也读一遍。**注意 Web 端做不到的部分要如实取舍**（例如服务端文件写入路径 → 浏览器只能下载），在汇报里写清你做了什么替代。
2. FE 现状：完全没有导出能力（`createObjectURL` / `Blob` 只出现在 `src/components/Markdown.tsx` 的 mermaid 渲染和 `src/components/scrollback/kinds/AssistantEntry.tsx:81-82` 的复制菜单里）。已有的可复用件：
   - 剪贴板：`/copy` 命令（`src/commands/registry.ts:404-424`）已经在用 `navigator.clipboard.writeText` 并处理了失败（`status()` 反馈），照它的错误处理风格写。
   - 滚动区数据：`useChatStore.getState().entries`，条目类型联合在 `src/api/types/scroll.ts`（`user` / `assistant` / `thought` / `tool` / `plan` / `subagent` / `workflow` / `bg_task` / `session_event` / `status` / `error` / `credit_limit` / `image` / `group_header`）。文本清洗工具已有：`src/scrollback/userText.ts`、`src/scrollback/thoughtText.ts`、`src/scrollback/liveText.ts`、`src/scrollback/toolDetail.ts`、`src/scrollback/toolHeaderExtra.ts`——导出时要复用它们而不是重新解析原始字段，否则会和屏幕显示不一致。
   - 时间戳：`src/components/scrollback/PromptTime.tsx` 与 `src/format.ts` 里已有的时间/字节/计数格式化函数；条目上带 `msgSeq`，部分带 `_meta.agentTimestampMs`（见 `src/store/chat/` 里 envelope 相关注释）。
3. **一个必须处理的正确性问题**：FE 的历史是**分页加载**的（`src/store/chat/loadHistory.ts`、`src/store/chat/loadMoreHistory.ts` / `src/store/chat/historyPage.ts`），未上翻加载的旧轮次不在 `entries` 里。所以「导出当前 transcript」在数据完整性上有坑。请在汇报里明确你选的语义（推荐：导出「已加载的部分」并在文件头部/剪贴板文本末尾用一行说明可能有未加载的历史，同时提示用户可先上翻加载；不要静默地给出一个看起来完整其实被截断的文件），并说明为什么不从 host 拉全量（如果 host 其实有全量端点，指出来但不要为此改 host）。

## 要做的改动

**A. 取证**（上面第 1、3 条要求的内容），据此定 Markdown 结构与导出语义。
**B. 组装函数。** 新建 `src/lib/exportTranscript.ts`：输入 entries（+ 会话元信息如 title / sessionId / cwd / model，从 store 取），输出 Markdown 字符串。纯函数、可单测、不碰 DOM。角色标签、时间戳格式、工具调用与思考块的取舍按 A 步的 TUI 规格来；被折叠/未展开的工具详情怎么导出要有一个明确决定（TUI 有 DisplayMode Collapsed 的概念，参考它的处理）。
**C. 命令。** 注册 `/export`，`argHint: '[filename]'`：无参数 → 复制剪贴板（成功/失败都要有 `status()` 反馈，风格对齐 `/copy`）；有参数 → 触发浏览器下载（`Blob` + `URL.createObjectURL` + `<a download>` + 及时 `revokeObjectURL`；文件名要做安全化：去 `/`、`..`、控制字符，缺 `.md` 后缀就补上，`~` 展开在 Web 下无意义——按你的取舍处理并说明）。无活动会话时 `err('没有可导出的会话')` 之类中文提示。参数里的路径补全（TUI 的 `suggest_args`）Web 端没有对应设施，可以不做，但要在汇报里说明。
**D. 测试。** `src/lib/exportTranscript.test.ts` 覆盖：各种 entry kind 的产出、空会话、只有 status 行、未加载历史提示行的存在与否；registry 层覆盖无参数走剪贴板、有参数触发下载（mock `URL.createObjectURL` 与 `navigator.clipboard`）、无会话报错。

> 提示：`git status` 里可能出现不属于本任务的改动（其它会话在同一工作区作业）。这是正常的——只按文件路径操作你自己的改动，不要回滚、不要顺手"修好"别人的部分。

## 约束

- 只改本任务相关文件。**不要动** `ContextModal.tsx`、`SessionInfoModal.tsx`、`McpPanel.tsx`、`ApprovalStrip.tsx`、`src/store/chat/store.ts`；`registry.ts` 里只加 `/export` 条目与必要 import。
- 不要 `git add` / `git commit`。
- 验证全绿：`npx tsc -b`、`npx oxlint`、`npx vitest run`（基线全绿，不许变红、不许靠删用例变绿）。
- 最终用中文汇报：A 步取证到的 TUI Markdown 结构、导出语义的最终决定与理由、文件名安全化规则、改了/新增了哪些 file:line、测试输出最后 5 行原文。
