import { loadStr, removeKey, saveStr } from '../../../lib/storage'
import { transport } from '../../../api/client'
import type { HostInfo } from '../../../api/types'
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
import { clearSubagentSettleTimer, clearTurnBlipTimer } from '../turn'
import { refreshDefaultModeFlags } from '../modePersist'
import { KEY } from '../../../lib/keys'

export function hostActions(set: SetState, get: () => ChatState) {
  // 注册表应用（含首次自动选 host）：set 列表 + 离线/删除横幅 + 挑选
  // 默认 host。数据来源由调用方决定——refreshHosts 拉 GET /api/hosts；
  // hub 的 WS hello 已携带同一份快照（含 defaultHostId）时直接复用，
  // 打开页面省掉一次跨网往返（见 conn.ts hello 分支）。
  const applyHostRegistry = async (
    hosts: HostInfo[],
    defaultHostId: string | undefined,
  ) => {
    set({ hosts })
    const s = get()
    // 选中 host 掉线/恢复：hub 层横幅提示（id 精确清除，不影响
    // hub-ws 等其他 hub 层错误）。
    if (s.selectedHostId) {
      const sel = hosts.find((h) => h.hostId === s.selectedHostId)
      const cur = s.layerErrors.hub
      if (sel && !sel.online && cur?.id !== 'host-offline') {
        get().setLayerError('hub', {
          id: 'host-offline',
          level: 'error',
          message: `Host「${sel.hostName}」已离线`,
          at: Date.now(),
        })
      } else if (sel && sel.online && cur?.id === 'host-offline') {
        get().setLayerError('hub', undefined)
      }
      if (sel) return
      // 当前 host 已被外部删除（另一标签页 unpair / hub 侧清理）：它不在
      // 列表里，上面的离线横幅分支根本不会触发，不清掉选择就会一直顶着
      // 一个不存在的 host、要手动刷页才能恢复。落回下方重新挑选。
      removeKey(KEY.host)
      set({ selectedHostId: undefined })
      // 一台都不剩时没有可连的 host（下面也挑不出 pick），整份落到空状态；
      // 还有别的 host 时交给 switchHost 自己做全套视图复位。
      if (hosts.length === 0) {
        set({ hostId: undefined, hostName: undefined })
        get().resetToEmpty()
      }
    }
    // First selection. 本机优先只给「页面本身就跑在本机 host 上」的场景
    // （内嵌前端 / Vite 代理，localBase 为空）——那里残留的远程
    // capri-fe.host 会把 localhost 调试拐成「连不上本地」。远程站探测出的
    // 127.0.0.1 近路（getLocalBase 非空）只是一条加速通路，不该盖掉用户在这
    // 个 origin 上显式选过的 host，否则永远回到本机、切不到 Hub 中继节点。
    //
    // 每次注册表更新都把最新列表交给 transport：近路按端口上「应答者自报的身份」
    // 认领（8765 是每台 capri-host 的默认端口，同一端口号在不同机器上指向不同
    // host），由它据此作废旧端口、补探还没验过的端口（见 discoverLocalHost）。
    if (transport.getConnectionMode() === 'hub') {
      await transport.discoverLocalHost(hosts)
    }
    const localId = transport.getLocalHostId()
    const local = localId ? hosts.find((h) => h.hostId === localId) : undefined
    const saved = loadStr(KEY.host)
    const remembered = saved ? hosts.find((h) => h.hostId === saved) : undefined
    const first = transport.getLocalBase()
      ? remembered?.online
        ? remembered
        : local
      : local
    const pick =
      first ??
      remembered ??
      hosts.find((h) => h.hostId === defaultHostId) ??
      hosts.find((h) => h.online) ??
      hosts.find((h) => h.local) ??
      hosts[0]
    if (pick) void get().switchHost(pick.hostId)
  }

  return {
    refreshHosts: async (snap?: { hosts: HostInfo[]; defaultHostId?: string }) => {
      try {
        const { hosts, defaultHostId } = snap ?? (await transport.listHosts())
        await applyHostRegistry(hosts, defaultHostId)
      } catch {
        /* ignore */
      }
    },

  switchHost: async (hostId) => {
    // 本地模式锁定本机：host 切换只在 hub 模式有效（也不写
    // localStorage capri-fe.host，避免残留状态）。
    if (transport.getConnectionMode() !== 'hub') return
    if (hostId === get().selectedHostId) return
    // Invalidate every in-flight async result from the previous host.
    const myGen = ++runtime.sessionSwitchGen
    clearContinueSessionTimer()
    clearPeerSessionLoad()
    clearSubagentSettleTimer()
    clearTurnBlipTimer()
    get().stopTopTaskPolling()
    transport.setHost(hostId)
    saveStr(KEY.host, hostId)
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
      historyOpen: false,
      // 空状态工作目录按 host 隔离：切换到哪个 host 就显示哪个 host
      // 自己选过的目录（没有则 undefined → 宿主默认），绝不沿用别的
      // host 的路径。
      emptyCwd: (get().emptyCwdByHost ?? {})[hostId] ?? undefined,
      homeDir: undefined,
      entries: [],
      liveStream: null,
      openAssistantId: undefined,
      openThoughtId: undefined,
      currentStreamStartMs: undefined,
      lastCompletedTurn: undefined,
      turnStartedAt: undefined,
      currentPromptId: undefined,
      awaitingNext: false,
      genRate: undefined,
      lastSentPromptId: undefined,
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
      // 换 host 即换连接：清空分层横幅，新 host 的状态由 hello 快照
      // 重新驱动。
      layerErrors: {},
      conn: 'connecting',
      statusText: host ? '连接中…' : 'Host 未配对',
      historyLoading: false,
      historyLoadingMore: false,
      historySessionId: undefined,
      historyCwd: undefined,
      historyLoadedAt: undefined,
      historyPrependedAt: undefined,
      historyAnchorId: undefined,
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
      gitInfo: undefined,
      sessionStats: undefined,
      followUps: undefined,
      followUpsResponseId: undefined,
      cancelPanelOpen: false,
      queuePanelOpen: false,
      planMode: false,
    })
    // 先等 setHost 发起的端口归属探测落地（同一次探测，不重复请求），第一条
    // 快照 RPC 才能直接走本机近路而不是先绕一趟 hub。
    await transport.verifyLocalRoute(hostId)
    if (myGen !== runtime.sessionSwitchGen || get().selectedHostId !== hostId) return
    // 只依赖 hostId 的数据不等 status 往返：会话列表 / 工作区分组 / `[ui]`
    // 设置都是 host 级的（实测远程 host 的 status 要 1~2s，整条侧栏因此
    // 白等一趟）。需要 sessionId/cwd 的（历史快照、git-info、队列、统计条）
    // 由下面的 hello 驱动——统计条不在这里预拉：hello 锚定会话的瞬间
    // SessionStatsBar 的 keyed effect 就会拉，一次切换问两遍没有意义。
    void get().refreshSessions()
    void get().refreshWorkspaces()
    // `[ui]` 设置同样是 host 级的：init 那次预取跑在 host 选定之前，hub
    // 模式下必然被 setHost 的 abort 风暴取消，而且旧 host 的缓存不能跟着
    // 切过来——这里以新 host 为准重读一次。
    void refreshDefaultModeFlags()
    // Apply the host's status snapshot through the normal hello path so
    // model state, pending requests and busy flags hydrate consistently.
    try {
      const st = await transport.status()
      if (myGen !== runtime.sessionSwitchGen || get().selectedHostId !== hostId) return
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
      if (myGen !== runtime.sessionSwitchGen || get().selectedHostId !== hostId) return
      // Host 不可达：丢弃未落库的流式缓冲并取消 rAF，避免残留 flush
      // 在错误态之后把 conn 重新顶回 busy。
      clearStreamBuf()
      set({ conn: 'error', statusText: 'Host 不可达' })
      get().setLayerError('hub', {
        level: 'error',
        message: `Host「${host?.hostName ?? hostId}」不可达`,
        at: Date.now(),
      })
      return
    }
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
        removeKey(KEY.host)
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

  /**
   * 用户显式切换某台 host 的通路（host 列表菜单）。近路默认是开的，这里
   * 主要给「反悔退回中继」和「重新试一次直连」用。
   * - `relay` 只关掉这台的近路，注册表与 hub 登录都不动；
   * - `direct` 重新走一遍先探再问：先拿 hub 那把探，探不过再问这台的钥匙。
   */
  setHostRoute: async (hostId, choice) => {
    // 纯 local 没有「中继」可言（页面本身就是这台 host），菜单也不给点。
    if (transport.getConnectionMode() !== 'hub') return
    transport.setRouteChoice(hostId, choice)
    const name = get().hosts.find((h) => h.hostId === hostId)?.hostName ?? hostId
    if (choice === 'relay') {
      pushToast(`Host「${name}」改走 Hub 中继`)
    } else {
      await transport.verifyLocalRoute(hostId)
      if (transport.activeRouteFor(hostId) !== 'direct') {
        pushToast(`Host「${name}」还需要它自己的钥匙，先继续走 Hub 中继`)
      } else {
        pushToast(`Host「${name}」已改为本机直连`)
      }
    }
    // 通路状态存在 transport 里，store 无感；复制一份 hosts 触发列表重绘，
    // 行上的「直连 / 中继」标记才会跟着变。
    set({ hosts: get().hosts.slice() })
  },

  // 用户显式重启当前 host 的 agent（host 从不自动重启——只报错）。
  // 重启期间在飞回合被中断且不重试；成功/失败都走 toast，状态变化
  // 由 host 的 live 事件（error / ready）自然驱动。
  restartAgent: async () => {
    try {
      await transport.restartAgent()
      pushToast('Agent 已重启')
      return true
    } catch (e) {
      pushToast(`重启 Agent 失败: ${e instanceof Error ? e.message : String(e)}`)
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
    // 会话未锚定（空状态 / 切换窗口期）时拒绝切换：请求不带 sessionId
    // 会被 host 落到它自身的 active 会话（可能不是当前视图），切换因此
    // 失去会话隔离。提示先开始/恢复会话。
    if (!get().sessionId) {
      pushToast('请先开始或恢复一个会话，再切换模型')
      return
    }
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
