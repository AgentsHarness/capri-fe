import { LocalTransport } from './localTransport'
import type { DetectModeResult, LocalProbe, LocalRoute } from './localTransport'
import type { RouteChoice } from './credentials'
import type { TransportHandler, TransportMode } from './transport'
import type { AcpEvent } from './types'
import type { RpcApi } from './rpc/mixins'

export type Transport = {
  setHost(hostId: string | null): void
  getHost(): string | null
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
  apiFetch(
    path: string,
    init?: RequestInit,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Response>
  connect(): void
  disconnect(): void
} & RpcApi

// Prototype mixin methods are invisible to the class type.
export const transport: Transport = new LocalTransport() as unknown as Transport

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
export { AgentTurnError, AccessTokenError } from './transport'
