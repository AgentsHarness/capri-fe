import { LocalTransport } from './localTransport'
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
  detectMode(): Promise<{
    mode: TransportMode
    hubUrl: string
    localHostId?: string
  }>
  getAccessToken(): string
  probeAccess(): Promise<'ok' | 'need_token' | 'error'>
  /**
   * Subscribe to auth-invalid notifications: fired when a request carrying a
   * token is rejected with 401 after the app is past the gate (FE_TOKEN was
   * changed server-side). The subscriber should reset to the access gate.
   */
  onAuthInvalid(handler: () => void): () => void
  /** Clear the stored token and abort in-flight requests (log out). */
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
export { AgentTurnError, AccessTokenError } from './transport'
