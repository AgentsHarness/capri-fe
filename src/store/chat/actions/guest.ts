import { transport } from '../../../api/client'
import type { GuestIdentity, GuestSessionItem, GuestSessionState, HostStatus } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { resetSessionState } from '../reset'
import { loadHistoryWithTaskProbe } from '../loadHistory'
import { runtime } from '../globals'

/**
 * 访客模式（只读）的 store 切片。
 *
 * 身份由启动链从 GET /api/access-role 取到后写入；此后绝大多数写操作在
 * 入口直接拒绝（见各 action 里的 guest 守卫），hub 侧也会再拒一次——前端
 * 守卫是为了给出「访客模式为只读」的即时反馈，不是安全边界。
 */

import { isGuestState, setGuestActive } from '../guestMode'

export { isGuestState, blockGuestWrite } from '../guestMode'

/**
 * 从 /api/status 里取出访客可用的那部分会话状态。
 *
 * hub 给访客的 status 已经删掉了 pendingRequests / roster，只把「你正在看
 * 的这个会话」压成 sessionState + busy + awaitingInput + pendingInput。
 * 老 hub（没有这几个字段）返回 undefined：访客状态行就当没有状态可显示，
 * 而不是猜一个。
 */
function readGuestStatus(status: HostStatus, sessionId: string): GuestSessionState | undefined {
  const root = status as unknown as Record<string, unknown>
  if (root.sessionId !== sessionId) return undefined
  const state = root.sessionState
  if (state !== 'active' && state !== 'awaiting' && state !== 'idle') return undefined
  const pi = root.pendingInput as Record<string, unknown> | undefined
  const kind =
    pi && typeof pi.kind === 'string'
      ? (pi.kind as NonNullable<GuestSessionState['pendingInput']>['kind'])
      : undefined
  const count = pi && typeof pi.count === 'number' ? pi.count : 0
  return {
    sessionState: state,
    busy: root.busy === true,
    awaitingInput: root.awaitingInput === true,
    ...(kind && count > 0
      ? {
          pendingInput: {
            kind,
            count,
            ...(typeof pi?.receivedAt === 'number' ? { receivedAt: pi.receivedAt } : {}),
          },
        }
      : {}),
  }
}

/** 写入访客状态；老 hub 缺字段时清掉，不保留上一次的过期读数。 */
function applyGuestStatus(set: SetState, status: HostStatus, sessionId: string): void {
  set({ guestSessionState: readGuestStatus(status, sessionId) })
}

export function guestActions(set: SetState, get: () => ChatState) {
  return {
    /** 启动链写入访客身份（null = 管理员）。 */
    setGuestIdentity: (identity: GuestIdentity | null) => {
      // 模块级镜像供 chat store 之外的模块读（见 guestMode.ts）。
      setGuestActive(identity != null)
      if (!identity) {
        set({ guestIdentity: undefined, guestSessions: [], guestSessionState: undefined })
        return
      }
      set({ guestIdentity: identity, guestSessions: identity.sessions })
    },

    /**
     * 从顶栏 host 列表切进访客视图：身份 + 会话视图一起换。
     *
     * 必须整份复位会话态：管理员的当前会话属于另一个身份，沿用会让访客壳
     * 的「首条白名单会话」加载守卫（historyLoadedAt / entryCount）直接早退，
     * 滚动区停在管理员那边的旧内容上。
     */
    enterGuestSession: (identity: GuestIdentity) => {
      transport.setGuestMode(identity)
      setGuestActive(true)
      const first = identity.sessions[0]
      resetSessionState(set, {
        guestIdentity: identity,
        guestSessions: identity.sessions,
        conn: 'ready',
        statusText: '只读 · 历史',
        ...(first?.hostId
          ? {
              selectedHostId: first.hostId,
              hostId: first.hostId,
              ...(first.hostName ? { hostName: first.hostName } : {}),
            }
          : {}),
      })
    },

    /** 重新拉一次白名单（refresh 后或从设置里加/删会话时）。 */
    refreshGuestSessions: async () => {
      if (!isGuestState(get())) return
      try {
        const sessions = await transport.guestSessions()
        const identity = get().guestIdentity
        set({
          guestSessions: sessions,
          ...(identity ? { guestIdentity: { ...identity, sessions } } : {}),
        })
      } catch {
        /* 网络失败：保留现有白名单 */
      }
    },

    /**
     * 访客切换会话：换订阅 + 只读加载历史。
     *
     * 不走 continueSession —— 后者会发 `session/load`（agent 侧写操作）。
     * 这里只做 `setHost` + `subscribe(host, session)` + `loadHistory`，读的是
     * host 持久化的 updates.jsonl。
     */
    switchGuestSession: async (item: GuestSessionItem) => {
      if (!isGuestState(get())) return
      if (!item.hostId || !item.sessionId) return
      const sid = item.sessionId
      const cwd = item.cwd ?? ''
      // host 锚点必须在发起加载**之前**就位：loadHistory 用调用前的
      // selectedHostId/hostId 作为「这份快照归谁」的凭据，而 hub 的 hello
      // 随时会经 refreshHosts 补上这两项（访客壳挂载时它们还是 undefined）。
      // 晚写一步，在途快照就会被判成「会话已被切走」而静默早退，滚动区
      // 永久停在「加载会话…」（线上访客链接实测）。
      set({
        selectedHostId: item.hostId,
        hostId: item.hostId,
        ...(item.hostName ? { hostName: item.hostName } : {}),
      })
      // 加载代际：切换期间旧的 loadHistory 结果必须作废（resetSessionState
      // 已推进 sessionSwitchGen，这里拿新值做比对）。
      resetSessionState(set, {
        sessionId: sid,
        cwd: cwd || undefined,
        conn: 'ready',
        statusText: '只读 · 历史',
        historyLoading: true,
      })
      transport.sendGuestSubscribe(item.hostId, sid)
      const myGen = runtime.sessionSwitchGen
      // 状态快照与历史并行：模型/模式/分支这类状态栏数据来自 status，
      // 历史有独立来源。失败不阻塞（离线时只剩历史）。
      const statusP = transport.status().catch(() => null)
      const [, status] = await Promise.all([loadHistoryWithTaskProbe(get, sid, cwd), statusP])
      if (myGen !== runtime.sessionSwitchGen) return
      if (status) {
        // 用 ready 事件走既有的状态应用路径（models/modes/configOptions/
        // 权限徽标 + refreshGitInfo）。ready 不会触发 session/load。
        transport.emitLocal({
          type: 'ready',
          ...status,
          sessionId: sid,
          cwd: cwd || status.cwd,
          hostId: item.hostId,
          ...(item.hostName ? { hostName: item.hostName } : {}),
        })
        applyGuestStatus(set, status, sid)
      }
      set({ statusText: '只读 · 历史' })
    },

    /**
     * 重拉当前会话的只读状态。hub 把 /api/status 的 pendingRequests /
     * roster 换成了一份按会话过滤的摘要（sessionState + pendingInput），
     * 所以这里读的仍是 status，只是能用的字段少得多。
     *
     * 失败静默：断线/离线时保留上一次状态，不要用一个错误把只读视图
     * 打成空白。
     */
    refreshGuestStatus: async (sessionId?: string) => {
      if (!isGuestState(get())) return
      const sid = sessionId ?? get().sessionId
      if (!sid) return
      const myGen = runtime.sessionSwitchGen
      try {
        const status = await transport.status()
        if (myGen !== runtime.sessionSwitchGen) return
        if (get().sessionId !== sid) return
        applyGuestStatus(set, status, sid)
      } catch {
        /* 离线：保留上一次状态 */
      }
    },

    /**
     * 退出访客：切回管理员令牌（那把本来就没被顶掉），复位会话视图，由 App
     * 重新跑启动链（管理员密钥还在就直接进主界面，不在就回门禁）。
     */
    exitGuestSession: () => {
      transport.exitGuestMode()
      setGuestActive(false)
      resetSessionState(set, {
        guestIdentity: undefined,
        guestSessions: [],
        guestSessionState: undefined,
      })
    },
  } satisfies Partial<ChatState>
}
