import { LocalTransport } from './localTransport'
import type { LocalRoute } from './localTransport'
import type { TransportHandler, TransportMode } from './transport'
import type { AcpEvent } from './types'
import type { RpcApi } from './rpc/mixins'

export type Transport = {
  setHost(hostId: string | null): void
  getHost(): string | null
  setAccessToken(token: string | null): void
  setConnectionMode(mode: TransportMode, hubUrl?: string): void
  getConnectionMode(): TransportMode
  getHubUrl(): string
  prefsOrigin(): string
  setLocalHostId(hostId: string | null): void
  getLocalHostId(): string | null
  getLocalBase(): string
  /** 某台 host 已验证的本机近路（null = 只能走 hub 中继）。 */
  getLocalRoute(hostId: string | null | undefined): LocalRoute | null
  /** 选中 host 当前是否正走本机近路。 */
  isLocalDirect(): boolean
  /** 定点核对某台 host 的本机端口归属（已验证且端口没变则零请求）。 */
  verifyLocalRoute(hostId: string): Promise<void>
  discoverLocalHost(
    hosts?: Array<{ hostId: string; port?: number; online?: boolean }>,
  ): Promise<string | null>
  detectMode(): Promise<{
    mode: TransportMode
    hubUrl: string
    localHostId?: string
  }>
  getAccessToken(): string
  probeAccess(): Promise<'ok' | 'need_token' | 'error'>
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
export { AgentTurnError, AccessTokenError } from './transport'
