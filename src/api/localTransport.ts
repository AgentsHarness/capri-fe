import type { GuestIdentity } from './types'
import { KEY } from '../lib/keys'
import { loadStr } from '../lib/storage'
import { loadGuestToken, loadHostTokens, loadHubToken, loadRouteChoices } from './credentials'
import type { RouteChoice } from './credentials'
import type { TransportHandler, TransportMode } from './transport'
import { EventSequencer } from './liveSequencing'
import { rpcMixins } from './rpc/mixins'
import type { LocalProbe, LocalRoute } from './local/types'
import type { TransportApi, TransportCtx } from './local/ctx'
import { guestMixin } from './local/guest'
import { authMixin } from './local/auth'
import { routesMixin } from './local/routes'
import { modeMixin } from './local/mode'
import { netMixin } from './local/net'
import { liveMixin } from './local/live'

export type {
  DetectModeResult,
  FetchOpts,
  HubWsFrame,
  LocalProbe,
  LocalRoute,
} from './local/types'

function resolveAccessToken(): string {
  return loadHubToken()
}

class LocalTransportImpl {
  es: EventSource | null = null
  ws: WebSocket | null = null
  handlers = new Set<TransportHandler>()
  base: string
  selectedHostId: string | null = null
  /** 显式连接模式：由 detectMode() 判定（host 配置 HUB_URL → hub）。 */
  mode: TransportMode = 'local'
  /** hub 模式的 hub 浏览器侧地址（跨源直连用；空则退回 base）。 */
  hubUrl = ''
  /**
   * 最近一次探测到的远端 hub origin（仅 hub 模式使用）。local 模式
   * 由 setConnectionMode 清空——置顶/待办只走 localStorage。
   */
  lastHubUrl = loadStr(KEY.hubUrl) || ''
  /**
   * 已发现的「hostId → 本机近路」候选。认领依据是端口上服务**自报**的 hostId
   * （且该 hostId 在 hub 注册表里），不是 hub 给某个端口配的候选身份：8765 是
   * 每台 capri-host 的默认端口，同一个端口号在不同机器上指向不同 host，拿注册表
   * 条目去期待应答者会把真正的本机 host 判成不匹配（一台都不剩 → 全程 hub 中继）。
   * 每条候选自带 `authRequired` + `probe`——钥匙是逐台的，没有全局布尔。
   */
  localRoutes = new Map<string, LocalRoute>()
  /** hub 注册表里各 host 自报的本机端口（hostId → port），供切 host 时定点探测。 */
  knownPorts = new Map<string, number>()
  /** 探不到的端口 → 最近失败时刻，见 LOCAL_PROBE_RETRY_MS。 */
  probeFailedAt = new Map<number, number>()
  /** 在途的定点探测（hostId → promise）：setHost 与 switchHost 共用同一次探测。 */
  probing = new Map<string, Promise<void>>()
  /** 在途的近路钥匙探路（hostId → promise）：并发切 host / 请求风暴只探一次。 */
  probingAuth = new Map<string, Promise<LocalProbe>>()
  /**
   * 探路吃了 401、正等用户输入钥匙的 host → 下次允许重探的时刻。近路探测会被
   * hosts_changed / refreshHosts 反复驱动，没有这个闸门就是每来一次注册表更新
   * 就往本机撞一发 401。用户给了钥匙 / 改了通路选择时立即清掉。
   */
  probeAuthRetryAt = new Map<string, number>()
  /** 管理员那把 hub FE_TOKEN（Authorization / WS ?token=）。 */
  hubToken: string
  /**
   * 访客槽（localStorage 的 `capri-fe.guestToken`）。与管理员那把彻底分开：
   * 同一浏览器可以同时存两把，切换身份只是换「这次出示哪格」，谁都顶不掉谁。
   */
  guestToken: string = loadGuestToken()
  /**
   * 本次启动/切换要用哪一格做门禁：admin = 管理员那把（hub 槽 / 纯 local 的
   * 页面 host 槽），guest = 访客槽。**启动时管理员优先**，只有分享链接或
   * 顶栏「切换到访客模式」才把它置为 guest。
   */
  credentialSource: 'admin' | 'guest' = 'admin'
  /**
   * 每台 host 自己的近路钥匙（hostId → 密钥）。与 hub 槽彻底分开：中继路径
   * 由 host 进程自注入凭据，浏览器只有走近路才需要这把，且它可能和 hub 那把
   * 不同值。见 credentials.ts。
   */
  hostTokens: Record<string, string> = loadHostTokens()
  /** 用户对某台 host 通路的显式选择（auto = 有近路就直连）。 */
  routeChoices: Record<string, RouteChoice> = loadRouteChoices()
  /** A token entered this session may be used to authenticate mode detection. */
  allowDetectAuth = false
  /**
   * 需要近路钥匙但还没问到答案的 host，已经弹过窗（一次会话每台只问一遍；
   * 用户在通路菜单里主动选「直连」会重新问）。
   */
  askedKeyFor = new Set<string>()
  /** onHostKeyRequired 订阅者（HostKeyModal）。 */
  hostKeyHandlers = new Set<(hostId: string) => void>()
  /** onHubAuthInvalid 订阅者（App 回密钥门禁）。 */
  hubAuthHandlers = new Set<() => void>()
  /** 401 一次性闸门：一批并发 401 只处理一次，直到下一次 connect()/换钥匙。 */
  hubRejected = false
  hostRejected = new Set<string>()
  intentionalClose = false
  reconnectTimer: ReturnType<typeof setTimeout> | null = null
  reconnectAttempt = 0
  /** 本地 SSE 的重连定时器/退避计数（与 hub WS 路径互不干扰）。 */
  sseReconnectTimer: ReturnType<typeof setTimeout> | null = null
  sseReconnectAttempt = 0
  /**
   * Per-host 事件排序 + 缺口补拉引擎（见 liveSequencing.ts）。emit 经
   * transport 的 host 过滤与 lastLiveAt 记账；补拉的 HTTP 侧在
   * pullEvents（apiBase/fetch 归 transport）。
   */
  seq: EventSequencer
  /**
   * Abort controllers of every in-flight fetch (gap pulls included), so
   * disconnect()/setHost()/setAccessToken() can settle them all — a
   * gapPull's finally then releases its per-host slot instead of wedging
   * it for as long as the request hangs.
   */
  inflight = new Set<AbortController>()
  /**
   * Hub 级请求（不带 ?host=、与选中 host 无关，如 /api/prefs）的在途
   * 控制器。与 inflight 分开跟踪：setHost 切换 host 时的 abortInflight
   * 只作废「上一个 host 的在途请求」——hub 级请求若一并被 abort，
   * 启动时与 refreshHosts 并发的 syncPrefsFromHub 会每次加载都失败
   * （refreshHosts 自动选中 host → setHost → abortInflight 的竞态）。
   * disconnect() 仍会中止它们，清理语义不变。
   */
  hubInflight = new Set<AbortController>()
  /**
   * 探测请求（opts.authProbe：模式判定、门禁探测、近路探路）的在途控制器。
   * 单开一桶是因为它们不属于任何连接代际——问的是「该连哪一端、要不要钥匙」。
   * 重挂载时（Vite HMR / StrictMode 双挂载）上一轮 AppShell 的卸载会调
   * disconnect()，若顺手 abort 掉**新一轮**在飞的 detectMode，它的 catch 会把
   * 这个自伤误读成网络故障（mode: null → 「无法连接到服务」整屏挡路）。
   * 桶里每条请求都自带超时，过期结果由调用方按代际丢弃（App 的 bootGen）。
   */
  probeInflight = new Set<AbortController>()
  /**
   * Connection generation: bumped on every connect()/disconnect(). Async
   * callbacks (onopen/onclose/reconnect timer/gap-pull) capture the gen at
   * creation and bail when a newer generation owns the transport, so stale
   * sockets can never spawn duplicate EventSource/WebSocket connections
   * (the React StrictMode double-mount race).
   */
  gen = 0
  /** Serialize WebSocket frames so async decompression cannot reorder them. */
  wsMessageTail: Promise<void> = Promise.resolve()
  /**
   * Last live-stream event arrival (epoch ms; null = never). The live
   * channel (SSE /events, hub WS) and the HTTP prompt RPC are independent
   * connections — chat.ts uses this to tell a mid-turn HTTP-channel blip
   * (turn still streaming) from a turn that never started (host dead).
   */
  lastLiveAt: number | null = null
  /**
   * 访客身份（凭 guest token 登录时的 access-role 应答）。非空即进入只读
   * 访客模式：
   * - 路由恒为「hub 中继 + 选中 host」，近路探测全部短路（本机直连没有
   *   hub 承担白名单）；
   * - live 事件直接 emit，绕过 EventSequencer（hub 已按会话过滤，per-host
   *   seq 在这里不连续，排序引擎会把事件永远堵在 pending 里）；
   * - 序号补拉（/api/events）不该被调用，hub 对访客直接 403。
   */
  guest: GuestIdentity | null = null
  /** 访客当前显示的会话（随 WS 连接与 subscribe 帧声明）。 */
  guestSessionId = ''
  /**
   * 本页正在看的会话（管理员）。只为 hub 的在线订阅者面板上报，不参与
   * 事件过滤；与 guestSessionId 分开是因为访客那条路径还要过白名单校验。
   */
  viewingSessionId = ''

  constructor(base = '', hubToken = resolveAccessToken()) {
    this.base = base.replace(/\/$/, '')
    this.hubToken = hubToken
    // 在构造函数里建：回调要指向 mixin 上的 emit / pullEvents，它们由模块
    // 尾部的 Object.assign 挂到原型——字段初始化阶段原型上还没有。
    const ctx = this as unknown as TransportCtx
    this.seq = new EventSequencer(
      (ev) => ctx.emit(ev),
      (hostId, after, signal) => ctx.pullEvents(hostId, after, signal),
      (gen) => gen === this.gen,
    )
  }

  /** 当前门禁那把（hub 模式 = hub 槽；纯 local = 页面这台的 host 槽）。 */
  getAccessToken(): string {
    // doorToken 是 mixin 里的私有辅助函数：class 类型看不见它，运行时挂在
    // 原型上（Object.assign 在模块尾部执行）。
    return (this as unknown as TransportCtx).doorToken()
  }
}

Object.assign(
  LocalTransportImpl.prototype,
  rpcMixins,
  guestMixin,
  authMixin,
  routesMixin,
  modeMixin,
  netMixin,
  liveMixin,
)

/**
 * `LocalTransport` 的公开面 = class 自己的成员（构造 + getAccessToken）
 * 加上挂到原型上的 mixin 方法。
 *
 * mixin 经 Object.assign 挂载，class 类型上看不见它们；这里用交叉类型
 * 把公开面拼出来，而不是 class/interface 声明合并——后者会让 class 里
 * 没声明的成员在类型上「凭空存在」，读代码时看不出哪些方法来自 mixin。
 */
export type LocalTransport = LocalTransportImpl & TransportApi

/** 实例类型：构造签名 + 公开面。测试与 client.ts 都用它。 */
export const LocalTransport: new (base?: string, hubToken?: string) => LocalTransport =
  LocalTransportImpl as unknown as new (base?: string, hubToken?: string) => LocalTransport
