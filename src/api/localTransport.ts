import type { AcpEvent, ContentBlock, HostInfo, RewindPoint, SessionInfo, SessionInfoDetail } from './types'

export type TransportHandler = (ev: AcpEvent) => void

/**
 * LocalTransport talks to acp-host on the same machine (or via Vite proxy),
 * or to acp-hub when running in hub mode.
 *
 * Host selection (hub mode):
 * - API calls carry `?host=<hostId>`; the hub relays them to that host
 *   (acp-host ignores the query param, so local mode is unaffected).
 * - `/events` streams every host's events tagged with hostId; events for
 *   non-selected hosts are filtered out here. Hub-level events (hello,
 *   hosts_changed) carry no hostId and always pass through.
 */
export class LocalTransport {
  private es: EventSource | null = null
  private handlers = new Set<TransportHandler>()
  private base: string
  private selectedHostId: string | null = null

  constructor(base = '') {
    this.base = base.replace(/\/$/, '')
  }

  /** Select the target host for API calls + event filtering (null = none). */
  setHost(hostId: string | null) {
    this.selectedHostId = hostId
  }

  getHost(): string | null {
    return this.selectedHostId
  }

  onEvent(handler: TransportHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  private emit(ev: AcpEvent) {
    // Events without hostId are hub/host-level (hello, hosts_changed,
    // or local-mode events) — always pass. Host-tagged events pass only
    // when they belong to the selected host.
    const host = (ev as { hostId?: string }).hostId
    if (host && this.selectedHostId && host !== this.selectedHostId) return
    for (const h of this.handlers) h(ev)
  }

  /** Emit a synthetic event (used to apply a host snapshot on switch). */
  emitLocal(ev: AcpEvent) {
    this.emit(ev)
  }

  private url(path: string): string {
    const qs = this.selectedHostId ? `?host=${encodeURIComponent(this.selectedHostId)}` : ''
    return `${this.base}${path}${qs}`
  }

  connect() {
    this.disconnect()
    const es = new EventSource(`${this.base}/events`)
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
    const res = await fetch(this.url('/api/prompt'), {
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
    await fetch(this.url('/api/cancel'), { method: 'POST' })
  }

  async respondPermission(requestId: string, optionId?: string, cancelled?: boolean) {
    const res = await fetch(this.url('/api/permission-response'), {
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
    const res = await fetch(this.url('/api/client-response'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, result, error }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'client response failed')
  }

  async newSession(config: { cwd?: string; additionalDirectories?: string[]; mcpServers?: unknown[] } = {}) {
    const res = await fetch(this.url('/api/session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'session failed')
    return data
  }

  /** Host registry + hub default selection (hub-level endpoint, no relay). */
  async listHosts(): Promise<{ hosts: HostInfo[]; defaultHostId?: string }> {
    const res = await fetch(`${this.base}/api/hosts`)
    const data = await res.json()
    return { hosts: data.hosts ?? [], defaultHostId: data.defaultHostId }
  }

  async listSessions(): Promise<SessionInfo[]> {
    const res = await fetch(this.url('/api/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const data = await res.json()
    return data.sessions ?? []
  }

  /**
   * Switch the active session to a historical one (session/load).
   * Returns the load response fields (notably `models` SessionModelState
   * and `busy` when focusing an in-flight session) so the UI can update
   * without racing SSE.
   */
  async loadSession(
    sessionId: string,
    cwd: string,
  ): Promise<{
    models?: unknown
    modes?: unknown
    configOptions?: unknown
    busy?: boolean
  }> {
    const res = await fetch(this.url('/api/session-load'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `load session failed (${res.status})`)
    }
    return {
      models: data.models,
      modes: data.modes,
      configOptions: data.configOptions,
      busy: data.busy === true,
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
    const res = await fetch(this.url('/api/session-updates'), {
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

  /**
   * STILL-RUNNING tasks of a session (POST /api/session-running-tasks):
   * task_backgrounded orphans whose output log was written recently
   * (host-side liveness probe). The web equivalent of the TUI's live
   * tasks pane — history is not dumped into the scrollback, only the
   * tasks that are currently running.
   */
  async sessionRunningTasks(
    sessionId: string,
    cwd: string,
  ): Promise<{ events?: import('./types').TaskTimelineEvent[] }> {
    const res = await fetch(this.url('/api/session-running-tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `running tasks failed (${res.status})`)
    }
    return data
  }

  /**
   * Git branch/worktree state for a session cwd (x.ai/git/info + host
   * worktree probe). The frontend polls this on session ready — the
   * git_head_changed notification is fire-and-forget and deduped, so a
   * page that opens after it was emitted would never see the branch.
   */
  async gitInfo(
    sessionId: string,
    cwd: string,
  ): Promise<{ branch?: string; isWorktree?: boolean; mainRepo?: string }> {
    const res = await fetch(this.url('/api/git-info'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `git-info failed (${res.status})`)
    }
    return data
  }

  async status() {
    const res = await fetch(this.url('/api/status'))
    return res.json()
  }

  /** x.ai/session-info — authoritative session details at open time. */
  async sessionInfo(): Promise<SessionInfoDetail> {
    const res = await fetch(this.url('/api/session-info'), { method: 'POST' })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `session info failed (${res.status})`)
    }
    return data
  }

  /** x.ai/session/fork — fork the current session (TUI /fork). */
  async forkSession(params: Record<string, unknown> = {}) {
    const res = await fetch(this.url('/api/session-fork'), {
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
    const res = await fetch(this.url('/api/session-rename'), {
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
    const res = await fetch(this.url('/api/recap'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'recap failed')
    return data
  }

  /** session/setModel — switch the session's model (grok /model). */
  async setModel(modelId: string, reasoningEffort?: string) {
    const res = await fetch(this.url('/api/set-model'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, ...(reasoningEffort ? { reasoningEffort } : {}) }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'set model failed')
    return data
  }

  /** x.ai/set-mode (host /api/set-mode) — switch permission mode (TUI /plan, /normal). */
  async setMode(modeId: string) {
    const res = await fetch(this.url('/api/set-mode'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modeId }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'set mode failed')
    return data
  }

  /** x.ai/subagent/cancel. */
  async cancelSubagent(subagentId: string) {
    const res = await fetch(this.url('/api/subagent-cancel'), {
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
    const res = await fetch(this.url('/api/task-kill'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'task kill failed')
    return data
  }

  /**
   * Parse one TaskSnapshot (snake_case or camelCase wire fields) into a
   * normalized shape the FE can merge into bg_task entries.
   */
  private parseTaskSnap(
    t: Record<string, unknown>,
    fallbackId = '',
  ): {
    taskId: string
    command?: string
    output?: string
    outputFile?: string
    completed?: boolean
    description?: string
    truncated?: boolean
    running?: boolean
    failed?: boolean
  } {
    const id = t.task_id ?? t.taskId ?? fallbackId
    return {
      taskId: id == null || id === '' ? '' : String(id),
      command:
        (typeof t.display_command === 'string' && t.display_command) ||
        (typeof t.displayCommand === 'string' && t.displayCommand) ||
        (typeof t.command === 'string' ? t.command : undefined) ||
        undefined,
      output: typeof t.output === 'string' ? t.output : undefined,
      outputFile:
        (typeof t.output_file === 'string' && t.output_file) ||
        (typeof t.outputFile === 'string' ? t.outputFile : undefined) ||
        undefined,
      completed: typeof t.completed === 'boolean' ? t.completed : undefined,
      description:
        typeof t.description === 'string' && t.description.trim()
          ? t.description.trim()
          : undefined,
      truncated: typeof t.truncated === 'boolean' ? t.truncated : undefined,
      // Host reconstruction (TaskLog) fields — camelCase on the wire.
      running: typeof t.running === 'boolean' ? t.running : undefined,
      failed: typeof t.failed === 'boolean' ? t.failed : undefined,
    }
  }

  /**
   * x.ai/task/list — live background tasks for the active session
   * (TUI restores these on session/load; history alone can miss running
   * tasks whose task_backgrounded fell outside the loaded page).
   */
  async listTasks(): Promise<
    Array<{
      taskId: string
      command?: string
      output?: string
      outputFile?: string
      completed?: boolean
      description?: string
      truncated?: boolean
    }>
  > {
    const res = await fetch(this.url('/api/task-list'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'task list failed')
    // Walk common envelopes until we find a tasks array:
    //   { ok, result: { result: { tasks }, error } }  // ExtMethodResult via JSON-RPC
    //   { ok, result: { tasks } }
    //   { tasks }
    const list = findArrayField(data, 'tasks')
    return list
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((t) => this.parseTaskSnap(t))
      .filter((t) => t.taskId)
  }

  /**
   * Fetch one background task's snapshot (incl. stdout). Two modes:
   *  - `{ taskId }` — live registry of the ACTIVE session (host →
   *    x.ai/task/list);
   *  - `{ taskId, sessionId, cwd }` — reconstructed from that session's
   *    persisted timeline + on-disk log by the host (pagination-
   *    independent; used by history-replay rows and top-strip restored
   *    tasks whose registry this host cannot see).
   */
  async taskOutput(
    taskId: string,
    session?: { sessionId?: string; cwd?: string },
  ): Promise<{
    taskId: string
    command?: string
    output?: string
    outputFile?: string
    completed?: boolean
    description?: string
    truncated?: boolean
    running?: boolean
    failed?: boolean
  }> {
    const res = await fetch(this.url('/api/task-output'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
        ...(session?.cwd ? { cwd: session.cwd } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'task output failed')
    return this.parseTaskSnap((data.task ?? {}) as Record<string, unknown>, taskId)
  }

  /**
   * x.ai/session/delete — delete a session (TUI /delete). Deleting the
   * ACTIVE session ends it; the UI falls back to a fresh session.
   */
  async sessionDelete(sessionId: string, cwd: string) {
    const res = await fetch(this.url('/api/session-delete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `session delete failed (${res.status})`)
    }
    return data
  }

  /** x.ai/session/compact — compress the active session's context (TUI /compact). */
  async compact(sessionId: string, note?: string) {
    const res = await fetch(this.url('/api/compact'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ...(note ? { note } : {}) }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'compact failed')
    return data
  }

  /**
   * x.ai/session/rewind_points — candidate rewind targets for the /rewind
   * picker. The points array is unwrapped here (host contract
   * `{ points: [{ index, timestamp, summary? }] }`).
   */
  async rewindPoints(
    sessionId: string,
    cwd: string,
  ): Promise<{ points: RewindPoint[] }> {
    const res = await fetch(this.url('/api/rewind-points'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `rewind points failed (${res.status})`)
    }
    const points = (findArrayField(data, 'points') as Record<string, unknown>[])
      .filter(
        (p): p is Record<string, unknown> & { index: number } =>
          !!p && typeof p === 'object' && typeof p.index === 'number',
      )
      .map((p) => ({
        index: p.index,
        ...(p.timestamp != null ? { timestamp: p.timestamp as number | string } : {}),
        ...(typeof p.summary === 'string' && p.summary ? { summary: p.summary } : {}),
      }))
    return { points }
  }

  /** x.ai/session/rewind — rewind the session to a stored index (TUI /rewind). */
  async rewindExecute(sessionId: string, targetIndex: number) {
    const res = await fetch(this.url('/api/rewind-execute'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, targetIndex }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'rewind failed')
    return data
  }

  /** x.ai/scheduler/delete — remove a scheduled task (TUI /loop delete). */
  async schedulerDelete(sessionId: string, taskId: string) {
    const res = await fetch(this.url('/api/scheduler-delete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, taskId }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'scheduler delete failed')
    }
    return data
  }

  /**
   * Memory system — /flush (TUI /flush): ask the host to persist the
   * session's knowledge to memory right now (LLM summary of the most
   * important content). The host may not implement this yet (parallel
   * work — 404s degrade gracefully in the caller).
   */
  async memoryFlush(sessionId: string) {
    const res = await fetch(this.url('/api/memory-flush'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `memory flush failed (${res.status})`)
    }
    return data
  }

  /**
   * Memory system — /dream (TUI /dream): memory consolidation. The FE
   * currently routes /dream through the prompt path (no wire method the
   * agent understands); this endpoint is reserved for when the host
   * implements memory consolidation directly.
   */
  async memoryRewrite(sessionId: string) {
    const res = await fetch(this.url('/api/memory-rewrite'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `memory rewrite failed (${res.status})`)
    }
    return data
  }
}

/**
 * Depth-first search for a `<key>: unknown[]` field in nested JSON
 * (walks `result` / `data` / `payload` envelopes).
 */
function findArrayField(root: unknown, key: string): unknown[] {
  const seen = new Set<unknown>()
  const walk = (v: unknown, depth: number): unknown[] | null => {
    if (v == null || depth > 6) return null
    if (typeof v !== 'object') return null
    if (seen.has(v)) return null
    seen.add(v)
    if (Array.isArray(v)) return null
    const o = v as Record<string, unknown>
    if (Array.isArray(o[key])) return o[key]
    for (const k of ['result', 'data', 'payload']) {
      const found = walk(o[k], depth + 1)
      if (found) return found
    }
    return null
  }
  return walk(root, 0) ?? []
}

export const transport = new LocalTransport()
