import type { AcpEvent, PendingReq } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { runtime } from '../globals'
import {
  SUPPORTED_XAI_REQUESTS,
  syncPendingForSession,
} from '../pending'
import { appendEntry } from '../entries'
export function handleSessionCtrlEvent(
  set: SetState,
  get: () => ChatState,
  ev: AcpEvent,
): boolean {
  switch (ev.type) {
      case 'task_lifecycle': {
        // 多会话广播（host withSid 约定）：非当前会话的任务回放行忽略
        // （缺 sid = 本会话历史回放，照常通过）。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // History replay renders stored task lifecycle events with the
        // SAME look as live bg_task rows — but the entry is NOT captured
        // into the task system: no bgTaskIndex entry, never running, no
        // kill button, no ⠋N / running-bar membership. The live running
        // set comes from the host probe at resume (replayRunningTasks).
        appendEntry(set, {
          kind: 'bg_task',
          title: ev.title,
          status: ev.kind === 'started' ? 'started' : ev.failed ? 'failed' : 'completed',
          running: false,
          taskId: ev.taskId,
          command: ev.command,
          isMonitor: ev.isMonitor,
          output: ev.output,
          finishedAt: Date.now(),
        })
        break
      }
      case 'client_request': {
        const method = ev.method || ''
        // Prefer the broadcast sessionId; fall back to params for hosts
        // that only put it inside the agent params map.
        const evSid =
          (typeof ev.sessionId === 'string' && ev.sessionId) ||
          (typeof ev.params?.sessionId === 'string' && ev.params.sessionId) ||
          (typeof ev.params?.session_id === 'string' && ev.params.session_id) ||
          undefined
        const row: PendingReq = {
          requestId: ev.requestId,
          method,
          params: ev.params,
          ...(evSid ? { sessionId: evSid } : {}),
        }
        if (method.startsWith('x.ai/')) {
          // Only interactive extension requests get UI; everything else is
          // answered immediately so the agent never hangs on a timeout.
          if (!SUPPORTED_XAI_REQUESTS.has(method)) {
            void get().respondXai(
              ev.requestId,
              undefined,
              `前端不支持方法 ${method}`,
            )
            break
          }
          set({
            xaiRequests: [
              ...get().xaiRequests.filter((r) => r.requestId !== ev.requestId),
              row,
            ],
          })
        } else {
          set({
            pending: [
              ...get().pending.filter((p) => p.requestId !== ev.requestId),
              row,
            ],
          })
        }
        break
      }
      case 'client_request_resolved': {
        // Multi-tab: another client (or this tab, or host timeout) settled
        // the request — drop the matching card. Idempotent when we already
        // cleared locally after respondPermission / respondXai.
        const rid = ev.requestId
        if (!rid) break
        const s = get()
        if (
          !s.pending.some((p) => p.requestId === rid) &&
          !s.xaiRequests.some((r) => r.requestId === rid)
        ) {
          break
        }
        set({
          pending: s.pending.filter((p) => p.requestId !== rid),
          xaiRequests: s.xaiRequests.filter((r) => r.requestId !== rid),
        })
        break
      }
      case 'session_load_started': {
        // Multi-tab: another client is calling agent session/load for this
        // session. Agent will replay the full conversation on the shared
        // SSE bus. The initiator already has historyLoading (HTTP rebuild);
        // peers must arm the same gate or replay chunks APPEND onto the
        // existing scrollback (doubled timeline).
        const sid = ev.sessionId
        if (!sid || sid !== get().sessionId) break
        if (get().historyLoading) {
          // We are the initiator (continueSession / loadHistory already
          // running) — leave peerSessionLoad unset so finished is ignored.
          break
        }
        runtime.peerSessionLoadSid = sid
        // Drop gate only — loadHistory on finished clears/rebuilds entries.
        // statusText so the peer tab shows a brief loading cue.
        set({
          historyLoading: true,
          statusText: '另一窗口正在重放会话，同步中…',
        })
        break
      }
      case 'session_load_finished': {
        const sid = ev.sessionId
        if (!sid) break
        // Only the peer path rebuilds here. Initiator finishes via its own
        // continueSession → loadHistory chain and never set runtime.peerSessionLoadSid.
        if (runtime.peerSessionLoadSid !== sid) break
        runtime.peerSessionLoadSid = null
        if (get().sessionId !== sid) {
          // User navigated away mid-load — drop the gate and leave the
          // new session alone.
          if (get().historyLoading) set({ historyLoading: false })
          break
        }
        const cwd = (typeof ev.cwd === 'string' && ev.cwd) || get().cwd || ''
        if (ev.ok === false) {
          // Load failed on the other tab — just unstick the gate; keep
          // whatever scrollback we still have (historyLoading may have
          // blocked live events but we did not clear entries).
          set({
            historyLoading: false,
            statusText: '会话重放失败，保持当前视图',
          })
          break
        }
        if (!cwd) {
          set({ historyLoading: false, statusText: '会话重放完成' })
          break
        }
        // Rebuild from HTTP history (same path as continueSession). loadHistory
        // sets historyLoading again and replaces entries wholesale.
        void get().loadHistory(sid, cwd).then(() => {
          if (get().sessionId !== sid) return
          void syncPendingForSession(sid, get, set, runtime.sessionSwitchGen)
        })
        break
      }
      // ── x.ai/* extension notifications ────────────────────────────
    default:
      return false
  }
  return true
}
