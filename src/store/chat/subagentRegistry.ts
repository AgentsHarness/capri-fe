import type { ScrollEntry } from '../../api/types'
import type { ChatState } from './types'
import { nid } from './ids'
import { nonBlankStr } from './util'

/**
 * agent 的活动子代理注册表（`x.ai/subagent/list_running`）→ subagent 条目。
 *
 * 为什么需要它：`subagent_spawned` 只在它自己那一轮被回放到时才建行，而
 * 首屏只回放最后 1 轮（INITIAL_TURNS）。所以在别的轮次里派出去、现在还
 * 在跑的子代理，切换/刷新会话后顶部完全看不到——TUI 不会这样，它
 * `session/load` 后按 agent 侧的注册表重建 tasks / subagent 面板。
 * 这里补上同一条路：注册表是「当前仍在跑」的权威来源，与顶部任务条
 * 取自 `x.ai/task/list` 的分工完全一致。
 *
 * 与中继探活的分工（同 topTasks 的取舍）：注册表里的行都杀得掉
 * （`x.ai/subagent/cancel`），所以它才是条目的唯一来源。
 */

/** 注册表行（agent `SubagentLiveSnapshotDto`，camelCase 由 serde 决定）。 */
export interface RunningSubagentRow {
  subagentId: string
  childSessionId?: string
  parentSessionId?: string
  subagentType?: string
  description?: string
  startedAtMs?: number
  durationMs?: number
  turns?: number
  toolCalls?: number
  tokensUsed?: number
  contextWindowTokens?: number
  contextUsagePct?: number
  toolsUsed?: string[]
  errorCount?: number
}

/**
 * 归一一行注册表条目。字段名两种拼写都收（host 透传 agent 的 camelCase，
 * 但旧 host / 直连 agent 可能给 snake_case），缺 subagentId 的行丢弃。
 */
export function parseRunningSubagent(
  src: Record<string, unknown>,
): RunningSubagentRow | null {
  const subagentId =
    nonBlankStr(src.subagentId) ?? nonBlankStr(src.subagent_id)
  if (!subagentId) return null
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const tools = Array.isArray(src.toolsUsed)
    ? (src.toolsUsed as unknown[]).filter(
        (t): t is string => typeof t === 'string' && t !== '',
      )
    : Array.isArray(src.tools_used)
      ? (src.tools_used as unknown[]).filter(
          (t): t is string => typeof t === 'string' && t !== '',
        )
      : undefined
  return {
    subagentId,
    childSessionId:
      nonBlankStr(src.childSessionId) ?? nonBlankStr(src.child_session_id),
    parentSessionId:
      nonBlankStr(src.parentSessionId) ?? nonBlankStr(src.parent_session_id),
    subagentType:
      nonBlankStr(src.subagentType) ?? nonBlankStr(src.subagent_type),
    description: nonBlankStr(src.description),
    startedAtMs:
      num(src.startedAtEpochMs) ?? num(src.started_at_epoch_ms),
    durationMs: num(src.durationMs) ?? num(src.duration_ms),
    turns: num(src.turnCount) ?? num(src.turn_count),
    toolCalls: num(src.toolCallCount) ?? num(src.tool_call_count),
    tokensUsed: num(src.tokensUsed) ?? num(src.tokens_used),
    contextWindowTokens:
      num(src.contextWindowTokens) ?? num(src.context_window_tokens),
    contextUsagePct:
      num(src.contextUsagePct) ?? num(src.context_usage_pct),
    toolsUsed: tools,
    errorCount: num(src.errorCount) ?? num(src.error_count),
  }
}

/** 从任意响应包络里取出注册表数组（host 可能包一层 result）。 */
export function parseRunningSubagents(raw: unknown): RunningSubagentRow[] {
  const list = findSubagentsArray(raw)
  return list
    .filter(
      (x): x is Record<string, unknown> =>
        !!x && typeof x === 'object' && !Array.isArray(x),
    )
    .map(parseRunningSubagent)
    .filter((r): r is RunningSubagentRow => r !== null)
}

function findSubagentsArray(root: unknown): unknown[] {
  const seen = new Set<unknown>()
  const walk = (v: unknown, depth: number): unknown[] | null => {
    if (v == null || depth > 6) return null
    if (typeof v !== 'object') return null
    if (seen.has(v)) return null
    seen.add(v)
    if (Array.isArray(v)) return null
    const o = v as Record<string, unknown>
    if (Array.isArray(o.subagents)) return o.subagents
    for (const k of ['result', 'data', 'payload']) {
      const found = walk(o[k], depth + 1)
      if (found) return found
    }
    return null
  }
  return walk(root, 0) ?? []
}

/**
 * 一行注册表条目 → 运行中的 subagent 条目。
 *
 * 与 `subagent_spawned`（subagentEvent.handleSubagentEvent）产出的条目形状
 * 保持一致：同一个 BlockViewer / 任务条渲染路径、同一个 cancel 入口。
 * startedAt 取注册表的 `started_at_epoch_ms`（真实派发时刻，不是拉取时刻）
 * ——否则切换会话后 elapsed 会从 0 重新计时。
 */
export function subagentEntryFrom(row: RunningSubagentRow, now: number): ScrollEntry {
  const detail = [
    row.turns != null ? `turns=${row.turns}` : undefined,
    row.toolCalls != null ? `tools=${row.toolCalls}` : undefined,
    row.contextUsagePct != null ? `${row.contextUsagePct}%` : undefined,
    row.durationMs != null ? ` · ${(row.durationMs / 1000).toFixed(0)}s` : undefined,
  ]
    .filter((s): s is string => !!s)
    .join(' ')
  return {
    id: nid(),
    kind: 'subagent',
    title: row.description || row.subagentType || row.subagentId,
    status: 'started',
    running: true,
    // 注册表给的是真实派发时刻；缺失才回落到本次拉取时刻。
    startedAt: row.startedAtMs ?? now,
    subagentId: row.subagentId,
    ...(row.childSessionId ? { childSessionId: row.childSessionId } : {}),
    ...(row.subagentType ? { subagentType: row.subagentType } : {}),
    ...(row.durationMs != null ? { durationMs: row.durationMs } : {}),
    ...(row.turns != null ? { turns: row.turns } : {}),
    ...(row.toolCalls != null ? { toolCalls: row.toolCalls } : {}),
    ...(row.tokensUsed != null ? { tokensUsed: row.tokensUsed } : {}),
    ...(row.contextWindowTokens != null
      ? { contextWindowTokens: row.contextWindowTokens }
      : {}),
    ...(row.contextUsagePct != null ? { contextUsagePct: row.contextUsagePct } : {}),
    ...(row.toolsUsed ? { toolsUsed: row.toolsUsed } : {}),
    ...(row.errorCount != null ? { errorCount: row.errorCount } : {}),
    ...(detail ? { detail } : {}),
  }
}

/**
 * 把注册表结果折进当前视图（**回放之后**调用）。
 *
 * 时机很关键：loadHistory 会先清空 entries（并整体替换为回放结果），所以
 * 结果在回放前落地会被回放覆盖掉。调用方在回放收口后再折进，才活着。
 *
 * 只补行 + 合进度，绝不据缺失收口（finish 事件是唯一的终态来源，见
 * syncLiveSubagents 的注释）。无变化时返回 null，调用方不写 store。
 */
export function foldRunningSubagents(
  get: () => ChatState,
  rows: RunningSubagentRow[],
  now: number,
): Pick<
  ChatState,
  'entries' | 'subagentIndex' | 'subagentChildIndex' | 'subagentViews'
> | null {
  if (rows.length === 0) return null
  const s = get()
  let entries = s.entries
  let subagentIndex = s.subagentIndex
  let subagentChildIndex = s.subagentChildIndex
  let subagentViews = s.subagentViews
  let changed = false

  for (const row of rows) {
    const existingId = s.subagentIndex[row.subagentId]
    if (existingId) {
      // 已有行（回放或 live 建过）：只把注册表更新的进度合进去，不重建行
      // ——重建会丢掉回放拿到的 persona / role / 模型元信息。
      const next = entries.map((e) =>
        e.id === existingId && e.kind === 'subagent'
          ? mergeSubagentProgress(e, row)
          : e,
      )
      if (next.some((e, i) => e !== entries[i])) {
        entries = next
        changed = true
      }
      continue
    }
    const entry = subagentEntryFrom(row, now)
    entries = [...entries, entry]
    subagentIndex = { ...subagentIndex, [row.subagentId]: entry.id }
    if (row.childSessionId) {
      subagentChildIndex = {
        ...subagentChildIndex,
        [row.childSessionId]: entry.id,
      }
      // 迷你时间线视图占位：与 subagent_spawned 同款，宿主为该子会话
      // 广播的事件流才有地方落（弹窗打开时按需回放）。
      if (!subagentViews[row.childSessionId]) {
        subagentViews = {
          ...subagentViews,
          [row.childSessionId]: { items: [], fetchState: 'idle' },
        }
      }
    }
    changed = true
  }

  if (!changed) return null
  return { entries, subagentIndex, subagentChildIndex, subagentViews }
}

/**
 * 把注册表里的进度字段合进一条已存在的 subagent 条目（缺失字段不动，
 * 空值不覆盖已有值）。运行中的行才写 detail 摘要——已结束的行保留收口
 * 时的耗时文案（与 handleSubagentEvent 的 subagent_progress 同款）。
 */
function mergeSubagentProgress(
  e: Extract<ScrollEntry, { kind: 'subagent' }>,
  row: RunningSubagentRow,
): Extract<ScrollEntry, { kind: 'subagent' }> {
  const detail = e.running
    ? [
        row.turns != null ? `turns=${row.turns}` : undefined,
        row.toolCalls != null ? `tools=${row.toolCalls}` : undefined,
        row.contextUsagePct != null ? `${row.contextUsagePct}%` : undefined,
      ]
        .filter((s): s is string => !!s)
        .join(' ')
    : undefined
  return {
    ...e,
    ...(row.durationMs != null ? { durationMs: row.durationMs } : {}),
    ...(row.turns != null ? { turns: row.turns } : {}),
    ...(row.toolCalls != null ? { toolCalls: row.toolCalls } : {}),
    ...(row.tokensUsed != null ? { tokensUsed: row.tokensUsed } : {}),
    ...(row.contextWindowTokens != null
      ? { contextWindowTokens: row.contextWindowTokens }
      : {}),
    ...(row.contextUsagePct != null ? { contextUsagePct: row.contextUsagePct } : {}),
    ...(row.toolsUsed ? { toolsUsed: row.toolsUsed } : {}),
    ...(row.errorCount != null ? { errorCount: row.errorCount } : {}),
    ...(detail ? { detail } : {}),
  }
}
