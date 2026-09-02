import type { AcpEvent, HostInfo } from './types'
import { loadStr, removeKey, saveStr } from '../lib/storage'
import type { TransportHandler, TransportMode } from './transport'
import { EventSequencer, type SequencedEvent } from './liveSequencing'
import { rpcMixins } from './rpc/mixins'
import { clearHostRegistryHandoff, rememberHostRegistry, freshHostRegistry } from './rpc/hosts'


function resolveAccessToken(): string {
  return loadStr('capri-fe-token')?.trim() || ''
}

type HubWsFrame =
  | { type: 'hello'; service?: string; hosts?: unknown; defaultHostId?: string; seqs?: Record<string, number>; [k: string]: unknown }
  | { type: 'events'; events: AcpEvent[] }
  | { type: 'ping'; ts?: number }
  | { type: string; [k: string]: unknown }

/**
 * Default hard timeout for transport fetches. Host-side endpoints are
 * quick operations; 30s covers slow hubs while bounding half-open TCP
 * connections that would otherwise hang the fetch (and, for gap pulls,
 * wedge the per-host `pulling` slot) forever.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000

/** 旧 hub/host 不下发 port 时试的本机默认端口（与 capri-host 的 PORT 默认一致）。 */
const DEFAULT_LOCAL_PORT = 8765
/** 单个 127.0.0.1 探测的超时：本机要么毫秒级应答，要么根本没服务。 */
const LOCAL_PROBE_TIMEOUT_MS = 800
/** 探不到的端口多久内不再重复探测（hosts_changed 会频繁驱动 discoverLocalHost）。 */
const LOCAL_PROBE_RETRY_MS = 30_000

/** 一条已验证的本机近路（host 直连，不绕 hub 中继）。 */
export type LocalRoute = {
  /** 直连用的 origin（如 http://127.0.0.1:8765）；空串 = 页面 origin 本身。 */
  base: string
  /** 验证时这台 host 自报的本机监听端口；0 = 页面 origin 近路（与端口无关）。 */
  port: number
  /** 这台 host 的 API 是否要求 FE_TOKEN。 */
  authRequired: boolean
}

/** 无 DecompressionStream 环境（旧浏览器）压缩帧会被丢弃——只告警一次。 */
let warnedNoDecompression = false
function warnNoDecompressionOnce(): void {
  if (warnedNoDecompression) return
  warnedNoDecompression = true
  console.warn('deflate 解压不可用，丢弃压缩帧')
}

export class LocalTransport {
  private es: EventSource | null = null
  private ws: WebSocket | null = null
  private handlers = new Set<TransportHandler>()
  private base: string
  private selectedHostId: string | null = null
  /** 显式连接模式：由 detectMode() 判定（host 配置 HUB_URL → hub）。 */
  private mode: TransportMode = 'local'
  /** hub 模式的 hub 浏览器侧地址（跨源直连用；空则退回 base）。 */
  private hubUrl = ''
  /**
   * 最近一次探测到的远端 hub origin（仅 hub 模式使用）。local 模式
   * 由 setConnectionMode 清空——置顶/待办只走 localStorage。
   */
  private lastHubUrl = loadStr('capri-fe.hubUrl') || ''
  /**
   * 已验证的「hostId → 本机近路」。认领依据是端口上服务**自报**的 hostId（且
   * 该 hostId 在 hub 注册表里），不是 hub 给某个端口配的候选身份：8765 是每台
   * capri-host 的默认端口，同一个端口号在不同机器上指向不同 host，拿注册表条目
   * 去期待应答者会把真正的本机 host 判成不匹配（一台都不剩 → 全程 hub 中继）。
   */
  private localRoutes = new Map<string, LocalRoute>()
  /** hub 注册表里各 host 自报的本机端口（hostId → port），供切 host 时定点探测。 */
  private knownPorts = new Map<string, number>()
  /** 探不到的端口 → 最近失败时刻，见 LOCAL_PROBE_RETRY_MS。 */
  private probeFailedAt = new Map<number, number>()
  /** 在途的定点探测（hostId → promise）：setHost 与 switchHost 共用同一次探测。 */
  private probing = new Map<string, Promise<void>>()
  /** Shared secret for hub FE_TOKEN (Authorization / WS ?token=). */
  private accessToken: string
  /** A token entered this session may be used to authenticate mode detection. */
  private allowDetectAuth = false
  /**
   * 本机 origin（directBase()）是否要求 FE_TOKEN。来自近路 /api/hosts 的
   * authRequired。EventSource 不能设 Authorization，只有本机真的要 token 时
   * 才把密钥放进 /events?token=，避免把 hub token 泄漏到开放本机的 URL /
   * 代理日志里。同一台机器上的多台 host 按部署约定共用一个 FE_TOKEN，故只
   * 留单个标志（以选中 host 的近路为准）。
   */
  private localAuthRequired = false
  private intentionalClose = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  /** 本地 SSE 的重连定时器/退避计数（与 hub WS 路径互不干扰）。 */
  private sseReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private sseReconnectAttempt = 0
  /**
   * Per-host 事件排序 + 缺口补拉引擎（见 liveSequencing.ts）。emit 经
   * transport 的 host 过滤与 lastLiveAt 记账；补拉的 HTTP 侧在
   * pullEvents（apiBase/fetch 归 transport）。
   */
  private seq = new EventSequencer(
    (ev) => this.emit(ev),
    (hostId, after, signal) => this.pullEvents(hostId, after, signal),
    (gen) => gen === this.gen,
  )
  /**
   * Abort controllers of every in-flight fetch (gap pulls included), so
   * disconnect()/setHost()/setAccessToken() can settle them all — a
   * gapPull's finally then releases its per-host slot instead of wedging
   * it for as long as the request hangs.
   */
  private inflight = new Set<AbortController>()
  /**
   * Hub 级请求（不带 ?host=、与选中 host 无关，如 /api/prefs）的在途
   * 控制器。与 inflight 分开跟踪：setHost 切换 host 时的 abortInflight
   * 只作废「上一个 host 的在途请求」——hub 级请求若一并被 abort，
   * 启动时与 refreshHosts 并发的 syncPrefsFromHub 会每次加载都失败
   * （refreshHosts 自动选中 host → setHost → abortInflight 的竞态）。
   * disconnect() 仍会中止它们，清理语义不变。
   */
  private hubInflight = new Set<AbortController>()
  /**
   * Connection generation: bumped on every connect()/disconnect(). Async
   * callbacks (onopen/onclose/reconnect timer/gap-pull) capture the gen at
   * creation and bail when a newer generation owns the transport, so stale
   * sockets can never spawn duplicate EventSource/WebSocket connections
   * (the React StrictMode double-mount race).
   */
  private gen = 0
  /** Serialize WebSocket frames so async decompression cannot reorder them. */
  private wsMessageTail: Promise<void> = Promise.resolve()
  /**
   * Last live-stream event arrival (epoch ms; null = never). The live
   * channel (SSE /events, hub WS) and the HTTP prompt RPC are independent
   * connections — chat.ts uses this to tell a mid-turn HTTP-channel blip
   * (turn still streaming) from a turn that never started (host dead).
   */
  private lastLiveAt: number | null = null

  constructor(base = '', accessToken = resolveAccessToken()) {
    this.base = base.replace(/\/$/, '')
    this.accessToken = accessToken
  }

  /** Select the target host for API calls + event filtering (null = none). */

  setHost(hostId: string | null) {
    // Requests already in flight were routed to the previous host — abort
    // them so their promises settle (gapPull releases its per-host slot;
    // stale results never land under the new host).
    this.abortInflight()
    this.selectedHostId = hostId
    // 双连接开关：切到本机 → 开本地 SSE 近路；切远程 → 关（hub WS 单路）。
    this.syncLocalSSE()
    // 每次切换都重新核对这台 host 的本机端口归属（已验证且端口没变则零请求）。
    if (hostId) void this.verifyLocalRoute(hostId)
  }

  getHost(): string | null {
    return this.selectedHostId
  }

  setAccessToken(token: string | null) {
    const next = (token ?? '').trim()
    this.accessToken = next
    this.allowDetectAuth = next !== ''
    if (next) saveStr('capri-fe-token', next)
    else removeKey('capri-fe-token')
    // 凭证变了：用旧凭证拿到的注册表交接快照不再代表「这次鉴权后的数据」。
    clearHostRegistryHandoff()
    // Requests issued under the old token are settled now (re-fetches pick
    // up the new token).
    this.abortInflight()
    // Token change: re-try WS in case we are talking to a hub.
    if (this.es || this.ws) this.connect()
  }

  private apiBase(): string {
    if (this.mode === 'hub' && this.hubUrl) return this.hubUrl
    return this.base
  }

  prefsOrigin(): string {
    // 部署版前端与 hub 同源时（页面即 hub，base / 显式 hubUrl 均为
    // 空串），prefs 落在页面自身 origin——相对路径 /api/prefs 经反代
    // 直达 hub。跨源 hub（host 报的 HUB_URL / 显式 hubUrl）优先。
    // local 模式不写 hub：置顶/待办仅存 localStorage。
    return this.mode === 'hub' ? this.hubUrl || this.lastHubUrl || location.origin : ''
  }

  setConnectionMode(mode: TransportMode, hubUrl: string = '') {
    const next = hubUrl.replace(/\/$/, '')
    if (mode === 'local') {
      const wipingToken = !this.localAuthRequired && this.accessToken !== ''
      const changed =
        this.mode !== 'local' ||
        this.hubUrl !== '' ||
        this.lastHubUrl !== '' ||
        wipingToken
      this.mode = 'local'
      this.hubUrl = ''
      this.lastHubUrl = ''
      removeKey('capri-fe.hubUrl')
      // 本机也要 FE_TOKEN 时保留密钥（门禁刚写入 / 刷新后从 localStorage
      // 读出的都是本机的）。本机开放则丢掉可能残留的 hub token。
      if (wipingToken) {
        this.accessToken = ''
        this.allowDetectAuth = false
        removeKey('capri-fe-token')
      }
      this.abortInflight()
      for (const ac of this.hubInflight) ac.abort()
      this.hubInflight.clear()
      if (changed && (this.es || this.ws)) this.connect()
      return
    }
    if (next) {
      this.lastHubUrl = next
      saveStr('capri-fe.hubUrl', next)
    }
    if (this.mode === mode && this.hubUrl === next) return
    this.resetSequencing()
    this.mode = mode
    this.hubUrl = next
    this.abortInflight()
    if (this.es || this.ws) this.connect()
  }

  getConnectionMode(): TransportMode {
    return this.mode
  }

  getHubUrl(): string {
    return this.mode === 'hub' ? this.hubUrl || this.lastHubUrl : ''
  }

  /**
   * 记录「页面 origin 本身就是这台 capri-host」（内嵌前端 / Vite 代理，
   * detectMode 从 /api/status 拿到的 hostId）。这类近路不需要 127.0.0.1
   * 探测，base 记空串 = 直接用 this.base。传 null 只清这一类，不动
   * discoverLocalHost 探到的回环近路。
   */
  setLocalHostId(hostId: string | null) {
    if (!hostId) {
      for (const [id, r] of this.localRoutes) if (r.port === 0) this.localRoutes.delete(id)
      return
    }
    this.localRoutes.set(hostId, {
      base: '',
      port: 0,
      authRequired: this.localAuthRequired,
    })
  }

  /** 主近路（按选中 host 优先），供「本机有几台 host / 页面是不是跑在 host 上」这类展示与挑选使用。 */
  private primaryRoute(): [string, LocalRoute] | null {
    if (this.selectedHostId) {
      const sel = this.localRoutes.get(this.selectedHostId)
      if (sel) return [this.selectedHostId, sel]
    }
    for (const entry of this.localRoutes.entries()) return entry
    return null
  }

  getLocalHostId(): string | null {
    return this.primaryRoute()?.[0] ?? null
  }

  /**
   * 主近路的直连 base；空串表示本机就是页面 origin（Vite 代理 / 内嵌前端）。
   * 只作「选中本机 host 时」的近路，绝不覆盖 this.base——base 是 hub 的
   * 地址（同源部署时 hubUrl 为空、apiBase() 回落到 base），一旦被改写成
   * 127.0.0.1，listHosts / ws-ticket / prefs / /ws/fe 全都会打到本机
   * capri-host，host 列表就只剩本机、也切不到 Hub 中继的节点了。
   */
  getLocalBase(): string {
    return this.primaryRoute()?.[1].base ?? ''
  }

  /** 某台 host 已验证的本机近路（null = 只能走 hub 中继）。 */
  getLocalRoute(hostId: string | null | undefined): LocalRoute | null {
    if (!hostId) return null
    return this.localRoutes.get(hostId) ?? null
  }

  /**
   * 当前是否应直连本机：hub 模式 + 选中的 host 有一条已验证的近路。近路来自：
   * - detectMode：页面 origin 本身就是本机 capri-host（单 host + local:true）
   * - discoverLocalHost / verifyLocalRoute：按 hub 登记的 port 探测 127.0.0.1，
   *   且端口上的服务自报了这台 host 的身份
   * 不按页面 hostname 过滤，避免局域网 IP 访问内嵌前端被误判为远程。
   */
  isLocalDirect(): boolean {
    return (
      this.mode === 'hub' &&
      this.selectedHostId != null &&
      this.localRoutes.has(this.selectedHostId)
    )
  }

  /** 选中 host 的直连 base：探到的 127.0.0.1 近路优先，否则页面 origin。 */
  private directBase(): string {
    const route = this.selectedHostId ? this.localRoutes.get(this.selectedHostId) : null
    if (this.mode === 'hub' && route?.base) return route.base
    return this.base
  }

  private pageIsLoopback(): boolean {
    const h = location.hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '::1'
  }

  /** 有没有「页面 origin 就是这台 host」的近路。 */
  private hasPageOriginRoute(): boolean {
    for (const r of this.localRoutes.values()) if (r.port === 0) return true
    return false
  }

  /** 刚探不到、还在重试冷却里的端口。 */
  private probeSkipped(port: number): boolean {
    const at = this.probeFailedAt.get(port)
    return at != null && Date.now() - at < LOCAL_PROBE_RETRY_MS
  }

  /**
   * 探一次 `http://127.0.0.1:<port>/api/hosts`，返回端口上那个服务**自报**的
   * 身份。只认「恰好一个 host 且 local:true」的应答形状（capri-host 的
   * /api/hosts），其余当作没探到。
   */
  private async probeLocalPort(
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
  }

  /**
   * 定点核对「127.0.0.1:<这台 host 的端口> 上是不是就是它」：切到一台 host 时
   * 调用。身份必须逐字匹配（问的就是这台），探不到就作废旧近路，宁可回落到 hub
   * 中继也不能把请求发到已经不属于它的端口上。
   */
  verifyLocalRoute(hostId: string): Promise<void> {
    const running = this.probing.get(hostId)
    if (running) return running
    const p = (async () => {
      if (this.mode !== 'hub') return
      const cur = this.localRoutes.get(hostId)
      // 页面 origin 就是这台 host：近路与端口无关，不需要验。
      if (cur?.port === 0) return
      const port = this.knownPorts.get(hostId)
      // hub 没报这台 host 的端口（旧版本 host 不上报）：无从定点探测，
      // 已验证的身份继续用（那是它自己在 /api/hosts 里报的）。
      if (!port) return
      if (cur && cur.port === port) return // 已验证且端口没变
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
        this.localRoutes.set(hostId, {
          base: `http://127.0.0.1:${port}`,
          port,
          authRequired: hit.authRequired,
        })
        this.probeFailedAt.delete(port)
        if (this.selectedHostId === hostId) this.localAuthRequired = hit.authRequired
      } else {
        // 应答者为空 = 端口上没服务 / 被浏览器拒绝：进冷却。应答者是别的
        // host 时不冷却（那是有人在答，下一次心跳的端口变更仍要立刻看清）。
        if (!hit) this.probeFailedAt.set(port, Date.now())
        if (cur) this.localRoutes.delete(hostId)
      }
      // 近路可能刚建立 / 刚作废：本机 SSE 那一路要跟着开关。
      this.syncLocalSSE()
    })().finally(() => this.probing.delete(hostId))
    this.probing.set(hostId, p)
    return p
  }

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
    hosts?: Array<{ hostId: string; port?: number; online?: boolean }>,
  ): Promise<string | null> {
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
    for (const hostId of [...this.knownPorts.keys()]) {
      if (!registry.has(hostId)) this.knownPorts.delete(hostId)
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
      this.localRoutes.set(hit.hostId, {
        base: `http://127.0.0.1:${port}`,
        port,
        authRequired: hit.authRequired,
      })
      bound += 1
    }
    if (bound > 0) {
      // 同机多台 host 共用一个 FE_TOKEN（部署约定），认证标志取选中 host 的近路，
      // 其次任意一条。
      const active =
        (this.selectedHostId && this.localRoutes.get(this.selectedHostId)) ||
        this.localRoutes.values().next().value
      if (active) this.localAuthRequired = active.authRequired
    }
    // 近路可能新增（补开本机 SSE 近路）也可能刚作废（关掉那条 SSE）。
    this.syncLocalSSE()
    return this.getLocalHostId()
  }

  /**
   * 判定当前 base 指向 capri-host 直连还是 hub，并带回 hub 地址。
   * - /api/hosts 单 host 且 local:true（无 defaultHostId）→ capri-host 直连：
   *   模式以 /api/status 的 mode 为准（host 配了 HUB_URL → hub，否则 local）。
   * - 多 host / 带 defaultHostId → hub（部署版前端 / VITE_PROXY_TARGET=hub）。
   * - 401 → hub（需要 FE_TOKEN，gate 会接管）。
   * - 网络失败 → local（ErrorBanner 兜底）。
   */
  async detectMode(): Promise<{
    mode: TransportMode
    hubUrl: string
    localHostId?: string
  }> {
    let res: Response
    try {
      res = await this.fetch(
        `${this.base}/api/hosts`,
        {},
        // hubLevel：模式探测是 hub 级请求（不带 ?host=），绝不能被
        // host 切换 / setConnectionMode 的 abortInflight 风暴打断——
        // 被 abort 会走下面的 catch 盲判成 local 模式。
        // 手里已有密钥就带上：hub 的 /api/hosts 不像 capri-host 那样开放，
        // 空手去问只会换回 401——白跑一趟，还看不见注册表（也就无从交接）。
        { auth: this.allowDetectAuth || this.accessToken !== '', hubLevel: true },
      )
    } catch {
      this.localAuthRequired = false
      return { mode: 'local', hubUrl: '' }
    }
    if (res.status === 401) {
      this.localAuthRequired = false
      return { mode: 'hub', hubUrl: this.base }
    }
    if (!res.ok) {
      this.localAuthRequired = false
      return { mode: 'local', hubUrl: '' }
    }
    const data = (await res.json().catch(() => ({}))) as {
      hosts?: HostInfo[]
      defaultHostId?: string
      authRequired?: boolean
    }
    const direct =
      !data.defaultHostId && data.hosts?.length === 1 && data.hosts[0]?.local === true
    // 这份注册表应答可能就是 hub 的那份（部署版前端与 hub 同源时 URL 完全
    // 相同）：交给 listHosts 用，别在启动链里问第二遍。URL 不同（本机 host
    // 的注册表 ≠ hub 的注册表）时自然不会命中。
    rememberHostRegistry(`${this.base}/api/hosts`, {
      hosts: data.hosts ?? [],
      defaultHostId: data.defaultHostId,
      authRequired: data.authRequired,
    })
    if (!direct) {
      this.localAuthRequired = false
      return { mode: 'hub', hubUrl: this.base }
    }
    // 必须在 /api/status 之前记下：默认 mode 仍是 local，fetch 会按
    // isLocalRequest 剥掉 Bearer；只有 localAuthRequired（或显式
    // auth:true）才会保留已存 FE_TOKEN。曾把 status 与 hosts 并行，
    // 导致 status 在本标志置位前发出 → 401 → 盲判 local。
    this.localAuthRequired = data.authRequired === true
    // capri-host 直连：模式由 host 配置决定（HUB_URL 环境变量）；
    // 顺带记录本机 hostId，供 hub 模式下选中本机时 API 直连本地。
    try {
      const stRes = await this.fetch(
        `${this.base}/api/status`,
        {},
        { auth: this.allowDetectAuth || this.localAuthRequired, hubLevel: true },
      )
      if (stRes.ok) {
        const st = (await stRes.json()) as { mode?: string; hubUrl?: string; hostId?: string }
        if (st.mode === 'hub')
          return { mode: 'hub', hubUrl: st.hubUrl || this.base, localHostId: st.hostId }
      }
    } catch {
      /* fall through to local */
    }
    return { mode: 'local', hubUrl: '' }
  }

  getAccessToken(): string {
    return this.accessToken
  }

  async probeAccess(): Promise<'ok' | 'need_token' | 'error'> {
    try {
      // hubLevel：门禁探测与选中 host 无关，被 abortInflight 打断会退成
      // 'error'，调用方（App）把 'error' 当「网络问题也进主界面」处理，
      // 于是本该弹出的密钥门禁被跳过。
      const url = `${this.apiBase()}/api/hosts`
      // 「能不能访问」这个问题，detectMode 刚问过的那个 URL 的应答已经回答了
      // （200 本身即访问通过，authRequired 与本地密钥是否齐备决定要不要进门禁）
      // ——交接窗口内直接据此作答，不再问第二遍。
      const handed = freshHostRegistry(url)
      if (handed) {
        return handed.authRequired && !this.accessToken ? 'need_token' : 'ok'
      }
      const res = await this.fetch(url, {}, { hubLevel: true })
      if (res.status === 401) return 'need_token'
      if (!res.ok) return 'error'
      // capri-host 配置了 FE_TOKEN 时 /api/hosts 保持开放（启动探测端点），
      // 但响应声明 authRequired —— 浏览器本地没有 token 就直接进门禁，
      // 避免无 token 裸请求打到所有接口上才暴露。
      const data = (await res.json().catch(() => ({}))) as {
        authRequired?: boolean
        hosts?: HostInfo[]
        defaultHostId?: string
      }
      if (data.authRequired && !this.accessToken) return 'need_token'
      // 这份应答与随后 refreshHosts 要问的是同一个 URL：交出去，别问第二遍。
      rememberHostRegistry(url, {
        hosts: data.hosts ?? [],
        defaultHostId: data.defaultHostId,
        authRequired: data.authRequired,
      })
      return 'ok'
    } catch {
      return 'error'
    }
  }

  onEvent(handler: TransportHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  private emit(ev: AcpEvent) {
    // hub 模式：host 级事件必须属于选中 host；未选 host 时丢弃所有
    // host 事件（只放行 hello/hosts_changed 等 hub 级事件），避免多个
    // host 的 live 事件混入视图。local 模式：本机事件全放行。
    const host = (ev as { hostId?: string }).hostId
    if (this.mode === 'hub' && host && host !== this.selectedHostId) return
    // 通道活着：任何事件（含被过滤的）都证明 live 连接在送达数据。
    this.lastLiveAt = Date.now()
    for (const h of this.handlers) h(ev)
  }

  emitLocal(ev: AcpEvent) {
    this.emit(ev)
  }

  lastLiveEventAt(): number | null {
    return this.lastLiveAt
  }

  isLiveOpen(): boolean {
    return (
      (this.es?.readyState ?? 0) === EventSource.OPEN ||
      (this.ws?.readyState ?? 0) === WebSocket.OPEN
    )
  }

  private url(path: string): string {
    // hub 模式：base 指向 hub，带 ?host= 由 hub 中转到目标 host；
    // 但选中本机 host 时直连本地（不绕 hub 中继，省一跳网络往返）。
    // local 模式：同源本机，绝不带 ?host=（避免 hostId=local 混淆）。
    const local = this.isLocalDirect()
    const base = local ? this.directBase() : this.apiBase()
    const qs =
      !local && this.mode === 'hub' && this.selectedHostId
        ? `?host=${encodeURIComponent(this.selectedHostId)}`
        : ''
    return `${base}${path}${qs}`
  }

  /**
   * Mode-aware URL for an API path (hub → 带 ?host= 指向选中 host；
   * 选中本机 → 直连本地；local → 同源本机)。独立 API 客户端
   * （如 shell.ts）必须用它拼 URL，不能裸 fetch 相对路径——
   * 否则 hub 模式下请求会打到页面所在机器而不是选中的 host。
   */
  apiUrl(path: string): string {
    return this.url(path)
  }

  /**
   * Mode-aware fetch：apiUrl 拼 URL + Authorization bearer + 超时 +
   * 在途请求跟踪（setHost/disconnect 时统一 abort）。所有 API 调用
   * 都应走这里而不是裸 fetch。
   */
  apiFetch(
    path: string,
    init: RequestInit = {},
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Response> {
    return this.fetch(this.url(path), init, opts)
  }

  private isLocalRequest(input: string): boolean {
    if (this.mode === 'local') return true
    if (!this.isLocalDirect()) return false
    try {
      const target = new URL(input, location.href)
      const local = new URL(this.directBase() || location.href, location.href)
      return target.origin === local.origin
    } catch {
      return false
    }
  }

  /**
   * fetch wrapper that attaches Authorization: Bearer when a hub FE
   * token is configured. All API calls go through this so token handling
   * stays in one place.
   *
   * Every request gets a hard timeout (default DEFAULT_FETCH_TIMEOUT_MS;
   * `opts.timeoutMs` overrides, 0 disables) plus an optional caller
   * `opts.signal`. Both sources are forwarded onto an owned
   * AbortController tracked in `inflight`, so disconnect()/
   * setHost()/setAccessToken() can abort everything in flight — a
   * gapPull's finally then releases its per-host pulling slot instead of
   * wedging it forever. Sources are composed by forwarding rather than
   * AbortSignal.any (newer than this build's baseline browsers), which is
   * equivalent here since every source funnels into one controller.
   */
  private async fetch(
    input: string,
    init: RequestInit = {},
    opts: { timeoutMs?: number; signal?: AbortSignal; hubLevel?: boolean; auth?: boolean } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers)
    // 本机开放时剥掉 hub token；本机自己要 FE_TOKEN（或调用方强制
    // auth:true）则照常带 Bearer。host withAuth 的约定就是 apiFetch
    // 走 Authorization、EventSource 走 ?token=。
    const sendLocalAuth = this.localAuthRequired || opts.auth === true
    if (this.isLocalRequest(input) && !sendLocalAuth) {
      headers.delete('Authorization')
    } else if (opts.auth !== false && this.accessToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${this.accessToken}`)
    }
    const ac = new AbortController()
    // hub 级请求（opts.hubLevel）单独跟踪：host 切换的 abort 风暴
    // （abortInflight）不影响它；disconnect() 时两者都中止。
    const tracked = opts.hubLevel ? this.hubInflight : this.inflight
    tracked.add(ac)
    const sources: AbortSignal[] = []
    const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    if (timeoutMs > 0) sources.push(AbortSignal.timeout(timeoutMs))
    const extSignal = opts.signal ?? init.signal ?? undefined
    if (extSignal) sources.push(extSignal)
    const wired = sources.map((s) => ({ s, fn: () => ac.abort(s.reason) }))
    for (const { s, fn } of wired) {
      if (s.aborted) {
        ac.abort(s.reason)
        break
      }
      s.addEventListener('abort', fn, { once: true })
    }
    try {
      // `await` matters: with a bare `return`, the finally would run the
      // moment fetch() returns its pending promise — un-wiring the abort
      // listeners and untracking the controller before the request ends.
      return await fetch(input, { ...init, signal: ac.signal, headers })
    } finally {
      for (const { s, fn } of wired) s.removeEventListener('abort', fn)
      tracked.delete(ac)
    }
  }

  private resetSequencing() {
    this.seq.reset()
  }

  private abortInflight() {
    // 只作废 host 级在途请求（gap pulls 等）；hub 级请求（hubInflight）
    // 与选中 host 无关，host 切换不能杀掉它们（见 syncPrefsFromHub 的
    // 启动竞态，prefs 读写均标记 hubLevel）。
    for (const ac of this.inflight) ac.abort()
    this.inflight.clear()
  }

  /**
   * Local capri-host live stream. EventSource cannot set Authorization;
   * host withAuth accepts ?token= for this path. Only attach the query
   * when the local origin itself requires FE_TOKEN.
   */
  private liveSseURL(): string {
    const path = `${this.directBase()}/events`
    if (this.accessToken && this.localAuthRequired) {
      return `${path}?token=${encodeURIComponent(this.accessToken)}`
    }
    return path
  }

  private liveWsURL(ticket?: string | null): string {
    const httpBase = this.apiBase() || `${location.protocol}//${location.host}`
    const u = new URL(httpBase, location.href)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    u.pathname = '/ws/fe'
    const params = new URLSearchParams()
    if (ticket) {
      // 首选单次短效 ticket：长期 FE_TOKEN 进 query 会落到 hub 与中间代理
      // 的 access log 里。hub 侧 feAuth 的顺序是 Bearer 头 → ?ticket= →
      // 兼容旧版 ?token=。
      params.set('ticket', ticket)
    } else if (this.accessToken) {
      params.set('token', this.accessToken)
    }
    // Ask the hub to flate-compress events frames; the browser
    // DecompressionStream API decodes them.
    if (typeof DecompressionStream !== 'undefined') params.set('c', '1')
    u.search = params.toString()
    u.hash = ''
    return u.toString()
  }

  /**
   * 向 hub 换一个单次使用的 WS ticket（TTL 2 分钟）。拿不到（老 hub 无此
   * 端点、请求失败、被 disconnect 取消）就返回 null，调用方退回 ?token=，
   * 所以不要求 hub 与 FE 同版本上线。
   * hubLevel：ticket 属于 hub 级请求，不能被切 host 的 abort 风暴取消。
   */
  private async wsTicket(): Promise<string | null> {
    if (!this.accessToken) return null
    try {
      const res = await this.fetch(
        `${this.apiBase()}/api/ws-ticket`,
        { method: 'POST' },
        { hubLevel: true },
      )
      if (!res.ok) return null
      const data = (await res.json().catch(() => ({}))) as { ticket?: unknown }
      return typeof data.ticket === 'string' && data.ticket ? data.ticket : null
    } catch {
      return null
    }
  }

  /**
   * hub 缓冲补拉的 HTTP 侧（gapPull 的传输回调）：拉取 host 缺口之后的
   * 事件；返回 null = 拉取失败（调用方按"离线"处理，下一个 live 事件
   * 或 hello 会重试）。gen/epoch 校验归 EventSequencer。
   */
  private async pullEvents(
    hostId: string,
    after: number,
    signal: AbortSignal,
  ): Promise<SequencedEvent[] | null> {
    const qs = `?host=${encodeURIComponent(hostId)}&after=${after}`
    const res = await this.fetch(`${this.apiBase()}/api/events${qs}`, {}, { signal })
    if (!res.ok) return null
    const body = (await res.json()) as { events?: SequencedEvent[] }
    return body.events || []
  }

  private acceptSequencedEvent(ev: SequencedEvent, gen = this.gen): void {
    this.seq.accept(ev, gen)
  }

  private reconcileSeq(seqs?: Record<string, number>) {
    if (!seqs || !this.selectedHostId) return
    // 双连接：选中本机时本机事件以本地 SSE 为权威（hub 路丢弃），
    // 缺口由本地 SSE 重连后的 gapPull 负责，不在此按 hub 补拉。
    if (this.isLocalDirect()) return
    const hubSeq = seqs[this.selectedHostId]
    if (typeof hubSeq !== 'number') return
    const mine = this.seq.watermark(this.selectedHostId)
    // 全新页面（本 tab 一条 live 事件都没收过，水位还是 0）：hub 的 seq 是它
    // 累计到现在的值，这不是"缺口"。transcript 由 loadHistory 从 host 持久化
    // 历史重建，此时按 after=0 补拉会把 hub 缓冲整段当 live 事件追加到末尾
    // ——实测一次就是 169 KB / 从 seq 114020 起的历史条目，用户看到"已完成的
    // 对话末尾莫名多出一串历史事件"。hub 侧 hello 带 seqs 的用途是「重连的
    // FE 补自己的缺口」，水位为 0 时只对齐、不补拉。
    if (mine === 0) {
      this.seq.resetHost(this.selectedHostId, hubSeq)
      return
    }
    // hub 报的 seq 比本地水位低 = host/hub 重启后序号从头计数（hello 的
    // seqs 是权威值）。不重置的话 acceptSequencedEvent 的 `seq <= last`
    // 会把重启后**所有** live 事件静默丢弃，直到序号重新爬过旧水位
    // ——用户看到的是「连着但永远不更新」，只能刷新页面。
    if (hubSeq < mine) {
      this.seq.resetHost(this.selectedHostId, hubSeq)
      return
    }
    if (hubSeq > mine) void this.seq.gapPull(this.selectedHostId, mine, this.gen)
  }

  /**
   * Hub 慢消费者保护：该订阅者被累计丢弃的事件超过阈值后，hub 会在
   * events 帧内下发 {"type":"resync","fromSeq":N}（N 为触发本次丢弃的
   * 事件序号）。此时逐洞 gap-pull 已不划算：
   * 1) 中止一切在途 gap-pull（abort + epoch 作废已返回未消费的响应）；
   * 2) 清空乱序等待缓冲，并把选中 host 的水位前跳到 fromSeq-1——缺口
   *    交给上层全量重建（store 走 loadHistory 从 host 持久化历史重放），
   *    旧洞不再逐个补；fromSeq 及之后的新事件照常按序放出（下一个
   *    live 事件若仍超前，会触发一次 after=fromSeq-1 的整段拉取，即
   *    hub 约定的一次性恢复路径）；
   * 3) 透传 resync 给上层触发重建（store 侧防抖：重建进行中的新
   *    resync 直接忽略，绝不并发重建）。
   */
  private handleResyncFrame(fromSeq: unknown, gen: number): void {
    if (gen !== this.gen) return
    const seq =
      typeof fromSeq === 'number' && Number.isSafeInteger(fromSeq) && fromSeq > 0
        ? fromSeq
        : 0
    this.seq.resync(this.selectedHostId, seq)
    this.emit({ type: 'resync', fromSeq: seq })
  }

  private async onWsMessage(msg: MessageEvent, gen: number, ws: WebSocket) {
    let text: string
    if (typeof msg.data === 'string') {
      text = msg.data
    } else if (msg.data instanceof Blob) {
      // Compressed binary frame (flate/deflate-raw).
      const buf = await msg.data.arrayBuffer()
      if (gen !== this.gen || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
      if (typeof DecompressionStream === 'undefined') {
        warnNoDecompressionOnce()
        return
      }
      const ds = new DecompressionStream('deflate-raw')
      const stream = new Blob([buf]).stream().pipeThrough(ds)
      text = await new Response(stream).text()
      // The connection may have been replaced while decompressing — a
      // stale socket's events must not leak into the new generation.
      if (gen !== this.gen || this.ws !== ws) return
    } else {
      return
    }
    let data: HubWsFrame
    try {
      data = JSON.parse(text) as HubWsFrame
    } catch {
      return
    }
    if (!data || typeof data !== 'object' || !('type' in data)) return
    if (data.type === 'ping') return
    if (data.type === 'hello' && (data as { service?: string }).service === 'hub') {
      this.emit(data as unknown as AcpEvent)
      this.reconcileSeq((data as { seqs?: Record<string, number> }).seqs)
      return
    }
    if (data.type === 'events' && Array.isArray((data as { events?: unknown }).events)) {
      for (const ev of (data as { events: AcpEvent[] }).events) {
        if (ev && typeof ev === 'object' && 'type' in ev) {
          // 双连接：选中本机 host 时，本机事件以本地 SSE 为唯一来源
          // （近路）；hub WS 推回的本机事件丢弃，避免与本地 SSE 重复
          // （hub 侧做 chunk 合并，两条路事件边界不一致，无法按 seq
          // 对齐去重）。远程 host 事件不受影响。
          const evHost = (ev as { hostId?: string }).hostId
          if (this.isLocalDirect() && evHost === this.selectedHostId) continue
          // resync 是 hub 的控制标记（无 hostId/seq），不能进 seq 排序
          // 通路（会被当 flat event 原样透传），单独拦截处理。
          if ((ev as { type?: string }).type === 'resync') {
            this.handleResyncFrame((ev as { fromSeq?: unknown }).fromSeq, gen)
            continue
          }
          this.acceptSequencedEvent(ev as SequencedEvent, gen)
        }
      }
      return
    }
    // Flat event frames (hosts_changed, etc.)
    this.emit(data as unknown as AcpEvent)
  }

  connect() {
    this.disconnect()
    const gen = ++this.gen
    this.intentionalClose = false
    this.reconnectAttempt = 0
    // 模式显式决定 live stream：hub → WS /ws/fe；local → SSE /events。
    // 不再"先试 WS 再降级"——local 模式永远不发起 WS。
    if (this.mode === 'hub') {
      void this.connectWS(gen)
      // 双连接：选中本机 host 时附加本地 SSE 近路（本机事件唯一来源）。
      this.syncLocalSSE()
    } else {
      this.connectSSE(gen)
    }
  }

  private syncLocalSSE() {
    const want = this.mode === 'hub' && this.isLocalDirect()
    if (want && !this.es) {
      this.connectSSE(this.gen, true)
    } else if (!want && this.es) {
      this.clearSseReconnect()
      this.es.close()
      this.es = null
    } else if (!want) {
      // 已经没有 es，但可能有在飞的重连定时器——不清会把不该开的
      // 近路重新拉起来。
      this.clearSseReconnect()
    }
  }

  private async connectWS(gen: number) {
    if (gen !== this.gen) return
    const ticket = await this.wsTicket()
    // 等 ticket 期间可能已经换代（connect/disconnect）或主动断开：放弃这次
    // 连接，换到的 ticket 不消费，2 分钟后由 hub 的清理协程回收。
    if (gen !== this.gen || this.intentionalClose) return
    let ws: WebSocket
    try {
      ws = new WebSocket(this.liveWsURL(ticket))
    } catch {
      // 构造失败（非法 URL 等）：hub 模式没有 SSE 兜底，定时重试 WS。
      if (gen !== this.gen) return
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5))
      this.reconnectAttempt += 1
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (gen !== this.gen || this.intentionalClose) return
        void this.connectWS(gen)
      }, delay)
      return
    }
    this.ws = ws
    this.wsMessageTail = Promise.resolve()

    ws.onopen = () => {
      if (gen !== this.gen || this.ws !== ws) return
      this.reconnectAttempt = 0
      // hub 恢复在线：让 store 清掉"与 hub 连接断开"提示。
      this.emitLocal({ type: 'hub_conn', online: true })
    }

    ws.onmessage = (msg) => {
      if (gen !== this.gen || this.ws !== ws) return
      this.wsMessageTail = this.wsMessageTail
        .then(() => this.onWsMessage(msg, gen, ws))
        .catch(() => {
          /* malformed/decompression failures do not break the frame queue */
        })
    }

    ws.onclose = () => {
      // Stale socket (superseded by a newer connect()/disconnect()) must
      // not schedule reconnects.
      if (gen !== this.gen || this.ws !== ws) return
      this.ws = null
      if (this.intentionalClose) return
      // 非主动断线：提示"与 hub 断开"，重连成功由 onopen 清除。
      // 仅 hub 模式（connectWS 只在 hub 模式被调用）。
      this.emitLocal({ type: 'hub_conn', online: false })
      // Hub 模式没有 SSE 兜底（hub 只提供 /ws/fe）：指数退避重连 WS。
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5))
      this.reconnectAttempt += 1
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (gen !== this.gen || this.intentionalClose) return
        void this.connectWS(gen)
      }, delay)
    }

    ws.onerror = () => {
      // onclose follows; no extra work
    }
  }

  private connectSSE(gen: number, trackSeq = false) {
    if (gen !== this.gen) return
    if (this.es) return // already on the SSE path; never double-connect
    this.clearSseReconnect()
    // 这条 SSE  stream 属于谁：建连时的选中 host（本机近路只为选中的 host 开），
    // 后面重连补拉按它对齐水位，不能在 onopen 时再读——期间可能已切走。
    const sseHostId = this.selectedHostId
    const es = new EventSource(this.liveSseURL())
    this.es = es
    es.onopen = () => {
      if (gen !== this.gen || this.es !== es) return
      this.sseReconnectAttempt = 0
      if (!trackSeq) return
      const hostId = sseHostId
      if (!hostId) return
      const last = this.seq.watermark(hostId)
      if (last === 0) {
        // 首次连接（本 tab 还没收过该 host 的事件）：transcript 由
        // loadHistory 从 host 持久化历史重建，此时按 after=0 补拉会把 hub
        // 缓冲整段当新事件追加到末尾（实测一次 169 KB、从 seq 114020 起）。
        // 改成以第一条 live 事件为起点，不回补历史。
        this.seq.seedFromLive(hostId)
        return
      }
      // 重连：从 hub 缓冲补拉本机缺口（本地 SSE 断线期间的事件 hub 已缓冲）。
      void this.seq.gapPull(hostId, last, gen)
    }
    es.onmessage = (msg) => {
      if (gen !== this.gen || this.es !== es) return
      try {
        const data = JSON.parse(msg.data) as AcpEvent & { hostId?: string }
        if (data && typeof data === 'object' && 'type' in data) {
          // 近路的端口随时可能被别人占走（那台 host 换了 PORT、另一台 host
          // 重启绑到了同一端口）。host 在 /events 的 hello/ready 里自报 hostId：
          // 与这条近路的 host 不符，说明应答者已经不是它了——立即作废近路、
          // 关掉这条 SSE，请求回落 hub 中继，绝不把 A 的会话继续发给 B。
          const declares = data.type === 'hello' || data.type === 'ready'
          if (
            trackSeq &&
            declares &&
            sseHostId &&
            typeof data.hostId === 'string' &&
            data.hostId &&
            data.hostId !== sseHostId
          ) {
            this.localRoutes.delete(sseHostId)
            this.syncLocalSSE()
            return
          }
          if (trackSeq) this.acceptSequencedEvent(data as SequencedEvent, gen)
          else this.emit(data)
        }
      } catch {
        /* ignore */
      }
    }
    es.onerror = () => {
      if (gen !== this.gen || this.es !== es) return
      // readyState CONNECTING = 浏览器自己在重连（网络级中断），不插手。
      // CLOSED 则是**永久失败**：按规范，服务端回非 200 / 非
      // text/event-stream（host 重启后要 token 的 401、反代 502/503）时
      // 浏览器关闭该 EventSource 且不再重试——local 模式（默认模式）的
      // live 通道就此死亡，用户只能刷新页面。这里接管重连。
      if (es.readyState !== EventSource.CLOSED) return
      es.close()
      this.es = null
      if (this.intentionalClose) return
      this.scheduleSseReconnect(gen, trackSeq)
    }
  }

  /** EventSource 永久关闭后的指数退避重连（与 WS 路径各用一个定时器）。 */
  private scheduleSseReconnect(gen: number, trackSeq: boolean): void {
    if (this.sseReconnectTimer != null) return
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.sseReconnectAttempt, 5))
    this.sseReconnectAttempt += 1
    this.sseReconnectTimer = setTimeout(() => {
      this.sseReconnectTimer = null
      if (gen !== this.gen || this.intentionalClose || this.es) return
      // 期间模式/选中 host 可能已变：只有本路仍是当前该开的那条才重连。
      const want = trackSeq ? this.mode === 'hub' && this.isLocalDirect() : this.mode === 'local'
      if (!want) return
      this.connectSSE(gen, trackSeq)
    }, delay)
  }

  private clearSseReconnect(): void {
    if (this.sseReconnectTimer != null) {
      clearTimeout(this.sseReconnectTimer)
      this.sseReconnectTimer = null
    }
  }

  disconnect() {
    this.gen += 1 // invalidate every in-flight callback of this generation
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearSseReconnect()
    // Settle every in-flight fetch (gap pulls included) so their finally
    // blocks run — gapPull releases its per-host pulling slot. Hub-level
    // requests (prefs) are settled here too, never by host switches.
    this.abortInflight()
    for (const ac of this.hubInflight) ac.abort()
    this.hubInflight.clear()
    this.ws?.close()
    this.ws = null
    this.es?.close()
    this.es = null
  }

}

Object.assign(LocalTransport.prototype, rpcMixins)

