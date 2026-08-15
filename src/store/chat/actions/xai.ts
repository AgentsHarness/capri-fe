import { transport } from '../../../api/client'
import type { ChatState, SetState } from '../types'
import { nid } from '../ids'
import { appendEntry } from '../entries'
import { scheduledTaskDeletedText } from '../tasks'

export function xaiActions(set: SetState, get: () => ChatState) {
  return {
  requestRecap: async () => {
    try {
      await transport.recap(false, get().sessionId)
      // fire-and-forget：显示等待指示（turn status 行 spinner + 相位
      // 计时），直到 session_recap / session_recap_unavailable 返回。
      // 绑定发起会话：只有该会话活动时显示，切换会话不残留。
      set({ recapPendingFor: get().sessionId, statusText: '正在生成摘要…' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        recapPendingFor: undefined,
        statusText: '摘要失败',
        entries: [...get().entries, { id: nid(), kind: 'error', text: msg }],
      })
    }
  },

  /**
   * Memory system — /flush (TUI /flush): persist the session's knowledge
   * to memory right now. The host contract is POST /api/memory-flush
   * `{ sessionId }` → `{ ok: true }` (parallel host work — a 404 here is
   * surfaced as an error row, not a hang). Progress events
   * (memory_flush_started / memory_flush_completed) arrive as
   * session_notification tags and render their own scrollback lines.
   */
  memoryFlush: async () => {
    const st = get()
    if (!st.sessionId) {
      appendEntry(set, { kind: 'error', text: '记忆刷新失败: 无活动会话' })
      return
    }
    try {
      await transport.memoryFlush(st.sessionId)
      set({ statusText: '正在刷新记忆…' })
      appendEntry(set, { kind: 'session_event', text: '等待记忆刷新完成…' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      appendEntry(set, { kind: 'error', text: `记忆刷新失败: ${msg}` })
    }
  },

  forkSession: async (opts) => {
    try {
      const r = await transport.forkSession(opts ?? {}, get().sessionId)
      const newId =
        (r.result as Record<string, unknown> | undefined)?.newSessionId as
          | string
          | undefined
      appendEntry(set, {
        kind: 'status',
        text: newId ? `已 fork 新会话 ${newId.slice(0, 8)}…` : '已 fork 新会话',
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `fork 失败: ${msg}` }],
      })
    }
  },

  renameSession: async (title) => {
    try {
      await transport.renameSession(title, get().sessionId)
      set({ sessionTitle: title, statusText: `已重命名为「${title}」` })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `重命名失败: ${msg}` }],
      })
    }
  },

  cancelSubagent: async (subagentId) => {
    try {
      await transport.cancelSubagent(subagentId, get().sessionId)
      set({ statusText: '正在取消子代理…' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `取消子代理失败: ${msg}` }],
      })
    }
  },

  killTask: async (taskId) => {
    try {
      await transport.killTask(taskId, get().sessionId)
      set({ statusText: '正在终止后台任务…' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `终止任务失败: ${msg}` }],
      })
    }
  },

  deleteSession: async (sessionId, cwd) => {
    // Capture the verdict BEFORE the delete request: sessionDelete can
    // take a while (worktree cleanup etc.), and the user may switch to
    // that session mid-request — the auto-fallback decision must reflect
    // the session's identity when the delete was issued, not after the
    // await (otherwise a historical delete could spuriously end the
    // newly-focused session and create a fresh one).
    const isCurrent = sessionId === get().sessionId
    try {
      await transport.sessionDelete(sessionId, cwd)
      set({ statusText: `已删除会话 ${sessionId.slice(0, 8)}` })
      void get().refreshSessions()
      void get().refreshWorkspaces()
      // Deleting the ACTIVE session lands in the EMPTY state (no
      // auto-new): reset all session-scoped state and drop the anchor.
      // The host clears its active-session pointer on the same delete,
      // so the next prompt without a sessionId creates a fresh session
      // there. Historical deletes just refresh the list.
      if (isCurrent) get().resetToEmpty()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `删除会话失败: ${msg}` }],
      })
    }
  },

  compactSession: async (note) => {
    const s = get()
    if (!s.sessionId || !s.cwd) {
      set({ statusText: '压缩失败: 无活动会话' })
      return
    }
    try {
      await transport.compact(s.sessionId, note)
      set({ statusText: note ? `已提交压缩「${note}」` : '已提交压缩' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `压缩失败: ${msg}` }],
      })
    }
  },

  rewindPoints: async () => {
    const s = get()
    if (!s.sessionId || !s.cwd) throw new Error('无活动会话')
    try {
      const r = await transport.rewindPoints(s.sessionId, s.cwd)
      return r.points
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Audit row (same style as fork 失败); the picker rethrows so it
      // can render the inline error too.
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `获取回退点失败: ${msg}` }],
      })
      throw e
    }
  },

  rewindExecute: async (targetIndex, mode) => {
    const s = get()
    if (!s.sessionId || !s.cwd) {
      set({ statusText: '回退失败: 无活动会话' })
      return undefined
    }
    try {
      const r = await transport.rewindExecute(s.sessionId, targetIndex, mode)
      set({
        statusText: `已回退到索引 ${targetIndex}${
          mode === 'all' ? '（含文件）' : ''
        }，重新加载历史…`,
      })
      // The rewind landed on a point whose prompt the agent echoes back
      // (RewindResponse.prompt_text). Park it in stashedDraft so the
      // composer restores it on picker close — replacing the pre-picker
      // draft with the rewound prompt, ready to edit / resend. No
      // promptText → the user's original draft comes back untouched.
      if (r.promptText) set({ stashedDraft: r.promptText })
      // The rewind truncates the conversation tail — reload the current
      // session's history so the scrollback reflects the rewound state.
      // Scheduled tasks belong to the same session, so stash them across
      // the loadHistory reset (which clears per-session state).
      const keep = get().scheduledTasks
      await get().loadHistory(s.sessionId, s.cwd)
      if (keep.length > 0) set({ scheduledTasks: keep })
      // Outcome details (reverted files / conflicts) ride back to the
      // picker so it can surface file-revert feedback (toast / warning).
      return r
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `回退失败: ${msg}` }],
      })
      throw e
    }
  },

  deleteScheduledTask: async (taskId) => {
    const s = get()
    if (!s.sessionId) {
      set({ statusText: '删除调度任务失败: 无活动会话' })
      return
    }
    try {
      await transport.schedulerDelete(s.sessionId, taskId)
      // Optimistic local removal — the host's scheduled_task_deleted SSE
      // (either carrier) arrives later and is idempotent on a missing id.
      // 用户主动删除 → reason=deleted 的提示文案（reason 回退链的
      // 迟到 SSE 会再补一条 session_event 行）。
      set({
        statusText: scheduledTaskDeletedText('deleted'),
        scheduledTasks: get().scheduledTasks.filter((t) => t.taskId !== taskId),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `删除调度任务失败: ${msg}` }],
      })
    }
  },

  // ── MCP management (TUI /mcps — host endpoints may be unsupported;
  //    every method rethrows so the McpPanel renders the failure inline) ──
  mcpList: async () => {
    const r = await transport.mcpList()
    return r.servers
  },

  mcpToggle: async (name, enabled) => {
    await transport.mcpToggle(name, enabled)
  },

  mcpToggleTool: async (serverName, toolName, enabled) => {
    await transport.mcpToggleTool(serverName, toolName, enabled)
  },

  mcpAdd: async (server) => {
    await transport.mcpAdd(server)
  },

  mcpRemove: async (name) => {
    await transport.mcpRemove(name)
  },

  mcpAuthTrigger: async (name) => {
    const r = await transport.mcpAuthTrigger(name)
    // Agent contract: { status, setup?, error? } — surface a readable
    // message; keep url/code passthrough for hosts that offer an OAuth
    // link directly.
    const status = typeof r.status === 'string' ? r.status : undefined
    const error = typeof r.error === 'string' && r.error ? r.error : undefined
    const message =
      status === 'failed'
        ? `认证失败${error ? `: ${error}` : ''}`
        : status === 'setup_required'
          ? '该服务器需要先完成配置（setup）'
          : status === 'authenticated'
            ? '认证成功'
            : error
              ? `认证异常: ${error}`
              : undefined
    return {
      ...(typeof r.url === 'string' && r.url ? { url: r.url } : {}),
      ...(typeof r.code === 'string' && r.code ? { code: r.code } : {}),
      ...(message ? { message } : {}),
    }
  },
  } satisfies Partial<ChatState>
}
