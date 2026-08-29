# FE（acp-fe）与 Grok Build TUI 差异审查报告

- 审查日期：2026-08-13
- 审查基线：`acp-fe` @ `main`（db959a5，worktree `acp-fe-review-main`）
- 对比对象：Grok Build TUI（`xai-grok-pager` / `xai-grok-markdown` / `xai-grok-shell`，`ccwork/grok-build`）+ 官方用户指南 `~/.grok/docs/user-guide/`（01–24 全量）
- 方法：TUI 侧按用户指南 24 章 + pager/shell 源码（views/、scrollback/blocks/、markdown crate）梳理功能面；FE 侧通读 `src/` 全部组件与 store（约 44k 行）；逐功能 1:1 对照，关键差异已在源码中二次验证
- 后续：本报告是 2026-08-13 的快照，基线较旧，条目状态会随提交漂移。2026-08-30 对其中若干条目做过逐项复核，并已把可执行的部分拆成带 file:line 现状与验收门槛的任务书，见 [`task-briefs/`](task-briefs/README.md)（含已完成项的提交号）

---

## 一、总体结论

FE 已经完成了 TUI 绝大部分**核心交互与渲染**的移植，复刻程度整体较高（估计 **≈75–80%**），且部分维度（图片内联、Mermaid 真 SVG、Git 面板、Hub 多 Host）**超过** TUI。剩余差距集中在四类：

1. **键盘可发现性层**：TUI 几乎全键驱动（`Ctrl+O/Ctrl+M/Ctrl+;/Ctrl+S/Ctrl+T/Ctrl+G/Ctrl+B/Ctrl+E`、`g/G`、`PgUp/PgDn`、`Ctrl+U/D`、`y/r`、`Shift+E`、`Esc Esc` 语义阶梯、快捷键帮助条/面板），FE 大量操作只能点击。这是体验差异的第一来源。
2. **搜索与检索**：滚动区 `/` 搜索、`@` 文件选择器、`/history` 会话内容搜索、会话选择器内容搜索 —— FE 全部缺失。
3. **输入形态**：语音输入、`/btw` 小话、补全建议（wire 已就绪）、`#` remember 模式、非图片文件拖拽路径 —— 缺失或半成品。
4. **管理面面板**：Todos 面板、Agent Dashboard、worktree 管理（wire 已有 12 个方法但无 UI）、hooks/marketplace 可写 UI、memory 读写、personas/agents 目录 —— 缺失或只读占位。

另有少量**渲染保真度**差异：编辑块单列行号 vs TUI 双列行号、无 follow 指示器、无虚拟化（长会话 DOM 成本）、无视频内联。

各功能域复刻程度评分（✅ 完整 / 🟡 部分 / ❌ 缺失，见第三节逐项依据）：

| 功能域 | 评分 | 一句话 |
|---|---|---|
| 布局与导航 | 🟡 | 核心布局对齐；缺 Welcome 屏、Dashboard、Todos/Tasks/Queue 侧栏、快捷键条 |
| Composer 与输入 | 🟡 | slash/历史/队列/shell/图片 chip 完整；缺 @选择器、语音、补全、/btw |
| 滚动区渲染 | 🟡 | 块模型/折叠/分组/sticky/时间戳/LaTeX/Mermaid 完整；缺搜索、raw、复制键、视频 |
| 权限与模式 | ✅ | 权限卡键盘全套、模式循环、PlanApproval、CancelPanel 均对齐 |
| 会话管理 | 🟡 | 全操作链路在；缺内容搜索、worktree 会话、Claude 导入 |
| 面板 | 🟡 | git/mcp/usage/context/goal/workflows 完整；extensions/memory/settings 只读或占位 |
| 主题 | ✅ | 5 主题 + accent 矩阵 + glyph + wave 动画全移植 |
| 键盘快捷键 | ❌ | 仅覆盖 TUI 快捷键的约 1/3（见第四节全表） |
| 渲染原理 | 🟡 | 流式 checkpoint 思路有对应物；无虚拟化、无搜索、diff 单列行号 |

---

## 二、架构与渲染原理对比

### 2.1 总体架构

| 维度 | TUI | FE |
|---|---|---|
| 技术栈 | Rust + ratatui + crossterm，全屏 alt-screen（另有 minimal 原生回滚模式） | React 18 + Vite + Tailwind v4 + Zustand，DOM/CSS |
| 运行形态 | 直连 x.ai 的完整客户端，同时是 ACP 协议实现方（shell 后端 + pager 前端） | `acp-host`（Local）或 `acp-hub`（Hub 多 Host）的 Web 客户端，事件经 SSE/WebSocket 转发 |
| 会话持久化 | `~/.grok/sessions/<cwd>/<id>/` JSONL（`updates.jsonl` 权威 + rewind 快照 + compaction 段） | 会话本体在 host 侧；前端只持久化主题/历史/置顶/待办/token（localStorage + hub `/api/prefs`） |
| 输入模型 | 终端键事件（crossterm，键位内置不可重映射），鼠标事件 | DOM 键盘/鼠标事件，各模态自管焦点 |
| 能力边界 | 直接调工具、直接执行 shell、直接写文件 | **不执行任何 fs/terminal**，一切经 host 转发（设计如此，非缺失） |

### 2.2 滚动区渲染模型

| 维度 | TUI | FE | 差距 |
|---|---|---|---|
| 数据模型 | `IndexMap<EntryId, ScrollbackEntry>`，O(1) 查找；`running`/`flashing` 集合；`dirty_heights` 增量布局 | entries 数组 → `projectDisplayRows()` 合成显示行（verbGroup 分组缓存） | 思路一致，FE 分组模型是 TUI 的移植 |
| 绘制策略 | `compute_paint_window()` 只画可见行；scroll_offset 为 `usize`（支持 >65535 行长会话） | **全部条目挂 DOM**（`content-visibility` 试过已移除，破坏锚定）；浏览器原生滚动 | 长会话 FE 的 DOM 节点数线性增长，卡顿风险；TUI 恒定 O(视口) |
| 流式 markdown | `StreamingMarkdownRenderer`：checkpoint 冻结（仅顶层块边界），只重渲 tail，O(N)；source_map 行映射 | 流式期纯文本直出（零解析）；收口 60ms + idle 后按 ≤2048 字符**结构完整块**渐进格式化；thought 尾窗 1600 字符/6 行 | 实现路线不同但效果对齐；FE 每块全量解析的粒度更细 |
| 语法高亮 | syntect，内置 3 个 tmTheme，随主题自动选，二进制内不可替换 | highlight.js，未知语言 pass-through | 引擎不同，效果接近 |
| 代码主题 | 颜色量化管线（truecolor/256/16 降级） | CSS 变量，浏览器原生真彩 | 无差距（web 天然真彩） |
| LaTeX | `$…$`/`$$…$$`/`\(…\)`/`\[…\]` → Unicode 近似（pretty 模式） | 自写转换器（`latexMath.ts`）同样输出 Unicode 近似，含行环境 | **对齐**（`latexMath.ts` 就是按 TUI 语义移植的） |
| Mermaid | 终端内只能渲染代码块 + `◇ mermaid` 文本 affordance（Open Image / Copy Source） | mermaid.js 懒加载渲染**真 SVG**，同样带 `◇ mermaid [Open Image] [Copy Source]` 工具条、未闭 fence/失败回退盒装源码 | **FE 更强**（真图），工具条语义对齐 |
| 图片 | Kitty graphics（iTerm2 回退）+ 图片 viewer modal；视频经 ffmpeg 出 poster 后内联 | 原生 `<img>` 内联 + BlockViewer | 渲染原理不同但 web 天然更强；**视频缺失** |
| 动画 | 30fps accent 波浪、thinking/运行命令强调线、finish flash | rAF ~30fps wave（sin² 行相位）、FINISH_FLASH_MS=400、pending 冻结、`prefers-reduced-motion` 冻结 | 对齐，FE 多了无障碍降级 |
| 编辑块 | **双列行号**（GitHub 风格 `dual_line_numbers`）、hunk 分隔符、per-hunk syntect 首绘 + 全文件高亮升级（有界）、折叠 diffstat | 每 hunk 一个面板 + 合并 diffstat + 分页（VIEWER_PAGE_LINES），但**单列行号**（`newNo ?? oldNo`） | 小差距：双列行号缺失 |
| execute 块 | `$`/Run 头、`cd &&` peel、流式截断 live tail（前 2 后 3）完成展开 | 行内截断预览 + 双进 viewer | 对齐 |
| 搜索 | 滚动区内 `/` 搜索（InputBarMode::Search）、`/history` 内容搜索、session picker 内容搜索 | **无任何搜索**（Ctrl+F 是打开 viewer） | ❌ 明显缺口 |
| 滚动锚定 | sticky 用户 prompt 头、`page_flip_on_send`、follow 模式（overscroll 跟尾 + ▼/▲ 指示器）、`respect_manual_folds` | stickyPin 钉选、发送后钉顶对齐；**无 follow 指示器**、无 manual-fold 保持 | 🟡 |
| ANSI | crossterm style 渲染 | `ansi-to-html` + 预剥离 OSC/DCS/APC/PM 与非 m CSI | 对齐 |
| 持久化回放 | 本地 JSONL 秒开 | 会话切换 = `/api/session-updates` 回放 + 500ms 防串话 + 回放中状态行 | 对齐（网络代价） |

### 2.3 输入/编辑器原理

| 维度 | TUI | FE |
|---|---|---|
| 编辑器 | readline / vim 模态（实验），原生终端编辑；`Ctrl+A/E`、`Alt+Backspace`、`Ctrl+W/U/K`、undo、`Shift+方向键` 选择 | 浏览器 textarea 原生编辑（自带 undo/选择），粘贴大文本原子 chip |
| 提示/补全 | slash 菜单（fuzzy，带描述/参数 hint/来源）、**@ 文件选择器**、completion dropdown、suggestion_controller | slash 菜单 fuzzy ✓；`transport.suggest/suggestPrompt` 已就绪但 **UI 未挂**；无 @ 选择器 |
| 文件引用 | @ 文件/行区间/目录浏览、.gitignore 尊重、! 搜隐藏 | ✗（浏览器无法取本地路径，但可经 host `/api/shell` 做目录浏览） |
| 图片输入 | 粘贴/拖拽 → `[Image #N]` chip + hover 预览；**非图片文件 → 绝对路径文本** | 粘贴/拖拽 image/* → chip + 缩略图；**非图片文件拖拽被忽略**（注释自认浏览器限制） |

### 2.4 通知/集成

| 维度 | TUI | FE |
|---|---|---|
| 通知 | OSC 9/99/777/BEL 按终端自动选、睡眠抑制、标签页进度条（OSC 9;4） | `document.title` 合成（title.*/progress_bar/action-required）+ ToastStack + 完成 ✓ 替换 | 对齐（web 等价物） |
| 终端标题 | 反映 agent 状态（session/cwd/model/turn-timer） | document.title 同样组合 | 对齐 |
| 光标色 | OSC 12 accent_user / OSC 112 还原 | N/A（无终端光标） | — |

---

## 三、功能实现逐项对比

> 图例：✅ 完整复刻 · 🟡 部分复刻 / 有替代 · ❌ 缺失 · ➕ FE 独有（TUI 无或更弱）

### 3.1 布局与导航

| 功能 | TUI | FE | 程度 |
|---|---|---|---|
| 全屏双区（scrollback + prompt） | ✅ | ✅（TopBar + ErrorBanner + 侧栏为 web 演化） | ✅ |
| Welcome 屏（最近会话/工作区/新 worktree/导入 Claude） | ✅ | 空状态 figlet + 「选择工作目录」DirectoryPickerModal | 🟡 |
| Agent Dashboard（`Ctrl+\`，多会话总览/peek/attach/pin/分组/搜索） | ✅ | ❌（Hub 模式以 **Host 选择器**替代，是不同架构） | ❌ |
| Todos 面板（`Ctrl+T`） | ✅ | ❌（只有 plan 条目的 TodoMark + WorkspaceBar TodoChip） | ❌ |
| Tasks 面板（`Ctrl+G`，子代理/后台任务/monitor/loop 带行数徽标） | ✅ | 🟡 RunningTasksBar（bg/subagent/workflow + 调度任务 + kill/cancel），无 monitor 行数徽标、无键盘 | 🟡 |
| Prompt Queue 面板（`Ctrl+;`） | ✅ | 🟡 队列面板完整（编辑/重排/删除/清空/hold），但无快捷键 | 🟡 |
| 底部 shortcuts bar（上下文相关，focus hint） | ✅ | ❌ | ❌ |
| 状态行（`◎ waiting · send a message to interrupt` / `◎ N commands…`） | ✅ | ✅ turn status 行（⠋ 活动+阶段计时+总计时+⇣Nt 速率+[↓]+[stop]；空闲 `○ N commands still running` 脉冲） | ✅ |
| 焦点模型（Tab 切换 / simple 模式 Space / vim i） | ✅ | 🟡 Tab 切换 ✓，Space/i 无 | 🟡 |

### 3.2 Composer 与输入

| 功能 | TUI | FE | 程度 |
|---|---|---|---|
| slash 命令 fuzzy 菜单 | ✅ 描述/参数 hint/来源（builtin/skill/plugin） | ✅ 名称+描述+[agent] 标签合并 agent 命令 | ✅ |
| 本地 slash 命令集 | 69（见附录 A） | 34（见附录 B） | 🟡 |
| prompt 历史（`↑` 空输入） | ✅ | ✅ localStorage 上限 50 条 | ✅ |
| `/history` 会话内 fuzzy 搜索 | ✅ | ❌ | ❌ |
| shell 模式（`!`） | ✅ 直接执行 | ✅ 经 `/api/terminal` piped 执行，`$ cmd` + ANSI + `exit N` | ✅ |
| `#` remember 模式 | ✅ | ❌（仅 `/remember` 命令） | 🟡 |
| 多行 `/multiline`（Enter/Shift+Enter 语义反转） | ✅ | ✅ | ✅ |
| 模型选择器 | ✅ `Ctrl+M` 或 `/model` | 🟡 底边框按钮菜单 + effort 档位 + 设为默认模型，**无 Ctrl+M** | 🟡 |
| effort 档位 | ✅ `/effort low|medium|high|xhigh` | ✅ | ✅ |
| 主题选择器 | ✅ `/theme` 实时预览/循环 | ✅ ThemePicker + `/theme` 循环（groknight→…→auto） | ✅ |
| 模式循环 `Shift+Tab` | ✅ Normal→Plan→Always | ✅ Normal→Plan→Auto→Always（多 Auto 档） | ✅ |
| `Ctrl+O` 切 always-approve | ✅ | ❌ | ❌ |
| 图片粘贴/拖拽 | ✅ chip + hover 预览 | ✅ chip + 缩略图 + Enter/双击展开 | ✅ |
| 非图片文件 → 路径 | ✅ | ❌ 忽略（浏览器限制） | ❌ |
| 语音输入 | ✅（mic 检测、10s 无语音自动停、GROK_VOICE_CAPTURE 回退） | ❌（全仓无 getUserMedia/SpeechRecognition） | ❌ |
| 运行中 Enter 排队 | ✅ | ✅ server-authoritative + 本地乐观行 + degraded 徽标 | ✅ |
| 双 Enter 发队首 | ✅ | ✅ | ✅ |
| send-now（Ctrl+Enter 等和弦） | ✅ 多终端变体 | ✅ Ctrl+Enter（先 cancel + queueInterject 版本校验） | ✅ |
| `/btw` 小话 | ✅（不打断，minimal 可关面板） | ❌（`transport.btw` 存在，无 UI 调用方） | ❌ |
| 补全建议（completion dropdown / suggestion controller） | ✅ | ❌（suggest wire 就绪，UI 预留注释） | ❌ |
| 粘贴大文本 | 终端原生 | ✅ 原子 `[Pasted: N lines]` chip + 预览 overlay | ➕ |
| `/loop` 调度任务 | ✅ scheduler_create/list/delete | ✅（**prompt 路径**让 agent 调 host；RunningTasksBar 展示+删除） | 🟡 |
| 40/64KiB prompt 上限 | ✅ dashboard toast | ✅ used/size flags 显示 | ✅ |

### 3.3 滚动区渲染与条目

| 功能 | TUI | FE | 程度 |
|---|---|---|---|
| markdown 全功能（标题/列表/引用/表格/代码/链接/hr） | ✅ | ✅ react-markdown + remark-gfm + 主题化表格 | ✅ |
| 语法高亮 | ✅ syntect | ✅ highlight.js | ✅ |
| Mermaid | 🟡 代码块+affordance | ✅ 真 SVG + 工具条 + 回退 | ➕/✅ |
| LaTeX → Unicode | ✅ | ✅ 自写转换器（含行环境、\mathbb 等） | ✅ |
| 图片内联 | ✅ kitty | ✅ `<img>` 圆角边框 | ✅（web 更强） |
| 视频内联 | ✅ kitty + ffmpeg poster + viewer | ❌（types 无 video 字段） | ❌ |
| 思考块（collapsed/truncated/expanded + 动画线 + 截断 3 行） | ✅ | ✅ 三态 + 流式尾窗 + Thought for Ns | ✅（无 Ctrl+E 全展开键） |
| 工具调用块（动词+目标头+折叠置灰） | ✅ | ✅ 折叠/展开/双进 viewer | ✅ |
| 编辑块 | ✅ 双列行号/hunk/diffstat/合并同文件 | ✅ hunk 面板+diffstat+同文件合并；**单列行号** | 🟡 |
| execute 块（截断 live tail） | ✅ 前2后3 | ✅ 行内截断预览 | ✅ |
| 搜索匹配结果块（files/pattern/count） | ✅ | ✅ MetaLine 模式标签 + 文件匹配行号 | ✅ |
| 动词分组（group_tool_verbs） | ✅ | ✅ verbGroup（Read 3 files, Searched 2 patterns + N more） | ✅ |
| 折叠/展开（←/→/h/l + `›` 指示） | ✅ | ✅ | ✅ |
| Shift+E 全部展开/收起、Ctrl+E 全思考块 | ✅ | ❌ | ❌ |
| raw markdown（`r`） | ✅ | ❌ | ❌ |
| 复制块内容（`y`）/ 块元数据（`Shift+Y`） | ✅ | 🟡 仅 `/copy`（复制最近助手回复）；无块级复制键 | 🟡 |
| 全屏块查看器（Enter/Ctrl+F） | ✅ | ✅ BlockViewer（bg_task 轮询 stdout、subagent 内嵌时间线） | ✅ |
| 滚动区搜索 `/` | ✅ | ❌ | ❌ |
| 时间戳（/timestamps，hover 全格式） | ✅ | ✅ 短格式+hover 扩展，user 行移动端也显示 | ✅ |
| sticky 用户 prompt 头 | ✅ | ✅ stickyPin（钉选+推开+点击跳回） | ✅ |
| 用户消息目录（timeline） | ✅ | ✅ 右侧 UserMessageNav rail（2s 淡出/点击跳转） | ✅ |
| follow 模式（overscroll 跟尾、指示器、manual folds） | ✅ | 🟡 自动跟尾 ✓；无 ▼/▲ 指示器、无 manual-fold 保持 | 🟡 |
| 历史分页加载 | ✅ | ✅ 上滑到顶拉旧轮（冷却/手势门控/视口保持） | ✅ |
| g/G 跳顶底、Ctrl+J/K 单行、PgUp/PgDn、Ctrl+U/D 半页 | ✅ | ❌（原生滚轮/触摸板替代） | ❌ |
| 选区（SelectionBox） | ✅ | ✅ 纯 CSS 边框选区 + 复制让位 | ✅ |
| 悬停高亮 | ✅ | ✅ | ✅ |
| 滚动条/边距/折叠指示 | ✅ | ✅ 布局常量（居中 960px、3px accent） | ✅ |
| 空状态 | ✅ Welcome | ✅ figlet 字符画 + 目录选择 | ✅ |
| 会话加载/切换 | — | ✅ 覆盖层+交叉淡入+回放中 | ➕ |

### 3.4 权限与模式

| 功能 | TUI | FE | 程度 |
|---|---|---|---|
| 权限卡键盘化（↑↓/j/k、Tab、1-9、Enter、Esc park、Ctrl+C） | ✅ | ✅ 全套 | ✅ |
| always 范围调整（←/→：精确→目录→通配） | ✅ | ✅ + 自动开模式编辑器 | ✅ |
| `e` 手编 always-allow 模式 | ✅ | ✅ glob 编辑器（Enter 持久 isGlob） | ✅ |
| `Ctrl+F` 展开/收起完整参数 | ✅ | ✅（>5 行折叠） | ✅ |
| RejectOnce 带反馈消息 | ✅ | ✅ 行内 followup 输入 | ✅ |
| remember_tool_approvals / 危险命令列表 | ✅ | ✅（always 行过滤；危险命令在 host 侧） | ✅ |
| 权限重置（`_x.ai/permissions/reset`） | ✅ | ✅ `/permissions-reset` + 按钮 | ✅ |
| 子代理权限溯源行 | ✅ | ✅ `Subagent "name":` / `Child session (untracked):` | ✅ |
| 模式循环 + banner | ✅ | ✅ 本地乐观 + persist + 2s 全亮 banner | ✅ |
| plan mode（只读 + plan.md） | ✅ | ✅ `/plan`、plan 中禁止编辑（host 侧）、`plan·auto` 叠加 | ✅ |
| exit_plan_mode 审批视图 | ✅ a/s/c/y/q + Tab | ✅ a/s/Enter/Esc + 行号评论（`Proposed plan line 12:` 格式对齐） | 🟡（y 复制/q 放弃/c 行内评论键缺失，但鼠标可完成） |
| cancel 面板（1-4 + 偏好持久化） | ✅ | ✅（选项 3/4 存偏好后不再问） | ✅ |
| Esc 语义阶梯（含 Esc Esc 800ms 清空/rewind） | ✅ 完整表格 | 🟡 单 Esc：关菜单→焦点→取消；**无 Esc Esc** | 🟡 |
| ask_user_question 多题/多选/freeform | ✅（1-9、a-f、z、Space、Tab、[]、y、Shift+X、Ctrl+F） | ✅（j/k、1-9、Space 多选、Tab 切题、freeform「其他」、plan 模式 chat_about_this/skip_interview） | 🟡（z/y/Shift+X/[] 键缺失） |

### 3.5 会话管理

| 功能 | TUI | FE | 程度 |
|---|---|---|---|
| 会话列表（分组/状态图标/上下文进度条/排序） | ✅ dashboard+sidebar | ✅ 目录/标记双形态、状态图标（active/awaiting/idle）、>90% 红进度条、排序规则对齐 | ✅ |
| 置顶/待办（pin/todo） | ✅ | ✅ localStorage + hub prefs 同步 + 三态待办 | ✅ |
| 新建/继续/恢复 | ✅（Ctrl+N/Ctrl+S、双击确认） | ✅（侧栏按钮；无 Ctrl+N/S） | 🟡 |
| rename/delete（确认） | ✅ | ✅（行内改名、删除确认、运行中禁删） | ✅ |
| fork | ✅（--worktree/--no-worktree） | ✅ 基础 fork；**无 worktree 选项** | 🟡 |
| compact（含自动压缩事件） | ✅ | ✅（session/compact + auto_compact_* 事件 + 阈值估算） | ✅ |
| rewind（快照+文件恢复） | ✅ Esc Esc 触发 | ✅ RewindPicker（两阶段确认、仅对话/对话+文件、busy 先 cancel-offer、冲突 warning） | ✅ |
| recap（「我在哪」摘要） | ✅ | ✅ 两段式 Recap 块（session_recap 事件） | ✅ |
| session-info | ✅ | ✅（含 share 链接 x.ai/share_session） | ✅ |
| /context 上下文明细 | ✅ | ✅ 分类条 + 工具/技能/MCP 估算 + auto-compact 阈值 | ✅ |
| 会话搜索（内容扩展） | ✅ session picker + SQLite FTS | ❌ | ❌ |
| worktree 会话管理 | ✅ 对话框 + x.ai/git/worktree/* | ❌（transport 有 12 个 gitWorktree* 方法，**无 UI 调用方**） | ❌ |
| 导入 Claude 设置/会话 | ✅ | ❌（transport.sessionImport 存在，无 UI） | ❌ |
| 会话分享链接 | ❌ | ✅ x.ai/share_session | ➕ |

### 3.6 面板与扩展

| 功能 | TUI | FE | 程度 |
|---|---|---|---|
| Git 面板 | 🟡 无独立面板（git 散见：worktree 对话框、只读命令放行） | ✅ GitPanel：status/branch/ahead-behind/checkout/stage/unstage/discard/diff/commit(+amend)/stash，两段确认 | ➕/✅ |
| MCP 面板 | ✅ 启停/工具/认证/添加/删除 | ✅ 事件流 + 合并列表 + 逐工具启停 + auth + 添加表单 + **call/read_resource** | ✅（FE 更全） |
| Extensions（hooks/plugins/skills/marketplace） | ✅ 全可写（r/a/x/Space/信任） | 🟡 skills 实时启停 ✓；**hooks/plugins 只读**（点按钮提示「需在 TUI/配置中修改」）；**marketplace 纯占位文案**；wire 方法均存在但无 UI | 🟡 |
| Settings | ✅ 读写 config.toml | 🟡 只读安全子集 + CustomModelsPanel 可写 `[model.*]` + 热加载 | 🟡 |
| Usage/Billing | ✅ | ✅ 额度 + 聚合报告（窗口/缓存命中/按模型表） | ✅ |
| Context 用量 | ✅ 状态栏 chip | ✅ ContextChip（hover 进度条）+ ContextModal | ✅ |
| Memory | ✅ 读写/搜索/删除/on-off/rewrite | 🟡 只读列表 + 查看/删除提示「去 TUI」；`/memory on|off`、`/dream` 走 prompt 路径 | 🟡 |
| Workflows 面板 | ✅ p/r/x/s | ✅ 面板 + 详情 + p/r/x/s 键；**控制走 prompt 路径**（无 wire）+ 乐观标记 | 🟡 |
| Goal | ✅ /goal + 状态机 | ✅ GoalChip（状态/暂停/恢复/清除/提示词路径）+ `/goal`（host /api/goal/*） | ✅ |
| deep-research | ✅ | ❌ | ❌ |
| 子代理卡片 + 全屏子 transcript | ✅ | ✅（标题栏状态图标/模型/elapsed、mini scrollback、context gauge、统计） | ✅ |
| Agents 目录（subagent catalog） | ✅ | ❌（transport.subagentListRunning/Get 存在无 UI） | ❌ |
| Personas / config-agents | ✅ | ❌ | ❌ |
| 公告（announcements + CTA） | ✅ modal + 隐藏键 | 🟡 状态行去重展示（无 CTA 交互） | 🟡 |
| 反馈（/feedback） | ✅ | ❌ | ❌ |
| 教程/文档/release-notes/doctor | ✅ | ❌ | ❌ |
| 会话内账户（/login /logout /privacy） | ✅ | —（hub token 门禁替代） | — |
| 调度任务管理 | ✅ tasks pane | ✅ RunningTasksBar（interval/nextFireAt/delete） | ✅ |
| monitor 事件 | ✅ | ✅ bg_task 卡片 + pulse 动画 + kill | ✅ |

### 3.7 主题

| 功能 | TUI | FE | 程度 |
|---|---|---|---|
| 主题集 | grok-night/grok-day/tokyo-night 等 | ✅ 5 个（+ rosepine-moon、oscura-midnight）+ Auto 跟随系统 | ✅ |
| 主题槽位（bg/accent/text/semantic/diff/markdown…） | ✅ | ✅ tokens.ts 全量移植（含 prompt-border、selection、diff 四色） | ✅ |
| accent 矩阵（工具家族/完成闪光/折叠 dim/pending 冻结） | ✅ | ✅ accents.ts 全量移植 | ✅ |
| glyph/图标（❯ ◆ ◇ ✗ ✓ › ‹） | ✅ | ✅ glyphPaths.ts SVG 路径 + braille spinner + monitor pulse | ✅ |
| wave 动画（30fps） | ✅ | ✅ rAF sin² 行相位 + reduced-motion | ✅ |
| 主题实时预览 | ✅ | ✅ picker 即时 applyTokens | ✅ |

### 3.8 协议与传输

| 维度 | TUI | FE |
|---|---|---|
| 传输 | 本地进程内 ACP | Local: SSE `/events`（EventSource 自动重连）；Hub: WebSocket `/ws/fe`（token/flate 压缩/退避重连）+ gap-pull + 本机 SSE 近路 |
| 事件面 | 全量 x.ai/* 原生 | 40+ 主事件 + 50+ session_notification 子标签全处理；未知 x.ai/* 自动拒绝（SUPPORTED 仅 ask_user_question/exit_plan_mode/diff_review） |
| 能力声明 | 直接 | 依赖 acp-host 桥接（README 所列 /api/* 端点） |

---

## 四、键盘快捷键全量对比

> ✅ FE 有等价键 · 🟡 FE 有功能但无键（点击可达）· ❌ FE 无功能

| TUI 键 | 动作 | FE | 备注 |
|---|---|---|---|
| `j/k` `↑/↓` | 条目导航 | ✅ | |
| `←/→` `h/l` | 折叠/展开 | ✅ | |
| `Enter` | 打开 viewer / 发送 | ✅ | |
| `Esc` | 取消/关闭/泊车 | ✅ | 单级；无 Esc Esc |
| `Tab` | 焦点切换 / 卡片行内循环 | ✅ | |
| `Space`（simple 模式） | 聚焦 prompt | ❌ | 点击即可 |
| `Shift+Tab` | 模式循环 | ✅ | |
| `Ctrl+Enter` | send-now | ✅ | |
| `Ctrl+C` | 取消回合（先清草稿） | ✅ | 有选区时让位复制 |
| `Ctrl+F` | viewer（TUI 也是 viewer；另作参数展开） | ✅ | |
| `Ctrl+O` | 切 always-approve | ❌ | 🟡 仅 Shift+Tab |
| `Ctrl+M` | 模型选择器（scrollback）/多行（prompt） | ❌ | 🟡 按钮菜单 |
| `Ctrl+S` | 会话选择器 | ❌ | 🟡 侧栏 |
| `Ctrl+N` | 新会话 | ❌ | 🟡 按钮 |
| `Ctrl+T` | Todos 面板 | ❌ | ❌ 无面板 |
| `Ctrl+G` | Tasks 面板 | ❌ | 🟡 RunningTasksBar |
| `Ctrl+;` | 队列面板 | ❌ | 🟡 点击 |
| `Ctrl+B` | 前台命令转后台 | ❌ | 🟡 [↓] 按钮 |
| `Ctrl+L` | Extensions / interject(家族) | ❌ | 🟡 按钮 |
| `Ctrl+P` `?` | 命令面板 | ❌ | ❌ 无 |
| `Ctrl+.` `Ctrl+X` | 快捷键帮助 | ❌ | ❌ 无 |
| `Ctrl+E` | 展开/收起全部 thinking | ❌ | 🟡 逐块 |
| `Shift+E` | 全部展开/收起 | ❌ | ❌ |
| `Shift+J/K` | 跳到下一/上一 assistant | ❌ | ❌ |
| `Shift+H/L` `Shift+←/→` | 上一/下一 turn | ❌ | 🟡 UserMessageNav 点击 |
| `g` / `Shift+G` | 底 / 顶 | ❌ | ❌ |
| `Ctrl+K`/`Ctrl+J` | 上/下滚一行 | ❌ | ❌ |
| `PgUp/PgDn` | 页滚动 | ❌ | 原生滚轮 |
| `Ctrl+U/D` | 半页滚动 | ❌ | ❌ |
| `r` | raw markdown 切换 | ❌ | ❌ |
| `y` / `Shift+Y` | 复制块 / 块元数据 | ❌ | 🟡 /copy 命令 |
| `1-9` | 权限/问题直达 | ✅ | |
| `←/→`（权限卡） | always 作用域 | ✅ | |
| `e`（权限卡） | 编辑模式 | ✅ | |
| `z` / `a-f` / `y` / `Shift+X` / `[` `]`（问题卡） | freeform/直达/复制/忽略/切题 | 🟡 | Tab 切题 ✓，其余 ❌ |
| `Ctrl+O`（权限卡） | 开 always-approve | ❌ | |
| cancel 面板 `1-4` | 选项 | ✅ | |
| `a/s/c/y/q`（plan 审批） | 批准/修改/评论/复制/放弃 | 🟡 | a/s/Enter ✓；c 以点击选行+Shift 选范围实现，y/q ❌ |
| 队列 `x/e/↑↓/Shift+J/K` | 管理 | ✅ | 还有 Ctrl+↑↓ |
| rewind `y/n/c/f/a/r` | 确认/范围 | ✅ | |
| workflows `p/r/x/s` | 控制 | ✅ | |
| `/`（滚动区） | 搜索 | ❌ | ❌ 无搜索 |
| `F2` | 设置 | ✅ | |

**FE 实际覆盖 TUI 快捷键约 1/3**，且缺失的多为「跳转/管理/发现性」键。

---

## 五、反向差异（FE 独有 / 强于 TUI）

| 项 | 说明 |
|---|---|
| ➕ Hub 多 Host 选择/管理 | TopBar Host 切换器、配对码、改名/删除、hostId 过滤、本机 SSE 近路 |
| ➕ 访问密钥门禁 | hub FE_TOKEN → AccessTokenGate，token 仅存 localStorage 不烧构建 |
| ➕ Mermaid 真 SVG | TUI 终端只能代码块 + affordance |
| ➕ 图片/截图真内联 | `<img>` 圆角边框；TUI 需 Kitty/iTerm2 图形协议 |
| ➕ GitPanel 完整 UI | TUI 无独立 git 面板；FE 有 status/diff/stage/discard/commit/stash/checkout |
| ➕ MCP 调用/读资源 UI | x.ai/mcp/call + read_resource，6k 截断展示 |
| ➕ 粘贴大文本原子 chip | 粘贴 ≥4 行 → chip + 预览 overlay + 整块删除 |
| ➕ 主题实时预览下拉 | 含 Auto 跟随系统 |
| ➕ Toast 通知栈 | web 端通知 fallback |
| ➕ 队列 host 同步 | queueEdit/Remove/Reorder/Clear/HoldEdit/ReleaseEdit 全量 wire |
| ➕ 移动端适配 | 顶栏 history 下拉、⋮ 更多菜单、主题手风琴 |

---

## 六、差异清单汇总

### 6.1 缺失（TUI 有、FE 完全没有）— 13 项

1. 滚动区搜索（`/`）+ 会话内容搜索（`/history`）+ session picker 内容搜索
2. `@` 文件选择器（fuzzy/行区间/目录浏览/隐藏文件）
3. 语音输入
4. `/btw` 小话（transport 有，无 UI）
5. 补全建议 UI（suggest/suggestPrompt wire 就绪，未挂 UI）
6. Todos 面板（Ctrl+T）
7. Agent Dashboard 多会话总览（架构性差异，Hub 模式部分覆盖）
8. 快捷键帮助（Ctrl+. / ?）与底部 shortcuts bar
9. worktree 会话管理 UI（wire 有 12 方法）
10. Agents 目录 / Personas / config-agents
11. deep-research / imagine / imagine-video 命令入口
12. 导入 Claude（wire sessionImport 无 UI）
13. 视频内联渲染

### 6.2 部分复刻（行为/触发/深度不齐）— 15 项

1. 键盘：Ctrl+O/M/S/N/T/G/;/B/L/E、Shift+E、Shift+J/K、g/G、PgUp/PgDn、Ctrl+U/D、r、y/Shift+Y、Space 聚焦 —— 均缺键，多为点击可达
2. Esc 语义阶梯（无 Esc Esc 清空/rewind）
3. question card 键（z/a-f/y/Shift+X/[] 缺失）
4. plan 审批键（y/q/c 缺失）
5. follow 指示器与 follow/manual-fold 配置
6. 编辑块双列行号
7. hooks/plugins 可写 UI、marketplace 占位
8. memory 读写/删除/刷新端点 UI
9. workflows 控制（prompt 路径，无 wire 方法）
10. `/memory on|off`、`/dream`（prompt 路径）
11. 公告（无 CTA）、/feedback、/export、/transcript
12. fork 无 worktree 选项
13. Settings 只读（CustomModelsPanel 例外）
14. Tasks 面板缺 monitor/loop 行数与键盘
15. 非图片文件拖拽（浏览器限制，可经 /api/shell 折衷）

### 6.3 渲染原理差异（非缺陷，但影响体验上限）

1. 无虚拟化：长会话 DOM 全量挂载（content-visibility 方案待修）
2. 滚动区搜索缺失 → 长会话无法定位
3. 单列行号编辑 diff vs TUI 双列
4. 无视频
5. markdown 流式：FE 每块渐进格式化（粒度更细，代价是 block 边界内全量重排）

### 6.4 文档/声明不一致（小）

- README 声称的 `/normal` 未注册（registry 无）；`/clear` 是 `/new` 别名 ✓；`/always-approve` ✓

---

## 七、未来改进方向（路线图）

按「对齐 TUI 体验的杠杆大小」排序。P0 = 高频触达、成本低、感知强；P1 = 功能补齐；P2 = 打磨/长期。

### P0 — 键盘与检索（建议 2–3 个迭代做完）

1. **滚动区搜索**
   - 差距：TUI `/` 搜索 + 匹配高亮 + n/N 跳转；FE 完全无搜索，长会话只能肉眼翻。
   - 实现：顶部搜索条（本地遍历 entries 文本 + thought/tool 内容），高亮匹配（mark 标签），`n/N` 下一处/上一处，Esc 关闭；tool/thought 折叠块命中时自动展开到匹配行。纯前端，无需 host 改动。
   - 工作量：M（搜索条 + 高亮 + 折叠联动 + 虚拟定位）。

2. **快捷键补齐与帮助面板**
   - 差距：约 2/3 TUI 快捷键缺失，且无发现入口。
   - 实现：
     - `Ctrl+O`（切 always）、`Ctrl+M`（模型菜单）、`Ctrl+;`（队列）、`Ctrl+S`（会话）、`Ctrl+N`（新建）、`Ctrl+T`（Todo 面板，见 P1）、`Ctrl+G`（任务条）、`Ctrl+B`（转后台）、`Ctrl+L`（扩展）、`Ctrl+E`（thinking 全展开）、`Shift+E`（全部展开/收起）、`g/G`、`PgUp/PgDn`、`Ctrl+U/D`、`y`（复制选中块文本，Clipboard API）、`r`（raw markdown 视图 —— 组件内加 rawSource 渲染分支即可）。
     - `?` / `Ctrl+.`：快捷键帮助 modal（从一份键位声明表渲染，同时作为未来 shortcuts bar 的数据源）。
   - 工作量：S–M（键位多为现成 handler 接线；raw 视图 + 复制需要少量新代码）。

3. **跳转键与选中扩展**
   - `Shift+J/K`（下一/上一 assistant）、`Shift+H/L`（下一/上一 user turn）：在现有 displayRows 上按 kind 扫描即可。
   - 与 UserMessageNav 共享跳转逻辑。

### P1 — 功能补齐（建议 3–5 个迭代）

4. **Todos 面板（Ctrl+T）**
   - 聚合当前会话 plan 条目状态（从 plan 事件流已有数据），列表 + 状态切换（check/uncheck 走 prompt 路径或 plan update wire）；滚动区定位联动。
   - 工作量：M。

5. **补全建议 UI**
   - `transport.suggest/suggestPrompt` 已就绪。输入中触发（防抖 + 光标上下文），下拉候选 + Tab 接受 + Esc 关闭；先接宿主返回的原始建议，fuzzy 排序后续加。
   - 工作量：M。

6. **`@` 文件选择器（经 host 折衷）**
   - 浏览器取不到本地路径，但 host 有 `/api/shell` 与 `find`（DirectoryPickerModal 已用）；新增 `@` 触发 → `/api/shell find` 当前 workspace 目录树（缓存 + 防抖），fuzzy 过滤，选中插入 `@path`；行区间语法 `@file:10-50` 提示支持。
   - 注意：与 TUI 差异在于输入的是**路径文本**而非文件内容（ACP 下 agent 自己读文件，语义等价）。
   - 工作量：M。

7. **worktree 管理 UI**
   - 12 个 `gitWorktree*` wire 方法全部就绪但无调用方。新建会话流程加「在 worktree 中」选项（对齐 TUI `/new` 二次确认 + Ctrl+W 对话框）；侧栏会话行标识 worktree（`wt` 徽标已存在于 WorkspaceBar）；`/session-info` 展示 worktree 关系。
   - 工作量：M（wire 已通，主要 UI + 状态机）。

8. **hooks 可写 + marketplace 真 UI**
   - wire 已有 hooksList/Action、pluginsList/Action、marketplaceList/Action。hooks 启停/删除/信任、marketplace 加源/安装直接接线；「去 TUI」占位文案替换为真面板。
   - 工作量：S–M（复用 McpPanel 的表单/列表模式）。

9. **memory 读写端点**
   - host 需补 read/delete（memory-rewrite 已有）。UI 已有列表骨架；补「查看文件内容」「删除会话文件」；`/memory on|off`、`/dream` 从 prompt 路径升级为 wire（若 host 提供）。
   - 工作量：M（含 host 侧）。

10. **workflow / loop 控制 wire 化**
    - pause/resume/stop 从「prompt 路径 + 乐观」升级为专用方法（host 侧补端点）；`/loop` 同。
    - 工作量：S（host 侧 S）。

11. **视频内联**
    - host 侧把 media 输出（image/video 块）暴露为可访问 URL；FE 加 `video` entry kind，`<video controls>` 渲染 + poster 占位；对齐 TUI 的 poster + viewer 语义。
    - 工作量：M（含 host 侧透传）。

12. **/btw、/feedback、/export、/transcript**
    - `/btw`：transport.btw 接线，Composer 菜单加命令，提交为独立 aside 消息（host 已支持？需验证）。
    - `/feedback`：简化面板（Enter 发送 Esc 丢弃）对齐 TUI。
    - `/export` `/transcript`：会话导出 markdown/JSON（可纯前端拼 updates 流）。
    - 工作量：S–M。

13. **公告升级 + deep-research / imagine 入口**
    - 公告：状态行 → 可点开的公告 modal（含 CTA 链接）。
    - deep-research / imagine：若 host agent 支持相应工具，注册斜杠命令即可（prompt 路径兜底）。
    - 工作量：S。

14. **Welcome 屏**
    - 空状态升级：最近会话列表（已有数据）+ 「新建 / 恢复 / 选择目录」三按钮，对齐 TUI welcome 的信息密度。
    - 工作量：S。

### P2 — 打磨与长期

15. **滚动区虚拟化 / DOM 成本控制**
    - 长会话（数千条）全量 DOM。方向：a) 修复 content-visibility 锚定问题（用 contain-intrinsic-size 正确值 + 锚定元素前置）；b) 真窗口化渲染（可见区间 + 上下缓冲，保留滚动锚定）；c) 阈值触发（>N 条才启用）。注意与 selection/folding/search 高亮的联动。
    - 工作量：L。

16. **渲染保真度**
    - 编辑块双列行号（对齐 TUI dual_line_numbers）；follow 指示器（▼/▲ + 点击回尾）；`Esc Esc` 语义（空闲清空 prompt 存历史 / 空 prompt 开 rewind）；question card 补 z/a-f/y/Shift+X/[]；plan 审批补 y/q。
    - 工作量：M。

17. **任务面板增强**
    - RunningTasksBar → 可停靠面板（Ctrl+G），monitor/loop 行 + 实时行数徽标（monitor_event 已有数据），子代理 catalog（subagentListRunning/Get wire 就绪）。
    - 工作量：M。

18. **/normal 等文档对齐**
    - registry 补 `/normal`（切回 Normal 模式，模式循环已有）；README 与实现同步。
    - 工作量：XS。

19. **语音输入（长期，架构决策）**
    - 浏览器 Web Speech API 只能本地识别；需要 host 侧 voice 转发端点或直接集成 x.ai voice API（TUI 走 `voice/` 模块 + `GROK_VOICE_CAPTURE`）。建议先做「粘贴转写文本」的轻量版，再评估全链路。
    - 工作量：L。

20. **Agent Dashboard（长期，架构性）**
    - 若 Hub 多 Host 场景需要多会话总览，可把 dashboard 设计移植为「跨 Host 会话矩阵」：peek/attach/pin/分组 + Ctrl+\。与现有 Host 选择器并存。
    - 工作量：XL。

---

## 附录 A：TUI slash 命令全表（69 个）

`/always-approve /announcements /auto /btw /cd /compact-mode /compact /config-agents /context /copy /dashboard /debug /delete /docs /doctor /edit-prompt /effort-levels /effort /exit /expand /export /feedback /find /fork /fullscreen /gboom /help /history /home /imagine-video /imagine /import-claude /jump /login /logout /loop /mcps /minimal /model /multiline /new /personas /plan /plugin /privacy /queue /recap /release-notes /remember /rename /resume /rewind /screen-mode-switch /scroll-debug /session-info /settings /share /tasks /theme /timeline /timestamps /toggle-mouse-reporting /transcript /tutorial /usage /view-plan /vim-mode /voice /workflows`

## 附录 B：FE slash 命令全表（34 个）

`/new(/clear) /resume /model /effort /theme /compact /rewind /delete /rename /fork /recap /session-info /context /loop /plan /copy /timestamps /multiline /help /always(/always-approve) /auto /permissions-reset /goal /workflows /memory(/mem) /flush /dream /remember /mcps /hooks /plugins /skills /marketplace /settings`（另有 agent 命令动态合并；README 提及的 `/normal` 未注册）

## 附录 C：审查依据文件

- FE：`src/App.tsx`、`src/components/*`（Composer/Scrollback/TopBar/ApprovalStrip/PlanApproval/CancelPanel/QuestionModal/DiffReviewModal/McpPanel/GitPanel/ExtensionsModal/SettingsModal/UsageModal/ContextModal/MemoryModal/RewindPicker/WorkflowPanel/BlockViewer/SessionHistoryList/UserMessageNav/StatusChips/…）、`src/commands/registry.ts`、`src/hooks/useScrollbackKeys.ts`、`src/store/chat.ts`、`src/api/localTransport.ts`、`src/scrollback/*`、`src/theme/*`
- TUI：`~/.grok/docs/user-guide/01–24`、`xai-grok-pager/src/views/*`、`xai-grok-pager/src/scrollback/*`（block.rs、state/、sticky.rs）、`xai-grok-pager/src/slash/commands/*`、`xai-grok-markdown/src/*`（streaming.rs、checkpoint.rs、render.rs）、`xai-grok-pager/src/app/agent_view/*`（input.rs、media.rs）
