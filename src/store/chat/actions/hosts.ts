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
import { resetToolFillCache } from '../historyFill'
import { resetSessionState } from '../reset'
import { modelLabel, formatContextWindow } from '../model'
import { beginModelSwitch, endModelSwitch } from '../modelSwitchEcho'
import { appendEntry } from '../entries'
import { pushToast } from '../../toast'
import { refreshDefaultModeFlags } from '../modePersist'
import { KEY } from '../../../lib/keys'
import { blockGuestWrite, isGuestState } from '../guestMode'
import { turnIsLive } from '../turnStatus'
import { markUndelivered, UNDELIVERED_PREFIX } from '../send'
import { sealThought } from '../stream'
import { nid } from '../ids'

/**
 * 直播静默探针：busy 且这么久没有任何 live 事件，就去查一次 host 心跳。
 *
 * 为什么需要它：host↔hub 的上行断掉时，FE↔hub 的 /ws/fe 仍然好着——界面上
 * 只是"不再更新"，与"模型在长时间思考"完全同形。hub 的快速 503 只覆盖
 * 用户动作，靠 hub 自己广播 host-offline 又太慢；静默两秒先探一次心跳，
 * 用户不必盯着不动的界面猜。
 *
 * 而 hub 每收到一个 host 上行帧就刷新 HostInfo.LastSeen（busy 时心跳 1s
 * 一拍、空闲 5s 一拍），并按自己的时钟算出 lastSeenAgeMs 一起下发。查一次
 * 就能把「host 活着只是在思考」和「host 已经不出声了」分开——前者 age
 * 是新鲜的，后者停住了。
 */
export const SILENCE_PROBE_AFTER_MS = 2_000

/**
 * lastSeen 超过这个年龄就认为心跳停了。busy 心跳 1 秒一拍，这里留三拍
 * 余量（3.5s）：心跳是可丢的非关键入队，事件爆发时的队列压力、长 GC、
 * 笔记本睡眠唤醒都可能连丢一两拍，太紧会把「忙」误判成「断」。
 *
 * 这只是 UI 的暂定结论：真正判定归 hub（host-offline / 快速 503），
 * 探针只负责提前把「连接中断」说给用户听。
 */
export const HOST_HEARTBEAT_STALE_MS = 3_500

export type HostSilenceVerdict = 'alive' | 'silent' | 'unknown'

/**
 * 读一次注册表，判断选中 host 的心跳是否还在更新。
 *
 * 纯读：不改任何回合状态、不发提示。判定归 hub（host-offline / 中继快速
 * 失败），这里只为 UI 提供"该不该说一声"的依据。
 *
 * 只看 hub 算好的 lastSeenAgeMs，绝不拿 lastSeen 减浏览器时钟：两个时间戳
 * 来自两台机器，时钟差几秒就会把一条健康心跳算成 "停了"，长工具调用期间
 * 会直接误报「Host 连接中断」。v2 hub 每帧都算出该字段，缺失按刚收到
 * 心跳处理。
 */
export async function probeHostHeartbeat(
  selectedHostId: string | undefined,
): Promise<HostSilenceVerdict> {
  if (!selectedHostId) return 'unknown'
  let hosts: HostInfo[]
  try {
    ;({ hosts } = await transport.listHosts())
  } catch {
    // 连注册表都拿不到：那是 FE↔hub 的问题，由 hub-ws 提示负责，不在这里
    // 下结论（误报成 host 断线会更糟）。
    return 'unknown'
  }
  const sel = hosts.find((h) => h.hostId === selectedHostId)
  if (!sel || !sel.online) return 'silent'
  // v2 hub 总会算好 age；真缺了就当刚收到（不拿 lastSeen 减本机时钟）。
  const ageMs = sel.lastSeenAgeMs ?? 0
  return ageMs >= HOST_HEARTBEAT_STALE_MS ? 'silent' : 'alive'
}

/**
 * host 被判离线时，收掉一个「已经上屏、但可能从未送达」的回合。
 *
 * 这个洞的形状：POST /api/prompt 经 hub 中继，上行链路静默死掉时请求会
 * 停在 hub 的 pending 表里，前端既不抛错也没有回音；而乐观用户行在发出
 * 请求之前就已经画好，于是界面看起来像个正常进行中的回合。等到 hub 把
 * host 标离线（心跳静默 / 传输层 drop），才第一次拿到"对方没了"的证据。
 *
 * 三档判定，按证据强弱排列：
 * 1) 收到过本回合的 live 事件 → 回合确实在 host 上跑过，什么都不做
 *    （重连的 gap-pull 会补齐输出）。
 * 2) 拿到过 200（promptAcceptedAt）→ host 已受理，回合在跑，只是输出
 *    回不来。不改回合状态，只在状态行提示"已送达，等待 Host 恢复连接…"。
 * 3) 两者都没有 → 消息很可能根本没到 host。收掉假 busy，给可重发的错误行。
 */
function handleHostOfflineTurn(
  set: SetState,
  get: () => ChatState,
  hostName: string,
) {
  const s = get()
  const started = s.turnStartedAt
  const accepted = s.promptAcceptedAt
  const lastLive = transport.lastLiveEventAt()
  const sawLive = started != null && lastLive != null && lastLive >= started
  if (sawLive) return

  // 已受理：回合在 host 上跑着，本端只是收不到输出。保持 busy，别把用户
  // 引向"重发"——重发会被 host 判为重号而静默丢弃，看起来像又发失败了。
  if (accepted != null) {
    if (s.conn === 'busy' || s.conn === 'ready') {
      // 空闲态的 idleStatusLine 优先读 statusText；不清掉上一次操作回执，
      // 「已送达，等待 Host 恢复连接…」会被它遮住。
      set({ phaseText: '已送达，等待 Host 恢复连接…', statusText: '' })
    }
    return
  }

  if (!turnIsLive(s) || started == null) return
  const msg = `消息未送达 Host「${hostName}」（连接已断开）`
  const after = sealThought(s)
  clearStreamBuf()
  // 用户行本身也要能重试：错误行在时间线末尾，用户回头看的是自己那条
  // prompt。标记跟随 lastSentPromptId（send() 写的是同一条），重发成功后
  // send() 重新画行，标记自然消失。
  const marked = markUndelivered(after.entries, s.lastSentPromptId)
  set({
    ...after,
    // 用户行与 currentPromptId 保留：线上那条"我发的没出去"还在，重发入口
    // 按 currentPromptId 复用同一身份。pendingOptimisticUserId 必须清掉：
    // turnLiveLocally / busyPlausibleForView 把它当作"回合在飞"，下一个
    // ready/hello 会据此把刚判死的回合又顶回 busy（重发时 send() 会重新
    // 点亮它，见 send.ts 的 pendingOptimisticUserId: userId）。
    conn: 'error',
    statusText: '',
    pendingOptimisticUserId: undefined,
    awaitingNext: false,
    turnStartedAt: undefined,
    entries: [
      ...marked,
      { id: nid(), kind: 'error', text: msg, action: 'resend' },
    ],
  })
}

/**
 * 重发上一轮那条「未送达」的用户消息：把它原样再发一次，并沿用同一个
 * promptId。host 侧按 promptId 去重（见 capri-host PromptWithOpts 的
 * claimPromptIDLocked），所以万一原请求其实已经受理，重发也不会跑出
 * 第二个回合。
 *
 * 没有可重发的回合（已送达 / 已收口）时返回 false。
 */
export function resendUndeliveredPrompt(
  set: SetState,
  get: () => ChatState,
): boolean {
  const s = get()
  const promptId = s.currentPromptId
  const row = s.entries.find((e) => e.id === s.lastSentPromptId)
  if (!promptId || !row || row.kind !== 'user') return false
  // 两个入口共用：时间线末尾的错误行（conn 已翻成 error）与用户行上的
  // 行内重试。后者在 host 恢复 ready 之后仍要可用——用户行上的按钮是
  // 「这条没送到」的持久标记，不随连接状态被清掉。
  if (s.conn !== 'error' && row.undelivered !== true) return false
  // 把失败回合的痕迹一起收走（用户行 + 未送达错误行）：重发会重新画出
  // 用户行，否则时间线上会留下两遍同样的内容。
  const kept = s.entries.filter(
    (e) =>
      e.id !== row.id &&
      !(e.kind === 'error' && e.text.startsWith(UNDELIVERED_PREFIX)),
  )
  const blocks =
    row.kind === 'user' && row.images?.length
      ? [
          ...(row.text ? [{ type: 'text' as const, text: row.text }] : []),
          ...row.images.map((img) => ({
            type: 'image' as const,
            data: img.data,
            mimeType: img.mimeType ?? 'image/png',
          })),
        ]
      : undefined
  set({ ...sealThought({ ...s, entries: kept }), layerErrors: {} })
  void get().send(row.text, blocks, { promptId })
  return true
}

export function hostActions(set: SetState, get: () => ChatState) {
  // 注册表应用（含首次自动选 host）：set 列表 + 离线/删除提示 + 挑选
  // 默认 host。数据来源由调用方决定——refreshHosts 拉 GET /api/hosts；
  // hub 的 WS hello 已携带同一份快照（含 defaultHostId）时直接复用，
  // 打开页面省掉一次跨网往返（见 conn.ts hello 分支）。
  const applyHostRegistry = async (
    hosts: HostInfo[],
    defaultHostId: string | undefined,
  ) => {
    // 访客：注册表只剩白名单里的 host，选中哪台由「当前会话」决定——
    // 不走 switchHost（它会清会话视图），也不探本机近路。
    if (isGuestState(get())) {
      const cur = get().guestSessions.find((s) => s.sessionId === get().sessionId)
      const hostId = cur?.hostId ?? transport.getHost() ?? undefined
      // 选中 host 掉线/恢复：与管理员同一条 hub 层提示（访客顶栏也显示）。
      if (hostId) {
        const sel = hosts.find((h) => h.hostId === hostId)
        const err = get().layerErrors.hub
        if (sel && !sel.online && err?.id !== 'host-offline') {
          // 访客只读，没有本端在途回合要收口，提示照旧就地设置。
          get().setLayerError('hub', {
            id: 'host-offline',
            level: 'error',
            message: `Host「${sel.hostName}」连接中断，正在重连…`,
            at: Date.now(),
          })
        } else if (sel && sel.online && err?.id === 'host-offline') {
          get().setLayerError('hub', undefined)
        }
      }
      set({
        hosts,
        ...(hostId ? { selectedHostId: hostId } : {}),
        ...(hostId
          ? {
              hostId,
              hostName:
                hosts.find((h) => h.hostId === hostId)?.hostName ??
                cur?.hostName ??
                get().hostName,
            }
          : {}),
      })
      return
    }
    set({ hosts })
    const s = get()
    // 选中 host 掉线/恢复：hub 层提示（id 精确清除，不影响
    // hub-ws 等其他 hub 层错误）。
    if (s.selectedHostId) {
      const sel = hosts.find((h) => h.hostId === s.selectedHostId)
      const cur = s.layerErrors.hub
      if (sel && !sel.online && cur?.id !== 'host-offline') {
        handleHostOfflineTurn(set, get, sel.hostName)
        if (!get().layerErrors.hub) {
          get().setLayerError('hub', {
            id: 'host-offline',
            level: 'error',
            message: `Host「${sel.hostName}」连接中断，正在重连…`,
            at: Date.now(),
          })
        }
      } else if (sel && sel.online && cur?.id === 'host-offline') {
        get().setLayerError('hub', undefined)
      }
      if (sel) return
      // 当前 host 已被外部删除（另一标签页 unpair / hub 侧清理）：它不在
      // 列表里，上面的离线提示分支根本不会触发，不清掉选择就会一直顶着
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
    // 访客的 host 由白名单会话决定（switchGuestSession 换订阅），
    // 不开放整台 host 的切换。
    if (blockGuestWrite(get(), '访客模式下请切换会话')) return
    // 本地模式锁定本机：host 切换只在 hub 模式有效（也不写
    // localStorage capri-fe.host，避免残留状态）。
    if (transport.getConnectionMode() !== 'hub') return
    if (hostId === get().selectedHostId) return
    clearContinueSessionTimer()
    clearPeerSessionLoad()
    get().stopTopTaskPolling()
    transport.setHost(hostId)
    saveStr(KEY.host, hostId)
    const host = get().hosts.find((h) => h.hostId === hostId)
    const emptyCwdByHost = get().emptyCwdByHost ?? {}
    clearSuppressedTools()
    resetToolFillCache()
    clearStreamBuf()
    // 换 host 先经统一会话复位清空全部会话态（含 usage / sessionStatus /
    // todos / goalState / mcpServers 等状态栏芯片数据源——目标 host 处于
    // 无活跃会话的空状态时不会触发 loadHistory，漏清会把上一台 host 的
    // 上下文状态留在 WorkspaceBar 最右侧），再覆盖 host 级字段。
    resetSessionState(set, {
      selectedHostId: hostId,
      hostId,
      hostName: host?.hostName,
      historyOpen: false,
      // 空状态工作目录按 host 隔离：切换到哪个 host 就显示哪个 host
      // 自己选过的目录（没有则 undefined → 宿主默认），绝不沿用别的
      // host 的路径。
      emptyCwd: emptyCwdByHost[hostId] ?? undefined,
      emptyCwdByHost,
      // 模型 id 只对产生它的那台 host 有意义：空状态下选的模型（等新会话
      // 下发）不能带到另一台 host 的目录里。
      pendingModel: undefined,
      homeDir: undefined,
      sessions: [],
      workspaces: [],
      workspaceLoading: false,
      modes: undefined,
      // 换 host 即换连接：清空分层错误栈，新 host 的状态由 hello 快照
      // 重新驱动。
      layerErrors: {},
      conn: 'connecting',
      phaseText: host ? '连接中…' : 'Host 未配对',
      cancelPanelOpen: false,
      queuePanelOpen: false,
    })
    // Invalidate every in-flight async result from the previous host.
    const myGen = runtime.sessionSwitchGen
    // 先等 setHost 发起的端口归属探测落地（同一次探测，不重复请求），第一条
    // 快照 RPC 才能直接走本机近路而不是先绕一趟 hub。
    await transport.verifyLocalRoute(hostId)
    if (myGen !== runtime.sessionSwitchGen || get().selectedHostId !== hostId) return
    // 只依赖 hostId 的数据不等 status 往返：会话列表 / 工作区分组 / `[ui]`
    // 设置都是 host 级的（实测远程 host 的 status 要 1~2s，整条侧栏因此
    // 白等一趟）。需要 sessionId/cwd 的（历史快照、git-info、队列、统计条）
    // 由下面的 hello 驱动——统计条不在这里预拉：hello 锚定会话的瞬间
    // SessionStatsBar 的 keyed effect 就会拉，一次切换问两遍没有意义。
    // 先清掉两台列表的节流窗口：新 host 的数据是另一份，不能因为上一台
    // 刚刷过就把这一台的首轮推迟到 400ms 后。
    get().resetListRefreshGates()
    void get().refreshSessionLists()
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
      // (the hello handler reads ev.error).
      const snapError: string | undefined =
        typeof st.bootError === 'string' && st.bootError ? st.bootError : undefined
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
      set({ conn: 'error', phaseText: 'Host 不可达' })
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

  setModel: async (
    modelId: string,
    reasoningEffort?: string,
    opts?: { asDefault?: boolean; contextWindow?: number },
  ) => {
    if (blockGuestWrite(get())) return
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
    const ctxWin =
      opts?.contextWindow && opts.contextWindow > 0 ? opts.contextWindow : undefined
    // 空状态（尚未建会话 / 切换窗口期）：host 的 set-model 必须带
    // sessionId（无 sid 直接 400，不会有发错会话的风险），此刻下发不了。
    // 记下选择并乐观更新 caption，newSession 锚定后按它补发——新对话里
    // 先选模型再发第一条消息即可生效，不必先建会话。
    if (!get().sessionId) {
      set({
        modelName: name,
        reasoningEffort: effort,
        pendingModel: {
          modelId,
          ...(effort ? { reasoningEffort: effort } : {}),
          ...(opts?.asDefault ? { asDefault: true } : {}),
          ...(ctxWin ? { contextWindow: ctxWin } : {}),
        },
      })
      pushToast(`${modelLabel(name, effort)} 将在新对话生效`, { type: 'info' })
      return
    }
    const prevName = get().modelName
    const prevEffort = get().reasoningEffort
    const sid = get().sessionId
    // host 先广播 model_changed 再回 HTTP 响应：登记本次目标，广播处理只
    // 更新身份、不落行，切换记录留给下面的乐观行（见 modelSwitchEcho）。
    if (sid) beginModelSwitch(sid, modelId)
    try {
      // 档位被 agent 拒绝（模型已切换）：caption 不能留在那个 agent 根本没
      // 采用的档位上，回滚成切换前会话实际生效的档位，并把 host 的话弹成
      // toast——静默成功会让用户以为档位生效了。
      const warning = (
        await (ctxWin
          ? transport.setModel(modelId, reasoningEffort, sid, ctxWin)
          : transport.setModel(modelId, reasoningEffort, sid))
      )?.warning
      // 回滚后的档位就是 caption 与时间线应显示的值：失败时是旧档位，成功
      // 时是本次请求的档位（未指定档位则为 undefined，由后续 models_update
      // 补上新模型的默认档）。
      const shownEffort = warning ? prevEffort : effort
      set((s) => ({
        modelName: name,
        reasoningEffort: shownEffort,
        // 目录是窗口的唯一真源：把本次选择乐观写进该模型条目，菜单与上下文
        // 芯片立刻跟上；host 随后 patch 缓存目录并 models_update 收敛。
        // 未指定窗口（普通切模型）保持原值——agent 是 Preserve 语义，沿用
        // 会话当前选择，新模型不支持时回落到它自己的默认窗口。
        ...(ctxWin
          ? {
              models: s.models.map((x) =>
                x.modelId === modelId
                  ? { ...x, contextWindowSelection: ctxWin }
                  : x,
              ),
              // 芯片的分母跟着窗口走，不等下一帧 session_status。
              usage: { used: s.usage?.used, size: ctxWin },
            }
          : {}),
      }))
      // Model switch feedback goes to the scrollback (session_event),
      // like the TUI's `Switched to <model>` pager toast. The host's
      // model_changed broadcast also prints its own line. Amber accent
      // (warning) makes the switch visible in the timeline.
      const ctxSuffix = ctxWin ? ` · 上下文 ${formatContextWindow(ctxWin)}` : ''
      appendEntry(set, {
        kind: 'session_event',
        text:
          prevName && prevName !== name
            ? `模型已从 ${modelLabel(prevName, prevEffort)} 切换到 ${modelLabel(name, shownEffort)}${ctxSuffix}`
            : `模型已切换到 ${modelLabel(name, shownEffort)}${ctxSuffix}`,
        warning: true,
      })
      if (warning) {
        pushToast(warning, { type: 'warning' })
        appendEntry(set, { kind: 'session_event', text: warning, warning: true })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      appendEntry(set, {
        kind: 'session_event',
        text: `切换模型失败: ${msg}`,
        warning: true,
      })
    } finally {
      // 无论成功/失败都释放：请求结束后同目标的广播要么已被乐观行覆盖
      // （名称已相同），要么本来就该按广播落行（比如切换失败后 agent 自己
      // 回滚触发的 model_changed）。
      if (sid) endModelSwitch(sid, modelId)
    }
    // 「设为默认」勾选：写在切换之后（TUI /model 的偏好副作用）。host 的
    // set-default-model 同样要求 sessionId（它内部先切会话再落盘），所以
    // 只有锚定后才有这一步。
    if (opts?.asDefault) {
      const sid = get().sessionId
      if (sid) {
        try {
          await (ctxWin
            ? transport.setDefaultModel(modelId, reasoningEffort, sid, ctxWin)
            : transport.setDefaultModel(modelId, reasoningEffort, sid))
          pushToast('已设为默认模型')
        } catch (e) {
          pushToast(`设为默认失败: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  },
  } satisfies Partial<ChatState>
}
