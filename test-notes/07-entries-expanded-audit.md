# 07 · scrollback 所有 entry 展开内容审计（对齐 TUI 参考实现）

日期：2026-09-01
方法：4 个只读子代理按类别分片并行审计（工具行展开体 / BlockViewer 弹窗查看器 / 文本类行体 / 任务类行体），
对照 TUI 参考（`grok-build/crates/codegen/xai-grok-pager`）；主控抽查复核了
execute / edit / list_dir / read / Markdown 流式 5 项。

## 总评

展开内容整体与 TUI 对齐良好（行头后缀、截断窗口、空/错态、hook 挂靠均已复刻），
共发现 33 条差异：**值得修复 8 条**（其中高优先 3 条）、设计取舍/美化级 12 条、
有意为之 1 条、其余为低优先细节。未发现展开内容缺失或渲染错乱级别的问题。

## 值得修复（★ 越高越优先）

| # | 类别 | 问题 | 优先级 | 状态 |
|---|------|------|--------|------|
| 1 | generic | AskUserQuestion 输出未结构化渲染：TUI 把 `User has answered your questions: "Q"="A"…` 解析成 `N. question` + `→ answer`（无答案 `(no answer)`）；FE 走 StdoutPanel 原样输出 | ★4 | 未复核 |
| 2 | execute | stdout 与错误并存：TUI 只在 `output.is_none()` 时渲染错误行，FE 在 stdout 下再追加红色 `exit code N`/signal 行 | ★3 | ✅已复核 |
| 3 | use_tool | 失败 MCP 调用：TUI 把原始输出文本当 error 展示（红色，正文不再显示 output），FE 保留 output 且 `Tool failed` 在有输出时被隐藏；null 参数 TUI 显示 `key: null`、FE 跳过 | ★3 | 未复核 |
| 4 | list_dir | 行内展开 TUI 全量渲染目录列表，FE 用 INLINE_MAX=10 行截断 + `… +N lines`，长目录中间内容丢失 | ★3 | ✅已复核 |
| 5 | edit | 行内展开 FE 对 diff 做 40 行阈值截断（head 20 + tail 10），TUI Truncated/Expanded 均全量渲染（仅视口预算硬截断） | ★3 | ✅已复核 |
| 6 | edit | FE 渲染 `@@ -n,m +n,m @@` 青色 hunk 头行；TUI 从不渲染 @@ 头（仅复制补丁时出现） | ★3 | ✅已复核 |
| 7 | subagent | 时间线回合收口标记缺信息：FE 固定文本（`— turn completed —` 等），忽略 stopReason/elapsedMs；TUI 渲染 `Worked for X`/`Turn failed in Xs`；子代理取消路径（无子会话 done 事件）永远缺收口标记 | ★3 | 未复核 |
| 8 | bg_task | 弹窗缺 TUI preamble：description（primary 色）+ `$ command` 软换行 + bash 高亮；FE 只有纯文本 command 盒，title（描述）不展示 | ★3 | 未复核 |

## 设计取舍 / 美化级（低优先）

- **read 图片数据源**：TUI 从本地路径加载（`ScrollbackImageRef::from_path`），FE 只认 wire base64。
  wire `ImageContent.data`/`mime_type` 均必填，实际场景 FE 能正常显示；仅当 wire 只带文件路径 uri 且非 http(s) 时落回 `(image)`。裸 base64 无 mime 默认 image/png 仅在旧形状下有瑕疵。
- **read 占位重复**：正文额外渲染 `(empty)`/`(image)`/`(N pages)` 与行头后缀重复；TUI 这些信息只在行头（✅已复核）。
- **edit hunk gap**：FE 裸 `…`，TUI 计算 `… N unchanged lines`（✅已复核）。
- **web_search citations**：FE 行内展开即追加 `1. url` 列表；TUI 行内只有 Sources 域名行，查看器是 `─────` + `Sources (N)` + `[n] url`。
- **search_tool 查看器**：TUI 查看器补 `limit: N`、`N results`、每条 `   description` 缩进行；FE 行内/查看器共用简化版。
- **fetch 元数据**：TUI `status: 200, content_type: markdown, size: 12 KB`；FE `status 200 · markdown · 11.8 KB`（无标签、· 分隔）。错误态 TUI 正文不渲染文本，FE 渲染红色 ErrorLine。
- **workflow 查看器**：BlockViewer 只显示 status/detail/name，缺 objective/阶段轨迹/agent 数/elapsed；ScrollEntry.workflow 无 runId 关联 workflowRuns。
- **workflow 面板**：phase rail 缺每阶段 agent 计数、running-agent→active 推导、current_phase 兜底（'All agents'）、roster 按阶段过滤；canResume 缺 failed/cancelled、canStop 缺 budget_limited；runElapsedMs 有 wire elapsed_ms 时冻结不叠加。
- **WorkflowEntry 死代码**：FE 从不创建 `kind:'workflow'` 滚动条目（workflow_updated 只写面板 + session_event 文本行），TaskEntries/BlockViewer 的 workflow 行与正文不可达；TUI 的 WorkflowBlock 常驻 scrollback（行尾阶段轨迹 + `(N agents)`）。
- **kill/cancel 按钮**：无 pending 单向守卫（可连点重复发送），不处理响应 outcome（already finished/not_found 时行停留在 running）。
- **子代理活动后缀**：FE 用最近进度 tick 的最后一个工具名 / e.detail 数值摘要；TUI 用 turn-tracker 活动（Thinking/Responding/Compacting…，无活动且 busy 显示 'Waiting'）。
- **subagent 标题栏**：缺 context_source 徽标（resumed/forked）；cancelled 图标黄色（TUI 走 error 红，与 FE 自身行内 bullet 不一致）。
- **thought 预览结构**：FE 前 5 行 + `…` + 后 3 行；TUI 只有 `… + 尾部 3 行`，且按软换行后行数计数。
- **thought 纯文本**：未做 markdown 渲染（查看器同）；TUI 渲染 markdown。需确认是否为有意取舍。
- **assistant 流式**：流式期间（及 settle 等待期）正文以 markdown 源码直出，TUI 边流边渲染 —— ✅有意设计（Markdown.tsx L507 成本模型注释）。
- **session_event 文案**：compaction 等为中文改写（`自动压缩上下文…`），TUI 英文原文（`Context N% full. Compacting…`），与同文件 turn 标记逐字对齐 TUI 的惯例分裂。
- **credit_limit**：只渲染单行加粗警告文本，缺 TUI 卡片结构（按 action 的正文 + 可点击 URL 行）。
- **TodoPane 样式**：cancelled 无删除线、图标灰色非错误红；completed/cancelled 正文 muted 而非 gray_bright。
- **子代理查看器嵌套弹窗**：BlockBodyDialog 渲染 SubagentView 不传 now，嵌套条目的 elapsed/统计冻结在打开时刻。
