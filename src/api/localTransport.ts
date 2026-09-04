import type { AcpEvent, HostInfo } from './types'
import { loadStr, removeKey, saveStr } from '../lib/storage'
import {
  PAGE_SLOT,
  dropHost,
  loadHostTokens,
  loadHubToken,
  loadRouteChoices,
  saveHostToken,
  saveHubToken,
  saveRouteChoice,
  type RouteChoice,
} from './credentials'
import type { TransportHandler, TransportMode } from './transport'
import { EventSequencer, type SequencedEvent } from './liveSequencing'
import { rpcMixins } from './rpc/mixins'
import { clearHostRegistryHandoff, rememberHostRegistry, freshHostRegistry } from './rpc/hosts'
import { KEY } from '../lib/keys'


function resolveAccessToken(): string {
  return loadHubToken()
}

type HubWsFrame =
  | { type: 'hello'; service?: string; hosts?: unknown; defaultHostId?: string; seqs?: Record<string, number>; [k: string]: unknown }
  | { type: 'events'; events: AcpEvent[] }
  | { type: 'ping'; ts?: number }
  /** 新 hub 对 subscribe 控制帧的回执：该 host 当前的 seq 水位。 */
  | { type: 'subscribed'; host?: string; seq?: number }
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

/**
 * 一条本机近路的钥匙状态。它同时回答两个问题：这台该不该直连、直连时出示
 * 哪把钥匙。**默认开**（`open`/`hub-ok` 都不需要用户输入），只有 `pending`
 * 才可能弹窗，`rejected` 表示用户已经拒绝过、这台改走中继。
 *
 * - `open`     —— 这台不设 FE_TOKEN，裸请求直连（回环默认绑定下最常见）。
 * - `pending`  —— 要钥匙，还没问到答案：先拿 hub 那把探路，或等用户输入。
 * - `hub-ok`   —— hub 槽那把打得开这台（两把同值），不弹窗。
 * - `host-ok`  —— 用户为这台单独输入的钥匙已验证通过。
 * - `rejected` —— 探路 401 且用户取消：这台走中继，不再重复问。
 */
export type LocalProbe = 'open' | 'pending' | 'hub-ok' | 'host-ok' | 'rejected'

/** 这三态才允许走近路（其余一律回落 hub 中继）。 */
function probeAllowsDirect(probe: LocalProbe): boolean {
  return probe === 'open' || probe === 'hub-ok' || probe === 'host-ok'
}

/** 一条已验证的本机近路（host 直连，不绕 hub 中继）。 */
export type LocalRoute = {
  /** 直连用的 origin（如 http://127.0.0.1:8765）；空串 = 页面 origin 本身。 */
  base: string
  /** 验证时这台 host 自报的本机监听端口；0 = 页面 origin 近路（与端口无关）。 */
  port: number
  /** 这台 host 的 API 是否要求 FE_TOKEN。 */
  authRequired: boolean
  /** 近路钥匙状态（见 LocalProbe）。 */
  probe: LocalProbe
}

/** `fetch` 的传输层选项（钥匙选择、超时、abort 归属、401 归因）。 */
export type FetchOpts = {
  timeoutMs?: number
  signal?: AbortSignal
  /** hub 级请求：不被切 host 的 abortInflight 风暴打断。 */
  hubLevel?: boolean
  /** 强制出示「当前门禁那把」（启动探测用），不做近路剥除。 */
  auth?: boolean
  /** 强制指定出示哪把钥匙（近路探路用：此刻近路还不可用，自动判定选不出归属）。 */
  forceToken?: string
  /**
   * 这条请求自带 401 语义（模式判定 / 门禁探测 / 探路），不参与运行时登出
   * 分流；同时它属于 probeInflight，任何 abort 风暴都不得打断它。
   */
  authProbe?: boolean
}

/** detectMode 的结论。`mode: null` = 不可知（网络失败），调用方不得改状态。 */
export type DetectModeResult = {
  mode: TransportMode | null
  hubUrl: string
  localHostId?: string
  /** 页面这台 host 的展示名（门禁文案用它，别把裸 hostId 甩给用户）。 */
  localHostName?: string
  authRequired?: boolean
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
  private lastHubUrl = loadStr(KEY.hubUrl) || ''
  /**
   * 已发现的「hostId → 本机近路」候选。认领依据是端口上服务**自报**的 hostId
   * （且该 hostId 在 hub 注册表里），不是 hub 给某个端口配的候选身份：8765 是
   * 每台 capri-host 的默认端口，同一个端口号在不同机器上指向不同 host，拿注册表
   * 条目去期待应答者会把真正的本机 host 判成不匹配（一台都不剩 → 全程 hub 中继）。
   * 每条候选自带 `authRequired` + `probe`——钥匙是逐台的，没有全局布尔。
   */
  private localRoutes = new Map<string, LocalRoute>()
  /** hub 注册表里各 host 自报的本机端口（hostId → port），供切 host 时定点探测。 */
  private knownPorts = new Map<string, number>()
  /** 探不到的端口 → 最近失败时刻，见 LOCAL_PROBE_RETRY_MS。 */
  private probeFailedAt = new Map<number, number>()
  /** 在途的定点探测（hostId → promise）：setHost 与 switchHost 共用同一次探测。 */
  private probing = new Map<string, Promise<void>>()
  /** 在途的近路钥匙探路（hostId → promise）：并发切 host / 请求风暴只探一次。 */
  private probingAuth = new Map<string, Promise<LocalProbe>>()
  /**
   * 探路吃了 401、正等用户输入钥匙的 host → 下次允许重探的时刻。近路探测会被
   * hosts_changed / refreshHosts 反复驱动，没有这个闸门就是每来一次注册表更新
   * 就往本机撞一发 401。用户给了钥匙 / 改了通路选择时立即清掉。
   */
  private probeAuthRetryAt = new Map<string, number>()
  /** Shared secret for hub FE_TOKEN (Authorization / WS ?token=). */
  private hubToken: string
  /**
   * 每台 host 自己的近路钥匙（hostId → 密钥）。与 hub 槽彻底分开：中继路径
   * 由 host 进程自注入凭据，浏览器只有走近路才需要这把，且它可能和 hub 那把
   * 不同值。见 credentials.ts。
   */
  private hostTokens: Record<string, string> = loadHostTokens()
  /** 用户对某台 host 通路的显式选择（auto = 有近路就直连）。 */
  private routeChoices: Record<string, RouteChoice> = loadRouteChoices()
  /** A token entered this session may be used to authenticate mode detection. */
  private allowDetectAuth = false
  /**
   * 需要近路钥匙但还没问到答案的 host，已经弹过窗（一次会话每台只问一遍；
   * 用户在通路菜单里主动选「直连」会重新问）。
   */
  private askedKeyFor = new Set<string>()
  /** onHostKeyRequired 订阅者（HostKeyModal）。 */
  private hostKeyHandlers = new Set<(hostId: string) => void>()
  /** onHubAuthInvalid 订阅者（App 回密钥门禁）。 */
  private hubAuthHandlers = new Set<() => void>()
  /** 401 一次性闸门：一批并发 401 只处理一次，直到下一次 connect()/换钥匙。 */
  private hubRejected = false
  private hostRejected = new Set<string>()
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
   * 探测请求（opts.authProbe：模式判定、门禁探测、近路探路）的在途控制器。
   * 单开一桶是因为它们不属于任何连接代际——问的是「该连哪一端、要不要钥匙」。
   * 重挂载时（Vite HMR / StrictMode 双挂载）上一轮 AppShell 的卸载会调
   * disconnect()，若顺手 abort 掉**新一轮**在飞的 detectMode，它的 catch 会把
   * 这个自伤误读成网络故障（mode: null → 「无法连接到服务」整屏挡路）。
   * 桶里每条请求都自带超时，过期结果由调用方按代际丢弃（App 的 bootGen）。
   */
  private probeInflight = new Set<AbortController>()
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

  constructor(base = '', hubToken = resolveAccessToken()) {
    this.base = base.replace(/\/$/, '')
    this.hubToken = hubToken
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
    // 让 hub 将这条 live 连接的事件流改指向新 host：hub 端按订阅者分流后，
    // 页面不再收到别的 host 一个字节（切 host 不必重连、不必重新换 ticket）。
    // 同时声明"新 host 从头算"：切过来的 transcript 由 loadHistory 从 host
    // 持久化历史重建，hub 环形缓冲里的旧事件不是缺口。hub 的 subscribed 回执
    // 通常随后就到并按它对齐水位，但回执晚于第一条 live 事件时，没有这个声明
    // 就会按 after=0 把整段缓冲拉回来当新事件追加。
    if (hostId) this.seq.seedFromLive(hostId)
    this.sendSubscribeFrame()
  }

  /**
   * 在活的 hub WS 上声明「本页面只关心选中 host」。hub 回一条
   * {type:'subscribed',host,seq}，由 onWsMessage 拿去对齐该 host 的 seq
   * 水位。连接还没建起来（首次加载时 host 往往晚于 WS 选定）时不用补发：
   * connectWS 会把选中 host 直接写进 ?host=。
   */
  private sendSubscribeFrame(): void {
    if (this.mode !== 'hub') return
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const hostId = this.selectedHostId ?? ''
    try {
      ws.send(JSON.stringify({ v: 1, type: 'subscribe', host: hostId }))
    } catch {
      // 连接正好在关闭中：重连后的 ?host= 会带上同样的选择。
    }
  }

  getHost(): string | null {
    return this.selectedHostId
  }

  /**
   * 退出登录：只清 hub 槽。各台 host 的近路钥匙与通路选择保留——它们属于
   * 那台机器，不属于这次 hub 会话（重新登录 hub 后近路应立刻原样可用）。
   */
  logout(): void {
    this.hubToken = ''
    saveHubToken('')
    this.allowDetectAuth = false
    this.hubRejected = false
    clearHostRegistryHandoff()
    this.abortInflight()
    if (this.es || this.ws) this.connect()
  }

  /**
   * 写「当前门禁那把」：hub 模式写 hub 槽；纯 local 模式页面本身就是那台
   * host，写这台的 host 槽——两把钥匙在存储上彻底分开，纯 local 也不再借用
   * hub 槽（否则 hub 换密钥会顺手抹掉本机钥匙，反之亦然）。
   */
  setAccessToken(token: string | null) {
    const next = (token ?? '').trim()
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
  }

  /**
   * 页面 origin 这台 host 的 host 槽键：认得出 hostId 就用它，认不出（host
   * 太旧、/api/hosts 不报 hostId）用保留键 PAGE_SLOT。
   */
  private pageSlot(): string {
    for (const [id, r] of this.localRoutes) if (r.port === 0) return id
    return PAGE_SLOT
  }

  /** 某台 host 的近路钥匙槽（null 选中继；未知 host 落到页面槽）。 */
  private hostKeySlot(hostId: string | null | undefined): string {
    return hostId ?? PAGE_SLOT
  }

  /**
   * 当前门禁那把：hub 模式 = hub 槽；纯 local = 页面这台的 host 槽。
   * 启动探测与「要不要弹门禁」都问它。
   */
  private doorToken(): string {
    if (this.mode !== 'local') return this.hubToken
    return this.hostTokens[this.pageSlot()] ?? ''
  }

  /**
   * 探测用钥匙（`opts.auth === true`）。模式尚未判定时 `doorToken()` 可能
   * 还是空的（默认 mode 是 local，hostId 也还没认出来），这时退到 hub 槽
   * ——旧版单凭据槽时代 `new LocalTransport('', token)` 就靠这条路。
   */
  private probeKey(): string {
    return this.doorToken() || this.hubToken
  }

  /** 这台 host 存过的近路钥匙（未存过 = 空串）。 */
  getHostToken(hostId: string | null | undefined): string {
    return this.hostTokens[this.hostKeySlot(hostId)] ?? ''
  }

  /** 写某台的近路钥匙（空串 = 删）。只动 host 槽，绝不碰 hub 槽。 */
  setHostToken(hostId: string | null | undefined, token: string): void {
    const slot = this.hostKeySlot(hostId)
    const t = token.trim()
    this.hostTokens = { ...this.hostTokens, [slot]: t }
    if (!t) delete this.hostTokens[slot]
    saveHostToken(slot, t)
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
      const changed = this.mode !== 'local' || this.hubUrl !== '' || this.lastHubUrl !== ''
      this.mode = 'local'
      this.hubUrl = ''
      this.lastHubUrl = ''
      removeKey(KEY.hubUrl)
      // 这里**不动任何密钥槽**。旧实现「本机开放就把当前凭据当 hub 残留删
      // 掉」是因为那时只有一把钥匙；现在 hub 槽与 host 槽分开，本机要的那把
      // 存在 host 槽里，删 hub 槽既救不了本机也白白抹掉用户刚输入的密钥
      // （探测失败回退 local 曾因此吃掉刚输的 hub 凭据）。
      this.abortInflight()
      for (const ac of this.hubInflight) ac.abort()
      this.hubInflight.clear()
      if (changed && (this.es || this.ws)) this.connect()
      return
    }
    if (next) {
      this.lastHubUrl = next
      saveStr(KEY.hubUrl, next)
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
   * 记录「页面 origin 本身就是这台 capri-host」（内嵌前端 / Vite 代理）。
   * 这类近路不需要 127.0.0.1 探测，base 记空串 = 直接用 this.base。传 null
   * 只清这一类，不动 discoverLocalHost 探到的回环近路。
   *
   * hostId 与 authRequired 都来自免鉴权的 `GET /api/hosts`：局域网 IP 打开
   * 内嵌前端时浏览器手里还没有 host 那把，只有这份应答能让它认出自己并升到
   * hub（旧实现问的是需鉴权的 /api/status → 401 → 盲判 local）。
   */
  setLocalHostId(hostId: string | null, authRequired = false) {
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
  }

  /**
   * 一条新候选近路的初始钥匙状态：存过这台的钥匙就当作可用（换 host 端口
   * 后可能失效，真被打回时由 401 分流负责退中继），没存过就先拿 hub 那把探
   * 一次；本机压根不设钥匙则直接开放。
   */
  private probeFor(hostId: string, authRequired: boolean): LocalProbe {
    if (!authRequired) return 'open'
    if (this.getHostToken(hostId)) return 'host-ok'
    return 'pending'
  }

  /**
   * 登记一条近路候选。同一 host 在同一个 origin 上被重新登记（注册表每次
   * hosts_changed 都会走一遍发现流程）时**保留已解析的钥匙状态**——清零会让
   * 已经探通、甚至已经输入过钥匙的机器悄悄退回 hub 中继；只有 base/端口/
   * 是否要钥匙真变了才当新候选重探。
   */
  private bindRoute(hostId: string, base: string, port: number, authRequired: boolean): void {
    const cur = this.localRoutes.get(hostId)
    const same = cur && cur.base === base && cur.port === port && cur.authRequired === authRequired
    this.localRoutes.set(hostId, {
      base,
      port,
      authRequired,
      probe: same ? cur!.probe : this.probeFor(hostId, authRequired),
    })
  }

  /** 用户对某台 host 通路的显式选择（默认 auto）。 */
  getRouteChoice(hostId: string | null | undefined): RouteChoice {
    return (hostId && this.routeChoices[hostId]) || 'auto'
  }

  /**
   * 设定某台的通路。`direct` 会清掉「这台已拒/已问过」的闸门并重新走一遍
   * 先探再问；`relay` 只是关掉近路，注册表与 hub 登录都不动。
   */
  setRouteChoice(hostId: string, choice: RouteChoice): void {
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
  }

  /** 这台有没有近路候选（127 探到了端口，或页面本身就是它）。 */
  hasLocalCandidate(hostId: string | null | undefined): boolean {
    return !!hostId && this.localRoutes.has(hostId)
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
   * 这台 host 当前**实际**走哪条路（列表行标记用）：
   * - `direct`  近路可用（有候选 + 用户没选中继 + 钥匙已就绪）
   * - `pending` 探到了候选，但还差这台自己的钥匙——此刻仍走中继
   * - `relay`   只有 hub 一条路（或用户显式选了中继）
   */
  activeRouteFor(hostId: string | null | undefined): 'direct' | 'pending' | 'relay' {
    if (!hostId || this.mode !== 'hub') return 'relay'
    if (this.usableRoute(hostId)) return 'direct'
    const route = this.localRoutes.get(hostId)
    if (route && this.getRouteChoice(hostId) !== 'relay') return 'pending'
    return 'relay'
  }

  /**
   * 可用的近路：hub 模式 + 有候选 + 用户没显式选中继 + 钥匙状态允许直连。
   * `pending` / `rejected` 时回 null —— 请求自动落回 hub 中继，用户不必先
   * 回答「这台要不要第二把钥匙」就能正常用。
   */
  private usableRoute(hostId: string | null | undefined): LocalRoute | null {
    if (this.mode !== 'hub' || !hostId) return null
    if (this.getRouteChoice(hostId) === 'relay') return null
    const route = this.localRoutes.get(hostId)
    if (!route || !probeAllowsDirect(route.probe)) return null
    return route
  }

  /**
   * 当前是否应直连本机：选中的 host 有一条可用近路。近路候选来自：
   * - detectMode：页面 origin 本身就是本机 capri-host（单 host + local:true，
   *   含用局域网 IP 打开内嵌前端的情况）
   * - discoverLocalHost / verifyLocalRoute：按 hub 登记的 port 探测 127.0.0.1，
   *   且端口上的服务自报了这台 host 的身份
   * 不按页面 hostname 过滤，避免局域网 IP 访问内嵌前端被误判为远程。
   */
  isLocalDirect(): boolean {
    return this.usableRoute(this.selectedHostId) != null
  }

  /** 选中 host 的直连 base：探到的 127.0.0.1 近路优先，否则页面 origin。 */
  private directBase(): string {
    const route = this.usableRoute(this.selectedHostId)
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
   * 定点核对「127.0.0.1:<这台 host 的端口> 上是不是就是它」+ 这条近路的钥匙
   * 状态：切到一台 host 时调用。身份必须逐字匹配（问的就是这台），探不到就
   * 作废旧近路，宁可回落到 hub 中继也不能把请求发到已经不属于它的端口上。
   */
  verifyLocalRoute(hostId: string): Promise<void> {
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
  }

  /**
   * 把探路结论写回这条近路。**必须按当前对象写**：注册表刷新会把 route 整个
   * 替换掉，往闭包里抓住的旧对象上写会静默丢失——实测过一次「两把同值、探路
   * 已经 200，业务请求却全程留在 hub 中继」。同一 hostId 上 base+port 变了
   * 说明应答者已经换人，旧结论作废，让新候选自己再探一次。
   */
  private setProbe(
    hostId: string,
    probed: { base: string; port: number },
    probe: LocalProbe,
  ): LocalProbe {
    const cur = this.localRoutes.get(hostId)
    if (!cur || cur.base !== probed.base || cur.port !== probed.port) return 'pending'
    cur.probe = probe
    return probe
  }

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
  async probeLocalRoute(hostId: string): Promise<LocalProbe> {
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
  }

  /**
   * 用某把钥匙打一次本机的 `GET /api/probe`。返回：
   * `ok`（200 且应答者就是这台）/ `denied`（401）/ `unreachable`（连不上或
   * 那把钥匙还没有，**不能**据此判认证）。
   *
   * 钥匙按 hostId 直接取，不走 `tokenFor`：探路往往发生在近路还不可用时
   * （`isLocalDirect()` 为 false），那时 routeOwner 判不出归属。
   */
  private async tryLocalKey(
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
  }

  /**
   * 请用户输入这台 host 的钥匙。只在**这正是用户选中的那台**时才问——没在用
   * 的 host 留着 `pending`（切过去时再探再问），绝不让启动时探到的一串候选把
   * 用户淹进弹窗。每台一次会话只问一遍（askedKeyFor）。
   */
  private requestHostKey(hostId: string): void {
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
  }

  /** 订阅「这台需要它自己的钥匙」（HostKeyModal）。 */
  onHostKeyRequired(handler: (hostId: string) => void): () => void {
    this.hostKeyHandlers.add(handler)
    return () => this.hostKeyHandlers.delete(handler)
  }

  /** 订阅「hub 那把被拒」（App 回密钥门禁）。 */
  onHubAuthInvalid(handler: () => void): () => void {
    this.hubAuthHandlers.add(handler)
    return () => this.hubAuthHandlers.delete(handler)
  }

  /**
   * 用户为某台 host 输入的钥匙：先验一把，**通过才落库**。
   * 成功 → 这台直连打开；失败 → 不落库、返回 false 让弹窗继续改。
   */
  async tryHostKey(hostId: string, token: string): Promise<boolean> {
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
  }

  /**
   * 用户拒为某台 host 输入钥匙：这台改走中继。**不动 hub 登录**，其他
   * host 与整份注册表也都不动。
   */
  declineHostKey(hostId: string): void {
    const cur = this.localRoutes.get(hostId)
    if (cur) this.setProbe(hostId, { base: cur.base, port: cur.port }, 'rejected')
    this.setRouteChoice(hostId, 'relay')
    this.syncLocalSSE()
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
  }

  /**
   * 判定页面 base 指向 capri-host 还是 hub，并带回 hub 地址。**只看
   * 免鉴权的 `GET /api/hosts`**：
   * - 应答带 `mode` 字段 → 打到的是 capri-host（host 才报自己的部署形态）：
   *   配了 HUB_URL 就升到 hub，hostId 交给 setLocalHostId 认「页面就是这台」。
   * - 只有 hosts / defaultHostId → 打到的是 hub（部署版前端 / VITE_PROXY_TARGET=hub）。
   * - 401 → hub（需要 FE_TOKEN，门禁会接管）。
   * - 网络失败 → `mode: null`：模式未知，调用方**既不能进主界面也不能改
   *   成 local**，更不能抹密钥（旧实现在这里盲判 local，把 hub 会话连带抹掉）。
   *
   * 不再请求需鉴权的 /api/status：那把浏览器此刻未必有的 host 钥匙，正是
   * 局域网 IP 打开内嵌前端时升不了 hub 的原因。
   */
  async detectMode(): Promise<DetectModeResult> {
    let res: Response
    try {
      res = await this.fetch(
        `${this.base}/api/hosts`,
        {},
        // hubLevel：模式探测是 hub 级请求（不带 ?host=），绝不能被
        // host 切换 / setConnectionMode 的 abortInflight 风暴打断——
        // 被 abort 会走下面的 catch 误判成网络故障。
        // authProbe：这里的 401 是「该弹门禁了」的信号，不是「密钥失效」；
        // 且这条请求进 probeInflight，连 disconnect() 也不许杀它（重挂载
        // 竞态下那会把新一轮探测读成「无法连接到服务」）。
        // 手里已有密钥就带上：hub 的 /api/hosts 不像 capri-host 那样开放，
        // 空手去问只会换回 401——白跑一趟，还看不见注册表（也就无从交接）。
        {
          auth: this.allowDetectAuth || this.probeKey() !== '',
          hubLevel: true,
          authProbe: true,
        },
      )
    } catch {
      return { mode: null, hubUrl: '' }
    }
    if (res.status === 401) {
      return { mode: 'hub', hubUrl: this.base }
    }
    if (!res.ok) return { mode: null, hubUrl: '' }
    const data = (await res.json().catch(() => null)) as {
      hosts?: HostInfo[]
      defaultHostId?: string
      authRequired?: boolean
      mode?: string
      hubUrl?: string
      hostId?: string
      port?: number
    } | null
    if (!data) return { mode: null, hubUrl: '' }
    const authRequired = data.authRequired === true
    // 这份注册表应答可能就是 hub 的那份（部署版前端与 hub 同源时 URL 完全
    // 相同）：交给 listHosts 用，别在启动链里问第二遍。URL 不同（本机 host
    // 的注册表 ≠ hub 的注册表）时自然不会命中。
    rememberHostRegistry(`${this.base}/api/hosts`, {
      hosts: data.hosts ?? [],
      defaultHostId: data.defaultHostId,
      authRequired: data.authRequired,
    })

    const hostRow =
      data.hosts?.length === 1 && data.hosts[0]?.local === true ? data.hosts[0] : null
    const hostLocalId = typeof data.hostId === 'string' ? data.hostId : hostRow?.hostId
    const localHostName = hostRow?.hostName
    const isHostShape =
      typeof data.mode === 'string' ||
      (!data.defaultHostId && data.hosts?.length === 1 && hostRow?.local === true)

    if (isHostShape && hostLocalId) {
      // 应答者自报 hostId，且形状像 host。`mode` 缺失 = 旧版本 capri-host
      // （只在 /api/status 里报模式）：走降级，仍按今天那样试一次 status。
      if (typeof data.mode !== 'string') {
        return this.detectModeLegacy(hostLocalId, authRequired, localHostName)
      }
      if (data.mode === 'hub') {
        return {
          mode: 'hub',
          hubUrl: data.hubUrl || this.base,
          localHostId: hostLocalId,
          localHostName,
          authRequired,
        }
      }
      return {
        mode: 'local',
        hubUrl: '',
        localHostId: hostLocalId,
        localHostName,
        authRequired,
      }
    }

    // 没有 mode 字段、又不是「单台 local:true」的形状 → hub 的注册表。
    // 不带 authRequired：hub 的「要不要钥匙」就是这里的 200/401，
    // 且升 hub 时页面那台 host 的身份也无从谈起。
    if (!isHostShape) {
      return { mode: 'hub', hubUrl: this.base }
    }
    // 形状像 host 但认不出它的 hostId（极旧的 host）：本机锁定，无近路可认。
    return { mode: 'local', hubUrl: '', authRequired }
  }

  /**
   * 旧版本 capri-host 的降级路径（/api/hosts 不带 mode）：只能去问需要
   * 钥匙的 /api/status。拿不到就锁本机——比从前多带一层保护：**不因失败
   * 抹密钥**，也不谎报 hub。
   */
  private async detectModeLegacy(
    hostId: string,
    authRequired: boolean,
    localHostName?: string,
  ): Promise<DetectModeResult> {
    try {
      const stRes = await this.fetch(
        `${this.base}/api/status`,
        {},
        {
          auth: this.allowDetectAuth || this.probeKey() !== '' || authRequired,
          hubLevel: true,
          authProbe: true,
        },
      )
      if (stRes.ok) {
        const st = (await stRes.json().catch(() => ({}))) as {
          mode?: string
          hubUrl?: string
          hostId?: string
        }
        if (st.mode === 'hub') {
          return {
            mode: 'hub',
            hubUrl: st.hubUrl || this.base,
            localHostId: st.hostId || hostId,
            localHostName,
            authRequired,
          }
        }
      }
    } catch {
      /* 保持 local */
    }
    return { mode: 'local', hubUrl: '', localHostId: hostId, localHostName, authRequired }
  }

  /** 当前门禁那把（hub 模式 = hub 槽；纯 local = 页面这台的 host 槽）。 */
  getAccessToken(): string {
    return this.doorToken()
  }

  async probeAccess(): Promise<'ok' | 'need_token' | 'error'> {
    try {
      // hubLevel：门禁探测与选中 host 无关，被 abortInflight 打断会退成
      // 'error'，调用方（App）把 'error' 当「网络问题也进主界面」处理，
      // 于是本该弹出的密钥门禁被跳过。authProbe 让它落在 probeInflight，
      // 连重挂载带来的 disconnect() 也打不断。
      // authProbe：这里的 401 是「该弹门禁」，不是「手里的密钥失效」。
      const url = `${this.apiBase()}/api/hosts`
      const opts = { hubLevel: true, authProbe: true }
      // 「能不能访问」这个问题，detectMode 刚问过的那个 URL 的应答已经回答了
      // （200 本身即访问通过，authRequired 与本地密钥是否齐备决定要不要进门禁）
      // ——交接窗口内直接据此作答，不再问第二遍。
      const handed = freshHostRegistry(url)
      if (handed) {
        return handed.authRequired && !this.doorToken() ? 'need_token' : 'ok'
      }
      const res = await this.fetch(url, {}, opts)
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
      if (data.authRequired && !this.doorToken()) return 'need_token'
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
   * 这条请求属于哪台 host 的近路（null = 不是近路请求，即打 hub）。
   * 钥匙按台存，所以 401 归因也必须落到具体 hostId——纯 local 时页面这台
   * 就是唯一答案。
   */
  private routeOwner(input: string): string | null {
    if (this.mode === 'local') return this.pageSlot()
    if (!this.isLocalDirect() || !this.selectedHostId) return null
    try {
      const target = new URL(input, location.href)
      const local = new URL(this.directBase() || location.href, location.href)
      return target.origin === local.origin ? this.selectedHostId : null
    } catch {
      return null
    }
  }

  /**
   * 这条请求该出示哪把钥匙（null = 不带 Authorization）：
   * - 打 hub → hub 槽；
   * - 走近路且那台不设 FE_TOKEN → 谁都不带（绝不把 hub 密钥塞进
   *   `/events?token=`，那会把它写进 URL 与代理日志）；
   * - 走近路且那台要钥匙 → 这台的 host 槽；没存过就用 hub 那把（即探路
   *   通过的那把，两把同值时全程只问一次）。
   */
  private tokenFor(input: string): string | null {
    if (!this.isLocalRequest(input)) return this.hubToken || null
    const slot = this.routeOwner(input)
    const route = slot ? this.localRoutes.get(slot) : null
    if (route && !route.authRequired) return null
    const hostKey = (slot && this.hostTokens[slot]) || ''
    // 纯 local 压根没有 hub：只出示存过的 host 钥匙，hub 槽那把绝不冒名。
    if (this.mode === 'local') return hostKey || null
    return hostKey || this.hubToken || null
  }

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
  private handleRejection(target: { local: boolean; hostId: string | null }): void {
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
    opts: FetchOpts = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers)
    // 钥匙选择集中在 tokenFor：打 hub 用 hub 槽，走近路用那台的 host 槽，
    // 本机开放就什么都不带（免得把 hub 密钥写进 URL / 代理日志）。
    // opts.forceToken / auth:true 是探测用途的强制指定（探路、模式判定）。
    const forced =
      opts.forceToken !== undefined
        ? opts.forceToken
        : opts.auth === true
          ? this.probeKey()
          : null
    const token = forced ?? (opts.auth === false ? null : this.tokenFor(input))
    // 401 归因用的目标，在**发请求之前**定格：见 handleRejection 的注释。
    const target = { local: this.isLocalRequest(input), hostId: this.routeOwner(input) }
    if (token) {
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
    } else {
      headers.delete('Authorization')
    }
    const ac = new AbortController()
    // 三条在途队列：探测请求（authProbe）谁都不许 abort（见 probeInflight）；
    // hub 级请求（hubLevel）躲过 host 切换的 abortInflight 风暴，但 disconnect()
    // 仍会中止它们；其余是选中 host 的请求。
    const tracked = opts.authProbe
      ? this.probeInflight
      : opts.hubLevel
        ? this.hubInflight
        : this.inflight
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
      const res = await fetch(input, { ...init, signal: ac.signal, headers })
      // 带着钥匙仍被 401 = 那把钥匙不对。按目标分流（hub 失效 / 这台换中继）。
      // 启动期探测（detectMode / probeAccess / 近路探路）自带 401 语义，
      // 由调用方判读，绝不能在这里顺手清掉用户刚输入的密钥。
      if (res.status === 401 && token && opts.authProbe !== true) this.handleRejection(target)
      return res
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
   * Local capri-host live stream. EventSource cannot set Authorization, so
   * the only transport left is `?token=` — which means only **that host's
   * own shortcut key** may go in the URL, and only when that host actually
   * requires one. An open local origin gets no query parameter at all, so a
   * hub secret never leaks into URLs / proxy access logs.
   */
  private liveSseURL(): string {
    const path = `${this.directBase()}/events`
    const key = this.tokenFor(path)
    if (key) return `${path}?token=${encodeURIComponent(key)}`
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
    } else if (this.hubToken) {
      params.set('token', this.hubToken)
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
    if (!this.hubToken) return null
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
    const hubSeq = seqs[this.selectedHostId]
    if (typeof hubSeq !== 'number') return
    this.reconcileHostSeq(this.selectedHostId, hubSeq)
  }

  /**
   * 把某个 host 的本地 seq 水位对齐到 hub 报的权威值。hello.seqs（重连）
   * 与 subscribed 回执（切 host）走同一条判断。
   */
  private reconcileHostSeq(hostId: string, hubSeq: number): void {
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
  private handleResyncFrame(fromSeq: unknown, gen: number, hostId?: unknown): void {
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
    if (data.type === 'subscribed') {
      // 切 host 的 subscribe 回执：以 hub 报的该 host 水位对齐本地序号。
      // 只认当前选中 host 的回执——连续快点选时旧回执不能拿来对齐新 host。
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
    // probeInflight 故意不碰：重挂载的这一次 disconnect 不该把**新一轮**启动
    // 探测判成「连不上」（见该字段注释）。
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

