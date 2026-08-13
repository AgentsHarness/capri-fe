import type { ChatState, SetState } from '../types'
import type { WireEvent } from './wire'
import { appendEntry } from '../entries'
export function handleNotifMemory(
  set: SetState,
  get: () => ChatState,
  ev: WireEvent,
  tag: string,
  fields: Record<string, unknown>,
): boolean {
  switch (tag) {
          case 'session_recap': {
            const summary = typeof fields.summary === 'string' ? fields.summary : ''
            if (!summary.trim()) break
            // 归属会话：事件带 sessionId 用事件值，否则当前活动会话。
            // 两者都缺（异常）时只清等待标志、不缓存。
            const targetSid = ev.sessionId || get().sessionId
            // 重放去重：同文本且 5 秒内再到达（SSE 重连 / hub 回放
            // 重推同一事件）视为重复，直接跳过——事件与 cache 都
            // 不再处理，避免滚动区出现两条相同摘要。
            const prev = targetSid ? get().recapCache[targetSid] : undefined
            if (prev && prev.text === summary && Date.now() - prev.at < 5000) {
              if (
                ev.sessionId == null ||
                get().recapPendingFor === ev.sessionId
              ) {
                set({ recapPendingFor: undefined })
              }
              break
            }
            // 按会话缓存（覆盖写，只留最新）：recap 事件 display-only、
            // 不进持久化历史，跨会话期间到达时若直接 append 会污染当前
            // 视图、切回原会话又因 loadHistory 重建而丢失。缓存后切回时
            // 由 loadHistory 按时间就近回填。
            const isActiveTarget = targetSid === get().sessionId
            const recapCache = targetSid
              ? {
                  ...get().recapCache,
                  [targetSid]: { text: summary, at: Date.now() },
                }
              : get().recapCache
            set({
              recapCache,
              // 摘要已返回：清掉等待指示。事件带 sessionId 时按会话匹配
              // 清除（多会话并发 recap 互不误清）；不带（活动会话省略
              // 约定）则全局清。
              ...(ev.sessionId == null || get().recapPendingFor === ev.sessionId
                ? { recapPendingFor: undefined }
                : {}),
            })
            // 仅目标会话是当前活动会话时才进滚动区——跨会话的摘要绝不
            // 污染当前视图。historyLoading 期间（loadHistory 重建中）
            // 到达的摘要不直接 append（条目会被下一轮 replay 的
            // entries 覆盖而丢失），只进 cache 交给回填插入。
            if (isActiveTarget && !get().historyLoading && targetSid) {
              // Two-part recap block: bold "Recap" header + muted body
              // (TUI session_event Recap). The body IS the summary text;
              // the scrollback renders the header separately. 默认展开：
              // 摘要全文（含换行）直接显示，点击行可折叠成单行预览。
              appendEntry(set, {
                kind: 'session_event',
                text: summary,
                recap: true,
                open: true,
              })
            }
            break
          }
          case 'session_recap_unavailable':
            // 无摘要可生成：同样清掉等待指示（按会话匹配，见上）。
            set((s) =>
              ev.sessionId == null || s.recapPendingFor === ev.sessionId
                ? { recapPendingFor: undefined }
                : {},
            )
            appendEntry(set, {
              kind: 'session_event',
              text: '暂无会话摘要（尚无对话内容）',
              recap: true,
              open: false,
            })
            break
          // ── memory system (TUI memory modal + scrollback lines) ──────
          case 'memory_flush_started':
            appendEntry(set, { kind: 'session_event', text: '记忆刷新…' })
            break
          case 'memory_flush_completed': {
            const r = String(fields.result ?? '')
            appendEntry(set, {
              kind: 'session_event',
              text: `记忆刷新完成${r ? `: ${r.slice(0, 120)}` : ''}`,
            })
            break
          }
          case 'memory_dream_completed': {
            const r = String(fields.result ?? '')
            appendEntry(set, {
              kind: 'session_event',
              text: `记忆整合完成${r ? `: ${r.slice(0, 120)}` : ''}`,
            })
            break
          }
          case 'memory_session_saved': {
            const p = String(fields.path ?? '')
            appendEntry(set, {
              kind: 'session_event',
              text: `会话记忆已保存${p ? ` → ${p}` : ''}`,
            })
            break
          }
          case 'memory_files': {
            const files = Array.isArray(fields.files) ? fields.files : []
            // Wire shape is TUI MemoryFileInfo {path, source, size_bytes,
            // modified_epoch_secs} — normalize to the modal's display
            // fields (name = path basename) and keep `source` so the
            // memory modal can group Global / Workspace / Sessions.
            const normalized = files
              .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
              .map((f) => {
                const path = typeof f.path === 'string' ? f.path : ''
                const name =
                  typeof f.name === 'string' && f.name
                    ? f.name
                    : path.split(/[\\/]/).filter(Boolean).pop() ?? path
                const size =
                  typeof f.size === 'number'
                    ? f.size
                    : typeof f.size_bytes === 'number'
                      ? f.size_bytes
                      : undefined
                return {
                  name,
                  ...(path ? { path } : {}),
                  ...(size !== undefined ? { size } : {}),
                  ...(f.updatedAt !== undefined
                    ? { updatedAt: f.updatedAt }
                    : f.modified_epoch_secs !== undefined
                      ? { updatedAt: f.modified_epoch_secs }
                      : {}),
                  ...(typeof f.source === 'string' && f.source ? { source: f.source } : {}),
                }
              })
              .filter((f) => f.name)
            set({ memoryFiles: normalized })
            const names = normalized.map((f) => f.name).join(', ')
            appendEntry(set, {
              kind: 'session_event',
              text: `记忆文件 ${normalized.length} 个${names ? `（${names.slice(0, 80)}）` : ''}`,
            })
            break
          }
          // ── retry / recovery ─────────────────────────────────────────
          case 'retry_state': {
            // Three wire variants (tagged by `type`): retrying has `attempt`,
            // exhausted has `attempts`/`reason`/`isRateLimited`, failed has
            // `errorType`/`message`. Rendering everything as "重试中…" hid
            // terminal failures entirely.
            const f = fields as Record<string, unknown>
            const kind = typeof f.type === 'string' ? f.type : undefined
            const attempt = f.attempt ?? f.attempts
            if (kind === 'failed') {
              const errType = typeof f.errorType === 'string' ? f.errorType : ''
              const msg = typeof f.message === 'string' ? f.message : ''
              appendEntry(set, {
                kind: 'session_event',
                text: `推理失败${errType ? `（${errType}）` : ''}${msg ? `: ${msg}` : ''}`,
                warning: true,
              })
            } else if (kind === 'exhausted') {
              const reason = typeof f.reason === 'string' ? f.reason : ''
              appendEntry(set, {
                kind: 'session_event',
                text: `重试已耗尽${attempt != null ? `（attempt ${String(attempt)}）` : ''}${reason ? `: ${reason}` : ''}${f.isRateLimited ? '（可能被限流）' : ''}`,
                warning: true,
              })
            } else {
              // TUI turn_status.rs: Retrying → "Retrying (attempt N)…".
              // 重试中状态由 composer busy 行（statusText fallback）展示，
              // 不往 scrollback 追加条目——transient 状态只在 busy 框出现；
              // 终态（failed / exhausted）仍保留在 scrollback。
              set({
                statusText:
                  attempt != null
                    ? `Retrying (attempt ${String(attempt)})…`
                    : 'Retrying…',
              })
            }
            break
          }
          case 'auto_recovery_started': {
            const f = fields as Record<string, unknown>
            const err = typeof f.error === 'string' ? f.error.slice(0, 100) : ''
            appendEntry(set, {
              kind: 'session_event',
              text: `自动恢复中 (attempt ${String(f.attempt ?? '?')}/${String(f.max_retries ?? '?')})${err ? `: ${err}` : ''}`,
              warning: true,
            })
            break
          }
          case 'auto_recovery_exhausted':
            appendEntry(set, {
              kind: 'session_event',
              text: '自动恢复失败，重试次数已用尽',
              warning: true,
            })
            break
          // ── images ───────────────────────────────────────────────────
          case 'image_dropped': {
            const notes = Array.isArray(fields.notes)
              ? fields.notes.map(String).join('\n')
              : ''
            appendEntry(set, {
              kind: 'session_event',
              text: `图片未发送${notes ? `: ${notes}` : ''}`,
              warning: true,
            })
            break
          }
          // ── hooks / plugins (TUI hook annotations on tool blocks) ────
          case 'hook_annotation': {
            const msg = typeof fields.message === 'string' ? fields.message : ''
            if (msg.trim()) appendEntry(set, { kind: 'session_event', text: msg })
            break
          }
          case 'hook_execution': {
            const f = fields as Record<string, unknown>
            const evName = typeof f.event_name === 'string' ? f.event_name : ''
            const tool = typeof f.tool_name === 'string' ? f.tool_name : ''
            const runs = Array.isArray(f.runs) ? f.runs.length : 0
            appendEntry(set, {
              kind: 'session_event',
              text: `🪝 ${evName}${tool ? ` for ${tool}` : ''}${runs ? ` (${runs} 条运行)` : ''}`,
            })
            break
          }
          case 'hooks_changed':
          case 'plugins_changed':
            // No modal in the web UI; bump the version so future panels
            // can refresh, without spamming the scrollback.
            set((s) => ({ hooksVersion: s.hooksVersion + 1 }))
            break
          case 'plugin_updates_installed': {
            const updates = Array.isArray(fields.updates)
              ? fields.updates.map(String).join(', ')
              : ''
            appendEntry(set, {
              kind: 'session_event',
              text: `插件已更新${updates ? `: ${updates}` : ''}`,
            })
            break
          }
          // ── session title ────────────────────────────────────────────
          case 'session_summary_generated': {
            const title =
              typeof fields.session_summary === 'string'
                ? fields.session_summary.trim()
                : ''
            if (title) set({ sessionTitle: title })
            break
          }
          // ── model switches (TUI ModelUnavailable block / remote switch) ─
          case 'model_auto_switched': {
            const prev = String(fields.previous_model_id ?? '')
            const next = String(fields.new_model_id ?? '')
            const reason = String(fields.reason ?? '')
            set({ modelName: next || undefined })
            appendEntry(set, {
              kind: 'session_event',
              text: `模型 ${prev} 不可用，已切换为 ${next}${reason ? `（${reason}）` : ''}`,
              warning: true,
            })
            break
          }
    default:
      return false
  }
  return true
}
