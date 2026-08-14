import type { AcpEvent } from './types'
import { loadStr, removeKey, saveStr } from '../lib/storage'
import type { TransportHandler, TransportMode } from './transport'
import { rpcMixins } from './rpc/mixins'


function resolveAccessToken(): string {
  return loadStr('acp-fe-token')?.trim() || ''
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
   * 本机 host 的 hostId（内嵌前端直连 acp-host 时从 /api/status 拿到）。
   * hub 模式下选中该 host 时，API 请求直连本机（base），不绕 hub 中继。
   */
  private localHostId: string | null = null
  /** Shared secret for hub FE_TOKEN (Authorization / WS ?token=). */
  private accessToken: string
  private intentionalClose = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  /** Last event seq seen per host (gap-pull bookkeeping). */
  private lastSeq = new Map<string, number>()
  /** In-flight gap pulls per host (dedupe). */
  private pulling = new Set<string>()
  /**
   * Abort controllers of every in-flight fetch (gap pulls included), so
   * disconnect()/setHost()/setAccessToken() can settle them all — a
   * gapPull's finally then releases its per-host slot instead of wedging
   * it for as long as the request hangs.
   */
  private inflight = new Set<AbortController>()
  /**
   * Connection generation: bumped on every connect()/disconnect(). Async
   * callbacks (onopen/onclose/reconnect timer/gap-pull) capture the gen at
   * creation and bail when a newer generation owns the transport, so stale
   * sockets can never spawn duplicate EventSource/WebSocket connections
   * (the React StrictMode double-mount race).
   */
  private gen = 0
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
    if (next) saveStr('acp-fe-token', next)
    else removeKey('acp-fe-token')
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

  setConnectionMode(mode: TransportMode, hubUrl: string = '') {
    const next = hubUrl.replace(/\/$/, '')
    if (this.mode === mode && this.hubUrl === next) return
    this.mode = mode
    this.hubUrl = next
    this.abortInflight()
    if (this.es || this.ws) this.connect()
  }

  getConnectionMode(): TransportMode {
    return this.mode
  }

  getHubUrl(): string {
    return this.hubUrl
  }

  setLocalHostId(hostId: string | null) {
    this.localHostId = hostId
  }

  private isLocalPage(): boolean {
    try {
      const hostname = new URL(this.base || location.href).hostname
      return (
        hostname === 'localhost' ||
        hostname === '::1' ||
        hostname.startsWith('127.')
      )
    } catch {
      return false
    }
  }

  private isLocalDirect(): boolean {
    return (
      this.mode === 'hub' &&
      this.isLocalPage() &&
      this.localHostId != null &&
      this.selectedHostId === this.localHostId
    )
  }

  /**
   * 判定当前 base 指向 acp-host 直连还是 hub，并带回 hub 地址。
   * - /api/hosts 单 host 且 local:true（无 defaultHostId）→ acp-host 直连：
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
      res = await this.fetch(`${this.base}/api/hosts`)
    } catch {
      return { mode: 'local', hubUrl: '' }
    }
    if (res.status === 401) return { mode: 'hub', hubUrl: this.base }
    if (!res.ok) return { mode: 'local', hubUrl: '' }
    const data = (await res.json().catch(() => ({}))) as {
      hosts?: Array<{ local?: boolean }>
      defaultHostId?: string
    }
    const direct =
      !data.defaultHostId && data.hosts?.length === 1 && data.hosts[0]?.local === true
    if (!direct) return { mode: 'hub', hubUrl: this.base }
    // acp-host 直连：模式由 host 配置决定（HUB_URL 环境变量）；
    // 顺带记录本机 hostId，供 hub 模式下选中本机时 API 直连本地。
    try {
      const st = (await (
        await this.fetch(`${this.base}/api/status`)
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
      const res = await this.fetch(`${this.apiBase()}/api/hosts`)
      if (res.status === 401) return 'need_token'
      if (!res.ok) return 'error'
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
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.accessToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${this.accessToken}`)
    }
    const ac = new AbortController()
    this.inflight.add(ac)
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
      this.inflight.delete(ac)
    }
  }

  private abortInflight() {
    for (const ac of this.inflight) ac.abort()
    this.inflight.clear()
  }

  private liveWsURL(): string {
    const httpBase = this.apiBase() || `${location.protocol}//${location.host}`
    const u = new URL(httpBase, location.href)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    u.pathname = '/ws/fe'
    const params = new URLSearchParams()
    if (this.accessToken) params.set('token', this.accessToken)
    // Ask the hub to flate-compress events frames; the browser
    // DecompressionStream API decodes them.
    if (typeof DecompressionStream !== 'undefined') params.set('c', '1')
    u.search = params.toString()
    u.hash = ''
    return u.toString()
  }

  private async gapPull(hostId: string, after: number, gen = this.gen) {
    if (gen !== this.gen) return
    if (this.pulling.has(hostId)) return
    this.pulling.add(hostId)
    try {
      const qs = `?host=${encodeURIComponent(hostId)}&after=${after}`
      const res = await this.fetch(`${this.apiBase()}/api/events${qs}`)
      if (!res.ok) return
      const body = (await res.json()) as { events?: Array<AcpEvent & { seq?: number }> }
      const evs = body.events || []
      // Fill the gap; skip events a live frame already delivered.
      for (const ev of evs) {
        if (gen !== this.gen) return
        const seen = this.lastSeq.get(hostId) ?? 0
        const s = ev.seq ?? 0
        if (s <= seen) continue
        this.lastSeq.set(hostId, s)
        this.emit(ev)
      }
    } catch {
      /* offline; the next hello/events re-triggers the pull */
    } finally {
      // Timeout and abort (disconnect/setHost/setAccessToken) both reject
      // the fetch and land here too — the per-host slot never wedges.
      this.pulling.delete(hostId)
    }
  }

  private trackSeq(ev: AcpEvent) {
    const host = (ev as { hostId?: string }).hostId
    const seq = (ev as { seq?: number }).seq
    if (!host || typeof seq !== 'number' || seq <= 0) return
    const prev = this.lastSeq.get(host) ?? 0
    // Duplicate: gap-pull already delivered this seq.
    if (seq <= prev) return
    if (prev > 0 && seq > prev + 1) {
      void this.gapPull(host, prev)
    }
    this.lastSeq.set(host, seq)
  }

  private reconcileSeq(seqs?: Record<string, number>) {
    if (!seqs || !this.selectedHostId) return
    // 双连接：选中本机时本机事件以本地 SSE 为权威（hub 路丢弃），
    // 缺口由本地 SSE 重连后的 gapPull 负责，不在此按 hub 补拉。
    if (this.isLocalDirect() && this.selectedHostId === this.localHostId) return
    const hubSeq = seqs[this.selectedHostId]
    if (typeof hubSeq !== 'number') return
    const mine = this.lastSeq.get(this.selectedHostId) ?? 0
    if (hubSeq > mine) void this.gapPull(this.selectedHostId, mine)
  }

  private async onWsMessage(msg: MessageEvent, gen: number) {
    let text: string
    if (typeof msg.data === 'string') {
      text = msg.data
    } else if (msg.data instanceof Blob) {
      // Compressed binary frame (flate/deflate-raw).
      const buf = await msg.data.arrayBuffer()
      if (gen !== this.gen || this.ws?.readyState !== WebSocket.OPEN) return
      if (typeof DecompressionStream === 'undefined') {
        warnNoDecompressionOnce()
        return
      }
      const ds = new DecompressionStream('deflate-raw')
      const stream = new Blob([buf]).stream().pipeThrough(ds)
      text = await new Response(stream).text()
      // The connection may have been replaced while decompressing — a
      // stale socket's events must not leak into the new generation.
      if (gen !== this.gen) return
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
          this.trackSeq(ev)
          this.emit(ev)
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
      this.connectWS(gen)
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
      this.es.close()
      this.es = null
    }
  }

  private connectWS(gen: number) {
    let ws: WebSocket
    try {
      ws = new WebSocket(this.liveWsURL())
    } catch {
      // 构造失败（非法 URL 等）：hub 模式没有 SSE 兜底，定时重试 WS。
      if (gen !== this.gen) return
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5))
      this.reconnectAttempt += 1
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (gen !== this.gen || this.intentionalClose) return
        this.connectWS(gen)
      }, delay)
      return
    }
    this.ws = ws

    ws.onopen = () => {
      if (gen !== this.gen || this.ws !== ws) return
      this.reconnectAttempt = 0
      // hub 恢复在线：让 store 清掉"与 hub 连接断开"提示。
      this.emitLocal({ type: 'hub_conn', online: true })
    }

    ws.onmessage = (msg) => {
      if (gen !== this.gen || this.ws !== ws) return
      void this.onWsMessage(msg, gen)
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
        this.connectWS(gen)
      }, delay)
    }

    ws.onerror = () => {
      // onclose follows; no extra work
    }
  }

  private connectSSE(gen: number, trackSeq = false) {
    if (gen !== this.gen) return
    if (this.es) return // already on the SSE path; never double-connect
    // Local acp-host: EventSource cannot set Authorization headers — token
    // query is unused locally but kept for symmetry if a proxy gates it.
    const eventsURL = this.accessToken
      ? `${this.base}/events?token=${encodeURIComponent(this.accessToken)}`
      : `${this.base}/events`
    const es = new EventSource(eventsURL)
    this.es = es
    es.onopen = () => {
      if (gen !== this.gen || this.es !== es) return
      if (!trackSeq) return
      // 重连（含首次）：从 hub 缓冲补拉本机缺口（本地 SSE 断线期间
      // 的事件 hub 已缓冲）。lastSeq 为 0 时补全量最近事件。
      const after = this.lastSeq.get(this.localHostId ?? '') ?? 0
      if (after > 0) void this.gapPull(this.localHostId ?? '', after, gen)
    }
    es.onmessage = (msg) => {
      if (gen !== this.gen || this.es !== es) return
      try {
        const data = JSON.parse(msg.data) as AcpEvent
        if (data && typeof data === 'object' && 'type' in data) {
          if (trackSeq) this.trackSeq(data)
          this.emit(data)
        }
      } catch {
        /* ignore */
      }
    }
    es.onerror = () => {
      // browser will reconnect EventSource automatically
    }
  }

  disconnect() {
    this.gen += 1 // invalidate every in-flight callback of this generation
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // Settle every in-flight fetch (gap pulls included) so their finally
    // blocks run — gapPull releases its per-host pulling slot.
    this.abortInflight()
    this.ws?.close()
    this.ws = null
    this.es?.close()
    this.es = null
  }

}

Object.assign(LocalTransport.prototype, rpcMixins)

