/**
 * 会话身份（标题 / 副行摘要 / 模型）的唯一写入口。
 *
 * 这几个状态都天然多来源，分散写会互相覆盖、且「谁是权威」散落在各 handler：
 *  - 标题：`session_summary_generated`（自动生成）、`session_info` /
 *    `session_info_update`（含手动改名保护）、roster / 会话列表刷新；
 *  - 一轮动作摘要：`last_turn_summary`（live）、roster 的 `lastTurnSummary`；
 *  - 模型：`model_changed`（agent 广播）、`model`（本端 setModel 回声）、
 *    `models_update`（目录热重载）、ready/hello 快照（`applySessionModelState`）。
 *
 * 标题与摘要都直接写 `sessions` 行（sidebar 的单一 live 事实源），当前
 * 会话的 `sessionTitle` 只是同一份数据的视图侧镜像。
 *
 * 这里收敛「标题写入」「副行摘要写入」与「模型身份（名称+档位）写入」
 * 三条规则；目录/档位选项表仍由 model.ts 的 applySessionModelState 负责。
 */
import type { SessionInfo } from '../../api/types'
import type { ChatState, SetState } from './types'

/**
 * 写入会话标题。
 * `isManual` = 事件自称手动改名（`_meta['x.ai/titleIsManual'] === true`）：
 * 本端不因该事件改写标题（另一端的手动改名经 roster / 会话列表刷新到达）。
 * 空标题与同值标题不写。
 *
 * `sessionId` = 标题所属会话：带值时写 `sessions` 里该行（sidebar 的 live
 * 标题源）；缺省或等于当前会话时同时更新 `sessionTitle`（命令面板 / 当前
 * 视图）。行不存在时只做当前会话那半，不凭空插入名册行。
 */
export function applySessionTitle(
  set: SetState,
  get: () => ChatState,
  title: unknown,
  opts: { isManual?: boolean; sessionId?: string } = {},
): void {
  if (opts.isManual === true) return
  const next = typeof title === 'string' ? title.trim() : ''
  if (!next) return
  const cur = get()
  const sid = opts.sessionId
  const patch: Partial<ChatState> = {}
  if ((!sid || sid === cur.sessionId) && next !== cur.sessionTitle) {
    patch.sessionTitle = next
  }
  if (sid) {
    const idx = cur.sessions.findIndex((s) => s.sessionId === sid)
    if (idx >= 0 && cur.sessions[idx].title !== next) {
      const sessions = cur.sessions.slice()
      sessions[idx] = { ...sessions[idx], title: next }
      patch.sessions = sessions
    }
  }
  if (Object.keys(patch).length > 0) set(patch)
}

/**
 * 写入会话行的一轮动作摘要（sidebar 副行）。
 *
 * 空白摘要按缺失处理（不写）：`last_turn_summary` 是覆盖写，agent 不会发
 * 空串；若真的收到空串，保留上一轮的摘要比清空副行更有信息量。行不在
 * 名册里时跳过（不给未知会话凭空插行）。
 */
export function applySessionLastTurnSummary(
  set: SetState,
  get: () => ChatState,
  summary: unknown,
  sessionId?: string,
): void {
  const next = typeof summary === 'string' ? summary.trim() : ''
  if (!next) return
  const cur = get()
  const sid = sessionId || cur.sessionId
  if (!sid) return
  const idx = cur.sessions.findIndex((s) => s.sessionId === sid)
  if (idx < 0 || cur.sessions[idx].lastTurnSummary === next) return
  const sessions = cur.sessions.slice()
  sessions[idx] = { ...sessions[idx], lastTurnSummary: next }
  set({ sessions })
}

/**
 * 全量会话列表刷新时的副行摘要保留。
 *
 * `/api/sessions` 的行来自 agent 的 session/list，不带 `lastTurnSummary`；
 * 而 live 的 `last_turn_summary` 事件（以及 roster 行级补丁）已经把摘要
 * 写进了当前的 `sessions` 行。直接整表替换会让 sidebar 副行回退到
 * workspace-list 的旧摘要，所以按 sessionId 合并：新行缺摘要（缺失或
 * 空白）时沿用旧行的非空摘要，新行有值则**以新值为准**（删掉副行的
 * 权威更新不能被旧值盖回去）。
 *
 * 只处理两份都存在的会话：新出现的会话没有旧摘要可继承，旧列表里有、
 * 新列表里没有的会话（已删除 / 换 host）也不会被复活。其余字段
 * （title / status / census）一律保持新行的值——全量快照仍是权威。
 * 没有任何行需要补时返回原数组引用，避免无意义的状态更新。
 */
export function preserveLiveSessionSummary(
  prev: SessionInfo[],
  next: SessionInfo[],
): SessionInfo[] {
  if (prev.length === 0 || next.length === 0) return next
  const prevById = new Map(prev.map((s) => [s.sessionId, s] as const))
  let changed = false
  const merged = next.map((row) => {
    if (typeof row.lastTurnSummary === 'string' && row.lastTurnSummary.trim()) return row
    const kept = prevById.get(row.sessionId)?.lastTurnSummary?.trim()
    if (!kept) return row
    changed = true
    return { ...row, lastTurnSummary: kept }
  })
  return changed ? merged : next
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
