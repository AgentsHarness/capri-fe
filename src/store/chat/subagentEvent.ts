import type { ScrollEntry, SubagentStatus } from '../../api/types'
import type { ChatState, SetState } from './types'
import { nid } from './ids'
import { nonBlankStr } from './util'
import { sealSubagentStreaming } from './subagentView'

/**
 * Normalize a subagent_finished wire status to the entry status set.
 * Absent status = success (the host may omit it); a PRESENT but unknown
 * status (error/timeout/killed/…) must not render as a green "Agent
 * done" — treat it as failed, like handleTaskCompleted's kill/nonzero
 * exit handling.
 */
export function subagentFinishStatus(fields: Record<string, unknown>): SubagentStatus {
  const raw = typeof fields.status === 'string' ? fields.status : ''
  if (raw === 'completed' || raw === 'failed' || raw === 'cancelled') return raw
  return raw === '' ? 'completed' : 'failed'
}

/** Apply a subagent finish to its scrollback entry (shared live/replay). */
export function applySubagentFinish(
  get: () => ChatState,
  set: SetState,
  entryId: string,
  status: SubagentStatus,
  durationMs?: number,
  output?: string,
  error?: string,
  toolCalls?: number,
  turns?: number,
  tokensUsed?: number,
): void {
  set({
    entries: get().entries.map((e) =>
      e.id === entryId && e.kind === 'subagent'
        ? {
            ...e,
            status,
            running: false,
            finishedAt: Date.now(),
            // Authoritative wall-clock (TUI display_elapsed: finished →
            // SubagentFinished duration_ms, not the local spawn stamp).
            ...(durationMs != null ? { durationMs } : {}),
            detail: durationMs != null ? `${(durationMs / 1000).toFixed(0)}s` : e.detail,
            ...(output != null ? { output } : {}),
            ...(error != null ? { error } : {}),
            ...(toolCalls != null ? { toolCalls } : {}),
            ...(turns != null ? { turns } : {}),
            ...(tokensUsed != null ? { tokensUsed } : {}),
          }
        : e,
    ),
  })
}

/**
 * 解析子代理的模型与 effort：
 * 1. 优先读取显式 wire 字段：fields.reasoning_effort / fields.reasoningEffort / fields.effort；
 * 2. fields.model 若自带 "name(effort)" 括号形式，拆出内嵌 effort；
 * 3. 若无显式 effort：
 *    - 若模型缺省或与父会话模型相同，继承父会话当前的 reasoningEffort；
 *    - 若为不同模型，匹配目录 availableModels：若支持 reasoningEffort，取模型配置的默认 effort；
 */
export function resolveSubagentModelAndEffort(
  fields: Record<string, unknown>,
  state: {
    modelName?: string
    reasoningEffort?: string
    models?: import('../../api/types').ModelOption[]
  },
): { model?: string; reasoningEffort?: string } {
  let model = nonBlankStr(fields.model)
  let explicitEffort = nonBlankStr(
    fields.reasoning_effort ?? fields.reasoningEffort ?? fields.effort,
  )

  if (model) {
    const match = model.match(/^(.+?)\s*\(([^)]+)\)$/)
    if (match) {
      model = match[1].trim()
      if (!explicitEffort) explicitEffort = match[2].trim()
    }
  }

  const parentOpt = state.models?.find(
    (m) => m.name === state.modelName || m.modelId === state.modelName,
  )
  const isSameAsParent =
    !model ||
    (state.modelName &&
      (model === state.modelName ||
        (parentOpt && (model === parentOpt.modelId || model === parentOpt.name))))

  const resolvedModel = model || parentOpt?.name || parentOpt?.modelId || state.modelName || undefined

  let reasoningEffort = explicitEffort
  if (!reasoningEffort) {
    if (isSameAsParent) {
      reasoningEffort = state.reasoningEffort || undefined
    } else if (model && state.models?.length) {
      const matched = state.models.find(
        (m) => m.modelId === model || (m.name && m.name.toLowerCase() === model.toLowerCase()),
      )
      if (matched && matched.supportsReasoningEffort !== false) {
        reasoningEffort =
          matched.reasoningEffort ||
          matched.reasoningEfforts?.find((e) => e.default)?.value
      }
    }
  }

  return { model: resolvedModel, reasoningEffort }
}

/**
 * spawn 载荷里的展示元信息（模型 / effort / persona / role / 子代理类型）。
 * 新建行与「注册表补行后回放到 spawn」的补全路径共用，取值口径只有这一处。
 */
function extractSpawnMeta(
  fields: Record<string, unknown>,
  state: {
    modelName?: string
    reasoningEffort?: string
    models?: import('../../api/types').ModelOption[]
  },
): {
  title?: string
  meta: Partial<Extract<ScrollEntry, { kind: 'subagent' }>>
} {
  const title = nonBlankStr(fields.description) ?? nonBlankStr(fields.subagent_type)
  const { model, reasoningEffort } = resolveSubagentModelAndEffort(fields, state)
  const persona = nonBlankStr(fields.persona)
  const role = nonBlankStr(fields.role)
  const subagentType = nonBlankStr(fields.subagent_type)
  return {
    ...(title ? { title } : {}),
    meta: {
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(persona ? { persona } : {}),
      ...(role ? { role } : {}),
      ...(subagentType ? { subagentType } : {}),
    },
  }
}

/** subagent_spawned / subagent_finished (session_notification carrier). */
export function handleSubagentEvent(
  get: () => ChatState,
  set: SetState,
  tag: string,
  fields: Record<string, unknown>,
): void {
  const id = String(fields.subagent_id ?? fields.child_session_id ?? '')
  if (!id) return
  const entryId = get().subagentIndex[id]

  if (tag === 'subagent_spawned') {
    // 已有行可能是两种来源：(1) 本会话 live/回放已建过（幂等，直接返回），
    // (2) 注册表（x.ai/subagent/list_running）先补出来的行——它只有注册表
    // 字段，回放到这里的 spawn 才是 persona / role / 模型元信息的来源，
    // 必须补进去而不是丢弃（否则注册表补出的行永远缺 meta）。
    if (entryId) {
      const spawned = extractSpawnMeta(fields, get())
      const childSid = nonBlankStr(fields.child_session_id)
      set((s) => {
        const cur = s.entries.find((e) => e.id === entryId)
        if (!cur || cur.kind !== 'subagent') return {}
        const merged = {
          ...cur,
          ...(spawned.title ? { title: cur.title || spawned.title } : {}),
          ...spawned.meta,
        }
        const patch: Partial<ChatState> = {
          entries: s.entries.map((e) => (e.id === entryId ? merged : e)),
        }
        // 注册表补行时若缺 child_session_id，spawn 这次补上索引与视图占位。
        if (childSid && !s.subagentChildIndex[childSid]) {
          patch.subagentChildIndex = { ...s.subagentChildIndex, [childSid]: entryId }
          if (!s.subagentViews[childSid]) {
            patch.subagentViews = {
              ...s.subagentViews,
              [childSid]: { items: [], fetchState: 'idle' },
            }
          }
        }
        return patch
      })
      return
    }
    const title =
      (typeof fields.description === 'string' && fields.description) ||
      (typeof fields.subagent_type === 'string' && fields.subagent_type) ||
      id
    const eid = nid()
    // Child session id (wire `child_session_id`, always present alongside
    // subagent_id per the host tests): the subagent session's own event
    // stream is broadcast with this id — the block viewer's mini
    // scrollback is keyed by it (TUI subagent_views 同款).
    const childSid = nonBlankStr(fields.child_session_id)
    const { model, reasoningEffort } = resolveSubagentModelAndEffort(fields, get())
    // Spawn metadata (SubagentSpawned wire fields): the model the child
    // runs, its persona / role and agent type. Stored so the scrollback
    // row and the block viewer can show them (TUI SubagentBlock meta).
    set((s) => ({
      subagentIndex: { ...s.subagentIndex, [id]: eid },
      ...(childSid
        ? {
            subagentChildIndex: { ...s.subagentChildIndex, [childSid]: eid },
            subagentViews: {
              ...s.subagentViews,
              [childSid]: { items: [], fetchState: 'idle' },
            },
          }
        : {}),
      entries: [
        ...s.entries,
        {
          id: eid,
          kind: 'subagent',
          title,
          status: 'started',
          running: true,
          // FE-local spawn stamp: live elapsed while running (TUI
          // SubagentInfo.started_at — the wire only carries duration_ms
          // on progress ticks, which trail by up to 2s).
          startedAt: Date.now(),
          subagentId: id,
          ...(childSid ? { childSessionId: childSid } : {}),
          model,
          reasoningEffort,
          persona: nonBlankStr(fields.persona),
          role: nonBlankStr(fields.role),
          subagentType: nonBlankStr(fields.subagent_type),
        },
      ],
    }))
    // A finish may have replayed BEFORE its spawn: history loads the
    // newest page first, so a subagent_finished in a newer page is
    // orphaned until the older page's subagent_spawned arrives. Apply
    // the buffered finish now — the row carries the REAL status/duration
    // instead of staying "running" on a page boundary.
    const pending = get().pendingSubagentFinishes[id]
    if (pending) {
      applySubagentFinish(
        get,
        set,
        eid,
        pending.status,
        pending.durationMs,
        pending.output,
        pending.error,
        pending.toolCalls,
        pending.turns,
        pending.tokensUsed,
      )
      set((s) => {
        const next = { ...s.pendingSubagentFinishes }
        delete next[id]
        return { pendingSubagentFinishes: next }
      })
    }
    return
  }

  // finished
  const status = subagentFinishStatus(fields)
  // Finish payload fields (SubagentFinished wire): output text, failure
  // error, and the subagent's stats — buffered with the finish so an
  // orphaned finish replay still lands them on the row.
  const output = typeof fields.output === 'string' ? fields.output : undefined
  const error = typeof fields.error === 'string' ? fields.error : undefined
  const toolCalls = typeof fields.tool_calls === 'number' ? fields.tool_calls : undefined
  const turns = typeof fields.turns === 'number' ? fields.turns : undefined
  const tokensUsed =
    typeof fields.tokens_used === 'number' ? fields.tokens_used : undefined
  if (!entryId) {
    // History replay can deliver the finish before its spawn (page
    // boundary, newest page first) — buffer it until the spawn replays.
    // Live finishes never orphan (spawn always precedes finish in real
    // time). Cleared by every loadHistory / session reset.
    const durationMs =
      typeof fields.duration_ms === 'number' ? fields.duration_ms : undefined
    set((s) => ({
      pendingSubagentFinishes: {
        ...s.pendingSubagentFinishes,
        [id]: {
          status,
          ...(durationMs != null ? { durationMs } : {}),
          ...(output != null ? { output } : {}),
          ...(error != null ? { error } : {}),
          ...(toolCalls != null ? { toolCalls } : {}),
          ...(turns != null ? { turns } : {}),
          ...(tokensUsed != null ? { tokensUsed } : {}),
        },
      },
    }))
    return
  }
  const durMs = typeof fields.duration_ms === 'number' ? fields.duration_ms : undefined
  applySubagentFinish(
    get,
    set,
    entryId,
    status,
    durMs,
    output,
    error,
    toolCalls,
    turns,
    tokensUsed,
  )
  // 子代理结束兜底：迷你视图里还挂着的流式条目（streaming 思考/回答）
  // 立即收口——回放分页截断或终态事件缺失时，表头不再停留 "Thinking…"。
  const childSid = nonBlankStr(fields.child_session_id)
  if (childSid) {
    set((s) => {
      const view = s.subagentViews[childSid]
      if (!view) return {}
      const items = sealSubagentStreaming(view.items)
      if (items === view.items) return {}
      return {
        subagentViews: {
          ...s.subagentViews,
          [childSid]: { ...view, items },
        },
      }
    })
  }
}

// ── 子代理迷你 scrollback（subagentViews）──────────────────────────
// 宿主按 withSid 广播所有会话的 session/update 事件；子代理会话
// （child_session_id）的事件流在这里被还原成子代理自己的活动时间线
// （TUI subagent_views 同款）。条目直接构造为主 scrollback 的
// ScrollEntry 模型（tool 条目与 handleEvent 的 tool_call 分支同构）——
// BlockViewer 的迷你时间线复用主渲染体系（scanGroups/projectDisplayRows
// → EntryShell/AccentRail/Bullet），不再自造一套条目与样式。live 事件
// 与按需历史回放（fetchSubagentView）共用同一个处理器。

/**
 * 子代理视图的分页大小（首次回放与上滑分页统一，与主 scrollback 的
 * HISTORY_PAGE_SIZE 同量级）。不设条目上限——完整历史由用户上滑分页获取，
 * 不再丢弃最旧条目。
 */
export const SUBAGENT_VIEW_PAGE_SIZE = 100

/**
 * 子代理流式条目即时收口（与主 scrollback sealThought / sealAssistantStream
 * 对齐）：thought → assistant / tool_call / plan 等推进事件到达时立即收口
 * 进行中的思考/回答段，而不是等到回合终态 done——否则运行中的每个
 * thinking 段都挂着 "Thinking…" 表头直到回合结束（TUI finish_thinking
 * on tool start 同款）。无变化时返回原引用（不触发 store 更新）。
 */
