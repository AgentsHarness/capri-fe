import type { TransportCtx } from './ctx'
import type { LocalProbe, LocalRoute } from './types'
import {
  DEFAULT_LOCAL_PORT,
  LOCAL_PROBE_RETRY_MS,
  LOCAL_PROBE_TIMEOUT_MS,
  probeAllowsDirect,
} from './types'
import { PAGE_SLOT, dropHost, saveHubToken, saveRouteChoice } from '../credentials'
import type { RouteChoice } from '../credentials'
import { freshHostRegistry, rememberHostRegistry } from '../rpc/hosts'
import type { HostInfo } from '../types'

/**
 * 本机近路：发现、验证、钥匙与通路选择。
 *
 * 「近路」= 浏览器直连某台 capri-host（127.0.0.1:<port> 或页面自身
 * origin），不绕 hub 中继。认领依据是端口上服务**自报**的 hostId，且该
 * hostId 在 hub 注册表里——8765 是每台 host 的默认端口，靠端口号猜身份
 * 会把别的机器认成本机。
 */

export const routesMixin = {

  /**
   * 记录「页面 origin 本身就是这台 capri-host」（内嵌前端 / Vite 代理）。
   * 这类近路不需要 127.0.0.1 探测，base 记空串 = 直接用 this.base。传 null
   * 只清这一类，不动 discoverLocalHost 探到的回环近路。
   *
   * hostId 与 authRequired 都来自免鉴权的 `GET /api/hosts`：局域网 IP 打开
   * 内嵌前端时浏览器手里还没有 host 那把，只有这份应答能让它认出自己并升到
   * hub（旧实现问的是需鉴权的 /api/status → 401 → 盲判 local）。
   */
  setLocalHostId(this: TransportCtx, hostId: string | null, authRequired = false) {
    if (!hostId) {
      for (const [id, r] of this.localRoutes) if (r.port === 0) this.localRoutes.delete(id)
      return
    }
    this.bindRoute(hostId, '', 0, authRequired)
    // 老版本纯 local 把本机钥匙存在 hub 槽：认出页面这台后搬进 host 槽。
    // 走 setHostToken 而不是只动 localStorage——内存里那份必须同步，否则
    // 本轮会话仍然读不到刚搬过去的钥匙。
    if (
      this.mode === 'local' &&
      authRequired &&
      this.hubToken &&
      !this.getHostToken(hostId)
    ) {
      this.setHostToken(hostId, this.hubToken)
      this.hubToken = ''
      saveHubToken('')
    }
  },


  /**
   * 一条新候选近路的初始钥匙状态：存过这台的钥匙就当作可用（换 host 端口
   * 后可能失效，真被打回时由 401 分流负责退中继），没存过就先拿 hub 那把探
   * 一次；本机压根不设钥匙则直接开放。
   */
  probeFor(this: TransportCtx, hostId: string, authRequired: boolean): LocalProbe {
    if (!authRequired) return 'open'
    if (this.getHostToken(hostId)) return 'host-ok'
    return 'pending'
  },


  /**
   * 登记一条近路候选。同一 host 在同一个 origin 上被重新登记（注册表每次
   * hosts_changed 都会走一遍发现流程）时**保留已解析的钥匙状态**——清零会让
   * 已经探通、甚至已经输入过钥匙的机器悄悄退回 hub 中继；只有 base/端口/
   * 是否要钥匙真变了才当新候选重探。
   */
  bindRoute(this: TransportCtx, hostId: string, base: string, port: number, authRequired: boolean): void {
    const cur = this.localRoutes.get(hostId)
    const same = cur && cur.base === base && cur.port === port && cur.authRequired === authRequired
    this.localRoutes.set(hostId, {
      base,
      port,
      authRequired,
      probe: same ? cur!.probe : this.probeFor(hostId, authRequired),
    })
  },


  /** 用户对某台 host 通路的显式选择（默认 auto）。 */
  getRouteChoice(this: TransportCtx, hostId: string | null | undefined): RouteChoice {
    return (hostId && this.routeChoices[hostId]) || 'auto'
  },


  /**
   * 设定某台的通路。`direct` 会清掉「这台已拒/已问过」的闸门并重新走一遍
   * 先探再问；`relay` 只是关掉近路，注册表与 hub 登录都不动。
   */
  setRouteChoice(this: TransportCtx, hostId: string, choice: RouteChoice): void {
    this.routeChoices = { ...this.routeChoices, [hostId]: choice }
    if (choice === 'auto') delete this.routeChoices[hostId]
    saveRouteChoice(hostId, choice)
    if (choice !== 'relay') {
      this.hostRejected.delete(hostId)
      this.askedKeyFor.delete(hostId)
      this.probeAuthRetryAt.delete(hostId)
      const r = this.localRoutes.get(hostId)
      if (r && r.authRequired && r.probe === 'rejected') r.probe = 'pending'
    }
    if (this.selectedHostId === hostId) {
      this.syncLocalSSE()
      if (this.es || this.ws) this.connect()
    }
  },


  /** 这台有没有近路候选（127 探到了端口，或页面本身就是它）。 */
  hasLocalCandidate(this: TransportCtx, hostId: string | null | undefined): boolean {
    return !!hostId && this.localRoutes.has(hostId)
  },


  /** 主近路（按选中 host 优先），供「本机有几台 host / 页面是不是跑在 host 上」这类展示与挑选使用。 */
  primaryRoute(this: TransportCtx): [string, LocalRoute] | null {
    if (this.selectedHostId) {
      const sel = this.localRoutes.get(this.selectedHostId)
      if (sel) return [this.selectedHostId, sel]
    }
    for (const entry of this.localRoutes.entries()) return entry
    return null
  },


  getLocalHostId(this: TransportCtx): string | null {
    return this.primaryRoute()?.[0] ?? null
  },


  /**
   * 主近路的直连 base；空串表示本机就是页面 origin（Vite 代理 / 内嵌前端）。
   * 只作「选中本机 host 时」的近路，绝不覆盖 this.base——base 是 hub 的
   * 地址（同源部署时 hubUrl 为空、apiBase() 回落到 base），一旦被改写成
   * 127.0.0.1，listHosts / ws-ticket / prefs / /ws/fe 全都会打到本机
   * capri-host，host 列表就只剩本机、也切不到 Hub 中继的节点了。
   */
  getLocalBase(this: TransportCtx): string {
    return this.primaryRoute()?.[1].base ?? ''
  },


  /** 某台 host 已验证的本机近路（null = 只能走 hub 中继）。 */
  getLocalRoute(this: TransportCtx, hostId: string | null | undefined): LocalRoute | null {
    if (!hostId) return null
    return this.localRoutes.get(hostId) ?? null
  },


  /**
   * 这台 host 当前**实际**走哪条路（列表行标记用）：
   * - `direct`  近路可用（有候选 + 用户没选中继 + 钥匙已就绪）
   * - `pending` 探到了候选，但还差这台自己的钥匙——此刻仍走中继
   * - `relay`   只有 hub 一条路（或用户显式选了中继）
   */
  activeRouteFor(this: TransportCtx, hostId: string | null | undefined): 'direct' | 'pending' | 'relay' {
    if (!hostId || this.mode !== 'hub') return 'relay'
    if (this.usableRoute(hostId)) return 'direct'
    const route = this.localRoutes.get(hostId)
    if (route && this.getRouteChoice(hostId) !== 'relay') return 'pending'
    return 'relay'
  },


  /**
   * 可用的近路：hub 模式 + 有候选 + 用户没显式选中继 + 钥匙状态允许直连。
   * `pending` / `rejected` 时回 null —— 请求自动落回 hub 中继，用户不必先
   * 回答「这台要不要第二把钥匙」就能正常用。
   */
  usableRoute(this: TransportCtx, hostId: string | null | undefined): LocalRoute | null {
    if (this.mode !== 'hub' || !hostId) return null
    if (this.getRouteChoice(hostId) === 'relay') return null
    const route = this.localRoutes.get(hostId)
    if (!route || !probeAllowsDirect(route.probe)) return null
    return route
  },


  /**
   * 当前是否应直连本机：选中的 host 有一条可用近路。近路候选来自：
   * - detectMode：页面 origin 本身就是本机 capri-host（单 host + local:true，
   *   含用局域网 IP 打开内嵌前端的情况）
   * - discoverLocalHost / verifyLocalRoute：按 hub 登记的 port 探测 127.0.0.1，
   *   且端口上的服务自报了这台 host 的身份
   * 不按页面 hostname 过滤，避免局域网 IP 访问内嵌前端被误判为远程。
   */
  isLocalDirect(this: TransportCtx): boolean {
    // 访客没有本机近路：白名单只在 hub 上，直连本机等于绕过它。
    if (this.guest) return false
    return this.usableRoute(this.selectedHostId) != null
  },


  /** 选中 host 的直连 base：探到的 127.0.0.1 近路优先，否则页面 origin。 */
  directBase(this: TransportCtx): string {
    const route = this.usableRoute(this.selectedHostId)
    if (this.mode === 'hub' && route?.base) return route.base
    return this.base
  },


  pageIsLoopback(this: TransportCtx): boolean {
    const h = location.hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '::1'
  },


  /** 有没有「页面 origin 就是这台 host」的近路。 */
  hasPageOriginRoute(this: TransportCtx): boolean {
    for (const r of this.localRoutes.values()) if (r.port === 0) return true
    return false
  },


  /** 刚探不到、还在重试冷却里的端口。 */
  probeSkipped(this: TransportCtx, port: number): boolean {
    const at = this.probeFailedAt.get(port)
    return at != null && Date.now() - at < LOCAL_PROBE_RETRY_MS
  },


  /**
   * 探一次 `http://127.0.0.1:<port>/api/hosts`，返回端口上那个服务**自报**的
   * 身份。只认「恰好一个 host 且 local:true」的应答形状（capri-host 的
   * /api/hosts），其余当作没探到。
   */
  async probeLocalPort(
    this: TransportCtx,
    port: number,
  ): Promise<{ hostId: string; authRequired: boolean } | null> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), LOCAL_PROBE_TIMEOUT_MS)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/hosts`, { signal: ac.signal })
      if (!res.ok) return null
      const data = (await res.json().catch(() => ({}))) as {
        hosts?: Array<{ hostId?: string; local?: boolean }>
        authRequired?: boolean
      }
      const local =
        data.hosts?.length === 1 && data.hosts[0]?.local === true ? data.hosts[0] : null
      if (!local?.hostId) return null
      return { hostId: local.hostId, authRequired: data.authRequired === true }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  },


  /**
   * 定点核对「127.0.0.1:<这台 host 的端口> 上是不是就是它」+ 这条近路的钥匙
   * 状态：切到一台 host 时调用。身份必须逐字匹配（问的就是这台），探不到就
   * 作废旧近路，宁可回落到 hub 中继也不能把请求发到已经不属于它的端口上。
   */
  verifyLocalRoute(this: TransportCtx, hostId: string): Promise<void> {
    if (this.guest) return Promise.resolve()
    const running = this.probing.get(hostId)
    if (running) return running
    const p = (async () => {
      if (this.mode !== 'hub') return
      const cur = this.localRoutes.get(hostId)
      // 页面 origin 就是这台 host：近路与端口无关，身份不必再验，
      // 但钥匙状态仍可能要探一次。
      if (cur?.port === 0) {
        await this.probeLocalRoute(hostId)
        return
      }
      const port = this.knownPorts.get(hostId)
      // hub 没报这台 host 的端口（旧版本 host 不上报）：无从定点探测，
      // 已验证的身份继续用（那是它自己在 /api/hosts 里报的）。
      if (!port) {
        if (cur) await this.probeLocalRoute(hostId)
        return
      }
      if (!(cur && cur.port === port)) {
        // 这个端口刚探不到（没服务 / 浏览器拒绝了本地网络访问）→ 冷却期内不再
        // 撞第二次：切来切去只是多刷几条控制台错误。与 discoverLocalHost 共用
        // 同一套 LOCAL_PROBE_RETRY_MS 冷却，过期后照常重探。
        if (this.probeSkipped(port)) {
          if (cur) this.localRoutes.delete(hostId)
          this.syncLocalSSE()
          return
        }
        const hit = await this.probeLocalPort(port)
        if (hit?.hostId === hostId) {
          this.bindRoute(hostId, `http://127.0.0.1:${port}`, port, hit.authRequired)
          this.probeFailedAt.delete(port)
        } else {
          // 应答者为空 = 端口上没服务 / 被浏览器拒绝：进冷却。应答者是别的
          // host 时不冷却（那是有人在答，下一次心跳的端口变更仍要立刻看清）。
          if (!hit) this.probeFailedAt.set(port, Date.now())
          if (cur) this.localRoutes.delete(hostId)
          this.syncLocalSSE()
          return
        }
      }
      await this.probeLocalRoute(hostId)
      // 近路可能刚建立 / 刚作废：本机 SSE 那一路要跟着开关。
      this.syncLocalSSE()
    })().finally(() => this.probing.delete(hostId))
    this.probing.set(hostId, p)
    return p
  },


  /**
   * 把探路结论写回这条近路。**必须按当前对象写**：注册表刷新会把 route 整个
   * 替换掉，往闭包里抓住的旧对象上写会静默丢失——实测过一次「两把同值、探路
   * 已经 200，业务请求却全程留在 hub 中继」。同一 hostId 上 base+port 变了
   * 说明应答者已经换人，旧结论作废，让新候选自己再探一次。
   */
  setProbe(
    this: TransportCtx,
    hostId: string,
    probed: { base: string; port: number },
    probe: LocalProbe,
  ): LocalProbe {
    const cur = this.localRoutes.get(hostId)
    if (!cur || cur.base !== probed.base || cur.port !== probed.port) return 'pending'
    cur.probe = probe
    return probe
  },


  /**
   * 近路「先探再问」：默认直连这台，但直连得先有一把开得了它的钥匙。
   * - 这台不设 FE_TOKEN → `open`，直连，什么都不问；
   * - 已存过这台的钥匙 → `host-ok`（真被打回时由 401 分流退中继，不在此重复问）；
   * - 否则先拿 **hub 槽那把** 打一次 `GET /api/probe`：200 = 两把同值，直接
   *   直连、不弹窗；401 才请用户输入这台的钥匙（文案写明不是 Hub 密钥）；
   * - 探路本身失败（连不上 / 被浏览器拒绝本地网络）→ 保持 `pending`，
   *   **不改任何认证状态**，请求继续走 hub 中继。
   * 每台 host 一次会话只弹窗问一遍（askedKeyFor）。
   */
  async probeLocalRoute(this: TransportCtx, hostId: string): Promise<LocalProbe> {
    if (this.guest) return 'rejected'
    const route = this.localRoutes.get(hostId)
    if (!route) return 'rejected'
    const at = { base: route.base, port: route.port }
    if (!route.authRequired) {
      return this.setProbe(hostId, at, 'open')
    }
    if (route.probe === 'host-ok' || route.probe === 'rejected') return route.probe
    if (this.getHostToken(hostId)) {
      return this.setProbe(hostId, at, 'host-ok')
    }
    const running = this.probingAuth.get(hostId)
    if (running) return running
    const retryAt = this.probeAuthRetryAt.get(hostId)
    if (retryAt != null && Date.now() < retryAt) {
      // 冷却期内不再撞 401，但「该问用户」这件事不能跟着被吞掉：刚切到这台
      // 时正是该弹窗的时刻（requestHostKey 自己会去重、只管选中的那台）。
      if (route.probe === 'pending') this.requestHostKey(hostId)
      return route.probe
    }
    const p = (async (): Promise<LocalProbe> => {
      const outcome = await this.tryLocalKey(hostId, 'hub')
      if (outcome === 'ok') {
        this.probeAuthRetryAt.delete(hostId)
        const probe = this.setProbe(hostId, at, 'hub-ok')
        this.syncLocalSSE()
        return probe
      }
      if (outcome === 'denied') {
        // 401：hub 那把开不了这台 → 问这台的钥匙（用户取消则退中继）。
        // 冷却期内不再重复撞 401（hosts_changed 风暴会不停驱动探测）。
        this.probeAuthRetryAt.set(hostId, Date.now() + LOCAL_PROBE_RETRY_MS)
        const probe = this.setProbe(hostId, at, 'pending')
        if (probe === 'pending') this.requestHostKey(hostId)
        return probe
      }
      // 网络层失败：认证状态一律不动，下次再探。
      return route.probe
    })().finally(() => this.probingAuth.delete(hostId))
    this.probingAuth.set(hostId, p)
    return p
  },


  /**
   * 按 hub 登记的 port 探测本机 `http://127.0.0.1:<port>/api/hosts`，把
   * **应答者自报的 hostId**（必须在注册表里）登记成本机近路；之后选中该 host
   * 时 API/SSE 走本机直连。要点：
   * - 探测对象是端口，认领身份以端口上的服务自报为准。同一个端口号在每台机器
   *   上指向各自的 host（8765 是 capri-host 默认端口），拿 hub 列表里排在前面
   *   的那台去期待应答者，会把真正的本机 host 判成不匹配。
   * - 每个唯一端口只探一次，能同时命中同机的多台 host（各自不同端口）。
   * - 端口变了指漂了的近路并重探；探不到的端口进短暂冷却，别被 hosts_changed
   *   风暴反复驱动。
   * 已在 loopback 页面且已有页面 origin 近路时跳过（内嵌前端已够用）。
   * 返回主近路的 hostId，一台都没探到则 null。
   */
  async discoverLocalHost(
    this: TransportCtx,
    hosts?: Array<{ hostId: string; port?: number; online?: boolean }>,
  ): Promise<string | null> {
    if (this.guest) return null
    if (this.mode !== 'hub') return this.getLocalHostId()
    if (this.pageIsLoopback() && this.hasPageOriginRoute()) return this.getLocalHostId()

    let list = hosts
    if (!list) {
      const url = `${this.apiBase()}/api/hosts`
      // 先吃注册表交接快照：detectMode / probeAccess / listHosts 问的就是这个
      // URL 的同一份数据，这里再发一次纯属白跑一趟 hub 往返。
      const handed = freshHostRegistry(url)
      if (handed) {
        list = handed.hosts
      } else {
        try {
          const res = await this.fetch(url, {}, { hubLevel: true })
          if (!res.ok) return this.getLocalHostId()
          const data = (await res.json().catch(() => ({}))) as {
            hosts?: HostInfo[]
            defaultHostId?: string
            authRequired?: boolean
          }
          const rows = data.hosts ?? []
          list = rows
          rememberHostRegistry(url, {
            hosts: rows,
            defaultHostId: data.defaultHostId,
            authRequired: data.authRequired,
          })
        } catch {
          return this.getLocalHostId()
        }
      }
    }

    // 注册表：hostId → 本机端口（0 = 未知）。顺带缓存给 verifyLocalRoute 用。
    const registry = new Map<string, number>()
    for (const h of list) {
      if (!h?.hostId) continue
      const port =
        typeof h.port === 'number' && h.port >= 1 && h.port <= 65535 ? h.port : 0
      registry.set(h.hostId, port)
      if (port > 0) this.knownPorts.set(h.hostId, port)
    }
    // 注册表里没有的 host（unpair / 删除）：定点探测的端口线索一并清掉。
    // 钥匙与通路选择跟着清——这份列表来自鉴权后的 hub，是权威的；留着一把
    // 已解除配对机器的长期密钥只会白白躺在 localStorage 里。
    for (const hostId of [...this.knownPorts.keys()]) {
      if (!registry.has(hostId)) this.knownPorts.delete(hostId)
    }
    if (registry.size > 0) {
      for (const hostId of [...Object.keys(this.hostTokens), ...Object.keys(this.routeChoices)]) {
        if (hostId === PAGE_SLOT) continue
        if (!registry.has(hostId)) {
          dropHost(hostId)
          delete this.hostTokens[hostId]
          delete this.routeChoices[hostId]
        }
      }
    }

    // 作废旧近路：host 被删（不在注册表里）、或它自报的端口变了——缓存的
    // 127.0.0.1:<旧端口> 可能已经没有服务，甚至换成了别的进程。
    for (const [hostId, route] of [...this.localRoutes]) {
      if (route.port === 0) continue // 页面 origin 近路与端口无关
      const known = registry.get(hostId)
      if (known === undefined || (known > 0 && known !== route.port)) {
        this.localRoutes.delete(hostId)
      }
    }

    // 还没验证过的端口才探（已绑到某台 host 的端口跳过）。
    const covered = new Set<number>()
    for (const r of this.localRoutes.values()) if (r.port > 0) covered.add(r.port)
    const ports: number[] = []
    for (const port of new Set(registry.values())) {
      if (port > 0 && !covered.has(port) && !this.probeSkipped(port)) ports.push(port)
    }
    // 整份注册表都没下发端口（旧 hub/host）：仍试默认端口一次，身份以应答者为准。
    if (
      ports.length === 0 &&
      this.localRoutes.size === 0 &&
      registry.size > 0 &&
      !this.probeSkipped(DEFAULT_LOCAL_PORT)
    ) {
      ports.push(DEFAULT_LOCAL_PORT)
    }

    let bound = 0
    for (const port of ports) {
      const hit = await this.probeLocalPort(port)
      if (!hit) {
        this.probeFailedAt.set(port, Date.now())
        continue
      }
      this.probeFailedAt.delete(port)
      // 应答者必须是 hub 注册表里的一员：认不出身份的端口不绑。
      if (!registry.has(hit.hostId)) continue
      this.bindRoute(hit.hostId, `http://127.0.0.1:${port}`, port, hit.authRequired)
      bound += 1
    }
    if (bound > 0) {
      // 新绑上的候选逐个探一次钥匙（默认开近路；要第二把钥匙的才会走到弹窗）。
      await Promise.all(
        [...this.localRoutes.keys()].map((id) => this.probeLocalRoute(id)),
      )
    }
    // 近路可能新增（补开本机 SSE 近路）也可能刚作废（关掉那条 SSE）。
    this.syncLocalSSE()
    return this.getLocalHostId()
  },
}
