/**
 * 会话身份（标题 / 模型）的唯一写入口。
 *
 * 这两个状态都天然多来源，分散写会互相覆盖、且「谁是权威」散落在各 handler：
 *  - 标题：`session_summary_generated`（自动生成）、`session_info` /
 *    `session_info_update`（含手动改名保护）、roster / 会话列表刷新；
 *  - 模型：`model_changed`（agent 广播）、`model`（本端 setModel 回声）、
 *    `models_update`（目录热重载）、ready/hello 快照（`applySessionModelState`）。
 *
 * 这里只收敛「标题写入」与「模型身份（名称+档位）写入」两条规则；目录/档位
 * 选项表仍由 model.ts 的 applySessionModelState 负责。
 */
import type { ChatState, SetState } from './types'

/**
 * 写入会话标题。
 * `isManual` = 事件自称手动改名（`_meta['x.ai/titleIsManual'] === true`）：
 * 本端不因该事件改写标题（另一端的手动改名经 roster / 会话列表刷新到达）。
 * 空标题与同值标题不写。
 */
export function applySessionTitle(
  set: SetState,
  get: () => ChatState,
  title: unknown,
  opts: { isManual?: boolean } = {},
): void {
  if (opts.isManual === true) return
  const next = typeof title === 'string' ? title.trim() : ''
  if (!next || next === get().sessionTitle) return
  set({ sessionTitle: next })
}

/**
 * 写入模型身份（名称 + 推理档位）。返回名称是否发生变化（调用方据此决定
 * 是否追加"模型已切换"提示行）。
 *
 * 档位规则：wire 给了档位就写；名称变了但 wire 未给档位则**清空**旧档位
 * （沿用旧档位会把它错配到新模型上）；名称未变且未给档位则不动。
 */
export function applyModelIdentity(
  set: SetState,
  get: () => ChatState,
  next: { name?: string | null; effort?: string | null },
): boolean {
  const name = typeof next.name === 'string' && next.name.trim() ? next.name.trim() : undefined
  const effort =
    typeof next.effort === 'string' && next.effort.trim() ? next.effort.trim() : undefined
  const prev = get().modelName
  if (!name) {
    if (effort) set({ reasoningEffort: effort })
    return false
  }
  const changed = name !== prev
  set({
    modelName: name,
    ...(effort ? { reasoningEffort: effort } : changed ? { reasoningEffort: undefined } : {}),
  })
  return changed
}
