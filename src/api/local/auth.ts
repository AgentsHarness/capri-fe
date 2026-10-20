import type { TransportCtx } from './ctx'
import { LOCAL_PROBE_TIMEOUT_MS } from './types'
import {
  PAGE_SLOT,
  saveGuestToken,
  saveHostToken,
  saveHubToken,
} from '../credentials'
import { clearHostRegistryHandoff } from '../rpc/hosts'

/**
 * 门禁与近路钥匙：hub 槽 / 页面 host 槽 / 每台 host 的近路槽。
 *
 * 401 在这里分两路——hub 那把被拒只清 hub 槽并通知 App 回门禁；某台 host
 * 的近路钥匙被拒只影响那一条近路，hub 登录不动。
 */

export const authMixin = {

  /**
   * 退出登录：只清 hub 槽。各台 host 的近路钥匙与通路选择保留——它们属于
   * 那台机器，不属于这次 hub 会话（重新登录 hub 后近路应立刻原样可用）。
   */
  logout(this: TransportCtx): void {
    this.hubToken = ''
    saveHubToken('')
    this.allowDetectAuth = false
    this.hubRejected = false
    clearHostRegistryHandoff()
    this.abortInflight()
    if (this.es || this.ws) this.connect()
  },


  /**
   * 写「当前门禁那把」：hub 模式写 hub 槽；纯 local 模式页面本身就是那台
   * host，写这台的 host 槽——两把钥匙在存储上彻底分开，纯 local 也不再借用
   * hub 槽（否则 hub 换密钥会顺手抹掉本机钥匙，反之亦然）。
   */
  setAccessToken(this: TransportCtx, token: string | null) {
    const next = (token ?? '').trim()
    // 门禁里输入的是管理员密钥：身份切回管理员，访客槽原样保留。
    this.credentialSource = 'admin'
    this.guest = null
    this.guestSessionId = ''
    if (this.mode === 'local') {
      this.setHostToken(this.pageSlot(), next)
    } else {
      this.hubToken = next
      saveHubToken(next)
    }
    this.allowDetectAuth = next !== ''
    this.hubRejected = false
    this.hostRejected.clear()
    // 凭证变了：用旧凭证拿到的注册表交接快照不再代表「这次鉴权后的数据」。
    clearHostRegistryHandoff()
    // Requests issued under the old token are settled now (re-fetches pick
    // up the new token).
    this.abortInflight()
    // Token change: re-try WS in case we are talking to a hub.
    if (this.es || this.ws) this.connect()
  },


  /**
   * 页面 origin 这台 host 的 host 槽键：认得出 hostId 就用它，认不出（host
   * 太旧、/api/hosts 不报 hostId）用保留键 PAGE_SLOT。
   */
  pageSlot(this: TransportCtx): string {
    for (const [id, r] of this.localRoutes) if (r.port === 0) return id
    return PAGE_SLOT
  },


  /** 某台 host 的近路钥匙槽（null 选中继；未知 host 落到页面槽）。 */
  hostKeySlot(this: TransportCtx, hostId: string | null | undefined): string {
    return hostId ?? PAGE_SLOT
  },


  /**
   * 当前门禁那把：管理员身份 = hub 槽（纯 local = 页面这台的 host 槽）；
   * 访客身份 = 访客槽。启动探测与「要不要弹门禁」都问它。
   */
  doorToken(this: TransportCtx): string {
    if (this.credentialSource === 'guest') return this.guestToken
    if (this.mode !== 'local') return this.hubToken
    return this.hostTokens[this.pageSlot()] ?? ''
  },


  /**
   * 探测用钥匙（`opts.auth === true`）。模式尚未判定时 `doorToken()` 可能
   * 还是空的（默认 mode 是 local，hostId 也还没认出来），这时退到 hub 槽
   * ——旧版单凭据槽时代 `new LocalTransport('', token)` 就靠这条路。
   */
  probeKey(this: TransportCtx): string {
    return this.doorToken() || this.hubToken
  },


  /** 这台 host 存过的近路钥匙（未存过 = 空串）。 */
  getHostToken(this: TransportCtx, hostId: string | null | undefined): string {
    return this.hostTokens[this.hostKeySlot(hostId)] ?? ''
  },


  /** 写某台的近路钥匙（空串 = 删）。只动 host 槽，绝不碰 hub 槽。 */
  setHostToken(this: TransportCtx, hostId: string | null | undefined, token: string): void {
    const slot = this.hostKeySlot(hostId)
    const t = token.trim()
    this.hostTokens = { ...this.hostTokens, [slot]: t }
    if (!t) delete this.hostTokens[slot]
    saveHostToken(slot, t)
  },


  /** 订阅「这台需要它自己的钥匙」（HostKeyModal）。 */
  onHostKeyRequired(this: TransportCtx, handler: (hostId: string) => void): () => void {
    this.hostKeyHandlers.add(handler)
    return () => this.hostKeyHandlers.delete(handler)
  },


  /** 订阅「hub 那把被拒」（App 回密钥门禁）。 */
  onHubAuthInvalid(this: TransportCtx, handler: () => void): () => void {
    this.hubAuthHandlers.add(handler)
    return () => this.hubAuthHandlers.delete(handler)
  },


  /**
   * 用户为某台 host 输入的钥匙：先验一把，**通过才落库**。
   * 成功 → 这台直连打开；失败 → 不落库、返回 false 让弹窗继续改。
   */
  async tryHostKey(this: TransportCtx, hostId: string, token: string): Promise<boolean> {
    if (!this.localRoutes.has(hostId)) return false
    this.probeAuthRetryAt.delete(hostId)
    this.setHostToken(hostId, token)
    const outcome = await this.tryLocalKey(hostId, 'host')
    if (outcome === 'ok') {
      const cur = this.localRoutes.get(hostId)
      if (cur) this.setProbe(hostId, { base: cur.base, port: cur.port }, 'host-ok')
      this.hostRejected.delete(hostId)
      this.setRouteChoice(hostId, 'auto')
      this.syncLocalSSE()
      return true
    }
    // 钥匙不对，或这台已经不在了：不要留下一把错的钥匙反复撞 401。
    this.setHostToken(hostId, '')
    return false
  },


  /**
   * 用户拒为某台 host 输入钥匙：这台改走中继。**不动 hub 登录**，其他
   * host 与整份注册表也都不动。
   */
  declineHostKey(this: TransportCtx, hostId: string): void {
    const cur = this.localRoutes.get(hostId)
    if (cur) this.setProbe(hostId, { base: cur.base, port: cur.port }, 'rejected')
    this.setRouteChoice(hostId, 'relay')
    this.syncLocalSSE()
  },


  /**
   * 请用户输入这台 host 的钥匙。只在**这正是用户选中的那台**时才问——没在用
   * 的 host 留着 `pending`（切过去时再探再问），绝不让启动时探到的一串候选把
   * 用户淹进弹窗。每台一次会话只问一遍（askedKeyFor）。
   */
  requestHostKey(this: TransportCtx, hostId: string): void {
    if (this.selectedHostId !== hostId) return
    if (this.askedKeyFor.has(hostId)) return
    this.askedKeyFor.add(hostId)
    for (const h of this.hostKeyHandlers) {
      try {
        h(hostId)
      } catch {
        /* 一个订阅者出错不影响其余 */
      }
    }
  },


  /**
   * 用某把钥匙打一次本机的 `GET /api/probe`。返回：
   * `ok`（200 且应答者就是这台）/ `denied`（401）/ `unreachable`（连不上或
   * 那把钥匙还没有，**不能**据此判认证）。
   *
   * 钥匙按 hostId 直接取，不走 `tokenFor`：探路往往发生在近路还不可用时
   * （`isLocalDirect()` 为 false），那时 routeOwner 判不出归属。
   */
  async tryLocalKey(
    this: TransportCtx,
    hostId: string,
    key: 'hub' | 'host',
  ): Promise<'ok' | 'denied' | 'unreachable'> {
    const route = this.localRoutes.get(hostId)
    if (!route) return 'unreachable'
    const token = key === 'hub' ? this.hubToken : this.getHostToken(hostId)
    if (!token) return 'unreachable'
    try {
      const res = await this.fetch(`${route.base || this.base}/api/probe`, {}, {
        timeoutMs: LOCAL_PROBE_TIMEOUT_MS,
        hubLevel: true,
        // 探路自带 401 语义，绝不能触发运行时的登出/退中继分流。
        authProbe: true,
        forceToken: token,
      })
      if (res.status === 401) return 'denied'
      if (!res.ok) return 'unreachable'
      const data = (await res.json().catch(() => ({}))) as { hostId?: string }
      // 应答者必须还是这台：近路的端口随时可能被别人占走。
      if (data.hostId && data.hostId !== hostId) return 'unreachable'
      return 'ok'
    } catch {
      return 'unreachable'
    }
  },


  /**
   * 401 按目标分流（**网络失败不进这里**——那是连通性问题，与认证无关）。
   * 目标归类是发请求前定好的 `{local, hostId}`：近路被第一条 401 关掉之后，
   * 同批剩下的 401 若回头重算目标，会被错认成 hub 拒绝、把有效的 hub 密钥
   * 一起抹掉——归因绝不能依赖此刻还变得动的路由状态。
   *
   * - `mode==='local'`：页面这台就是门，清「门禁那把」并回门禁；
   * - hub 拒绝：清 hub 槽、回门禁；
   * - 近路拒绝：只关这台的直连退中继，**hub 登录一概不动**；
   * - 并发里的一批 401 各只处理一次，直到换钥匙 / 用户显式改通路。
   */
  handleRejection(this: TransportCtx, target: { local: boolean; hostId: string | null }): void {
    const doorRejection = target.hostId === null || this.mode === 'local'
    if (!doorRejection) {
      const hostId = target.hostId as string
      if (this.hostRejected.has(hostId)) return
      this.hostRejected.add(hostId)
      // 被拒的那把不再复用：清掉这台的钥匙 + 关直连。hub 槽一个字都不动。
      this.setHostToken(hostId, '')
      this.declineHostKey(hostId)
      return
    }
    const slot = this.pageSlot()
    if (this.hubRejected) return
    // 访客槽被拒：清访客槽，**管理员那把原样保留**（切回管理员照样能进）。
    if (this.credentialSource === 'guest') {
      if (!this.guestToken) return
      this.hubRejected = true
      this.guestToken = ''
      saveGuestToken('')
      clearHostRegistryHandoff()
      for (const h of this.hubAuthHandlers) {
        try {
          h()
        } catch {
          /* 一个订阅者出错不影响其余 */
        }
      }
      return
    }
    if (!this.hubToken && !(this.mode === 'local' && this.hostTokens[slot])) return
    this.hubRejected = true
    this.hubToken = ''
    saveHubToken('')
    if (this.mode === 'local') this.setHostToken(slot, '')
    clearHostRegistryHandoff()
    for (const h of this.hubAuthHandlers) {
      try {
        h()
      } catch {
        /* 一个订阅者出错不影响其余 */
      }
    }
  },


  /**
   * 这条请求该出示哪把钥匙（null = 不带 Authorization）：
   * - 打 hub → hub 槽；
   * - 走近路且那台不设 FE_TOKEN → 谁都不带（绝不把 hub 密钥塞进
   *   `/events?token=`，那会把它写进 URL 与代理日志）；
   * - 走近路且那台要钥匙 → 这台的 host 槽；没存过就用 hub 那把（即探路
   *   通过的那把，两把同值时全程只问一次）。
   */
  tokenFor(this: TransportCtx, input: string): string | null {
    // 访客：全部请求都打 hub（isLocalDirect 恒 false），出示访客槽那把。
    if (this.credentialSource === 'guest') return this.guestToken || null
    if (!this.isLocalRequest(input)) return this.hubToken || null
    const slot = this.routeOwner(input)
    const route = slot ? this.localRoutes.get(slot) : null
    if (route && !route.authRequired) return null
    const hostKey = (slot && this.hostTokens[slot]) || ''
    // 纯 local 压根没有 hub：只出示存过的 host 钥匙，hub 槽那把绝不冒名。
    if (this.mode === 'local') return hostKey || null
    return hostKey || this.hubToken || null
  },
}
