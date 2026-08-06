import type { AcpEvent, ContentBlock, HostInfo, SessionInfo } from './types'

export type TransportHandler = (ev: AcpEvent) => void

/**
 * LocalTransport talks to acp-host on the same machine (or via Vite proxy).
 * HubTransport will share the same surface later.
 */
export class LocalTransport {
  private es: EventSource | null = null
  private handlers = new Set<TransportHandler>()
  private base: string

  constructor(base = '') {
    this.base = base.replace(/\/$/, '')
  }

  onEvent(handler: TransportHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  private emit(ev: AcpEvent) {
    for (const h of this.handlers) h(ev)
  }

  connect() {
    this.disconnect()
    const url = `${this.base}/events`
    const es = new EventSource(url)
    this.es = es
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as AcpEvent
        if (data && typeof data === 'object' && 'type' in data) {
          this.emit(data)
        }
      } catch {
        /* ignore */
      }
    }
    es.onerror = () => {
      // browser will reconnect EventSource automatically
    }
  }

  disconnect() {
    this.es?.close()
    this.es = null
  }

  async prompt(blocks: ContentBlock[]): Promise<{ stopReason?: string }> {
    const res = await fetch(`${this.base}/api/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `prompt failed (${res.status})`)
    }
    return data
  }

  async cancel(): Promise<void> {
    await fetch(`${this.base}/api/cancel`, { method: 'POST' })
  }

  async respondPermission(requestId: string, optionId?: string, cancelled?: boolean) {
    const res = await fetch(`${this.base}/api/permission-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, optionId, cancelled }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'permission failed')
  }

  /**
   * Respond to a forwarded x.ai/* request (ask_user_question, exit_plan_mode…).
   * `result` is passed through verbatim as the JSON-RPC result; `error`
   * rejects the request.
   */
  async respondClientRequest(requestId: string, result?: Record<string, unknown>, error?: string) {
    const res = await fetch(`${this.base}/api/client-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, result, error }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'client response failed')
  }

  async newSession(config: { cwd?: string; additionalDirectories?: string[]; mcpServers?: unknown[] } = {}) {
    const res = await fetch(`${this.base}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'session failed')
    return data
  }

  async listHosts(): Promise<HostInfo[]> {
    const res = await fetch(`${this.base}/api/hosts`)
    const data = await res.json()
    return data.hosts ?? []
  }

  async listSessions(): Promise<SessionInfo[]> {
    const res = await fetch(`${this.base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const data = await res.json()
    return data.sessions ?? []
  }

  /** Switch the active session to a historical one (session/load). */
  async loadSession(sessionId: string, cwd: string): Promise<void> {
    const res = await fetch(`${this.base}/api/session-load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `load session failed (${res.status})`)
    }
  }

  /**
   * Load a historical session's updates as raw storage envelopes.
   * The frontend replays them locally through the normal event pipeline.
   */
  async loadSessionHistory(
    sessionId: string,
    cwd: string,
    opts: { offset?: number; limit?: number } = {},
  ): Promise<{
    totalCount?: number
    hasMore?: boolean
    updates?: unknown[]
  }> {
    const res = await fetch(`${this.base}/api/session-updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd, ...opts }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `history failed (${res.status})`)
    }
    return data
  }

  async status() {
    const res = await fetch(`${this.base}/api/status`)
    return res.json()
  }

  /** x.ai/session/fork — fork the current session (TUI /fork). */
  async forkSession(params: Record<string, unknown> = {}) {
    const res = await fetch(`${this.base}/api/session-fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'fork failed')
    return data
  }

  /** x.ai/session/rename. */
  async renameSession(title: string) {
    const res = await fetch(`${this.base}/api/session-rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'rename failed')
    return data
  }

  /** x.ai/recap — fire-and-forget "where was I" summary. */
  async recap(auto = false) {
    const res = await fetch(`${this.base}/api/recap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'recap failed')
    return data
  }

  /** x.ai/subagent/cancel. */
  async cancelSubagent(subagentId: string) {
    const res = await fetch(`${this.base}/api/subagent-cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subagentId }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'subagent cancel failed')
    return data
  }

  /** x.ai/task/kill — kill a background task. */
  async killTask(taskId: string) {
    const res = await fetch(`${this.base}/api/task-kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'task kill failed')
    return data
  }
}

export const transport = new LocalTransport()
