import { transport } from '../../../api/client'
import type { ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { nid } from '../ids'
import { appendEntry } from '../entries'
import { scheduledTaskDeletedText } from '../tasks'
import { pushToast } from '../../toast'

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
   * /btw — 旁路小话（x.ai/btw）：不打断当前回合，直接发请求、不占 prompt
   * 队列。等待反馈是滚动区里一条进行中的 btw 条目（金色脉冲），HTTP 响应
   * 到达后按 id 原位更新为答案（markdown）或错误。
   * 按会话绑定：条目属于发起会话的 entries——用户切走会话后更新按 id
   * 找不到条目即自然失效，不会把答案/错误写进别的会话的滚动区（与
   * recapPendingFor 同款防跨会话残留）。
   */
  askBtw: async (question) => {
    const sid = get().sessionId
    if (!sid) {
      appendEntry(set, { kind: 'error', text: 'btw 失败: 无活动会话' })
      return
    }
    const id = nid()
    set({
      entries: [
        ...get().entries,
        { id, kind: 'btw', question, streaming: true, open: false },
      ],
    })
    try {
      const raw = await transport.btw({ question, sessionId: sid })
      const answer =
        raw && typeof raw === 'object'
          ? String((raw as Record<string, unknown>).answer ?? '')
          : ''
      set((s) => ({ entries: patchBtw(s.entries, id, { answer, streaming: false }) }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 错误态留在区块里直接可见（open 展开），不静默。
      set((s) => ({
        entries: patchBtw(s.entries, id, {
          error: msg,
          streaming: false,
          open: true,
        }),
      }))
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

  /**
   * Memory system — /remember <note>: the raw note goes through
   * POST /api/memory-rewrite → _x.ai/memory/rewrite, a one-shot LLM
   * reformat for MEMORY.md. That call does NOT persist — the TUI writes
   * the chosen text into its LOCAL memory storage, and the web FE has no
   * such channel (no save endpoint), so the rewritten entry is presented
   * in the scrollback instead of behind a fake confirm dialog. sessionId
   * is passed explicitly — never rely on the host's active-session
   * fallback.
   */
  rememberNote: async (rawText: string) => {
    const st = get()
    if (!st.sessionId) {
      appendEntry(set, { kind: 'error', text: '记忆笔记失败: 无活动会话' })
      return
    }
    try {
      const data: unknown = await transport.memoryRewrite(
        st.sessionId,
        rawText,
        extractRememberContext(st),
      )
      const rewritten =
        data && typeof data === 'object'
          ? (data as { result?: { rewritten?: unknown } }).result?.rewritten
          : undefined
      const text =
        typeof rewritten === 'string' && rewritten.trim() ? rewritten : rawText
      appendEntry(
        set,
        text === rawText
          ? { kind: 'session_event', text: `记忆笔记（原文）:\n${rawText}` }
          : {
              kind: 'session_event',
              text: `记忆笔记（改写稿）:\n${text}\n\n── 原文 ──\n${rawText}`,
            },
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      appendEntry(set, { kind: 'error', text: `记忆笔记失败: ${msg}` })
    }
  },

  /**
   * Fork the current session. Shared by the /fork command (full copy, TUI
   * /fork parity incl. --worktree) and the per-message Fork button
   * (targetPromptIndex = clicked message's turn → agent-side truncation).
   * On success the FE refreshes the session lists and switches to the
   * forked session (TUI switches to the peer agent).
   */
  forkSession: async (opts) => {
    const { worktree, targetPromptIndex, ...rest } = opts ?? {}
    const st = get()
    const sid = st.sessionId
    const cwd = st.cwd
    if (!sid || !cwd) {
      appendEntry(set, { kind: 'error', text: 'fork 失败: 无活动会话' })
      return
    }
    // Forking mid-turn would snapshot the session without the in-flight
    // turn's output — same busy rule as the /rewind picker (cancel-offer
    // there; a toast here, fork is restartable).
    if (st.conn === 'busy') {
      pushToast('会话运行中：等回合结束或先取消当前回合再 fork')
      return
    }
    try {
      let newId: string | undefined
      let newCwd = cwd
      if (worktree) {
        // TUI /fork --worktree (effects.rs CreateWorktreeSession): derive the
        // session into a fresh git worktree (full history, no truncation).
        // resume_session keys on the host's ACTIVE session — the FE forks the
        // session it is viewing, which is that one. Response wire keys:
        // {sessionId, worktreePath, effectiveCwd}.
        const r = await transport.gitWorktreeResumeSession({ sourceCwd: cwd, copyMode: 'dirty' })
        const o = (r ?? {}) as Record<string, unknown>
        newId =
          (typeof o.sessionId === 'string' && o.sessionId) ||
          (typeof o.session_id === 'string' && o.session_id) ||
          undefined
        const wt =
          (typeof o.effectiveCwd === 'string' && o.effectiveCwd) ||
          (typeof o.worktreePath === 'string' && o.worktreePath) ||
          ''
        if (wt) newCwd = wt
      } else {
        const params: Record<string, unknown> = { ...rest }
        if (targetPromptIndex != null) {
          // Clamp against the agent's own turn numbering: rewind points cover
          // every prompt 0..N-1, and the FE's window-relative count can
          // diverge from counted turns (mid-turn phantom user rows).
          const pts = await transport.rewindPoints(sid, cwd)
          if (pts.points.length === 0) throw new Error('没有可截断的回合')
          params.targetPromptIndex = Math.min(
            Math.max(0, Math.floor(targetPromptIndex)),
            pts.points.length - 1,
          )
        }
        const r = await transport.forkSession(params, sid)
        newId =
          (r.result as Record<string, unknown> | undefined)?.newSessionId as
            | string
            | undefined
      }
      if (!newId) throw new Error('fork 响应缺少新会话 id')
      // Switch FIRST, then refresh the lists: continueSession bumps
      // sessionSwitchGen, so refreshes dispatched before it capture the
      // pre-switch generation and get their results dropped by
      // isAsyncScopeCurrent — the forked session never showed up in the
      // sidebar. After the switch the generation is stable and both
      // refreshes land.
      await get().continueSession(newId, newCwd)
      void get().refreshSessions()
      void get().refreshWorkspaces()
      set({
        statusText: worktree
          ? `已在 worktree 中派生新会话 ${newId.slice(0, 8)}…`
          : `已 fork 新会话 ${newId.slice(0, 8)}…`,
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
      // Deleting the ACTIVE session lands in the EMPTY state (no
      // auto-new): reset all session-scoped state and drop the anchor.
      // The host clears its active-session pointer on the same delete,
      // so the next prompt without a sessionId creates a fresh session
      // there. Historical deletes just refresh the list.
      // resetToEmpty bumps sessionSwitchGen — run it BEFORE the list
      // refreshes: both capture an async scope keyed on that generation,
      // and a bump after dispatch makes isAsyncScopeCurrent drop the
      // fresh lists (the sidebar kept showing the deleted session until
      // an unrelated refresh).
      if (isCurrent) get().resetToEmpty()
      void get().refreshSessions()
      void get().refreshWorkspaces()
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

/**
 * 按 id 原位更新 btw 条目（答案/错误落位）；id 不在当前 entries（用户已
 * 切走会话）→ 原样返回原数组（引用不变，zustand 浅比较跳过重渲染）。
 */
function patchBtw(
  entries: ScrollEntry[],
  id: string,
  patch: { answer?: string; error?: string; streaming: boolean; open?: boolean },
): ScrollEntry[] {
  let changed = false
  const out = entries.map((e) => {
    if (e.id === id && e.kind === 'btw') {
      changed = true
      return { ...e, ...patch }
    }
    return e
  })
  return changed ? out : entries
}

/**
 * 轻量版会话上下文（TUI `extract_session_context` 的浏览器替代）：
 * CWD + 最近 5 条 user 文本（各截断 200 字符），供 memory/rewrite 的
 * 改写调用携带。纯读滚动区，无 DOM/fs 依赖。
 */
function extractRememberContext(st: ChatState): string {
  const parts = [`CWD: ${st.cwd ?? ''}`]
  const recent: string[] = []
  for (let i = st.entries.length - 1; i >= 0 && recent.length < 5; i--) {
    const e = st.entries[i]
    if (e && e.kind === 'user' && typeof e.text === 'string') {
      const t = e.text.trim()
      if (t) recent.push(t.length > 200 ? `${t.slice(0, 200)}...` : t)
    }
  }
  if (recent.length) {
    recent.reverse()
    parts.push('Recent prompts:', ...recent.map((p) => `- ${p}`))
  }
  return parts.join('\n')
}
