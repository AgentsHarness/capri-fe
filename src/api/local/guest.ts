import type { TransportCtx } from './ctx'
import type { GuestIdentity, GuestSessionItem } from '../types'
import {
  adoptSharedToken as adoptTokenFromHash,
  loadGuestToken,
  loadHubToken,
  saveGuestToken,
  saveHubToken,
} from '../credentials'
import { clearHostRegistryHandoff } from '../rpc/hosts'

/**
 * 访客（只读分享）的身份与令牌槽。
 *
 * 两把钥匙两个槽：hub 槽是管理员门禁，访客槽是分享令牌。同一浏览器可以
 * 同时存两把，切身份只换「这次出示哪格」，互不覆盖。
 */

export const guestMixin = {

  // ── 访客模式 ──────────────────────────────────────────────────────

  /**
   * 采纳 URL fragment 里的分享令牌（`#g=…`）。返回是否采到一个新令牌；
   * 调用方在启动链最前面调用（早于 detectMode）。
   */
  adoptSharedToken(this: TransportCtx): boolean {
    const token = adoptTokenFromHash()
    if (!token) return false
    this.guestToken = token
    this.useGuestCredentials()
    return true
  },


  /**
   * 进入访客模式：记下身份、锁定 hub 中继、把选中 host 夹到白名单里的
   * 第一台。之后 url()/WS/live 事件全走访客分支。
   *
   * hub 判这把是访客，说明**当前出示的就是访客令牌**（老版本可能把它存在
   * hub 槽）：归位到访客槽并腾空 hub 槽，否则退出访客会拿着一把访客令牌
   * 站在管理员门禁前，怎么都进不去。
   */
  setGuestMode(this: TransportCtx, identity: GuestIdentity | null) {
    this.guest = identity
    this.guestSessionId = identity?.sessions[0]?.sessionId ?? ''
    if (!identity) return
    if (this.credentialSource !== 'guest') {
      const t = this.doorToken()
      if (t) {
        this.guestToken = t
        saveGuestToken(t)
        if (this.mode !== 'local') {
          this.hubToken = ''
          saveHubToken('')
        }
      }
      this.credentialSource = 'guest'
      this.allowDetectAuth = true
      this.hubRejected = false
      clearHostRegistryHandoff()
    }
    const first = identity.sessions[0]
    if (first?.hostId) this.setHost(first.hostId)
  },


  /**
   * 切成「出示访客槽」。管理员那把留在自己的槽里不动——退出访客时直接切回
   * 去即可，不需要备份/恢复。存储与内存的访客令牌是同一份真相源。
   */
  useGuestCredentials(this: TransportCtx): void {
    this.credentialSource = 'guest'
    this.allowDetectAuth = true
    this.hubRejected = false
    this.hostRejected.clear()
    clearHostRegistryHandoff()
    this.abortInflight()
  },


  /**
   * 切成「出示管理员槽」。只换令牌来源，不清任何存储：访客令牌照旧留着，
   * 下次再切回去不用重新输入。
   */
  useAdminCredentials(this: TransportCtx): void {
    this.credentialSource = 'admin'
    this.allowDetectAuth = true
    this.hubRejected = false
    this.hostRejected.clear()
    clearHostRegistryHandoff()
    this.abortInflight()
    if (this.es || this.ws) this.connect()
  },


  /**
   * hub 判定现在出示的那把是管理员：把它从访客槽搬回 hub 槽，身份归位管理员。
   *
   * 只在「访客槽被当成门禁令牌」时发生——分享链接里贴的其实是管理员密钥，
   * 或老版本把访客令牌写进 hub 槽留下的反向状态。搬过去之后两个槽仍然各司
   * 其职，下次切访客会重新问令牌。
   */
  settleAdminCredential(this: TransportCtx): void {
    if (this.credentialSource !== 'guest') return
    // 纯 local 没有 hub 槽的概念：只把身份归位，两个槽都不动。
    if (this.mode === 'local') {
      this.credentialSource = 'admin'
      return
    }
    const t = this.guestToken
    if (t && !this.hubToken) {
      this.hubToken = t
      saveHubToken(t)
    }
    this.guestToken = ''
    saveGuestToken('')
    this.credentialSource = 'admin'
  },


  /** 当前门禁用的是哪一格（顶栏据此渲染「切换到访客 / 退出访客」）。 */
  getCredentialSource(this: TransportCtx): 'admin' | 'guest' {
    return this.credentialSource
  },


  /** 存过的访客令牌（空串 = 没存过，切访客时要先问用户）。 */
  getGuestToken(this: TransportCtx): string {
    // 存储是真相源：多标签页写入、或本轮早于构造函数写入时，内存值可能是旧的。
    const stored = loadGuestToken()
    if (stored !== this.guestToken) {
      this.guestToken = stored
    }
    return this.guestToken
  },


  /**
   * 访客槽那把打不开门（分享链接已失效 / 被吊销）：清掉访客槽并回管理员
   * 身份。管理员那把一个字不动——它从来不在同一个槽里。
   */
  dropGuestCredential(this: TransportCtx): void {
    this.guestToken = ''
    saveGuestToken('')
    this.guest = null
    this.guestSessionId = ''
    this.credentialSource = 'admin'
    this.hubRejected = false
  },


  /**
   * 启动时选令牌来源：**管理员优先**。分享链接（`#g=`）已在 adoptSharedToken
   * 里抢先把来源置成 guest，这里不覆盖；其余情况只要有管理员密钥就用它，
   * 只有「本地从来没存过管理员密钥、但存过访客令牌」时才直接进访客视图，
   * 否则那台浏览器会被管理员门禁永远挡在自己进不去的地方。
   */
  chooseStartupCredential(this: TransportCtx): 'admin' | 'guest' {
    // 纯 local 没有 hub 承载白名单，无所谓访客视图：门禁那把永远是这台 host 的
    // （分享链接落到 local 页面也一样，别让访客槽顶掉本机钥匙）。
    if (this.mode === 'local') {
      this.credentialSource = 'admin'
      return 'admin'
    }
    if (this.credentialSource === 'guest') return 'guest'
    if (this.hasAdminToken()) return 'admin'
    if (this.getGuestToken()) {
      this.credentialSource = 'guest'
      return 'guest'
    }
    return 'admin'
  },


  /** 是否已经存着一把管理员门禁密钥（hub 槽；纯 local 是页面这台的 host 槽）。 */
  hasAdminToken(this: TransportCtx): boolean {
    return this.mode === 'local'
      ? !!this.hostTokens[this.pageSlot()]
      : loadHubToken() !== ''
  },


  /**
   * 顶栏「切换到访客模式」：有存过的访客令牌就直接拿它向 hub 复核身份；
   * 没存过则返回 'need_token'（此时**不动令牌槽**，管理员请求照常），由
   * UI 弹访客令牌输入框，输入后再调 {@link tryGuestToken}。
   *
   * 'invalid' = 存的那把被 hub 拒了（吊销 / 过期 / 其实是管理员密钥），
   * 已从访客槽清掉；'error' = 网络问题，槽原样保留，稍后重试即可。
   */
  async enterGuestMode(this: TransportCtx): Promise<'ok' | 'need_token' | 'invalid' | 'error'> {
    const stored = this.getGuestToken()
    if (!stored) return 'need_token'
    // 先验后切：失败时管理员身份与在途请求都没被动过，页面原样不动。
    const r = await this.probeGuestRole(stored)
    if (typeof r === 'string') {
      // 存的那把开不了访客视图（吊销 / 过期 / 其实是管理员密钥）：清掉，
      // 让 UI 要一把新的。
      if (r === 'invalid') this.dropGuestCredential()
      return r
    }
    this.useGuestCredentials()
    this.setGuestMode(r)
    if (this.es || this.ws) this.connect()
    return 'ok'
  },


  /**
   * 用一把用户输入的访客令牌进入访客模式：hub 的 `/api/access-role` 回 guest
   * 才算数（回 admin 说明这是管理员密钥，不是访客令牌）。通过才落库；失败
   * 不落库，当前管理员身份照常。
   */
  async tryGuestToken(this: TransportCtx, token: string): Promise<GuestIdentity | null> {
    const t = token.trim()
    if (!t) return null
    const r = await this.probeGuestRole(t)
    if (typeof r === 'string') return null
    this.guestToken = t
    saveGuestToken(t)
    this.useGuestCredentials()
    this.setGuestMode(r)
    if (this.es || this.ws) this.connect()
    return r
  },


  /**
   * 拿指定令牌问一次 hub 的角色。**不改身份、不改存储**：管理员界面上的
   * 「切到访客」必须能在验证失败时原样留在管理员那边，不能先把令牌槽换掉、
   * 把在途请求全 abort 一遍再退回来。
   *
   * 返回身份对象，或 'invalid'（401 / 404 / 不是访客令牌）、'error'（网络等）。
   */
  async probeGuestRole(this: TransportCtx, token: string): Promise<GuestIdentity | 'invalid' | 'error'> {
    if (this.mode !== 'hub') return 'error'
    try {
      const res = await this.fetch(
        `${this.apiBase()}/api/access-role`,
        {},
        {
          hubLevel: true,
          // 自带 401 语义：验令牌失败不能触发运行时「登录失效」分流。
          authProbe: true,
          forceToken: token,
        },
      )
      // 旧 hub 没有访客功能：404 当「不是访客令牌」处理。
      if (res.status === 401 || res.status === 404) return 'invalid'
      if (!res.ok) return 'error'
      const data = (await res.json().catch(() => null)) as {
        role?: string
        guest?: { id?: string; label?: string; expiresAt?: number }
        sessions?: GuestSessionItem[]
      } | null
      if (data?.role !== 'guest') return 'invalid'
      return {
        role: 'guest',
        guest: {
          id: data.guest?.id ?? '',
          label: data.guest?.label ?? '',
          expiresAt: data.guest?.expiresAt ?? 0,
        },
        sessions: Array.isArray(data.sessions) ? data.sessions : [],
      }
    } catch {
      return 'error'
    }
  },


  /** 当前访客身份（null = 管理员 / local）。 */
  getGuestIdentity(this: TransportCtx): GuestIdentity | null {
    return this.guest
  },


  isGuest(this: TransportCtx): boolean {
    return this.guest != null
  },


  /**
   * 退出访客：清掉访客身份，切回管理员槽（那把本来就没被顶掉），并重连。
   * 管理员槽为空时由调用方决定回门禁（`hasAdminToken()` 为 false）。
   */
  exitGuestMode(this: TransportCtx): void {
    const wasGuest = this.guest != null
    this.guest = null
    this.guestSessionId = ''
    if (!wasGuest) return
    this.useAdminCredentials()
    // 选中 host 不动：访客看的那台在管理员注册表里通常也在，applyHostRegistry
    // 会直接沿用；真不在（令牌只对白名单开放）时它自己会重新挑一台。
  },


  /**
   * 访客切换会话：换 host（若不同）+ 在同一 WS 上改订阅到 (host, session)。
   * 只做订阅，不触发任何写操作。
   */
  sendGuestSubscribe(this: TransportCtx, hostId: string, sessionId: string): void {
    if (!this.guest) return
    // 先写会话再换 host：setHost 内部会发一帧 subscribe，此时两字段都是新的。
    this.guestSessionId = sessionId
    if (hostId !== this.selectedHostId) this.setHost(hostId)
    else this.sendSubscribeFrame(sessionId)
  },
}
