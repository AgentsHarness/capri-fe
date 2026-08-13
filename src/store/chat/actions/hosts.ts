import { transport } from '../../../api/localTransport'
import type { ChatState, SetState } from '../types'
import { clearStreamBuf } from '../stream'
import {
  clearContinueSessionTimer,
  clearPeerSessionLoad,
  runtime,
} from '../globals'
import { clearSuppressedTools } from '../tools'
import { modelLabel } from '../model'
import { appendEntry } from '../entries'
import { pushToast } from '../../toast'

export function hostActions(set: SetState, get: () => ChatState) {
  return {
  refreshHosts: async () => {
    try {
      const { hosts, defaultHostId } = await transport.listHosts()
      set({ hosts })
      const s = get()
      if (s.selectedHostId) return
      // First selection: persisted choice → hub default → first online →
      // first local host (local mode).
      let saved: string | null = null
      try {
        saved = localStorage.getItem('acp-fe.host')
      } catch {
        /* ignore */
      }
      const pick =
        (saved ? hosts.find((h) => h.hostId === saved) : undefined) ??
        hosts.find((h) => h.hostId === defaultHostId) ??
        hosts.find((h) => h.online) ??
        hosts.find((h) => h.local) ??
        hosts[0]
      if (pick) void get().switchHost(pick.hostId)
    } catch {
      /* ignore */
    }
  },

  switchHost: async (hostId) => {
    // 本地模式锁定本机：host 切换只在 hub 模式有效（也不写
    // localStorage acp-fe.host，避免残留状态）。
    if (transport.getConnectionMode() !== 'hub') return
    if (hostId === get().selectedHostId) return
    // Invalidate every in-flight async result from the previous host.
    runtime.sessionSwitchGen += 1
    clearContinueSessionTimer()
    clearPeerSessionLoad()
    get().stopTopTaskPolling()
    transport.setHost(hostId)
    try {
      localStorage.setItem('acp-fe.host', hostId)
    } catch {
      /* ignore */
    }
    const host = get().hosts.find((h) => h.hostId === hostId)
    clearSuppressedTools()
    clearStreamBuf()
    set({
      selectedHostId: hostId,
      hostId,
      hostName: host?.hostName,
      sessionId: undefined,
      cwd: undefined,
      // 换 host 即换会话视图：旧 host 的加载失败提示一并清掉。
      historyLoadError: undefined,
      // 空状态工作目录按 host 隔离：切换到哪个 host 就显示哪个 host
      // 自己选过的目录（没有则 undefined → 宿主默认），绝不沿用别的
      // host 的路径。
      emptyCwd: (get().emptyCwdByHost ?? {})[hostId] ?? undefined,
      homeDir: undefined,
      entries: [],
      liveStream: null,
      sessions: [],
      workspaces: [],
      workspaceLoading: false,
      pending: [],
      xaiRequests: [],
      diffReview: undefined,
      diffReviewOpen: false,
      memoryFiles: undefined,
      memoryOpen: false,
      pendingOptimisticUserId: undefined,
      modes: undefined,
      agentCommands: [],
      error: undefined,
      statusWarning: undefined,
      conn: 'connecting',
      statusText: host ? '连接中…' : 'Host 未配对',
      historyOpen: false,
      historyTotalCount: undefined,
      historyLoadedCount: 0,
      historyLoadedStart: undefined,
      historyHasMore: false,
      historyPromptStarts: undefined,
      historyTurnIdx: 0,
      toolIndex: {},
      subagentIndex: {},
      pendingSubagentFinishes: {},
      subagentChildIndex: {},
      subagentViews: {},
      bgTaskIndex: {},
      topTasks: [],
      scheduledTasks: [],
      followUps: undefined,
      followUpsResponseId: undefined,
      cancelPanelOpen: false,
      queuePanelOpen: false,
      planMode: false,
    })
    // Apply the host's status snapshot through the normal hello path so
    // model state, pending requests and busy flags hydrate consistently.
    try {
      const st = await transport.status()
      // GET /api/status serializes the host Status struct verbatim, so a
      // boot failure arrives as `bootError` — while the SSE hello event
      // (http.go handleSSE) maps the same field to `error`. Normalize so
      // a failed boot surfaces the error instead of hanging on "启动中…"
      // (the hello handler reads ev.error). Never clobber an `error` that
      // the snapshot itself already carried.
      const snapError: string | undefined =
        typeof st.bootError === 'string' && st.bootError
          ? st.bootError
          : typeof st.error === 'string'
            ? st.error
            : undefined
      transport.emitLocal({
        type: 'hello',
        ...st,
        ...(snapError ? { error: snapError } : {}),
      })
    } catch {
      // Host 不可达：丢弃未落库的流式缓冲并取消 rAF，避免残留 flush
      // 在错误态之后把 conn 重新顶回 busy。
      clearStreamBuf()
      set({ conn: 'error', statusText: 'Host 不可达' })
      return
    }
    void get().refreshSessions()
    void get().refreshWorkspaces()
  },

  renameHost: async (hostId, hostName) => {
    try {
      await transport.renameHost(hostId, hostName)
      // 本地乐观更新 + 后台刷新注册表（hub 也会广播 hosts_changed）。
      set({
        hosts: get().hosts.map((h) =>
          h.hostId === hostId ? { ...h, hostName } : h,
        ),
      })
      if (get().selectedHostId === hostId) set({ hostName })
      void get().refreshHosts()
      pushToast('Host 名称已更新')
      return true
    } catch (e) {
      pushToast(`修改 Host 失败: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  },

  deleteHost: async (hostId) => {
    const host = get().hosts.find((h) => h.hostId === hostId)
    try {
      await transport.unpairHost(hostId)
      // 删掉的是当前选中 host：清掉选择，让 refreshHosts 重新挑选
      // （持久化选择一并清除，避免下次进页面选中一个已删除的 host）。
      if (get().selectedHostId === hostId) {
        try {
          localStorage.removeItem('acp-fe.host')
        } catch {
          /* ignore */
        }
        set({ selectedHostId: undefined })
      }
      // refreshHosts 直接以新注册表为准（不依赖 hosts_changed 广播）。
      const remaining = get().hosts.filter((h) => h.hostId !== hostId)
      set({
        hosts: remaining,
        // 一个 host 都不剩时清掉 host 展示态（下拉兜底显示 Local Host）。
        ...(remaining.length === 0
          ? { hostId: undefined, hostName: undefined }
          : {}),
      })
      await get().refreshHosts()
      pushToast(`Host「${host?.hostName ?? hostId}」已删除`)
      return true
    } catch (e) {
      pushToast(`删除 Host 失败: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  },

  fetchPairingCode: async () => {
    try {
      return await transport.pairingCode()
    } catch (e) {
      pushToast(`获取配对码失败: ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  },

  rotatePairingCode: async () => {
    try {
      const next = await transport.rotatePairingCode()
      pushToast('已生成新配对码，旧码立即失效')
      return next
    } catch (e) {
      pushToast(`轮换配对码失败: ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  },

  setModel: async (modelId, reasoningEffort) => {
    const prevName = get().modelName
    const prevEffort = get().reasoningEffort
    try {
      await transport.setModel(modelId, reasoningEffort, get().sessionId)
      // Optimistic: agent broadcasts model_changed on success, but the
      // request itself is the authority for local state (TUI does the same).
      const m = get().models.find((x) => x.modelId === modelId)
      const def =
        m?.reasoningEfforts?.find((r) => r.default) ??
        m?.reasoningEfforts?.[0]
      // Prefer the wire value (canonical level) for the caption suffix.
      const effort =
        reasoningEffort ??
        def?.value ??
        def?.id ??
        m?.reasoningEffort
      const name = m?.name || modelId
      set({
        modelName: name,
        reasoningEffort: effort,
      })
      // Model switch feedback goes to the scrollback (session_event),
      // like the TUI's `Switched to <model>` pager toast. The host's
      // model_changed broadcast also prints its own line. Amber accent
      // (warning) makes the switch visible in the timeline.
      appendEntry(set, {
        kind: 'session_event',
        text:
          prevName && prevName !== name
            ? `模型已从 ${modelLabel(prevName, prevEffort)} 切换到 ${modelLabel(name, effort)}`
            : `模型已切换到 ${modelLabel(name, effort)}`,
        warning: true,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      appendEntry(set, {
        kind: 'session_event',
        text: `切换模型失败: ${msg}`,
        warning: true,
      })
    }
  },
  } satisfies Partial<ChatState>
}
