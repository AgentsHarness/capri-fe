你在两个本地仓库里修一个「设置项点了没反应」的缺陷：Go host `/Users/benin/ccwork/acp-host` 和 capri Web 前端 `/Users/benin/ccwork/acp-fe`。相关参考实现在 `/Users/benin/ccwork/grok-build/crates/codegen/`（`xai-grok-pager` = Rust TUI，`xai-grok-shell` = agent 配置与会话层）。

## 缺陷

FE 设置弹窗里有一个 `follow_up_behavior`（queue / steer）三选一胶囊（`acp-fe/src/components/SettingsModal.tsx:361-380`，点击调 `onPatch({ follow_up_behavior: ... })`），但 host 的写入通道**静默丢弃**这个键：`handleSettingsUpdate` 的 body 是个固定字段 struct（`acp-host/internal/server/http.go:1745-1776`，只有 collapsed_edit_blocks / page_flip_on_send / remember_tool_approvals / permission_mode），未声明的 json 字段被直接丢掉且不报错；再往里还有一层白名单 `writableUIKeys`（`acp-host/internal/acp/ui_settings.go:9-14`）也会拒绝未知键。结果是 FE 拿到「没变化」的响应后 `setData(next)`，开关自己弹回原位——用户看到的就是设置无效，而且没有任何错误提示。同文件的 `permission_mode` 是正常工作的（它同时在白名单和 struct 里），可以拿它当模板。

## 要做的改动

**A. 先取证，别照着 FE 的假设写。** 在 shell/TUI 侧确认这个配置的**真实键名、所在 section、合法取值、以及它的生效时机**：从 `xai-grok-pager` 里搜 `follow_up_behavior`（设置项 setter 与 `[ui]` 定义），再到 `xai-grok-shell` 里搜它的读取处（值枚举类型、`resolve_*` 函数、以及它是每回合读取还是会话创建时读取）。把结论写进最终汇报。如果取证发现 FE 用的键名或取值跟 agent 认的不一致（比如 agent 侧 canonical 是别的字符串），**以 agent 为准**改 FE，而不是让 host 去迁就 FE。

**B. host 支持写入。** 按 `permission_mode` 的现成套路加 `follow_up_behavior`：`settingsUpdateBody` 加字段（指针类型，保持「未提供就不写」的语义）、`handleSettingsUpdate` 里塞进 patch、`writableUIKeys` 加一个校验函数（照 `requirePermissionMode` 的写法，取值集合用 A 步取证到的合法值，非法值返回中文错误消息，风格与现有 `必须是 ask / auto / always-approve` 一致）。写入仍然只落在 `[ui]` 那一个 table（`SetUiSettings` 已经处理了）。

**C. 消除「静默丢弃」这个坑本身。** 现在未知键被 struct 无声吃掉，是这类 bug 的根因。给 `handleSettingsUpdate` 加一个前置检查：把请求体先解成 `map[string]any`，凡是出现了白名单之外的已知 FE 设置键（或者说：任何 `settingsUpdateBody` 不认识的 `[ui]` 键）就返回 400 并明确说明「不允许的设置项 <key>」，让前端能看见错误而不是被弹回。实现要克制，别顺手把 settings 写入重构成通用透传。补一个 Go 用例：未知键 → 400；合法 `follow_up_behavior` → 写进 config.toml 的 `[ui]` 且响应里能读回来（先看 `internal/server/` 现有 settings 测试怎么搭 fake config 路径，照抄结构）。

**D. FE 侧收口。** 如果 A 步取证出 FE 的键名/取值就是对的，那 FE 只需要保证这条改动失败时用户看得见（现有 `onPatch` 已经 `pushToast(e.message)`，确认 400 的错误消息能正常冒出来即可）。如果不一致，改 FE 对齐 agent。另外检查 `GET /api/settings` 的返回（`settingsPayload`，`http.go:1737-1743, 1797+`）到底会不会把 `[ui].follow_up_behavior` 回吐给前端——不会的话，胶囊的选中态是从哪来的（`ui?.follow_up_behavior`）？把这个数据流也一并核实并在汇报里讲清楚，必要时补上读取路径。

> 提示：`git status` 里可能出现不属于本任务的改动（其它会话在同一工作区作业）。这是正常的——只按文件路径操作你自己的改动，不要回滚、不要顺手"修好"别人的部分。

## 约束

- 只改这个任务相关的文件。FE 侧预期落在 `src/components/SettingsModal.tsx`、`src/api/transport.ts` 的 `SettingsPatch` 类型、以及对应测试；host 侧落在 `internal/server/http.go`、`internal/acp/ui_settings.go` 与它们的测试文件。**不要动** `src/components/ContextModal.tsx`、`SessionInfoModal.tsx`、`McpPanel.tsx`、`src/commands/registry.ts`。
- 不要 `git add`、不要 `git commit`，两个仓库的改动都留在工作区，由我 review。
- 验证：host 侧 `go build ./...` + `go test ./internal/...`；FE 侧 `npx tsc -b` + `npx oxlint` + `npx vitest run`（基线全绿，不许变红、不许靠删用例变绿）。
- 最终用中文汇报：A 步的取证结论（键名/section/合法值/生效时机，各带 file:line）、两个仓库改了哪些 file:line、GET 返回是否含该键的核实结果、两侧测试输出最后 5 行原文。
