import type { ChatState, SetState } from '../types'
import type { WireEvent } from './wire'
import { formatTurnDuration } from '../format'
import {
  tailAlreadyTurnEnded,
} from '../turn'
import { modelLabel } from '../model'
import { appendEntry } from '../entries'
import { applyFollowUps } from '../followUps'
import {
  parseScheduledTask,
  removeScheduledTask,
  scheduledTaskDeleteReason,
  scheduledTaskDeletedText,
  updateScheduledTaskFire,
  upsertScheduledTask,
} from '../tasks'
import { wireTaskId } from '../util'

export function handleNotifApps(
  set: SetState,
  get: () => ChatState,
  ev: WireEvent,
  tag: string,
  fields: Record<string, unknown>,
): boolean {
  switch (tag) {
          case 'model_changed': {
            // 多会话广播：非当前会话的 model_changed 忽略（事件可能在
            // 顶层或 params 携带 sessionId；`model` 事件同款守卫）。
            const notifSid =
              (ev as { sessionId?: string }).sessionId ??
              (typeof ev.params?.sessionId === 'string'
                ? ev.params.sessionId
                : undefined)
            if (notifSid && notifSid !== get().sessionId) break
            // 会话切换中忽略：agent 的 session/load 会把持久化的模型 id
            // 映射到当前 catalog 键（如 deepseek-v4-flash →
            // deepseek-v4-flash-go）并广播新模型的默认 effort（如 low），
            // 会覆盖 load 响应恢复的用户原档位（如 max）。切换期间模型
            // 状态以 HTTP load 响应为准（ready 事件同款守卫）。
            if (get().historyLoading) break
            const id =
              (typeof fields.model_id === 'string' && fields.model_id) ||
              (typeof fields.modelId === 'string' && fields.modelId) ||
              ''
            if (!id) break
            const m = get().models.find((x) => x.modelId === id)
            const effortRaw =
              fields.reasoning_effort ??
              fields.reasoningEffort ??
              (fields._meta &&
              typeof fields._meta === 'object' &&
              fields._meta !== null
                ? (fields._meta as Record<string, unknown>).reasoningEffort ??
                  (fields._meta as Record<string, unknown>).reasoning_effort
                : undefined)
            const name = m?.name || id
            const prevName = get().modelName
            const prevEffort = get().reasoningEffort
            // Wire effort only for the new model's label: if the
            // broadcast omits it, the parens are dropped rather than
            // recycling the previous model's effort into the new one.
            // The state update below also skips when the wire omits it
            // (leaving reasoningEffort untouched — same as the old
            // no-op fallback).
            const wireEffort =
              typeof effortRaw === 'string' && effortRaw.trim()
                ? effortRaw.trim()
                : undefined
            set({
              modelName: name,
              ...(wireEffort ? { reasoningEffort: wireEffort } : {}),
            })
            // A model_changed broadcast marks a switch point: print the
            // "模型已从 xx(effort) 切换到 xx(effort)" line. The echo of
            // our own optimistic setModel usually arrives after modelName
            // was already updated (prevName === name) — nothing switched
            // from this store's perspective, so it stays silent (the
            // setModel line already recorded it). The host never persists
            // model_changed, so replay shows switches via the
            // user_message_chunk modelId diff in replayUpdates instead.
            if (prevName && prevName !== name) {
              appendEntry(set, {
                kind: 'session_event',
                text: `模型已从 ${modelLabel(prevName, prevEffort)} 切换到 ${modelLabel(name, wireEffort)}`,
                warning: true,
              })
            }
            break
          }
          // ── workflows (TUI workflows pane) ───────────────────────────
          case 'workflow_updated': {
            const f = fields as Record<string, unknown>
            const runId = typeof f.run_id === 'string' ? f.run_id : ''
            if (!runId) break
            const name = typeof f.name === 'string' ? f.name : runId.slice(0, 8)
            const status = typeof f.status === 'string' ? f.status : ''
            const phase =
              typeof f.current_phase === 'string' ? f.current_phase : undefined
            // Optional payload — parse defensively (the wire only
            // guarantees runId/name/status; the panel degrades when the
            // extras are absent): progress (0..1 or 0..100), script
            // (save-script source), agent roster, start time.
            const rawP = f.progress ?? f.progress_pct ?? f.progressPct
            const pNum = typeof rawP === 'number' ? rawP : Number(rawP)
            const progress =
              rawP != null && rawP !== '' && Number.isFinite(pNum)
                ? pNum > 1
                  ? pNum / 100
                  : pNum
                : undefined
            const rawAgents = Array.isArray(f.agents)
              ? f.agents
              : Array.isArray(f.agent_roster)
                ? f.agent_roster
                : undefined
            // Agents may be plain labels (older producers) or full
            // WorkflowAgentInfo objects {label, state, tokens_used, …}.
            // Both collapse into the same roster; the list-row labels come
            // from the same source (TUI shows them per row).
            const agentRoster = rawAgents
              ?.map((a) => {
                if (a && typeof a === 'object' && !Array.isArray(a)) {
                  const o = a as Record<string, unknown>
                  const name =
                    (typeof o.label === 'string' && o.label.trim()) ||
                    (typeof o.name === 'string' && o.name.trim()) ||
                    (typeof o.agent_id === 'string' ? o.agent_id : '')
                  if (!name) return null
                  const tokensRaw = o.tokens_used ?? o.tokensUsed ?? o.tokens
                  return {
                    name,
                    status: typeof o.state === 'string' ? o.state : undefined,
                    tokens:
                      tokensRaw != null &&
                      tokensRaw !== '' &&
                      Number.isFinite(Number(tokensRaw))
                        ? Number(tokensRaw)
                        : undefined,
                  }
                }
                const s = String(a).trim()
                return s ? { name: s } : null
              })
              .filter(
                (a): a is { name: string; status?: string; tokens?: number } =>
                  !!a,
              )
            const agents = agentRoster?.map((a) => a.name)
            const script = typeof f.script === 'string' ? f.script : undefined
            const objective =
              typeof f.objective === 'string' && f.objective.trim()
                ? f.objective
                : undefined
            const rawPhases = Array.isArray(f.phases) ? f.phases : undefined
            const phases = rawPhases
              ?.map((p) => {
                if (!p || typeof p !== 'object' || Array.isArray(p)) return null
                const o = p as Record<string, unknown>
                const title = typeof o.title === 'string' ? o.title.trim() : ''
                if (!title) return null
                return {
                  title,
                  state: typeof o.state === 'string' ? o.state : 'pending',
                }
              })
              .filter((p): p is { title: string; state: string } => !!p)
            const rawElapsed = f.elapsed_ms ?? f.elapsedMs
            const elapsedMs =
              rawElapsed != null &&
              rawElapsed !== '' &&
              Number.isFinite(Number(rawElapsed)) &&
              Number(rawElapsed) >= 0
                ? Number(rawElapsed)
                : undefined
            const rawStart = f.started_at ?? f.startedAt ?? f.start_time
            const sNum = typeof rawStart === 'number' ? rawStart : Number(rawStart)
            const startedAt =
              rawStart != null && rawStart !== '' && Number.isFinite(sNum) && sNum > 0
                ? sNum < 1e12
                  ? sNum * 1000
                  : sNum
                : undefined
            const prev = get().workflowRuns[runId]
            const prevStatus = prev?.status
            set({
              workflowRuns: {
                ...get().workflowRuns,
                [runId]: {
                  runId,
                  name,
                  status,
                  phase,
                  progress,
                  agents,
                  agentRoster,
                  phases,
                  objective,
                  script,
                  elapsedMs,
                  startedAt,
                  // Start-time fallback: first event that introduced the run.
                  firstSeenAt: prev?.firstSeenAt ?? Date.now(),
                  // The event is authoritative — clear any optimistic
                  // marker set by workflowControl before it arrived.
                  pendingControl: undefined,
                },
              },
            })
            // Surface transitions once (started / done / failed / paused).
            if (prevStatus !== status && status) {
              const text =
                !prevStatus && status === 'running'
                  ? `工作流启动: ${name}`
                  : status === 'done'
                    ? `工作流完成: ${name}`
                    : status === 'failed'
                      ? `工作流失败: ${name}`
                      : status === 'cancelled'
                        ? `工作流取消: ${name}`
                        : status === 'paused'
                          ? `工作流暂停: ${name}`
                          : `工作流 ${name} → ${status}`
              appendEntry(set, { kind: 'session_event', text })
            }
            break
          }
          // ── goal mode (TUI goal panel; web shows completion events) ───
          case 'goal_updated': {
            const f = fields as Record<string, unknown>
            const status = typeof f.status === 'string' ? f.status : ''
            const objective = typeof f.objective === 'string' ? f.objective : ''
            // goalReceivedAt anchors the elapsed fallback chain (wire
            // elapsed_ms / started_at absent → receive time).
            set({ goalState: f, goalReceivedAt: Date.now() })
            // TUI turn_status.rs: goal completion verification window →
            // "Verifying…" (text_secondary); the status line returns to
            // the wait-for-token text once verification clears.
            const verifying = f.verifying_completion === true
            if (verifying) {
              set({ statusText: 'Verifying…' })
            } else if (get().statusText === 'Verifying…') {
              set({ statusText: 'Waiting for response…' })
            }
            if (status === 'complete') {
              appendEntry(set, {
                kind: 'session_event',
                text: `目标完成: ${objective}`,
              })
            } else if (status === 'cleared') {
              appendEntry(set, { kind: 'session_event', text: '目标已清除' })
            } else if (status === 'budget_limited') {
              appendEntry(set, {
                kind: 'session_event',
                text: `目标预算耗尽: ${objective}`,
                warning: true,
              })
            }
            break
          }
          // ── subagent progress ticks: state only, never scrollback ────
          // Wire fields mirror TUI SubagentProgress (xai-grok-shell
          // extensions/notification.rs): duration_ms / turn_count /
          // tool_call_count / tokens_used / context_window_tokens /
          // context_usage_pct / tools_used / error_count. Every tick
          // merges into the entry so the block viewer shows live
          // progress (TUI tasks-pane row + dashboard mini gauge); the
          // `detail` summary keeps the collapsed scrollback row glanceable.
          case 'subagent_progress': {
            const f = fields as Record<string, unknown>
            const id = String(f.subagent_id ?? '')
            const entryId = id ? get().subagentIndex[id] : undefined
            if (!entryId) break
            const num = (v: unknown): number | undefined =>
              typeof v === 'number' && Number.isFinite(v) ? v : undefined
            const str = (v: unknown): string | undefined =>
              typeof v === 'string' && v.trim() ? v : undefined
            const tools = Array.isArray(f.tools_used)
              ? (f.tools_used as unknown[])
                  .map((t) => (typeof t === 'string' ? t : ''))
                  .filter(Boolean)
              : undefined
            const turnCount = num(f.turn_count)
            const toolCount = num(f.tool_call_count)
            const pct = num(f.context_usage_pct)
            const tokens = num(f.tokens_used)
            const windowTokens = num(f.context_window_tokens)
            const errors = num(f.error_count)
            const durMs = num(f.duration_ms)
            const desc = str(f.description)
            set({
              entries: get().entries.map((e) =>
                e.id === entryId && e.kind === 'subagent'
                  ? {
                      ...e,
                      ...(durMs != null ? { durationMs: durMs } : {}),
                      ...(turnCount != null ? { turns: turnCount } : {}),
                      ...(toolCount != null ? { toolCalls: toolCount } : {}),
                      ...(tokens != null ? { tokensUsed: tokens } : {}),
                      ...(windowTokens != null ? { contextWindowTokens: windowTokens } : {}),
                      ...(pct != null ? { contextUsagePct: pct } : {}),
                      ...(errors != null ? { errorCount: errors } : {}),
                      ...(tools != null ? { toolsUsed: tools } : {}),
                      // TUI SubagentBlock activity suffix: the wire has
                      // no activity label, so keep a compact numeric
                      // summary ("turns=3 tools=7 42%") as the row detail.
                      // Running only — a late tick must not clobber the
                      // finish detail ("42s") once the subagent is done.
                      ...(e.running
                        ? {
                            detail:
                              desc ||
                              `turns=${String(turnCount ?? '?')} tools=${String(toolCount ?? '?')}${
                                pct != null ? ` ${String(pct)}%` : ''
                              }${durMs != null ? ` · ${(durMs / 1000).toFixed(0)}s` : ''}`,
                          }
                        : {}),
                    }
                  : e,
              ),
            })
            break
          }
          // ── scheduled tasks (TUI tasks pane only — not scrollback) ───
          // TUI updates agent.session.scheduled_tasks; the fire itself is
          // rendered later as UserPromptBlock::cron from the inject's
          // UserMessageChunk. No session_event rows for create/fire;
          // delete 除外——每个删除原因都要有可见反馈（见下）。
          // The same updates can ALSO arrive as standalone SSE events
          // (scheduled_task_created/deleted/fired) — both paths land in
          // the shared upsert/remove helpers keyed by taskId, so a task
          // delivered twice is never duplicated.
          case 'scheduled_task_created':
            upsertScheduledTask(set, parseScheduledTask(fields))
            break
          case 'scheduled_task_deleted': {
            // 多会话广播守卫（同 model_changed）：别的会话的删除事件
            // 不得动本会话任务列表 / 滚动区。
            const notifSid =
              (ev as { sessionId?: string }).sessionId ??
              (typeof ev.params?.sessionId === 'string'
                ? ev.params.sessionId
                : undefined)
            if (notifSid && notifSid !== get().sessionId) break
            const inner = fields.task as Record<string, unknown> | undefined
            const id = wireTaskId(fields.task_id, fields.taskId, inner?.taskId)
            if (id) removeScheduledTask(set, id)
            // 原因回退链：update 顶层 → params → task 内（宿主归一化
            // update.reason → params.reason → task.reason 同款）。
            const reason = scheduledTaskDeleteReason(fields.reason, ev.params, inner)
            appendEntry(set, {
              kind: 'session_event',
              text: scheduledTaskDeletedText(reason),
            })
            break
          }
          case 'scheduled_task_fired': {
            const id = wireTaskId(fields.task_id, fields.taskId)
            if (id) updateScheduledTaskFire(set, id, fields.next_fire_at ?? fields.nextFireAt)
            break
          }
          // ── misc ─────────────────────────────────────────────────────
          // follow-ups (turn-end suggestion chips; TUI follow_ups.rs):
          // live 走 typed `follow_ups` 事件 / ext_notification 兜底，回放
          // 走 x.ai carrier 的 session_notification 通道——切走期间回合
          // 结束的广播被丢弃，切回时若不重放，chips 永远不出现。
          case 'follow_ups':
          case 'followups':
            applyFollowUps(get, set, fields)
            break
          case 'diff_review': {
            const content = Array.isArray(fields.content) ? fields.content : []
            // Notification path (no requestId → no receipt): cache the
            // payload and open the modal read-only.
            set({ diffReview: content, diffReviewOpen: content.length > 0 })
            appendEntry(set, {
              kind: 'session_event',
              text: `收到 Diff 审查请求（${content.length} 个文件）`,
            })
            break
          }
          case 'feedback_request':
            appendEntry(set, { kind: 'session_event', text: '收到会话反馈请求' })
            break
          case 'turn_completed': {
            const f = fields as Record<string, unknown>
            const reason = typeof f.stop_reason === 'string' ? f.stop_reason : ''
            // TUI prompt_origin.rs stop_reason mapping → TurnFailed
            // marker: "Turn failed in 4.4s: <error>" (warning color).
            // The shell formats the request failure; here the
            // agent_result is the best error text and "rate limited"
            // stands in for a rate_limit without a payload. The `done`
            // event skips its "Worked for" marker for these reasons.
            // Fallback rail: typed turn_completed events (capri-host)
            // already render the failed marker — dedupe via the tail.
            if (reason === 'error' || reason === 'rate_limit') {
              if (tailAlreadyTurnEnded(get().entries)) break
              const err =
                reason === 'error'
                  ? String(f.agent_result ?? 'unknown error')
                  : 'rate limited'
              const ts = get().turnStartedAt
              const dur =
                ts != null ? formatTurnDuration(Date.now() - ts) : null
              appendEntry(set, {
                kind: 'session_event',
                text:
                  dur != null
                    ? `Turn failed in ${dur}: ${err}`
                    : `Turn failed: ${err}`,
                warning: true,
              })
            }
            break
          }
          // tool_call_delta_chunk: streamed args are superseded by the
          // final tool_call update — nothing to render.
          case 'tool_call_delta_chunk':
          case 'pending_interaction':
          case 'interaction_resolved':
          case 'relay_sync_status':
          case 'response_completed':
            break
    default:
      return false
  }
  return true
}
