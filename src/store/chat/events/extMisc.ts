import type { AcpEvent, AgentCommand } from '../../../api/types'
import type { FileSearchMatch } from '../typesPublic'
import { applyQueueChanged } from '../../promptQueue'
import type { ChatState, SetState } from '../types'
import { runtime } from '../globals'
import { sessionModesPatch } from '../modeFlags'
import {
  adoptTurn,
  busyPlausibleForView,
  finalizeTurn,
  promptIdMismatch,
  tailAlreadyTurnEnded,
  turnEndMarkerText,
} from '../turn'
import { applySessionModelState } from '../model'
import { appendEntry } from '../entries'
import { applyFollowUps, applyMcpInitProgress, SILENT_EXT_NOTIFICATIONS } from '../followUps'
import { wireTaskId } from '../util'
import {
  parseScheduledTask,
  removeScheduledTask,
  scheduledTaskDeleteReason,
  scheduledTaskDeletedText,
  updateScheduledTaskFire,
  upsertScheduledTask,
} from '../tasks'

export function handleExtMiscEvent(
  set: SetState,
  get: () => ChatState,
  ev: AcpEvent,
): boolean {
  switch (ev.type) {
      case 'models_update': {
        // 多会话广播（host withSid 约定）：非当前会话的 models_update 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // 会话切换中忽略：load 时模型映射广播会带新模型的默认 effort
        // （如 low），覆盖 load 响应恢复的用户原档位（如 max）；切换
        // 期间模型状态以 HTTP load 响应为准。
        if (get().historyLoading) break
        const p = (ev.params ?? {}) as Record<string, unknown>
        // Host/agent may push a full SessionModelState ({currentModelId,
        // availableModels}) — apply it as the authoritative session model
        // (catalog + current + effort). A pure catalog refresh keeps the
        // current effort when the model did not change (TUI
        // update_catalog semantics); a model switch applies the new
        // model's effort.
        if (
          p.currentModelId != null ||
          Array.isArray(p.availableModels) ||
          Array.isArray(p.available_models)
        ) {
          const snap = applySessionModelState(p, undefined)
          if (snap.models?.length || snap.modelName) {
            const hasExplicitEffort =
              (typeof p.reasoningEffort === 'string' && !!p.reasoningEffort.trim()) ||
              (typeof p.reasoning_effort === 'string' && !!p.reasoning_effort.trim())
            const modelChanged =
              snap.modelName != null && snap.modelName !== get().modelName
            set({
              ...snap,
              ...(!hasExplicitEffort && snap.reasoningEffort && !modelChanged
                ? { reasoningEffort: get().reasoningEffort || snap.reasoningEffort }
                : {}),
            })
          }
          break
        }
        // Best-effort: payload may carry {modelId, modelName} or {models:[…]}.
        const name =
          (typeof p.modelName === 'string' && p.modelName) ||
          (typeof p.modelId === 'string' && p.modelId) ||
          (typeof p.model === 'string' && p.model)
        if (name) set({ modelName: name })
        break
      }
      case 'scheduled_task_created':
        // Standalone SSE carrier (host may ALSO wrap the same update in a
        // session_notification tag — both paths upsert by taskId).
        upsertScheduledTask(set, parseScheduledTask(ev))
        break
      case 'scheduled_task_deleted': {
        // 多会话广播（host withSid 约定）：非当前会话的删除事件不得
        // 移除本会话任务，也不得在本会话滚动区留提示行。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        const p = (ev.params ?? {}) as Record<string, unknown>
        const id = wireTaskId(ev.taskId, p.taskId, p.task_id)
        if (id) removeScheduledTask(set, id)
        // 每个删除原因都要有可见反馈（session_event 行，announcements /
        // workflow 同款形态）：expired / completed / deleted / shutdown
        // 各有文案，unknown 或缺失回退「定时任务已移除」。
        const rawParams = (ev.rawParams ?? {}) as Record<string, unknown>
        const reason = scheduledTaskDeleteReason(ev.reason, p, rawParams)
        appendEntry(set, {
          kind: 'session_event',
          text: scheduledTaskDeletedText(reason),
        })
        break
      }
      case 'scheduled_task_fired': {
        const p = (ev.params ?? {}) as Record<string, unknown>
        const id = wireTaskId(ev.taskId, p.taskId, p.task_id)
        // TUI only updates the tasks pane (next_fire_at) — no scrollback
        // row. The turn itself surfaces as a cron UserPromptBlock via
        // user_chunk.
        if (id) updateScheduledTaskFire(set, id, ev.nextFireAt ?? p.nextFireAt ?? p.next_fire_at)
        break
      }
      case 'scheduled_task_inject_prompt':
        // TUI enqueues the cron prompt (driver-only); scrollback comes from
        // the resulting UserMessageChunk, classified as is_cron. FE is not
        // the driver — ignore the inject signal and wait for user_chunk.
        break
      case 'prompt_complete': {
        // 多会话广播（host withSid 约定）：非当前会话的回合终态忽略——
        // 否则后台回合的 prompt_complete 会把当前会话的回合错误收尾。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // Agent-side turn end: x.ai/session/prompt_complete fires for EVERY
        // prompt turn — user-sent turns also get a host `done`, but
        // scheduled injections end with only this.
        //
        // 回合身份校验（TUI finalize_turn_from_terminal exact-pid 匹配）：
        // payload 带 promptId（lost-response fix 后的 shell）且与当前回合
        // 不符 → 上一个回合的迟到广播（RPC 与 live 通道乱序、hub 缓冲
        // 重放、队列收养窗口）——绝不能收口新回合：新回合刚锚定
        // （conn=busy、turnStartedAt=现在），被它收口会渲染
        // "Worked for 0.0s" 假标记并清掉新回合的锚。无 pid（旧 shell）
        // → 退回 conn busy 守卫的 legacy 行为。
        const s = get()
        if (s.conn !== 'busy') break
        if (promptIdMismatch(ev.params, s.currentPromptId)) break
        // stop_reason 原样携带（shell PromptCompletePayload）——失败/取消
        // 回合必须渲染 TurnFailed / TurnCancelled，而不是 "Worked for"。
        const p = (ev.params ?? {}) as Record<string, unknown>
        const stopReason =
          typeof p.stopReason === 'string'
            ? p.stopReason
            : typeof p.stop_reason === 'string'
              ? p.stop_reason
              : undefined
        const agentResult =
          typeof p.agentResult === 'string'
            ? p.agentResult
            : typeof p.agent_result === 'string'
              ? p.agent_result
              : undefined
        // 与 `done` 同款收口（finalizeTurn：hasOutput / bashTurn / turnIsLive
        // 守卫 + 幂等 settle）；失败/取消标记是本 rail 的职责（done 对
        // error/rate_limit 不追加标记），收口后按 tailAlreadyTurnEnded
        // 去重补渲染（TUI viewer 的 stop_reason 映射同款）。
        const railEndTs = s.turnStartedAt
        finalizeTurn(set, get, stopReason)
        if (
          stopReason === 'error' ||
          stopReason === 'rate_limit' ||
          stopReason === 'cancelled'
        ) {
          if (!tailAlreadyTurnEnded(get().entries)) {
            const { text, warning } = turnEndMarkerText(
              stopReason,
              agentResult,
              railEndTs != null ? Date.now() - railEndTs : undefined,
            )
            appendEntry(set, {
              kind: 'session_event',
              text,
              ...(warning ? { warning } : {}),
            })
          }
        }
        break
      }
      case 'follow_ups': {
        // 多会话广播（host withSid 约定）：非当前会话的跟进建议忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // 同 busy 防线：follow_ups 由 host 在回合结束时广播，sid 可能错标
        // 或缺省（见模块头 sessionIdFrom 注释）——别的会话的回合结束建议
        // 不能出现在本会话输入框上方（点选还会把跟进消息发进本会话）。
        // 只有当前视图确实在跑/刚在跑回合（turnIsLive / 发送在飞 /
        // roster 显示 busy）才接受；回放的 chips 走 session_notification
        // 通道（无 sid），不受影响。
        if (!busyPlausibleForView(get())) break
        // Typed carrier for x.ai/follow_ups (host bridge.go broadcasts it
        // as {type:'follow_ups', params}) — turn-end suggestion chips (TUI
        // follow_ups.rs): parsed into store state for the Composer's chip
        // row; NO scrollback line (the TUI renders them as a transient row
        // above the prompt). Newest-wins by response_id. Older hosts fall
        // back to the ext_notification arm below (same consumer).
        applyFollowUps(get, set, ev.params)
        break
      }
      case 'ext_notification': {
        // Status-type notifications with no scrollback UI value — drop
        // silently. Aligned with the TUI: these are panel-local status
        // feeds the TUI shows ONLY inside their dedicated surfaces
        // (file-watch panel, /search panel, terminal pane, settings
        // modal, MCP panel), never as scrollback rows — so a generic dim
        // status line here would be pure noise:
        // - x.ai/fs_notify / fs/index / fs/index/delta — file-watcher
        //   state (TUI file-watch panel); fires on every file change.
        // - x.ai/search/fuzzy/status / search/content/status — search
        //   engine status (TUI /search panel).
        // - x.ai/config_changed — config reload notice (TUI settings
        //   modal; FE has no config editor).
        // - x.ai/settings/update — pre-existing silence, same rationale.
        // x.ai/mcp/init_progress is NOT silent: the current host forwards
        // it as the typed `mcp_init_progress` event (consumed above); an
        // older host that falls back to ext_notification is consumed here
        // the same way — never rendered as a status line.
        if (ev.method === 'x.ai/mcp/init_progress') {
          applyMcpInitProgress(set, ev.params)
          break
        }
        // x.ai/queue/changed — agent's authoritative queue snapshot.
        // Older hosts forward it as ext_notification instead of the
        // typed `queue_changed` event; both rails feed the promptQueue
        // sync layer (guard on session id like the typed carrier — the
        // ext_notification AcpEvent type omits sessionId, but the host
        // attaches it via withSid).
        if (ev.method === 'x.ai/queue/changed') {
          const sid = (ev as { sessionId?: string }).sessionId
          if (!sid || sid === get().sessionId) {
            runtime.lastLiveQueueChangedAt = Date.now()
            const adopted = applyQueueChanged(ev.params)
            if (adopted) adoptTurn(set, get, adopted)
          }
          break
        }
        if (SILENT_EXT_NOTIFICATIONS.has(ev.method ?? '')) break
        // x.ai/follow_ups — turn-end suggestion chips (TUI follow_ups.rs):
        // parsed into store state for the Composer's chip row; NO
        // scrollback line (the TUI renders them as a transient row above
        // the prompt). Newest-wins by response_id.
        if (ev.method === 'x.ai/follow_ups') {
          // 同 typed 入口的防线：ext_notification 的 sid 由 host 附加
          // （可能错标/缺省）——不是当前视图的回合就别画 chips。
          if (!busyPlausibleForView(get())) break
          applyFollowUps(get, set, ev.params)
          break
        }
        // Unknown x.ai/* notification — render a dim status line so nothing
        // is silently dropped (matches the host's generic forwarding).
        appendEntry(set, {
          kind: 'status',
          text: `扩展通知: ${ev.method ?? 'x.ai/*'}`,
        })
        break
      }
      case 'search_fuzzy_status': {
        // @ file-picker engine stream (workspace run_fuzzy_notifications,
        // forwarded by the host as this typed event): {sessionId, searchId,
        // matches: [{path, score, matchedIndices}], total, done,
        // generation}. Each generation carries the FULL match snapshot —
        // replace wholesale. Feeds only the Composer popover; no
        // scrollback row (the TUI shows this inside its /search panel).
        // A searchId that isn't the picker's current session is stale and
        // dropped; when the picker is closed (fileSearch null) the event
        // is dropped too.
        const cur = get().fileSearch
        if (!cur) break
        const p = (ev.params ?? {}) as Record<string, unknown>
        const searchId = typeof p.searchId === 'string' ? p.searchId : ''
        if (!searchId || searchId !== cur.searchId) break
        const matches: FileSearchMatch[] = []
        if (Array.isArray(p.matches)) {
          for (const m of p.matches) {
            if (m == null || typeof m !== 'object') continue
            const o = m as Record<string, unknown>
            if (typeof o.path !== 'string' || !o.path) continue
            matches.push({
              path: o.path,
              ...(typeof o.score === 'number' ? { score: o.score } : {}),
              ...(Array.isArray(o.matchedIndices)
                ? {
                    matchedIndices: o.matchedIndices.filter(
                      (x): x is number => typeof x === 'number',
                    ),
                  }
                : {}),
            })
          }
        }
        set({
          fileSearch: {
            ...cur,
            matches,
            done: p.done === true,
            ...(typeof p.total === 'number' ? { total: p.total } : {}),
          },
        })
        break
      }
      case 'modes_update':
        // 多会话广播守卫（同 ready/model）：非当前会话的 modes 快照
        // 不得覆盖本会话的模式标志。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        set({ modes: ev.modes, ...(sessionModesPatch(get, ev.modes) ?? {}) })
        break
      case 'session_info':
        // 多会话广播（host withSid 约定）：非当前会话的会话信息忽略
        // （别的会话的 session_info_update 不能改写本会话的标题）。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // titleIsManual=true：本会话标题是手动改名的——自动标题（本
        // 事件的 title）不得覆盖；false / 缺省保持原有覆盖行为
        // （/rename --auto 的结果照样应用）。
        if (ev.titleIsManual === true) break
        if (ev.title != null && String(ev.title).trim()) {
          set({ sessionTitle: String(ev.title).trim() })
        }
        break
      case 'model': {
        // 多会话广播（host withSid 约定）：非当前会话的 model 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // 会话切换中忽略：load 时模型映射广播（model_changed → model）
        // 会带新模型的默认 effort（如 low），覆盖 load 响应恢复的用户
        // 原档位（如 max）；切换期间以 HTTP load 响应为准。
        if (get().historyLoading) break
        const name =
          (ev.modelName && String(ev.modelName).trim()) ||
          (ev.modelId && String(ev.modelId).trim()) ||
          undefined
        set({
          modelName: name,
          reasoningEffort: ev.reasoningEffort
            ? String(ev.reasoningEffort)
            : get().reasoningEffort,
        })
        break
      }
      case 'config_options_update': {
        // Best-effort: ACP config options may carry current model id/name.
        const opts = ev.configOptions as
          | Array<{ id?: string; type?: string; currentValue?: unknown; options?: Array<{ value?: string; name?: string }> }>
          | { model?: string; modelId?: string; modelName?: string }
          | undefined
        if (!opts) break
        if (Array.isArray(opts)) {
          const modelOpt = opts.find(
            (o) =>
              o?.id === 'model' ||
              o?.type === 'model' ||
              String(o?.id || '').toLowerCase().includes('model'),
          )
          if (modelOpt?.currentValue != null) {
            const cv = String(modelOpt.currentValue)
            const named = modelOpt.options?.find((x) => x.value === cv)?.name
            set({ modelName: (named && String(named)) || cv })
          }
        } else {
          const name =
            (opts.modelName && String(opts.modelName)) ||
            (opts.modelId && String(opts.modelId)) ||
            (opts.model && String(opts.model))
          if (name) set({ modelName: name })
        }
        break
      }
      case 'commands_update': {
        // ACP `available_commands_update` (host-forwarded as
        // `{type:'commands_update', commands, sessionId}` — `commands`
        // is the agent's `AvailableCommand[]` passed through untouched).
        // Defensive extraction: the array may be absent/malformed; only
        // well-formed entries are kept (name required, rest best-effort).
        const raw = ev.commands
        const list = Array.isArray(raw) ? raw : []
        const agentCommands: AgentCommand[] = []
        for (const item of list) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue
          const o = item as Record<string, unknown>
          const name = typeof o.name === 'string' ? o.name.trim() : ''
          if (!name) continue
          let argHint: string | undefined
          const input = o.input
          if (typeof input === 'string' && input.trim()) {
            argHint = input.trim()
          } else if (input && typeof input === 'object' && !Array.isArray(input)) {
            const h = (input as Record<string, unknown>).hint
            if (typeof h === 'string' && h.trim()) argHint = h.trim()
          }
          const meta =
            o._meta && typeof o._meta === 'object' && !Array.isArray(o._meta)
              ? (o._meta as Record<string, unknown>)
              : undefined
          agentCommands.push({
            name,
            description: typeof o.description === 'string' ? o.description : undefined,
            argHint,
            ...(meta ? { meta } : {}),
          })
        }
        set({ agentCommands })
        break
      }
      case 'announcements_update': {
        // x.ai/announcements/update: { gen, announcements: [{id?, title?,
        // message?, severity?, cta?, …}] } — surface each as a status line so
        // the event is consumed instead of silently dropped. The host/TUI
        // re-pushes the SAME list on every /new, startup, and settings
        // refresh — only append a row when an announcement's content
        // actually changed (dedup by id, content-fallback like the TUI's
        // announcement_hide_key).
        const p = (ev.params ?? {}) as Record<string, unknown>
        const items = Array.isArray(p.announcements) ? p.announcements : []
        for (const a of items) {
          if (!a || typeof a !== 'object') continue
          const o = a as Record<string, unknown>
          const title = typeof o.title === 'string' && o.title ? o.title : ''
          const message = typeof o.message === 'string' && o.message ? o.message : ''
          const sev = typeof o.severity === 'string' && o.severity ? o.severity : ''
          const text = [title, message].filter(Boolean).join(' — ')
          if (!text) continue
          // Key: the announcement id when present, else its rendered content
          // (same fallback semantics as the TUI's announcement_hide_key).
          const rawId = typeof o.id === 'string' ? o.id.trim() : ''
          const key = rawId || `content:${text}`
          const fingerprint = `${sev}\u{1f}${text}`
          if (runtime.displayedAnnouncementFingerprints.get(key) === fingerprint) continue
          runtime.displayedAnnouncementFingerprints.set(key, fingerprint)
          // 上限：超 200 条时清最旧 50 条（Map 迭代序即插入序），防止
          // 公告 id 持续变化（如时间戳类内容键）时 Map 无上限增长。
          if (runtime.displayedAnnouncementFingerprints.size > 200) {
            let dropped = 0
            for (const k of runtime.displayedAnnouncementFingerprints.keys()) {
              runtime.displayedAnnouncementFingerprints.delete(k)
              if (++dropped >= 50) break
            }
          }
          appendEntry(set, {
            kind: 'session_event',
            text,
            warning: sev === 'error' || sev === 'critical',
          })
        }
        break
      }
      case 'queue_changed': {
        // x.ai/queue/changed (host bridge.go broadcasts the TYPED carrier)
        // — the agent's authoritative prompt-queue snapshot. The FE's
        // local queue mirrors the host (see store/promptQueue.ts sync
        // layer: mutations are mirrored fire-and-forget, the snapshot is
        // applied here). Guard on session id: withSid attaches the
        // emitting session — a stale broadcast from another session must
        // not clobber our queue. The emitting sessionId also tags the
        // queue so drains stay session-scoped. When the broadcast carries
        // a running_prompt_id that matches a local queue row, the agent
        // has auto-drained it into the running slot — adopt it: render
        // the user row (server-authoritative turn start, no prompt RPC).
        if (!ev.sessionId || ev.sessionId === get().sessionId) {
          runtime.lastLiveQueueChangedAt = Date.now()
          const adopted = applyQueueChanged(ev.params, ev.sessionId)
          if (adopted) adoptTurn(set, get, adopted)
        }
        break
      }
    default:
      return false
  }
  return true
}
