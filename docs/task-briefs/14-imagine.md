你在 /Users/benin/ccwork/acp-fe（React 19 + TS + zustand + vitest，capri 的 Web 前端）里实现 `/imagine`（以及 `/imagine-video`，如果取证支持）。参考实现在 /Users/benin/ccwork/grok-build/crates/codegen/xai-grok-pager（TUI）与 …/xai-grok-tools（指令与工具名来源）。

## 背景

FE 完全没有 imagine 入口，而且它**不会自动出现**在 agent 广播的命令里，所以必须 FE 自己实现。取证要点：

1. TUI 的 `/imagine` 在 `xai-grok-pager/src/slash/commands/imagine.rs`：命令名与指令文本都来自 `xai_grok_tools::implementations::grok_build` 的 `IMAGINE_COMMAND_NAME`、`imagine_instruction(prompt)`、`imagine_usage_message()`、`IMAGE_GEN_TOOL_NAME`；`required_tools = [IMAGE_GEN_TOOL_NAME]`（测试 `requires_image_gen_tool` 断言它是 `"image_gen"`）；空参数返回 `CommandResult::Message(imagine_usage_message())`；有参数返回
   ```
   CommandResult::InjectSkill {
       display_text: format!("/imagine {prompt}"),
       prompt_blocks: vec![ContentBlock::Text(TextContent::new(imagine_instruction(prompt)))],
       display_as_skill: false,
       scheduled_task_preview: None,
   }
   ```
   也就是说：**发给模型的是 `imagine_instruction()` 生成的指令块，但界面上显示的是用户敲的 `/imagine <描述>`**。同目录还有 `imagine_video.rs`，先读它确认它对应哪个工具、指令函数叫什么。
2. shell 侧**没有** `imagine` 这个 builtin（`xai-grok-shell/src/session/slash_commands.rs` 的 `BUILTIN_COMMANDS` / `PROMPT_COMMANDS` 里没有它），而且 `PAGER_COMMAND_KEYS`（同文件 `:487-597`）把 `imagine` / `imagine-video` 都烧成了保留名，所以 agent 不会广播它、也不会让同名 skill 占用它。结论：FE 拿不到这条命令，只能本地实现。
3. 你必须去 `xai-grok-tools` 里读到 `imagine_instruction()` 与 `imagine_usage_message()` 的**真实文本**（在 `…/xai-grok-tools/src/implementations/grok_build/` 下搜这两个函数名），FE 的指令要忠实复刻它的语义（工具名、参数提示、aspect_ratio 之类可选项、产物如何回呈现）。不要在没读到原文的情况下自己编一段。

## 要做的改动

**A. 取证**（上面第 1、3 条）：`imagine_instruction()` 与 `imagine_usage_message()` 的原文、`/imagine-video` 对应的工具名与指令函数、以及 host/agent 侧这两个工具在当前 capri 会话里是否真的可用（在 `/Users/benin/ccwork/acp-host` 与 `xai-grok-tools` 里查工具注册；FE 侧 `src/api/types/tools.ts` 与 `src/store/chat/tools.ts` 看有没有工具清单可用）。把「不可用时会发生什么」也查清楚（agent 会不会回一句没有该工具）。
**B. 指令构造。** 新建 `src/commands/imagine.ts`：导出 `imagineInstruction(prompt: string): string` 与 `imagineUsageMessage(): string`（以及 video 版），逐条对齐 A 步读到的 TUI 文本语义；注释里标明「复刻自 xai-grok-tools 的 imagine_instruction，agent 侧改名需同步」。
**C. 显示文本与发送内容分离。** FE 的 `useChatStore.getState().send(text, blocks, opts)` 签名支持分开传「显示文本」和「内容块」（实现见 `src/store/chat/send.ts`，先读它确认这两个参数各自的用途、以及本地滚动区最终显示哪一个）。要求达到 TUI 的效果：用户敲 `/imagine 一只戴帽子的柴犬`，界面上留下的是 `/imagine 一只戴帽子的柴犬`，而发给模型的是指令块文本。如果 `send` 的现有语义做不到这种分离，**不要**为了它改 send 的内部逻辑——退化成把指令文本原样发出（并在汇报里说明为什么以及退化后的用户体验差异）。
**D. 命令注册。** 在 `src/commands/registry.ts` 加 `/imagine`（`argHint: '<description>'`，`description` 中文，风格对齐同文件其它条目）和 `/imagine-video`（如果 A 步确认工具存在且语义不同；不存在就不加，汇报里说明）。要点：
   - 空参数 → 输出用法提示（用同文件的 `note()`，文案用 B 步复刻的 usage）。
   - busy（回合进行中）时的行为要跟 `/loop` 一致：走队列而不是打断（`src/store/promptQueue.ts`，参考 registry 里 `/loop` 的 busy 分支写法）。
   - A 步若确认 `image_gen` 工具在当前 host 上不可用，命令仍然要注册，但要在发出前给一次明确提示（不要静默失败）。FE 目前没有 `required_tools` 门控（`SlashCommand` 类型里没这个字段），不要为这一个命令引入门控架构。
**E. 测试。** `src/commands/imagine.test.ts` 断言指令构造的输出（含 prompt 里的空白/超长输入处理）；registry 层断言 `/imagine` 无参数出用法、有参数会调用 send 且传入的内容块是指令文本、busy 时进队列。

> 提示：`git status` 里可能出现不属于本任务的改动（其它会话在同一工作区作业）。这是正常的——只按文件路径操作你自己的改动，不要回滚、不要顺手"修好"别人的部分。

## 约束

- 只改本任务相关文件（新增 `src/commands/imagine.ts` 与测试、`registry.ts` 里加条目与 import）。**不要动** `ContextModal.tsx`、`SessionInfoModal.tsx`、`McpPanel.tsx`、`ApprovalStrip.tsx`、`ExtensionsModal.tsx`。
- 不要 `git add` / `git commit`。
- 验证全绿：`npx tsc -b`、`npx oxlint`、`npx vitest run`（基线全绿，不许变红、不许靠删用例变绿）。
- 最终用中文汇报：A 步取证到的 `imagine_instruction` 原文要点（贴关键片段）、`imagine-video` 的结论、工具可用性结论、C 步最终走的是分离还是退化、改了/新增了哪些 file:line、测试输出最后 5 行原文。
