import type { AcpEvent } from './types'
import { loadStr, removeKey, saveStr } from '../lib/storage'
import type { TransportHandler, TransportMode } from './transport'
import { EventSequencer, type SequencedEvent } from './liveSequencing'
import { rpcMixins } from './rpc/mixins'


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
   * 本机 host 的 hostId（内嵌前端直连 capri-host 时从 /api/status 拿到）。
   * hub 模式下选中该 host 时，API 请求直连本机（base），不绕 hub 中继。
   */
  private localHostId: string | null = null
  /** Shared secret for hub FE_TOKEN (Authorization / WS ?token=). */
  private accessToken: string
  /** A token entered this session may be used to authenticate mode detection. */
  private allowDetectAuth = false
  /**
   * 本机 origin（this.base）是否要求 FE_TOKEN。来自直连 /api/hosts 的
   * authRequired。EventSource 不能设 Authorization，只有本机真的要
   * token 时才把密钥放进 /events?token=，避免把 hub token 泄漏到
   * 开放本机的 URL / 代理日志里。
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

  setLocalHostId(hostId: string | null) {
    this.localHostId = hostId
  }

  getLocalHostId(): string | null {
    return this.localHostId
  }

  /**
   * 当前是否应直连本机：hub 模式 + 选中了本机 host。localHostId 只在
   * detectMode 直连探测成功时设置——页面 origin 本身返回了「单 host +
   * local:true」的 /api/hosts 和带 hostId 的 /api/status，即页面就托管在
   * 本机 capri-host 上，无需再按页面 hostname 判断：localhost / 127.x /
   * 局域网 IP（如 192.168.1.6）访问同一台机器的内嵌前端都成立，按
   * hostname 过滤会把局域网地址误判为远程，白白绕 hub 中继。
   */
  private isLocalDirect(): boolean {
    return (
      this.mode === 'hub' &&
      this.localHostId != null &&
      this.selectedHostId === this.localHostId
    )
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
        { auth: this.allowDetectAuth, hubLevel: true },
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
      hosts?: Array<{ local?: boolean }>
      defaultHostId?: string
      authRequired?: boolean
    }
    const direct =
      !data.defaultHostId && data.hosts?.length === 1 && data.hosts[0]?.local === true
    if (!direct) {
      this.localAuthRequired = false
      return { mode: 'hub', hubUrl: this.base }
    }
    // 必须在 /api/status 之前记下：status 本身也受 FE_TOKEN 门禁，
    // 刷新后 allowDetectAuth 仍是 false，不带已存 token 会 401，
    // 下面 catch 就会把配了 HUB_URL 的 host 盲判成 local。
    this.localAuthRequired = data.authRequired === true
    // capri-host 直连：模式由 host 配置决定（HUB_URL 环境变量）；
    // 顺带记录本机 hostId，供 hub 模式下选中本机时 API 直连本地。
    try {
      const st = (await (
        await this.fetch(
          `${this.base}/api/status`,
          {},
          { auth: this.allowDetectAuth || this.localAuthRequired, hubLevel: true },
        )
      ).json()) as { mode?: string; hubUrl?: string; hostId?: string }
      if (st.mode === 'hub')
        return { mode: 'hub', hubUrl: st.hubUrl || this.base, localHostId: st.hostId }
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
      const res = await this.fetch(`${this.apiBase()}/api/hosts`, {}, { hubLevel: true })
      if (res.status === 401) return 'need_token'
      if (!res.ok) return 'error'
      // capri-host 配置了 FE_TOKEN 时 /api/hosts 保持开放（启动探测端点），
      // 但响应声明 authRequired —— 浏览器本地没有 token 就直接进门禁，
      // 避免无 token 裸请求打到所有接口上才暴露。
      const data = (await res.json().catch(() => ({}))) as {
        authRequired?: boolean
      }
      if (data.authRequired && !this.accessToken) return 'need_token'
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
    const base = local ? this.base : this.apiBase()
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
      const local = new URL(this.base || location.href, location.href)
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
    const path = `${this.base}/events`
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
    if (this.isLocalDirect() && this.selectedHostId === this.localHostId) return
    const hubSeq = seqs[this.selectedHostId]
    if (typeof hubSeq !== 'number') return
    const mine = this.seq.watermark(this.selectedHostId)
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
          if (this.isLocalDirect() && evHost === this.localHostId) continue
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
    const es = new EventSource(this.liveSseURL())
    this.es = es
    es.onopen = () => {
      if (gen !== this.gen || this.es !== es) return
      this.sseReconnectAttempt = 0
      if (!trackSeq) return
      // 重连（含首次）：从 hub 缓冲补拉本机缺口（本地 SSE 断线期间
      // 的事件 hub 已缓冲）。水位为 0 时补全量最近事件。
      const hostId = this.localHostId
      if (hostId) {
        void this.seq.gapPull(hostId, this.seq.watermark(hostId), gen)
      }
    }
    es.onmessage = (msg) => {
      if (gen !== this.gen || this.es !== es) return
      try {
        const data = JSON.parse(msg.data) as AcpEvent
        if (data && typeof data === 'object' && 'type' in data) {
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

