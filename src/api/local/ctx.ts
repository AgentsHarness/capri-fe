import type { AcpEvent, GuestIdentity } from '../types'
import type { TransportHandler, TransportMode } from '../transport'
import type { EventSequencer, SequencedEvent } from '../liveSequencing'
import type { RouteChoice } from '../credentials'
import type { DetectModeResult, FetchOpts, LocalProbe, LocalRoute } from './types'
import type { RpcApi } from '../rpc/mixins'

/**
 * Mixin 契约：`LocalTransport` 实例的编译期视图。
 *
 * 拆分后每个 mixin 方法写成 `method(this: TransportCtx, …)`：方法体只
 * 需要认识「同一实例上有哪些字段、能调哪些方法」，不必认识 class 本体。
 * 字段由 `LocalTransportImpl` 声明并持有（拆分后不再是 private：它们要对
 * 各个 mixin 可见），运行时是同一个对象，mixin 经 Object.assign 挂上去。
 *
 * 新增 mixin 方法时把签名补进这里——契约集中一处，比每个模块各引半个类
 * 好查；漏补会在 tsc 阶段报 this 上不存在该属性。
 */
export interface TransportCtx {
  es: EventSource | null
  ws: WebSocket | null
  handlers: Set<TransportHandler>
  base: string
  selectedHostId: string | null
  mode: TransportMode
  hubUrl: string
  lastHubUrl: string
  localRoutes: Map<string, LocalRoute>
  knownPorts: Map<string, number>
  probeFailedAt: Map<number, number>
  probing: Map<string, Promise<void>>
  probingAuth: Map<string, Promise<LocalProbe>>
  probeAuthRetryAt: Map<string, number>
  hubToken: string
  guestToken: string
  credentialSource: 'admin' | 'guest'
  hostTokens: Record<string, string>
  routeChoices: Record<string, RouteChoice>
  allowDetectAuth: boolean
  askedKeyFor: Set<string>
  hostKeyHandlers: Set<(hostId: string) => void>
  hubAuthHandlers: Set<() => void>
  hubRejected: boolean
  hostRejected: Set<string>
  intentionalClose: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempt: number
  sseReconnectTimer: ReturnType<typeof setTimeout> | null
  sseReconnectAttempt: number
  seq: EventSequencer
  inflight: Set<AbortController>
  hubInflight: Set<AbortController>
  probeInflight: Set<AbortController>
  gen: number
  wsMessageTail: Promise<void>
  lastLiveAt: number | null
  guest: GuestIdentity | null
  guestSessionId: string
  viewingSessionId: string

  setHost(hostId: string | null): void
  sendSubscribeFrame(sessionId?: string): void
  reportViewingSession(sessionId: string | null): void
  sendViewingFrame(force?: boolean): void
  sendGuestSubscribe(hostId: string, sessionId: string): void
  getHost(): string | null
  adoptSharedToken(): boolean
  setGuestMode(identity: GuestIdentity | null): void
  useGuestCredentials(): void
  useAdminCredentials(): void
  settleAdminCredential(): void
  getCredentialSource(): 'admin' | 'guest'
  getGuestToken(): string
  dropGuestCredential(): void
  chooseStartupCredential(): 'admin' | 'guest'
  hasAdminToken(): boolean
  enterGuestMode(): Promise<'ok' | 'need_token' | 'invalid' | 'error'>
  tryGuestToken(token: string): Promise<GuestIdentity | null>
  probeGuestRole(token: string): Promise<GuestIdentity | 'invalid' | 'error'>
  getGuestIdentity(): GuestIdentity | null
  isGuest(): boolean
  exitGuestMode(): void
  logout(): void
  setAccessToken(token: string | null): void
  pageSlot(): string
  hostKeySlot(hostId: string | null | undefined): string
  doorToken(): string
  probeKey(): string
  getHostToken(hostId: string | null | undefined): string
  setHostToken(hostId: string | null | undefined, token: string): void
  apiBase(): string
  prefsOrigin(): string
  setConnectionMode(mode: TransportMode, hubUrl?: string): void
  getConnectionMode(): TransportMode
  getHubUrl(): string
  setLocalHostId(hostId: string | null, authRequired?: boolean): void
  probeFor(hostId: string, authRequired: boolean): LocalProbe
  bindRoute(hostId: string, base: string, port: number, authRequired: boolean): void
  getRouteChoice(hostId: string | null | undefined): RouteChoice
  setRouteChoice(hostId: string, choice: RouteChoice): void
  hasLocalCandidate(hostId: string | null | undefined): boolean
  primaryRoute(): [string, LocalRoute] | null
  getLocalHostId(): string | null
  getLocalBase(): string
  getLocalRoute(hostId: string | null | undefined): LocalRoute | null
  activeRouteFor(hostId: string | null | undefined): 'direct' | 'pending' | 'relay'
  usableRoute(hostId: string | null | undefined): LocalRoute | null
  isLocalDirect(): boolean
  directBase(): string
  pageIsLoopback(): boolean
  hasPageOriginRoute(): boolean
  probeSkipped(port: number): boolean
  probeLocalPort(port: number): Promise<{ hostId: string; authRequired: boolean } | null>
  verifyLocalRoute(hostId: string): Promise<void>
  setProbe(hostId: string, probed: { base: string; port: number }, probe: LocalProbe): LocalProbe
  probeLocalRoute(hostId: string): Promise<LocalProbe>
  tryLocalKey(hostId: string, key: 'hub' | 'host'): Promise<'ok' | 'denied' | 'unreachable'>
  requestHostKey(hostId: string): void
  onHostKeyRequired(handler: (hostId: string) => void): () => void
  onHubAuthInvalid(handler: () => void): () => void
  tryHostKey(hostId: string, token: string): Promise<boolean>
  declineHostKey(hostId: string): void
  discoverLocalHost(hosts?: Array<{ hostId: string; port?: number; online?: boolean }>): Promise<string | null>
  detectMode(): Promise<DetectModeResult>
  detectModeLegacy(hostId: string, authRequired: boolean, localHostName?: string): Promise<DetectModeResult>
  getAccessToken(): string
  probeAccess(): Promise<'ok' | 'need_token' | 'error'>
  onEvent(handler: TransportHandler): () => void
  emit(ev: AcpEvent): void
  emitLocal(ev: AcpEvent): void
  lastLiveEventAt(): number | null
  isLiveOpen(): boolean
  url(path: string): string
  apiUrl(path: string): string
  urlForHost(hostId: string, path: string): string | null
  apiFetch(path: string, init?: RequestInit, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<Response>
  isLocalRequest(input: string): boolean
  routeOwner(input: string): string | null
  tokenFor(input: string): string | null
  handleRejection(target: { local: boolean; hostId: string | null }): void
  fetch(input: string, init?: RequestInit, opts?: FetchOpts): Promise<Response>
  resetSequencing(): void
  abortInflight(): void
  liveSseURL(): string
  liveWsURL(ticket?: string | null): string
  wsTicket(): Promise<string | null>
  pullEvents(hostId: string, after: number, signal: AbortSignal): Promise<SequencedEvent[] | null>
  acceptSequencedEvent(ev: SequencedEvent, gen?: number): void
  reconcileSeq(seqs?: Record<string, number>): void
  reconcileHostSeq(hostId: string, hubSeq: number): void
  handleResyncFrame(fromSeq: unknown, gen: number, hostId?: unknown): void
  onWsMessage(msg: MessageEvent, gen: number, ws: WebSocket): void
  connect(): void
  syncLocalSSE(): void
  connectWS(gen: number): void
  connectSSE(gen: number, trackSeq?: boolean): void
  scheduleSseReconnect(gen: number, trackSeq: boolean): void
  clearSseReconnect(): void
  disconnect(): void
}

/**
 * LocalTransport 的对外面：mixin 里声明为 public 的方法。
 *
 * mixin 经 Object.assign 挂到原型上，class 类型上看不见；这个接口把公开
 * 部分单独列出来，与 LocalTransportImpl 交叉成完整类型。私有的近路探测 /
 * 令牌槽辅助函数刻意不进来——它们是实现细节，调用方不该碰。
 */
export interface TransportApi extends RpcApi {
  setHost(hostId: string | null): void
  reportViewingSession(sessionId: string | null): void
  sendGuestSubscribe(hostId: string, sessionId: string): void
  getHost(): string | null
  adoptSharedToken(): boolean
  setGuestMode(identity: GuestIdentity | null): void
  settleAdminCredential(): void
  getCredentialSource(): 'admin' | 'guest'
  getGuestToken(): string
  dropGuestCredential(): void
  chooseStartupCredential(): 'admin' | 'guest'
  hasAdminToken(): boolean
  enterGuestMode(): Promise<'ok' | 'need_token' | 'invalid' | 'error'>
  tryGuestToken(token: string): Promise<GuestIdentity | null>
  getGuestIdentity(): GuestIdentity | null
  isGuest(): boolean
  exitGuestMode(): void
  logout(): void
  setAccessToken(token: string | null): void
  getHostToken(hostId: string | null | undefined): string
  setHostToken(hostId: string | null | undefined, token: string): void
  prefsOrigin(): string
  setConnectionMode(mode: TransportMode, hubUrl?: string): void
  getConnectionMode(): TransportMode
  getHubUrl(): string
  setLocalHostId(hostId: string | null, authRequired?: boolean): void
  getRouteChoice(hostId: string | null | undefined): RouteChoice
  setRouteChoice(hostId: string, choice: RouteChoice): void
  hasLocalCandidate(hostId: string | null | undefined): boolean
  getLocalHostId(): string | null
  getLocalBase(): string
  getLocalRoute(hostId: string | null | undefined): LocalRoute | null
  activeRouteFor(hostId: string | null | undefined): 'direct' | 'pending' | 'relay'
  isLocalDirect(): boolean
  verifyLocalRoute(hostId: string): Promise<void>
  probeLocalRoute(hostId: string): Promise<LocalProbe>
  onHostKeyRequired(handler: (hostId: string) => void): () => void
  onHubAuthInvalid(handler: () => void): () => void
  tryHostKey(hostId: string, token: string): Promise<boolean>
  declineHostKey(hostId: string): void
  discoverLocalHost(hosts?: Array<{ hostId: string; port?: number; online?: boolean }>): Promise<string | null>
  detectMode(): Promise<DetectModeResult>
  getAccessToken(): string
  probeAccess(): Promise<'ok' | 'need_token' | 'error'>
  onEvent(handler: TransportHandler): () => void
  emitLocal(ev: AcpEvent): void
  lastLiveEventAt(): number | null
  isLiveOpen(): boolean
  apiUrl(path: string): string
  urlForHost(hostId: string, path: string): string | null
  apiFetch(path: string, init?: RequestInit, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<Response>
  connect(): void
  disconnect(): void
}
