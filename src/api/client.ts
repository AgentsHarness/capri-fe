import { LocalTransport } from './localTransport'
import type { DetectModeResult, LocalProbe, LocalRoute } from './localTransport'
import type { RouteChoice } from './credentials'
import type { GuestIdentity } from './types'
import type { TransportHandler, TransportMode } from './transport'
import type { AcpEvent } from './types'
import type { RpcApi } from './rpc/mixins'

export type Transport = {
  setHost(hostId: string | null): void
  getHost(): string | null
  /** 采纳 URL fragment 的 `#g=<token>`（访客分享链接）；返回是否采到。 */
  adoptSharedToken(): boolean
  /** 进入 / 清除访客身份（null = 退出）。 */
  setGuestMode(identity: GuestIdentity | null): void
  getGuestIdentity(): GuestIdentity | null
  isGuest(): boolean
  /** 退出访客：切回管理员令牌槽（那把从未被顶掉）。 */
  exitGuestMode(): void
  /** 启动时选令牌来源：管理员优先，管理员槽为空才用访客槽。 */
  chooseStartupCredential(): 'admin' | 'guest'
  /** hub 说门禁那把是管理员：把出示的那把归到管理员槽。 */
  settleAdminCredential(): void
  /** 当前门禁用的是哪一格。 */
  getCredentialSource(): 'admin' | 'guest'
  /** 存着的访客令牌（空串 = 没存过）。 */
  getGuestToken(): string
  /** 访客槽那把打不开门：清掉它并回管理员身份（管理员槽不动）。 */
  dropGuestCredential(): void
  /** 是否存着管理员门禁密钥。 */
  hasAdminToken(): boolean
  /** 用存下的访客令牌进入访客模式；没存过 → need_token。 */
  enterGuestMode(): Promise<'ok' | 'need_token' | 'invalid' | 'error'>
  /** 用一把用户输入的访客令牌进入访客模式（通过才落库）。 */
  tryGuestToken(token: string): Promise<GuestIdentity | null>
  /** 访客切换会话：换 host + 改 WS 订阅到 (host, session)，无写操作。 */
  sendGuestSubscribe(hostId: string, sessionId: string): void
  /**
   * 上报「本页正在看哪个会话」，供 hub 的在线订阅者面板展示。
   * 纯台账，不改事件过滤；null 表示没有会话（新建前 / 切 host 后）。
   */
  reportViewingSession(sessionId: string | null): void
  /** 写「当前门禁那把」：hub 模式写 hub 槽，纯 local 写页面这台的 host 槽。 */
  setAccessToken(token: string | null): void
  setConnectionMode(mode: TransportMode, hubUrl?: string): void
  getConnectionMode(): TransportMode
  getHubUrl(): string
  prefsOrigin(): string
  setLocalHostId(hostId: string | null, authRequired?: boolean): void
  getLocalHostId(): string | null
  getLocalBase(): string
  /** 某台 host 已验证的本机近路（null = 还没探到候选，只能走 hub 中继）。 */
  getLocalRoute(hostId: string | null | undefined): LocalRoute | null
  /** 选中 host 当前是否正走本机近路。 */
  isLocalDirect(): boolean
  /** 这台**实际**走哪条路（列表行标记用）：候选 + 用户选择 + 钥匙状态合起来判。 */
  activeRouteFor(hostId: string | null | undefined): 'direct' | 'pending' | 'relay'
  /** 这台有没有近路候选（通路菜单里「直连本机」可点的条件）。 */
  hasLocalCandidate(hostId: string | null | undefined): boolean
  getRouteChoice(hostId: string | null | undefined): RouteChoice
  setRouteChoice(hostId: string, choice: RouteChoice): void
  /** 某台 host 存过的近路钥匙（host 槽；与 hub 槽互不影响）。 */
  getHostToken(hostId: string | null | undefined): string
  /** 用户给的这台钥匙：验一把，通过才落库并打开直连。 */
  tryHostKey(hostId: string, token: string): Promise<boolean>
  /** 用户拒为这台输入钥匙：这台改走中继，hub 登录不动。 */
  declineHostKey(hostId: string): void
  /** 订阅「这台需要它自己的钥匙」（HostKeyModal）。 */
  onHostKeyRequired(handler: (hostId: string) => void): () => void
  /** 订阅「hub 那把被拒」（App 回密钥门禁）。只清 hub 槽，不动 host 槽。 */
  onHubAuthInvalid(handler: () => void): () => void
  /** 定点核对某台 host 的本机端口归属 + 近路钥匙状态。 */
  verifyLocalRoute(hostId: string): Promise<void>
  /** 近路「先探再问」：默认直连，探不过才请用户输入这台的钥匙。 */
  probeLocalRoute(hostId: string): Promise<LocalProbe>
  discoverLocalHost(
    hosts?: Array<{ hostId: string; port?: number; online?: boolean }>,
  ): Promise<string | null>
  /** `mode: null` = 网络不可达，模式未知（调用方不得改认证状态）。 */
  detectMode(): Promise<DetectModeResult>
  getAccessToken(): string
  probeAccess(): Promise<'ok' | 'need_token' | 'error'>
  /** 只清 hub 槽（退出登录 / hub 密钥失效），host 槽与通路选择保留。 */
  logout(): void
  onEvent(handler: TransportHandler): () => void
  emitLocal(ev: AcpEvent): void
  lastLiveEventAt(): number | null
  isLiveOpen(): boolean
  apiUrl(path: string): string
  /**
   * 指向指定 host 的 API URL（跨 host 读别的 host 用），始终走 hub 中继。
   * 非 hub 模式返回 null（没有第二台 host，调用方据此禁用入口）。
   */
  urlForHost(hostId: string, path: string): string | null
  apiFetch(
    path: string,
    init?: RequestInit,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Response>
  connect(): void
  disconnect(): void
} & RpcApi

// Mixin 方法经 Object.assign 挂到原型，LocalTransport 类型已把它们交叉进来。
export const transport: Transport = new LocalTransport() as Transport

export type {
  TransportCore,
  TransportHandler,
  TransportMode,
  AgentTurnKind,
  McpListServer,
  McpToolInfo,
  ExtensionsPayload,
  SettingsPayload,
  SettingsPatch,
  TerminalOutput,
} from './transport'
export type { ExtensionHook, ExtensionPlugin, ExtensionSkill } from './types'
export type { LocalRoute, LocalProbe, DetectModeResult } from './localTransport'
export type { RouteChoice } from './credentials'
export type { AccessRole, GuestIdentity, GuestSessionItem, GuestTokenRecord } from './types'
export { AgentTurnError, AccessTokenError } from './transport'
