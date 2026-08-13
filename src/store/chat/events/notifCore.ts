import type { ChatState, SetState } from '../types'
import type { WireEvent } from './wire'
import {
  applyModeFlags,
  sessionModesPatch,
} from '../modeFlags'
import { fmtTokens } from '../format'
import {
  sealThought,
} from '../stream'
import { appendEntry } from '../entries'
import { handleSubagentEvent } from '../subagent'
import {
  handleTaskBackgrounded,
  handleTaskCompleted,
} from '../tasks'
import { wireTaskId } from '../util'

export function handleNotifCore(
  set: SetState,
  get: () => ChatState,
  ev: WireEvent,
  tag: string,
  fields: Record<string, unknown>,
): boolean {
  switch (tag) {
          case 'subagent_spawned':
          case 'subagent_finished':
            handleSubagentEvent(get, set, tag, fields)
            break
          // Permission/plan mode arrives via the standalone yolo_mode_changed
          // SSE event OR the session_notification tag (the x.ai carrier
          // replay routes every kind here) — identical flags either way.
          // current_mode_update (session-mode id, e.g. 'plan') restores the
          // plan/perm flags from the replayed timeline.
          case 'yolo_mode_changed':
            // 权限模式是客户端级全局状态：agent 对发送客户端的所有会话
            // 生效，广播无条件应用——所有会话的显示同步（订阅器落全局
            // 记录）。current_mode_update（session-mode id，如 'plan'）
            // 从回放的 timeline 恢复 plan/perm flags。
            applyModeFlags(set, fields)
            break
          case 'current_mode_update': {
            // 多会话广播守卫：非当前会话的 plan 状态快照不应用。
            if (ev.sessionId && ev.sessionId !== get().sessionId) break
            const flags = sessionModesPatch(get, fields)
            if (flags) set(flags)
            break
          }
          case 'task_backgrounded':
            handleTaskBackgrounded(get, set, fields)
            break
          case 'task_completed':
            handleTaskCompleted(get, set, fields)
            break
          case 'monitor_event': {
            // Stdout accumulation for BOTH live rows (bgTaskIndex) and
            // history-replay display rows (no index — match by taskId
            // over entries so replayed tasks keep their log inline).
            const taskId = wireTaskId(fields.task_id, fields.taskId)
            if (!taskId) break
            const text =
              (typeof fields.event_text === 'string' && fields.event_text) ||
              (typeof fields.eventText === 'string' && fields.eventText) ||
              ''
            if (!text) break
            const entryId = get().bgTaskIndex[taskId]
            const eid =
              entryId ??
              get().entries.find(
                (e) => e.kind === 'bg_task' && e.taskId === taskId,
              )?.id
            if (!eid) break
            set({
              entries: get().entries.map((e) =>
                e.id === eid && e.kind === 'bg_task'
                  ? {
                      ...e,
                      output: (e.output ?? '') + text,
                      // Keep a short tail on the row detail for glanceability.
                      detail:
                        text.trim().split('\n').filter(Boolean).slice(-1)[0] ||
                        e.detail,
                    }
                  : e,
              ),
            })
            break
          }
          case 'response_started': {
            // A new LLM response started — finish any in-flight thought.
            // First token hasn't arrived yet: wait window (TUI
            // Waiting(Model) until stream_start).
            const sealed = sealThought(get())
            set({ ...sealed, statusText: 'Waiting for response…' })
            break
          }
          case 'reasoning_completed':
            set({ statusText: 'Waiting for response…' })
            break
          case 'auto_compact_started': {
            const pct = fields.percentage as number | undefined
            // TUI turn_status.rs: AutoCompacting → "Compacting…".
            set({ statusText: 'Compacting…' })
            appendEntry(set, {
              kind: 'session_event',
              text: `自动压缩上下文… (${pct ?? '?'}%)`,
              streaming: false,
            })
            break
          }
          case 'auto_compact_completed': {
            // TUI CompactionCompleted: tokens_before/tokens_after/
            // elapsed_ms are optional on the wire — keep the plain line
            // when the data is absent.
            const before = fields.tokens_before ?? fields.tokensBefore
            const after = fields.tokens_after ?? fields.tokensAfter
            const elapsedMs = fields.elapsed_ms ?? fields.elapsedMs
            let text = '自动压缩完成'
            if (typeof after === 'number' && after > 0) {
              const beforePart =
                typeof before === 'number' && before > 0
                  ? `${fmtTokens(before)} → `
                  : ''
              text = `自动压缩完成: ${beforePart}${fmtTokens(after)} tokens`
              if (typeof elapsedMs === 'number' && elapsedMs >= 0) {
                text += ` (${(elapsedMs / 1000).toFixed(1)}s)`
              }
            }
            appendEntry(set, { kind: 'session_event', text })
            // Compact finished → back to the wait-for-token window (the
            // turn resumes streaming after compaction).
            set({ statusText: 'Waiting for response…' })
            break
          }
          case 'auto_compact_failed': {
            appendEntry(set, {
              kind: 'session_event',
              text: `自动压缩失败: ${String(fields.error ?? '未知错误')}`,
              warning: true,
            })
            set({ statusText: 'Waiting for response…' })
            break
          }
          case 'auto_compact_cancelled':
            appendEntry(set, { kind: 'session_event', text: '自动压缩已取消' })
            set({ statusText: 'Waiting for response…' })
            break
          case 'auto_continue_completed': {
            const tokens = fields.total_tokens as number | undefined
            appendEntry(set, {
              kind: 'session_event',
              text: `继续生成${tokens != null ? ` (共 ${tokens} tokens)` : ''}`,
            })
            break
          }
          case 'image_compressed':
            appendEntry(set, {
              kind: 'session_event',
              text: `图片已压缩${fields.message ? `: ${String(fields.message)}` : ''}`,
            })
            break
    default:
      return false
  }
  return true
}
