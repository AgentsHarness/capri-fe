# 区域 06 大组件二 测试笔记（BlockViewer / ApprovalStrip / McpPanel / GitPanel / Markdown / ToolDetail）

【McpPanel.tsx:511】bug: 工具启停按钮传参疑似错误——`onClick` 调 `toggleTool(s.name, t.name, t.enabled !== false)` 传的是**当前** enabled 状态而非翻转值。点击「禁用」（enabled=true）实际调用 `mcpToggleTool(server, tool, true)`，乐观更新把状态写成原值（无变化），statusText 显示「已启用工具」（McpPanel.tsx:197）。与服务器级 `toggleServer(s.name, !enabled)`（:168）的翻转语义不一致；若 host 端按「目标状态」语义处理，该按钮将完全失效。疑似应为 `t.enabled === false`（期望的新状态）。
→ 已确认并修复（现 McpPanel.tsx:566 改为 `t.enabled === false`）：host 端 `/api/mcp/toggle-tool` 按目标状态语义处理，此前该按钮确实是完全失效的空操作。用例已改为双向断言（禁用→false / 启用→true）。

【McpPanel.tsx:627】安全（低危）: MCP 认证链接 `href={authResult.url}` 是全仓唯一绕过 react-markdown `defaultUrlTransform` 协议过滤的裸 `<a href>`（Markdown.tsx 的链接走 react-markdown，`javascript:` 等协议会被清空）。已修：`authServer` 写入 authResult 前用 `/^https?:\/\//i` 白名单过滤，非 http(s) 的 URL 不落进 `url` 字段，卡片落到「已触发认证流程」兜底文案。

【Markdown.tsx:274】疑问: markdown 中 data URI 图片（`![alt](data:image/png;base64,...)`）——react-markdown 默认 urlTransform 过滤掉 `data:` 协议，自定义 img 组件收到的 src 为 undefined，渲染出**无 src 的 `<img>`**（测试实证：`<img alt="alt text" class="...">` 无 src 属性；http(s) 正常）。若历史回放/滚动内容里出现 data-URI 图片的 markdown，将静默无法显示。

【BlockViewer.tsx:299】设计问题: `viewerChrome` 的 `e.kind === 'subagent'` 分支在 BlockViewer 内不可达——subagent 条目永远走 `subagentChrome`（subChrome 非空），该分支只有组件外部复用 `viewerChrome` 时才可能命中（死代码/冗余分支）。

【ToolDetail.tsx:251】设计问题: ReadBody 的图片预览分支实际不可达——`extractToolDetail` 对 `Read/ImageContent` 等 tag 只产出 `{ media: 'image' }` 且 content 恒为 undefined（scrollback/toolDetail.ts extractReadFile:380），`readImageSrc`（ToolDetail.tsx:226）的 data URI / base64 识别逻辑（:229-237）成为死代码，图片内容一律落到 `(image)` 占位（:266）。

【BlockViewer.tsx:785-802,833-834】难测: sticky pin 计算依赖 `getBoundingClientRect`/`scrollTop`/`offsetHeight`（jsdom 恒 0），上滑分页的 `setUserScrolledUp(true)` 与滚动视口恢复分支无法在 jsdom 触发，仅能覆盖「scrollTop<=0 提前返回」路径。

【Markdown.tsx:86-110,152-176,186-197】难测: mermaid [Open Image] 的 canvas 栅格化管线（loadImage/canvasToPngUrl/downloadUrl）与 clipboard 的 execCommand 兜底依赖真实浏览器能力，jsdom 无法覆盖；`requestIdleCallback` 分支通过注入 stub 已覆盖。

【ApprovalStrip.tsx:230-499】难测: keydown 监听器依赖渲染闭包（sel/scopeIdx/patternEdit/followupOpen 等）并经 effect 重挂——测试中连续两次合成按键之间必须强制重渲染（rerender）刷新监听器，否则命中旧闭包（真实浏览器事件循环每键一帧无此问题）。

【Markdown.tsx:246-249,431】难测: 静态渲染路径的 h5/h6 与 mermaid 错误态无按钮行等组合未全覆盖（已尽力，累计 73.87% Stmts，未达标 80% 的是浏览器专属能力代码，见上两条）。