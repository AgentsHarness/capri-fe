/**
 * Transport 薄层：组件/Store 只经由此处拿 transport，且只依赖
 * Transport 接口类型（实现细节在 localTransport.ts / rpc/* 中）。
 */
import { LocalTransport } from './localTransport'
import type { TransportCore, TransportHandler, TransportMode } from './transport'
import type { AcpEvent } from './types'
import type { sessionsRpc } from './rpc/sessions'
import type { gitRpc } from './rpc/git'
import type { toolsRpc } from './rpc/tools'
import type { miscRpc } from './rpc/misc'

/**
 * Transport 全公开 API：连接管理（类内实现）+ 命令发送
 * （api/rpc/* 的 mixin 方法，类型级组合，签名自动继承）。
 * 放此处（消费端）而非 transport.ts，避免 transport ↔ rpc 的类型环。
 */
export type Transport = TransportCore & {
    setHost(hostId: string | null): void;
    getHost(): string | null;
    setAccessToken(token: string | null): void;
    setConnectionMode(mode: TransportMode, hubUrl?:unknown): void;
    getConnectionMode(): TransportMode;
    getHubUrl(): string;
    setLocalHostId(hostId: string | null): void;
    detectMode(): Promise<{
    mode: TransportMode
    hubUrl: string
    localHostId?: string
  }>;
    getAccessToken(): string;
    probeAccess(): Promise<'ok' | 'need_token' | 'error'>;
    onEvent(handler: TransportHandler): () => void;
    emitLocal(ev: AcpEvent): void;
    lastLiveEventAt(): number | null;
    isLiveOpen(): boolean;
    apiUrl(path: string): string;
    apiFetch(
    path: string,
    init?:RequestInit,
    opts?:{ timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Response>;
    connect(): void;
    disconnect(): void;
} & typeof sessionsRpc & typeof gitRpc & typeof toolsRpc & typeof miscRpc

/** 全应用共享的 transport 单例（接口收窄，禁止触碰实现细节）。
 *  RPC 方法经 Object.assign 挂在原型上，TS 静态类型不认识，
 *  用双重断言收敛到 Transport 接口。 */
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
  TerminalOutput,
} from './transport'
export type { ExtensionHook, ExtensionPlugin, ExtensionSkill } from './types'
export { AgentTurnError, AccessTokenError } from './transport'
