import type {
  AcpEvent,
  ContentBlock,
  ExtensionHook,
  ExtensionPlugin,
  ExtensionSkill,
  HostInfo,
  PermissionScope,
  RewindPoint,
  SessionInfo,
  SessionInfoDetail,
  WorkspaceGroup,
  WorkspaceSummary,
} from './types'

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

  async respondPermission(
    requestId: string,
    optionId?: string,
    cancelled?: boolean,
    /**
     * Structured "always allow" scope (TUI BashCommandSelectedTerms) —
     * sent only when an always-allow option is selected. Host contract
     * (parallel): `scope: { commandParts: string[], isGlob: boolean }`,
     * parsed verbatim — field names must match exactly.
     */
    scope?: PermissionScope,
    /** Optional followup message on a reject (TUI RejectOnce followup). */
    followupMessage?: string,
  ) {
    const res = await fetch(this.url('/api/permission-response'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        optionId,
        cancelled,
        ...(scope ? { scope } : {}),
        ...(followupMessage ? { followupMessage } : {}),
      }),
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

  async newSession(config: {
    cwd?: string
    additionalDirectories?: string[]
    mcpServers?: unknown[]
    /** Permission-mode seeds (TUI's yoloMode/autoMode) → session/new `_meta`. */
    meta?: Record<string, unknown>
  } = {}) {
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
   * x.ai/session_summaries/workspace_list — session summaries bucketed
   * by workspace. Wire shape: all_sessions = { "<cwd>": [summary, ...] },
   * possibly wrapped in an ExtMethodResult envelope ({ ok, result: {...} }
   * or deeper) — dug out via findObjectField. Each summary is snake_case
   * (info.id / info.cwd / session_summary / updated_at / num_messages /
   * current_model_id) and normalized to WorkspaceGroup[] here.
   */
  async workspaceList(): Promise<WorkspaceGroup[]> {
    const res = await fetch(this.url('/api/session-summaries/workspace-list'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `workspace list failed (${res.status})`)
    }
    const all = findObjectField(data, 'all_sessions')
    const groups: WorkspaceGroup[] = []
    if (!all) return groups
    for (const [cwd, raw] of Object.entries(all)) {
      if (!Array.isArray(raw)) continue
      const sessions: WorkspaceSummary[] = []
      for (const s of raw) {
        if (!s || typeof s !== 'object') continue
        const o = s as Record<string, unknown>
        const info =
          o.info && typeof o.info === 'object' && !Array.isArray(o.info)
            ? (o.info as Record<string, unknown>)
            : {}
        const id =
          (typeof info.id === 'string' && info.id) ||
          (typeof o.session_id === 'string' && o.session_id) ||
          (typeof o.sessionId === 'string' && o.sessionId) ||
          ''
        if (!id) continue
        const summary =
          (typeof o.session_summary === 'string' && o.session_summary.trim()) ||
          (typeof o.sessionSummary === 'string' && o.sessionSummary.trim()) ||
          ''
        sessions.push({
          sessionId: id,
          cwd: (typeof info.cwd === 'string' && info.cwd) || cwd,
          // session_summary 兜底 info.id 前 12 字符。
          title: summary || id.slice(0, 12),
          ...(typeof o.updated_at === 'string' && o.updated_at
            ? { updatedAt: o.updated_at }
            : typeof o.updatedAt === 'string' && o.updatedAt
              ? { updatedAt: o.updatedAt }
              : {}),
          ...(typeof o.current_model_id === 'string' && o.current_model_id
            ? { currentModelId: o.current_model_id }
            : typeof o.currentModelId === 'string' && o.currentModelId
              ? { currentModelId: o.currentModelId }
              : {}),
          ...(typeof o.num_messages === 'number' && Number.isFinite(o.num_messages)
            ? { numMessages: o.num_messages }
            : typeof o.numMessages === 'number' && Number.isFinite(o.numMessages)
              ? { numMessages: o.numMessages }
              : {}),
        })
      }
      if (sessions.length > 0) groups.push({ cwd, label: cwd, sessions })
    }
    return groups
  }

  /**
   * Switch the active session to a historical one (session/load).
   * `meta` (permission-mode seeds, e.g. {yoloMode, autoMode}) is
   * forwarded as the request `_meta` so the agent restores the session's
   * permission mode — the agent never persists ask/auto/always-approve.
   * Returns the load response fields (notably `models` SessionModelState
   * and `busy` when focusing an in-flight session) so the UI can update
   * without racing SSE.
   */
  async loadSession(
    sessionId: string,
    cwd: string,
    meta?: Record<string, unknown>,
  ): Promise<{
    models?: unknown
    modes?: unknown
    configOptions?: unknown
    busy?: boolean
  }> {
    const res = await fetch(this.url('/api/session-load'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd, ...(meta ? { meta } : {}) }),
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

  // ── Git workspace panel (POST /api/git/* → x.ai/git/* passthrough) ──
  // Host contract: {ok: true, result: <agent raw result>} where the agent
  // result is an ExtMethodResult envelope ({result, error}) for ext
  // methods — unwrapped by unwrapExtResult below (legacy flat payloads
  // also pass through). All calls are cwd-scoped (gitRoot wire key).

  /**
   * POST /api/git/status {cwd?, includeUntracked?} → x.ai/git/status.
   * The host defaults includeUntracked to true; the agent's structured
   * GitStatusData (branch / staged / unstaged) lands in the envelope.
   */
  async gitStatus(
    opts: { cwd?: string; includeUntracked?: boolean } = {},
  ): Promise<import('./types').GitStatusData> {
    return unwrapExtResult<import('./types').GitStatusData>(
      await this.xaiCall('/api/git/status', opts),
    )
  }

  /**
   * POST /api/git/diffs {cwd?, from, to, paths?} → x.ai/git/diffs.
   * `from`/`to` are git refs — "HEAD"/"working"/"staged" or a commit-ish.
   * The host does not forward includePatch, so patch text is usually
   * absent; the panel degrades to stats (+ content via /api/git/files
   * for untracked files) and renders the patch when it is present.
   */
  async gitDiffs(opts: {
    cwd?: string
    from: string
    to: string
    paths?: string[]
  }): Promise<import('./types').GitDiffsData> {
    return unwrapExtResult<import('./types').GitDiffsData>(
      await this.xaiCall('/api/git/diffs', opts),
    )
  }

  /** POST /api/git/stage {cwd?, paths?} → x.ai/git/stage. */
  async gitStage(opts: { cwd?: string; paths?: string[] }): Promise<unknown> {
    return unwrapExtResult(await this.xaiCall('/api/git/stage', opts))
  }

  /** POST /api/git/unstage {cwd?, paths?} → x.ai/git/unstage. */
  async gitUnstage(opts: { cwd?: string; paths?: string[] }): Promise<unknown> {
    return unwrapExtResult(await this.xaiCall('/api/git/unstage', opts))
  }

  /**
   * POST /api/git/discard {cwd?, paths?, includeUntracked?} →
   * x.ai/git/discard. includeUntracked only reaches the agent when
   * explicitly provided — the panel sends it for untracked rows.
   */
  async gitDiscard(opts: {
    cwd?: string
    paths?: string[]
    includeUntracked?: boolean
  }): Promise<unknown> {
    return unwrapExtResult(await this.xaiCall('/api/git/discard', opts))
  }

  /** POST /api/git/commit {cwd?, message, amend?, signoff?, push?} → x.ai/git/commit. */
  async gitCommit(opts: {
    cwd?: string
    message: string
    amend?: boolean
    signoff?: boolean
    push?: boolean
  }): Promise<unknown> {
    return unwrapExtResult(await this.xaiCall('/api/git/commit', opts))
  }

  /**
   * POST /api/git/files {cwd?, paths, version?} → x.ai/git/files —
   * file content at a version ("working" / "staged" / commit-ish). Used
   * by the git panel to preview untracked files (git diff never shows
   * them).
   */
  async gitFiles(opts: {
    cwd?: string
    paths: string[]
    version?: string
  }): Promise<import('./types').GitReadFilesData> {
    return unwrapExtResult<import('./types').GitReadFilesData>(
      await this.xaiCall('/api/git/files', opts),
    )
  }

  /**
   * POST /api/billing {sessionId?} → _x.ai/billing. Response shape is the
   * agent's BillingConfigResponse ({ config: { creditUsagePercent,
   * prepaidBalance: { val }, … }, onDemandEnabled, … }) — no ExtMethodResult
   * envelope (billing is a plain method). Unwraps {ok, result} only.
   */
  async billing(sessionId?: string): Promise<import('./types').BillingConfigResponse> {
    const res = await fetch(this.url('/api/billing'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `billing failed (${res.status})`)
    }
    const result = data.result ?? {}
    return result && typeof result === 'object' ? result : {}
  }

  /**
   * Shared x.ai/* passthrough call: POST `path` with JSON `body`,
   * returns the agent's raw `result` (the host answers {ok, result}).
   */
  private async xaiCall(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(this.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `${path} failed (${res.status})`)
    }
    return data.result
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
    // Host wraps the payload in { ok, session: {...} } — same convention as
    // /api/sessions (data.sessions). Unwrap so the fields land on the
    // SessionInfoDetail shape.
    return (data.session ?? data) as SessionInfoDetail
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

  /**
   * x.ai/toggle_plan_mode (host /api/toggle-plan-mode) — enter/leave plan
   * mode. Returns the authoritative `planMode` when the host reports it;
   * callers fall back to their local toggle when it is absent.
   */
  async togglePlanMode(
    sessionId?: string,
  ): Promise<{ ok?: boolean; planMode?: boolean }> {
    const res = await fetch(this.url('/api/toggle-plan-mode'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'toggle plan mode failed')
    }
    return data
  }

  /**
   * x.ai/permissions/reset (host /api/permissions-reset) — forget every
   * remembered permission rule (always-allow patterns, etc.).
   */
  async permissionsReset(sessionId?: string): Promise<void> {
    const res = await fetch(this.url('/api/permissions-reset'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'permissions reset failed')
    }
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
        ...(typeof p.hasFileChanges === 'boolean'
          ? { hasFileChanges: p.hasFileChanges }
          : {}),
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

  // ── MCP management (TUI /mcps modal) ────────────────────────────────
  // Host contract (parallel implementation — may 404 / be unsupported for
  // now): every call degrades to a thrown Error the panel renders inline.

  /**
   * GET /api/mcp/list — configured MCP servers (host reads config.toml).
   * The array may be envelope-wrapped ({ result: { servers } } —
   * agent-rendered), so it is dug out defensively; malformed entries are
   * dropped rather than failing the whole list.
   */
  async mcpList(): Promise<{ servers: McpListServer[] }> {
    const res = await fetch(this.url('/api/mcp/list'))
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `mcp list failed (${res.status})`)
    }
    const servers = (findArrayField(data, 'servers') as Record<string, unknown>[])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => {
        // The agent nests per-session state (enabled/status/tools) under a
        // snake_case `session` object; the bare catalog config lives at the
        // top level. Prefer top-level fields, fall back to session.*.
        const sess =
          s.session && typeof s.session === 'object' && !Array.isArray(s.session)
            ? (s.session as Record<string, unknown>)
            : {}
        const env =
          s.env && typeof s.env === 'object'
            ? Array.isArray(s.env)
              ? Object.fromEntries(
                  s.env
                    .filter(
                      (e): e is Record<string, unknown> =>
                        !!e && typeof e === 'object',
                    )
                    .map((e) => [String(e.name ?? ''), String(e.value ?? '')])
                    .filter(([k]) => k !== ''),
                )
              : (s.env as Record<string, string>)
            : undefined
        // Tool list — agent wire (mcps_modal.rs McpsServerSession, camelCase):
        // session.tools = [{name, displayName?, description?, enabled?}].
        // Absent (older agents / config-only entries) → undefined; the
        // panel then renders 无工具信息 instead of an empty list.
        const rawTools = Array.isArray(sess.tools) ? sess.tools : []
        const tools: McpToolInfo[] = rawTools
          .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
          .map((t) => ({
            name: typeof t.name === 'string' ? t.name : '',
            ...(typeof t.displayName === 'string' && t.displayName
              ? { displayName: t.displayName }
              : {}),
            ...(typeof t.description === 'string' && t.description
              ? { description: t.description }
              : {}),
            ...(typeof t.enabled === 'boolean' ? { enabled: t.enabled } : {}),
          }))
          .filter((t) => t.name)
        return {
          name: typeof s.name === 'string' ? s.name : '',
          ...(typeof s.command === 'string' && s.command ? { command: s.command } : {}),
          ...(Array.isArray(s.args) ? { args: s.args.map(String) } : {}),
          ...(env && Object.keys(env).length > 0 ? { env } : {}),
          ...(typeof s.enabled === 'boolean'
            ? { enabled: s.enabled }
            : typeof sess.enabled === 'boolean'
              ? { enabled: sess.enabled }
              : {}),
          ...(typeof s.source === 'string' && s.source ? { source: s.source } : {}),
          ...(typeof s.url === 'string' && s.url ? { url: s.url } : {}),
          ...(typeof s.status === 'string' && s.status
            ? { status: s.status }
            : typeof sess.status === 'string' && sess.status
              ? { status: sess.status }
              : {}),
          // Only attach the tools array when the wire actually carried one
          // (empty array = a connected server with zero tools; undefined =
          // no tool info at all).
          ...(Array.isArray(sess.tools) ? { tools } : {}),
        }
      })
      .filter((s) => s.name)
    return { servers }
  }

  /** POST /api/mcp-toggle-tool — enable/disable one tool of a server
   *  (TUI /mcps tool row toggle → x.ai/mcp/toggle_tool). Body is
   *  camelCase ({serverName, toolName, enabled}); the host maps it to the
   *  agent's snake_case wire (session_id/server_name/tool_name/enabled). */
  async mcpToggleTool(
    serverName: string,
    toolName: string,
    enabled: boolean,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(this.url('/api/mcp/toggle-tool'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverName, toolName, enabled }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `mcp toggle tool failed (${res.status})`)
    }
    return data
  }

  /** POST /api/mcp-toggle — enable/disable a server (TUI /mcps Space). */
  async mcpToggle(
    name: string,
    enabled: boolean,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(this.url('/api/mcp-toggle'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, enabled }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `mcp toggle failed (${res.status})`)
    }
    return data
  }

  /** POST /api/mcp-add — add a stdio MCP server (TUI /mcps a). */
  async mcpAdd(server: {
    name: string
    command: string
    args?: string[]
    env?: Record<string, string>
  }): Promise<Record<string, unknown>> {
    const res = await fetch(this.url('/api/mcp-add'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `mcp add failed (${res.status})`)
    }
    return data
  }

  /** POST /api/mcp-remove — remove a server (TUI /mcps x). */
  async mcpRemove(name: string): Promise<Record<string, unknown>> {
    const res = await fetch(this.url('/api/mcp-remove'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `mcp remove failed (${res.status})`)
    }
    return data
  }

  /**
   * Memory system — /dream (TUI /dream): memory consolidation. The FE
   * currently routes /dream through the prompt path (no wire method the
   * agent understands); this endpoint is reserved for when the host
   * implements memory consolidation directly. rawText is required by the
   * agent's rewrite contract (rawText + contextSummary).
   */
  async memoryRewrite(sessionId: string, rawText: string, contextSummary?: string) {
    const res = await fetch(this.url('/api/memory-rewrite'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        rawText,
        ...(contextSummary ? { contextSummary } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `memory rewrite failed (${res.status})`)
    }
    return data
  }

  /**
   * POST /api/mcp-auth-trigger — OAuth trigger for a server (TUI /mcps i).
   * May return `{ url, code }` / `{ url }` for the UI to surface.
   */
  async mcpAuthTrigger(name: string): Promise<Record<string, unknown>> {
    const res = await fetch(this.url('/api/mcp-auth-trigger'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `mcp auth failed (${res.status})`)
    }
    // The agent answers { status: authenticated|setup_required|failed,
    // setup?, error? }; unwrap the host's {ok, result} envelope and pass
    // the fields through (url/code kept for host implementations that
    // offer an OAuth link directly).
    const result =
      data.result && typeof data.result === 'object'
        ? (data.result as Record<string, unknown>)
        : {}
    return {
      ...(typeof result.status === 'string' && result.status
        ? { status: result.status }
        : {}),
      ...(result.setup && typeof result.setup === 'object'
        ? { setup: result.setup }
        : {}),
      ...(typeof result.error === 'string' && result.error
        ? { error: result.error }
        : {}),
      ...(typeof result.url === 'string' && result.url ? { url: result.url } : {}),
      ...(typeof result.code === 'string' && result.code ? { code: result.code } : {}),
    }
  }

  /**
   * GET /api/extensions — hooks / plugins / skills (host reads ~/.grok;
   * local-only). Arrays may be missing or envelope-wrapped; each entry is
   * parsed defensively (unknown fields dropped).
   */
  async extensions(): Promise<ExtensionsPayload> {
    const res = await fetch(this.url('/api/extensions'))
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `extensions failed (${res.status})`)
    }
    const hooks = (findArrayField(data, 'hooks') as Record<string, unknown>[])
      .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
      .map((h) => ({
        name: typeof h.name === 'string' ? h.name : '',
        ...(typeof h.command === 'string' && h.command ? { command: h.command } : {}),
        ...(typeof h.event === 'string' && h.event ? { event: h.event } : {}),
        ...(typeof h.enabled === 'boolean' ? { enabled: h.enabled } : {}),
      }))
      .filter((h) => h.name)
    const plugins = (findArrayField(data, 'plugins') as Record<string, unknown>[])
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .map((p) => ({
        name: typeof p.name === 'string' ? p.name : '',
        ...(typeof p.source === 'string' && p.source ? { source: p.source } : {}),
        ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}),
      }))
      .filter((p) => p.name)
    const skills = (findArrayField(data, 'skills') as Record<string, unknown>[])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => ({
        name: typeof s.name === 'string' ? s.name : '',
        ...(typeof s.scope === 'string' && s.scope ? { scope: s.scope } : {}),
        ...(typeof s.path === 'string' && s.path ? { path: s.path } : {}),
        ...(typeof s.enabled === 'boolean' ? { enabled: s.enabled } : {}),
      }))
      .filter((s) => s.name)
    return { hooks, plugins, skills }
  }

  /**
   * GET /api/settings — safe config.toml subset (read-only; TUI F2).
   * Groups may be absent; objects are dug out of envelopes defensively.
   */
  async settings(): Promise<SettingsPayload> {
    const res = await fetch(this.url('/api/settings'))
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `settings failed (${res.status})`)
    }
    return {
      ui: findObjectField(data, 'ui'),
      session: findObjectField(data, 'session'),
      models: findObjectField(data, 'models'),
      cli: findObjectField(data, 'cli'),
    }
  }

  // ── Terminals (x.ai/terminal/* — host /api/terminal/*) ──────────────
  // Host contract (http_ext2.go /api/terminal/* + grok-build
  // extensions/terminal.rs): every endpoint answers `{ok:true,
  // result:<agent raw result>}`; failures are HTTP errors or
  // `{ok:false, error}`. Output delivery is split:
  //  - piped (non-interactive) terminals → POLL /api/terminal/output
  //    (cumulative snapshot incl. exitStatus; no SSE push exists);
  //  - PTY terminals → `pty_notification` SSE events (host broadcasts
  //    x.ai/terminal/pty/notification as {type:'pty_notification',
  //    params:{terminalId, type: output|exit|process_started|
  //    process_ended, data?<base64>, outputOffset?, isReplay?,
  //    exitCode?, signal?}}). x.ai/terminal/output does NOT serve PTYs
  //    (the agent looks those up by terminal_id alone, in a different
  //    registry) — so interactive terminals are never polled.

  /** POST /api/terminal/list — live terminals (piped + PTY) of the session. */
  async terminalList(): Promise<{ terminals: TerminalInfo[] }> {
    const res = await fetch(this.url('/api/terminal/list'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `terminal list failed (${res.status})`)
    }
    const terminals = (findArrayField(data, 'terminals') as Record<string, unknown>[])
      .map(parseTerminalInfo)
      .filter((t) => t.terminalId)
    return { terminals }
  }

  /** POST /api/terminal/create — run `command` in a piped terminal. */
  async terminalCreate(params: {
    command: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    outputByteLimit?: number
  }): Promise<{ terminalId: string }> {
    const res = await fetch(this.url('/api/terminal/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `terminal create failed (${res.status})`)
    }
    const id = findField(data, 'terminalId')
    if (typeof id !== 'string' || !id) {
      throw new Error('terminal create: 响应缺少 terminalId')
    }
    return { terminalId: id }
  }

  /** POST /api/terminal/output — cumulative output snapshot (piped only). */
  async terminalOutput(terminalId: string): Promise<TerminalOutput> {
    const res = await fetch(this.url('/api/terminal/output'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `terminal output failed (${res.status})`)
    }
    const raw = findField(data, 'output')
    const esRaw = findField(data, 'exitStatus') ?? findField(data, 'exit_status')
    const es =
      esRaw && typeof esRaw === 'object' && !Array.isArray(esRaw)
        ? (esRaw as Record<string, unknown>)
        : undefined
    return {
      output: typeof raw === 'string' ? raw : '',
      truncated: findField(data, 'truncated') === true,
      ...(es
        ? {
            exitStatus: {
              ...(es.exitCode != null || es.exit_code != null
                ? { exitCode: ((es.exitCode ?? es.exit_code) as number) ?? null }
                : {}),
              ...(typeof es.signal === 'string' && es.signal ? { signal: es.signal } : {}),
            },
          }
        : {}),
    }
  }

  /** POST /api/terminal/kill — kill a terminal; outcome killed|already_exited. */
  async terminalKill(terminalId: string): Promise<{ outcome?: string }> {
    const res = await fetch(this.url('/api/terminal/kill'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `terminal kill failed (${res.status})`)
    }
    const outcome = findField(data, 'outcome')
    return outcome && typeof outcome === 'string' ? { outcome } : {}
  }

  /** POST /api/terminal/release — forget a terminal (kills a running child). */
  async terminalRelease(terminalId: string): Promise<void> {
    const res = await fetch(this.url('/api/terminal/release'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `terminal release failed (${res.status})`)
    }
  }

  /**
   * POST /api/terminal/background — mark a piped terminal backgrounded:
   * the process keeps running and the agent continues (TUI bg_task).
   */
  async terminalBackground(terminalId: string): Promise<void> {
    const res = await fetch(this.url('/api/terminal/background'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `terminal background failed (${res.status})`)
    }
  }

  /** POST /api/terminal/pty/create — interactive shell PTY (SSE-pushed output). */
  async terminalPtyCreate(params: {
    shell?: string
    cwd?: string
    sessionId?: string
    env?: Record<string, string>
    rows?: number
    cols?: number
    name?: string
    meta?: Record<string, unknown>
  }): Promise<{ terminalId: string }> {
    const res = await fetch(this.url('/api/terminal/pty/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `pty create failed (${res.status})`)
    }
    const id = findField(data, 'terminalId')
    if (typeof id !== 'string' || !id) {
      throw new Error('pty create: 响应缺少 terminalId')
    }
    return { terminalId: id }
  }

  /** POST /api/terminal/pty/resize — resize an interactive PTY. */
  async terminalPtyResize(terminalId: string, rows: number, cols: number): Promise<void> {
    const res = await fetch(this.url('/api/terminal/pty/resize'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId, rows, cols }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `pty resize failed (${res.status})`)
    }
  }

  /**
   * POST /api/terminal/pty/input — fire-and-forget `_x.ai/terminal/pty/input`
   * notification; `data` is base64 (raw bytes, UTF-8). Success answers
   * {ok:true, result} — nothing to return.
   */
  async terminalPtyInput(terminalId: string, data: string): Promise<void> {
    const res = await fetch(this.url('/api/terminal/pty/input'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId, data }),
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || body.ok === false) {
      throw new Error(
        typeof body.error === 'string' && body.error
          ? body.error
          : `pty input failed (${res.status})`,
      )
    }
  }
}

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

/** GET /api/extensions — one hook/plugin/skill row (canonical types). */
export type { ExtensionHook, ExtensionPlugin, ExtensionSkill } from './types'

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

/** One terminal row from x.ai/terminal/list (agent TerminalInfo, camelCase). */
export type TerminalInfo = {
  terminalId: string
  status: 'connecting' | 'connected' | 'exited' | 'error'
  interactive: boolean
  name?: string
  exitCode?: number | null
  cwd?: string
  /** Bytes consumed so far (cumulative). */
  outputOffset: number
  /** Unix seconds (agent SystemTime::as_secs). */
  createdAt: number
}

/** x.ai/terminal/output — cumulative snapshot for piped terminals. */
export type TerminalOutput = {
  output: string
  truncated: boolean
  exitStatus?: { exitCode?: number | null; signal?: string }
}

/** Parse one agent TerminalInfo (snake_case or camelCase wire fields). */
export function parseTerminalInfo(t: Record<string, unknown>): TerminalInfo {
  const id = t.terminal_id ?? t.terminalId
  const status = String(t.status ?? 'connecting')
  return {
    terminalId: id == null ? '' : String(id),
    status: (['connecting', 'connected', 'exited', 'error'] as const).includes(
      status as TerminalInfo['status'],
    )
      ? (status as TerminalInfo['status'])
      : 'connecting',
    interactive: t.interactive === true,
    ...(typeof t.name === 'string' && t.name ? { name: t.name } : {}),
    ...(t.exitCode != null || t.exit_code != null
      ? { exitCode: ((t.exitCode ?? t.exit_code) as number) ?? null }
      : {}),
    ...(typeof t.cwd === 'string' && t.cwd ? { cwd: t.cwd } : {}),
    outputOffset:
      typeof t.outputOffset === 'number'
        ? t.outputOffset
        : typeof t.output_offset === 'number'
          ? t.output_offset
          : 0,
    createdAt:
      typeof t.createdAt === 'number'
        ? t.createdAt
        : typeof t.created_at === 'number'
          ? t.created_at
          : 0,
  }
}

/**
 * Depth-first search for a `<key>: any` field in nested JSON (walks
 * `result` / `data` / `payload` envelopes — the `{ok, result:{result,
 * error}}` ExtMethodResult nesting included; any value type).
 */
function findField(root: unknown, key: string): unknown {
  const seen = new Set<unknown>()
  const walk = (v: unknown, depth: number): unknown => {
    if (v == null || depth > 6) return undefined
    if (typeof v !== 'object' || Array.isArray(v)) return undefined
    if (seen.has(v)) return undefined
    seen.add(v)
    const o = v as Record<string, unknown>
    if (key in o && o[key] !== undefined && o[key] !== null) return o[key]
    for (const k of ['result', 'data', 'payload']) {
      const found = walk(o[k], depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(root, 0)
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

/**
 * Depth-first search for a `<key>: object` field in nested JSON (walks
 * `result` / `data` / `payload` envelopes — GET responses may be wrapped).
 */
function findObjectField(
  root: unknown,
  key: string,
): Record<string, unknown> | undefined {
  const seen = new Set<unknown>()
  const walk = (v: unknown, depth: number): Record<string, unknown> | undefined => {
    if (v == null || depth > 6) return undefined
    if (typeof v !== 'object' || Array.isArray(v)) return undefined
    if (seen.has(v)) return undefined
    seen.add(v)
    const o = v as Record<string, unknown>
    if (o[key] && typeof o[key] === 'object' && !Array.isArray(o[key])) {
      return o[key] as Record<string, unknown>
    }
    for (const k of ['result', 'data', 'payload']) {
      const found = walk(o[k], depth + 1)
      if (found) return found
    }
    return undefined
  }
  return walk(root, 0)
}

/**
 * Unwrap the agent's ExtMethodResult envelope ({result: T, error?}) from
 * the host's {ok, result} passthrough. The envelope's `error` field is
 * skipped on success (serde skip_serializing_if), so presence of the
 * `result` key alone identifies the envelope; a non-null `error` throws.
 * A legacy flat payload (no `result` key) passes through untouched.
 */
function unwrapExtResult<T>(raw: unknown): T {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>
    if ('result' in o) {
      if (o.error != null && o.error !== false && o.error !== '') {
        throw new Error(
          typeof o.error === 'string' ? o.error : JSON.stringify(o.error),
        )
      }
      if (o.result != null) return o.result as T
    }
  }
  return raw as T
}

export const transport = new LocalTransport()
