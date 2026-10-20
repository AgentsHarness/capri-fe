import type { TransportCtx } from './ctx'
import type { AcpEvent } from '../types'
import type { TransportHandler } from '../transport'
import type { HubWsFrame } from './types'
import type { SequencedEvent } from '../liveSequencing'
import { warnNoDecompressionOnce } from './decompress'
import { KEY } from '../../lib/keys'
import { loadStr } from '../../lib/storage'

/**
 * live 通道：hub WebSocket（主）/ 本机 SSE（近路）、事件扇出、序号对齐。
 *
 * 每帧都带连接代际：回调在创建时捕获 gen，回来时若已被新一轮 connect/
 * disconnect 顶掉就作废——否则 React StrictMode 的双挂载会开出两条连接。
 */

export const liveMixin = {

  /** Select the target host for API calls + event filtering (null = none). */

  setHost(this: TransportCtx, hostId: string | null) {
    // Requests already in flight were routed to the previous host — abort
    // them so their promises settle (gapPull releases its per-host slot;
    // stale results never land under the new host).
    this.abortInflight()
    this.selectedHostId = hostId
    // 双连接开关：切到本机 → 开本地 SSE 近路；切远程 → 关（hub WS 单路）。
    this.syncLocalSSE()
    // 每次切换都重新核对这台 host 的本机端口归属（已验证且端口没变则零请求）。
    if (hostId) void this.verifyLocalRoute(hostId)
    // 让 hub 将这条 live 连接的事件流改指向新 host：hub 端按订阅者分流后，
    // 页面不再收到别的 host 一个字节（切 host 不必重连、不必重新换 ticket）。
    // 同时声明"新 host 从头算"：切过来的 transcript 由 loadHistory 从 host
    // 持久化历史重建，hub 环形缓冲里的旧事件不是缺口。hub 的 subscribed 回执
    // 通常随后就到并按它对齐水位，但回执晚于第一条 live 事件时，没有这个声明
    // 就会按 after=0 把整段缓冲拉回来当新事件追加。
    if (hostId) this.seq.seedFromLive(hostId)
    this.sendSubscribeFrame()
    // 换 host 会作废会话归属：旧会话名留在这行会指向另一台机器上的同名
    // 会话。清掉并让面板那一格空着，等 store 按新会话再上报。
    this.viewingSessionId = ''
    this.sendViewingFrame(true)
  },


  getHost(this: TransportCtx): string | null {
    return this.selectedHostId
  },


  /**
   * 在活的 hub WS 上声明「本页面只关心选中 host」。hub 回一条
   * {type:'subscribed',host,seq}，由 onWsMessage 拿去对齐该 host 的 seq
   * 水位。连接还没建起来（首次加载时 host 往往晚于 WS 选定）时不用补发：
   * connectWS 会把选中 host 直接写进 ?host=。
   */
  sendSubscribeFrame(this: TransportCtx, sessionId?: string): void {
    if (this.mode !== 'hub') return
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const hostId = this.selectedHostId ?? ''
    // 访客：没显式给 session 时用当前显示的会话（setHost 触发的那一帧
    // 也要带上，否则 hub 只知道 host 不知道该放行哪个会话）。
    const guestSession = sessionId ?? (this.guest ? this.guestSessionId : '')
    try {
      ws.send(
        JSON.stringify({
          v: 1,
          type: 'subscribe',
          host: hostId,
          // 访客：hub 按「host + session」双白名单校验；管理员忽略该字段。
          ...(this.guest && guestSession ? { session: guestSession } : {}),
        }),
      )
    } catch {
      // 连接正好在关闭中：重连后的 ?host= 会带上同样的选择。
    }
  },


  /**
   * 声明本页正在看的会话，供 hub 的在线订阅者面板（GET /api/subscribers）
   * 展示。只读台账：hub 不拿它做事件过滤，所以单独一帧、不换订阅、不回
   * 执——用 subscribe 帧捎带会多打一次 seq 对齐，会话切换频繁时纯属噪声。
   *
   * null / 空串 = 当前没有会话（切 host、新建会话前），hub 会把该行清空。
   */
  reportViewingSession(this: TransportCtx, sessionId: string | null): void {
    const next = (sessionId ?? '').trim()
    if (next === this.viewingSessionId) return
    this.viewingSessionId = next
    this.sendViewingFrame(true)
  },


  /**
   * force: 发一帧即使会话为空（切 host 时用来清掉旧会话名）。常规上报与
   * 重连补报都只在有会话时发——空帧对面板没有任何信息量。
   */
  sendViewingFrame(this: TransportCtx, force = false): void {
    // 访客的会话已经随 subscribe 帧声明（hub 还要按白名单校验），不再
    // 重复上报。
    if (this.mode !== 'hub' || this.guest) return
    if (!force && !this.viewingSessionId) return
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(
        JSON.stringify({
          v: 1,
          type: 'viewing',
          host: this.selectedHostId ?? '',
          session: this.viewingSessionId,
        }),
      )
    } catch {
      // 连接正在关闭：重连的 onopen 会重新上报。
    }
  },


  onEvent(this: TransportCtx, handler: TransportHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  },


  emit(this: TransportCtx, ev: AcpEvent) {
    // hub 模式：host 级事件必须属于选中 host；未选 host 时丢弃所有
    // host 事件（只放行 hello/hosts_changed 等 hub 级事件），避免多个
    // host 的 live 事件混入视图。local 模式：本机事件全放行。
    const host = (ev as { hostId?: string }).hostId
    if (this.mode === 'hub' && host && host !== this.selectedHostId) return
    // 通道活着：任何事件（含被过滤的）都证明 live 连接在送达数据。
    this.lastLiveAt = Date.now()
    for (const h of this.handlers) h(ev)
  },


  emitLocal(this: TransportCtx, ev: AcpEvent) {
    this.emit(ev)
  },


  lastLiveEventAt(this: TransportCtx): number | null {
    return this.lastLiveAt
  },


  isLiveOpen(this: TransportCtx): boolean {
    return (
      (this.es?.readyState ?? 0) === EventSource.OPEN ||
      (this.ws?.readyState ?? 0) === WebSocket.OPEN
    )
  },


  resetSequencing(this: TransportCtx) {
    this.seq.reset()
  },


  /**
   * Local capri-host live stream. EventSource cannot set Authorization, so
   * the only transport left is `?token=` — which means only **that host's
   * own shortcut key** may go in the URL, and only when that host actually
   * requires one. An open local origin gets no query parameter at all, so a
   * hub secret never leaks into URLs / proxy access logs.
   */
  liveSseURL(this: TransportCtx): string {
    const path = `${this.directBase()}/events`
    const key = this.tokenFor(path)
    if (key) return `${path}?token=${encodeURIComponent(key)}`
    return path
  },


  liveWsURL(this: TransportCtx, ticket?: string | null): string {
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
    } else if (this.doorToken()) {
      params.set('token', this.doorToken())
    }
    // Ask the hub to flate-compress events frames; the browser
    // DecompressionStream API decodes them.
    if (typeof DecompressionStream !== 'undefined') params.set('c', '1')
    // 分流：告诉 hub 这个页面只关心选中 host 的事件。首帧之前 host 往往
    // 还没选定（宿主列表要一次跨网往返），落回上次选中的持久值，让建连即
    // 起就是过滤态；选错了也会被随后的 subscribe 帧改正。旧 hub 不认这个
    // 参数也照常工作（照样全推，客户端 emit 里那层过滤兜底）。
    const scope = this.selectedHostId ?? loadStr(KEY.host)
    if (this.mode === 'hub' && scope) {
      params.set('host', scope)
    }
    // 访客：当前会话随连接一起声明，hub 据此把订阅夹进白名单。管理员
    // 忽略该参数（行为不变）。
    const guestSession = this.guest ? this.guestSessionId : ''
    if (this.guest && guestSession) params.set('session', guestSession)
    u.search = params.toString()
    u.hash = ''
    return u.toString()
  },


  /**
   * 向 hub 换一个单次使用的 WS ticket（TTL 2 分钟）。拿不到（老 hub 无此
   * 端点、请求失败、被 disconnect 取消）就返回 null，调用方退回 ?token=，
   * 所以不要求 hub 与 FE 同版本上线。
   * hubLevel：ticket 属于 hub 级请求，不能被切 host 的 abort 风暴取消。
   */
  async wsTicket(this: TransportCtx): Promise<string | null> {
    // 访客也用 ticket（hub 在 ticket 里带 guest 身份），凭据是自己的
    // guest token；管理员用 hub 槽那把。没有凭据就不裸连。
    if (!this.getAccessToken()) return null
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
  },


  /**
   * hub 缓冲补拉的 HTTP 侧（gapPull 的传输回调）：拉取 host 缺口之后的
   * 事件；返回 null = 拉取失败（调用方按"离线"处理，下一个 live 事件
   * 或 hello 会重试）。gen/epoch 校验归 EventSequencer。
   */
  async pullEvents(
    this: TransportCtx,
    hostId: string,
    after: number,
    signal: AbortSignal,
  ): Promise<SequencedEvent[] | null> {
    // 访客不做序号补拉：hub 对 /api/events 直接 403（事件已被按会话
    // 过滤，per-host seq 不再连续），调用只会换来一次失败往返。
    if (this.guest) return null
    const qs = `?host=${encodeURIComponent(hostId)}&after=${after}`
    const res = await this.fetch(`${this.apiBase()}/api/events${qs}`, {}, { signal })
    if (!res.ok) return null
    const body = (await res.json()) as { events?: SequencedEvent[] }
    return body.events || []
  },


  acceptSequencedEvent(this: TransportCtx, ev: SequencedEvent, gen = this.gen): void {
    this.seq.accept(ev, gen)
  },


  reconcileSeq(this: TransportCtx, seqs?: Record<string, number>) {
    if (!seqs || !this.selectedHostId) return
    const hubSeq = seqs[this.selectedHostId]
    if (typeof hubSeq !== 'number') return
    this.reconcileHostSeq(this.selectedHostId, hubSeq)
  },


  /**
   * 把某个 host 的本地 seq 水位对齐到 hub 报的权威值。hello.seqs（重连）
   * 与 subscribed 回执（切 host）走同一条判断。
   */
  reconcileHostSeq(this: TransportCtx, hostId: string, hubSeq: number): void {
    // 双连接：选中本机时本机事件以本地 SSE 为权威（hub 路丢弃），
    // 缺口由本地 SSE 重连后的 gapPull 负责，不在此按 hub 补拉。
    if (this.isLocalDirect()) return
    const mine = this.seq.watermark(hostId)
    // 全新页面（本 tab 一条 live 事件都没收过，水位还是 0）：hub 的 seq 是它
    // 累计到现在的值，这不是"缺口"。transcript 由 loadHistory 从 host 持久化
    // 历史重建，此时按 after=0 补拉会把 hub 缓冲整段当 live 事件追加到末尾
    // ——实测一次就是 169 KB / 从 seq 114020 起的历史条目，用户看到"已完成的
    // 对话末尾莫名多出一串历史事件"。hub 侧 hello 带 seqs 的用途是「重连的
    // FE 补自己的缺口」，水位为 0 时只对齐、不补拉。
    if (mine === 0) {
      this.seq.resetHost(hostId, hubSeq)
      return
    }
    // hub 报的 seq 比本地水位低 = host/hub 重启后序号从头计数（hello 的
    // seqs 是权威值）。不重置的话 acceptSequencedEvent 的 `seq <= last`
    // 会把重启后**所有** live 事件静默丢弃，直到序号重新爬过旧水位
    // ——用户看到的是「连着但永远不更新」，只能刷新页面。
    if (hubSeq < mine) {
      this.seq.resetHost(hostId, hubSeq)
      return
    }
    if (hubSeq > mine) void this.seq.gapPull(hostId, mine, this.gen)
  },


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
  handleResyncFrame(this: TransportCtx, fromSeq: unknown, gen: number, hostId?: unknown): void {
    if (gen !== this.gen) return
    // seq 计数器是 per-host 的，别的 host 的慢消费信号与本 host 毫无关系：
    // 拿 B 的 fromSeq 顶 A 的水位，会把 A 之后所有低于它的事件静默丢掉。
    // 新 hub 的 resync 帧带 hostId，归属不符直接忽略；旧 hub 不带 hostId，
    // 退回原语义（只能当作本 host 的信号）。
    if (typeof hostId === 'string' && hostId && hostId !== this.selectedHostId) return
    const seq =
      typeof fromSeq === 'number' && Number.isSafeInteger(fromSeq) && fromSeq > 0
        ? fromSeq
        : 0
    this.seq.resync(this.selectedHostId, seq)
    this.emit({ type: 'resync', fromSeq: seq })
  },


  async onWsMessage(this: TransportCtx, msg: MessageEvent, gen: number, ws: WebSocket) {
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
    if (data.type === 'subscribed') {
      // 切 host 的 subscribe 回执：以 hub 报的该 host 水位对齐本地序号。
      // 只认当前选中 host 的回执——连续快点选时旧回执不能拿来对齐新 host。
      // 访客不参与排序/补拉（见 onWsMessage 的 events 分支），回执只用于
      // 通知上层订阅已生效。
      if (this.guest) {
        this.emit(data as unknown as AcpEvent)
        return
      }
      const d = data as { host?: unknown; seq?: unknown }
      if (d.host && d.host === this.selectedHostId && typeof d.seq === 'number') {
        this.reconcileHostSeq(this.selectedHostId, d.seq)
      }
      return
    }
    if (data.type === 'hello' && (data as { service?: string }).service === 'hub') {
      this.emit(data as unknown as AcpEvent)
      this.reconcileSeq((data as { seqs?: Record<string, number> }).seqs)
      return
    }
    if (data.type === 'events' && Array.isArray((data as { events?: unknown }).events)) {
      // 访客：hub 已按「host + session」白名单过滤，per-host seq 因而不再
      // 连续（别的会话的事件被丢弃）。任何序号排序/缺口补拉都会把这些
      // 事件永远堵在 pending 里，所以直接 emit。
      if (this.guest) {
        for (const ev of (data as { events: AcpEvent[] }).events) {
          if (ev && typeof ev === 'object' && 'type' in ev) this.emit(ev)
        }
        return
      }
      for (const ev of (data as { events: AcpEvent[] }).events) {
        if (ev && typeof ev === 'object' && 'type' in ev) {
          // 双连接：选中本机 host 时，本机事件以本地 SSE 为唯一来源
          // （近路）；hub WS 推回的本机事件丢弃，避免与本地 SSE 重复
          // （hub 侧做 chunk 合并，两条路事件边界不一致，无法按 seq
          // 对齐去重）。远程 host 事件不受影响。
          const evHost = (ev as { hostId?: string }).hostId
          if (this.isLocalDirect() && evHost === this.selectedHostId) continue
          // 未选中 host 的事件一律不进排序引擎。它们最终也会在 emit 里被
          // 丢掉，但在那之前会先污染序号状态：本 tab 对该 host 水位是 0，
          // 第一条事件就会打一发 GET /api/events?host=X&after=0，把 hub
          // 环形缓冲整段（上限 6000 条）拉回来再全部丢弃；非选中 host 的
          // pending 也就此堆积。hub 侧分流后正常情况下收不到，但老 hub
          // 不分流、以及首屏 host 选定之前的窗口（连接还不带 ?host=）都在
          // 这条守卫的覆盖范围内。
          if (this.mode === 'hub' && evHost && evHost !== this.selectedHostId) continue
          // resync 是 hub 的控制标记（无 seq，新 hub 带 hostId），不能进 seq
          // 排序通路（会被当 flat event 原样透传），单独拦截处理。
          if ((ev as { type?: string }).type === 'resync') {
            this.handleResyncFrame(
              (ev as { fromSeq?: unknown }).fromSeq,
              gen,
              (ev as { hostId?: unknown }).hostId,
            )
            continue
          }
          this.acceptSequencedEvent(ev as SequencedEvent, gen)
        }
      }
      return
    }
    // Flat event frames (hosts_changed, etc.)
    this.emit(data as unknown as AcpEvent)
  },


  connect(this: TransportCtx) {
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
  },


  syncLocalSSE(this: TransportCtx) {
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
  },


  async connectWS(this: TransportCtx, gen: number) {
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
      // 新连接上订阅者面板还看不到「在看哪个会话」：补报一次（hub 的
      // 行是新建的，旧连接的台账不会跟过来）。
      this.sendViewingFrame()
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
  },


  connectSSE(this: TransportCtx, gen: number, trackSeq = false) {
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
  },


  /** EventSource 永久关闭后的指数退避重连（与 WS 路径各用一个定时器）。 */
  scheduleSseReconnect(this: TransportCtx, gen: number, trackSeq: boolean): void {
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
  },


  clearSseReconnect(this: TransportCtx): void {
    if (this.sseReconnectTimer != null) {
      clearTimeout(this.sseReconnectTimer)
      this.sseReconnectTimer = null
    }
  },


  disconnect(this: TransportCtx) {
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
    // probeInflight 故意不碰：重挂载的这一次 disconnect 不该把**新一轮**启动
    // 探测判成「连不上」（见该字段注释）。
    this.abortInflight()
    for (const ac of this.hubInflight) ac.abort()
    this.hubInflight.clear()
    this.ws?.close()
    this.ws = null
    this.es?.close()
    this.es = null
  },
}
