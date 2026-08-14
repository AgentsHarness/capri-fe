import type { AcpEvent } from './types'
import type { ExtensionHook, ExtensionPlugin, ExtensionSkill } from './types'


export type TransportHandler = (ev: AcpEvent) => void


/**
 * Turn-level failure from POST /api/prompt — the host answered (any HTTP
 * status) with an error envelope ({ok:false, error} or non-2xx). The host
 * is a relay: such failures are the AGENT's (e.g. the model API's 400
 * "Internal Error: …"), not a host outage — the store renders them as a
 * scrollback error row instead of flipping the connection to 'error'.
 * Network-level failures (fetch rejection — host unreachable) stay plain
 * Errors and keep the host-error treatment.
 */
export type AgentTurnKind = 'rejected' | 'unreachable'


export class AgentTurnError extends Error {
  /**
   * 'rejected' — agent 回复了 JSON-RPC 错误（进程活着，只是拒绝了回合）；
   * 'unreachable' — agent 不可达（host 返回 502：超时/写失败/boot 失败，
   * host 正在重启 agent）。
   */
  kind: AgentTurnKind
  /** HTTP 状态码（有则带上）——409 = mid-turn 竞态（渲染错误行）。 */
  status?: number
  constructor(kind: AgentTurnKind, message: string, status?: number) {
    super(message)
    this.name = 'AgentTurnError'
    this.kind = kind
    if (status != null) this.status = status
  }
}


/** Thrown when the hub rejects the browser token (or none was sent). */
export class AccessTokenError extends Error {
  constructor(message = '需要有效的访问 token') {
    super(message)
    this.name = 'AccessTokenError'
  }
}


/** 连接模式：local = 同源 capri-host（SSE /events，无 ?host=，锁定本机）；hub = 跨源直连 hub（WS /ws/fe + ?host= + token）。 */
export type TransportMode = 'local' | 'hub'


/** One configured MCP server from GET /api/mcp/list (host reads config). */
export type McpListServer = {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
  source?: string
  url?: string
  status?: string
  /**
   * Tools of the server's live session (agent wire `session.tools`,
   * camelCase). Undefined = the wire carried no tool info (config-only
   * entry / older agent) — the panel degrades to 无工具信息.
   */
  tools?: McpToolInfo[]
}


/** One MCP tool row (mcps_modal.rs McpToolDetail — camelCase wire). */
export type McpToolInfo = {
  name: string
  displayName?: string
  description?: string
  enabled?: boolean
}


/** GET /api/extensions — full payload (arrays always present, maybe empty). */
export type ExtensionsPayload = {
  hooks: ExtensionHook[]
  plugins: ExtensionPlugin[]
  skills: ExtensionSkill[]
}


/** GET /api/settings — safe config.toml subset (read-only). */
export type SettingsPayload = {
  ui?: Record<string, unknown>
  session?: Record<string, unknown>
  models?: Record<string, unknown>
  cli?: Record<string, unknown>
}


/** x.ai/terminal/output — cumulative snapshot for piped terminals. */
export type TerminalOutput = {
  output: string
  truncated: boolean
  exitStatus?: { exitCode?: number | null; signal?: string }
}

/** RPC 模块可见的传输核心能力（LocalTransport 实现）。 */
export interface TransportCore {
  url(path: string): string
  apiBase(): string
  mode: TransportMode
  fetch(
    path: string,
    init?: RequestInit,
    opts?: { timeoutMs?: number; signal?: AbortSignal; hubLevel?: boolean },
  ): Promise<Response>
}
