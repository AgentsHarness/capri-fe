import type { TransportCore } from '../transport'
import { AccessTokenError, AgentTurnError } from '../transport'
import { findArrayField, unwrapExtResult, xaiCall } from './core'
import type { ContentBlock, HostInfo, HubPrefsDoc, PermissionScope } from '../types'

/**
 * POST /api/prompt 的超时上限（受理即返回后实际毫秒级；旧 host 阻塞式
 * 回合最长 30min）。调用方可按需用 prompt({ timeoutMs }) 覆盖。
 */
const PROMPT_TIMEOUT_MS = 30 * 60_000

/**
 * misc — RPC 命令发送（api/rpc/，经 Object.assign 挂到
 * LocalTransport.prototype；方法内 `this` 即 TransportCore）。
 */
export const miscRpc = {
  async prompt(this: TransportCore, 
    blocks: ContentBlock[],
    opts: { sessionId?: string; timeoutMs?: number; promptId?: string } = {},
  ): Promise<{ stopReason?: string; meta?: Record<string, unknown> }> {
    const body: Record<string, unknown> = { blocks }
    if (opts.sessionId) body.sessionId = opts.sessionId
    // Host JSON 键是 `meta`（http.go promptBody），再转发为 agent `_meta`。
    if (opts.promptId) body.meta = { promptId: opts.promptId }
    const res = await this.fetch(
      this.url('/api/prompt'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      // 受理响应毫秒级返回；30min 上限只兜底死 relay（旧 host 阻塞到
      // 回合结束，最长 30min，也不会被误杀）。调用方可按需覆盖。
      { timeoutMs: opts.timeoutMs ?? PROMPT_TIMEOUT_MS },
    )
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || data.ok === false) {
      // 三档 wire 约定（host writeAgentError）：
      //   200 + {ok:false, error}            → agent 拒绝了请求（RPCError）
      //   502 + {ok:false, error}            → agent 不可达（传输级失败）
      //   其余非 2xx（400/404/409/500）       → host 语义/内部错误
      // 全部说明 host 活着 → 回合级错误；只有 fetch 网络拒绝才是 host 级。
      throw new AgentTurnError(
        res.status === 502 ? 'unreachable' : 'rejected',
        typeof data.error === 'string' && data.error
          ? data.error
          : `prompt failed (${res.status})`,
        res.status,
      )
    }
    const out: { stopReason?: string; meta?: Record<string, unknown> } = {}
    if (typeof data.stopReason === 'string') out.stopReason = data.stopReason
    if (
      data.meta &&
      typeof data.meta === 'object' &&
      !Array.isArray(data.meta) &&
      Object.keys(data.meta as Record<string, unknown>).length > 0
    ) {
      out.meta = data.meta as Record<string, unknown>
    }
    return out
  },

  async cancel(this: TransportCore, opts: { cancelSubagents?: boolean } = {}, sessionId?: string): Promise<void> {
    await this.fetch(this.url('/api/cancel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cancelSubagents: opts.cancelSubagents ?? false,
        // 可选：指定目标会话（缺省 = host active 会话）。
        ...(sessionId ? { sessionId } : {}),
      }),
    })
  },

  async respondPermission(this: TransportCore, 
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
    const res = await this.fetch(this.url('/api/permission-response'), {
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
  },

  async respondClientRequest(this: TransportCore, requestId: string, result?: Record<string, unknown>, error?: string) {
    const res = await this.fetch(this.url('/api/client-response'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, result, error }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'client response failed')
  },

  async newSession(this: TransportCore, config: {
    cwd?: string
    additionalDirectories?: string[]
    mcpServers?: unknown[]
    /** Permission-mode seeds (TUI's yoloMode/autoMode) → session/new `_meta`. */
    meta?: Record<string, unknown>
  } = {}) {
    const res = await this.fetch(this.url('/api/session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'session failed')
    return data
  },

  async listHosts(this: TransportCore): Promise<{ hosts: HostInfo[]; defaultHostId?: string }> {
    const res = await this.fetch(`${this.apiBase()}/api/hosts`)
    const data = (await res.json().catch(() => ({}))) as {
      hosts?: HostInfo[]
      defaultHostId?: string
      error?: string
      ok?: boolean
    }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error
          ? data.error
          : '需要有效的访问 token',
      )
    }
    if (!res.ok) {
      throw new Error(
        typeof data.error === 'string' && data.error
          ? data.error
          : `hosts failed (${res.status})`,
      )
    }
    return { hosts: data.hosts ?? [], defaultHostId: data.defaultHostId }
  },

  async pairingCode(this: TransportCore): Promise<{ code: string; expiresAt?: string; ttl?: number }> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持查看配对码')
    const res = await this.fetch(`${this.apiBase()}/api/pairing`)
    const data = (await res.json().catch(() => ({}))) as {
      code?: string
      expiresAt?: string
      ttl?: number
      error?: string
      ok?: boolean
    }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
      )
    }
    if (!res.ok || !data.code) {
      throw new Error(
        typeof data.error === 'string' && data.error
          ? data.error
          : `pairing failed (${res.status})`,
      )
    }
    return { code: data.code, expiresAt: data.expiresAt, ttl: data.ttl }
  },

  async rotatePairingCode(this: TransportCore): Promise<{ code: string; expiresAt?: string }> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持轮换配对码')
    const res = await this.fetch(`${this.apiBase()}/api/pairing/rotate`, { method: 'POST' })
    const data = (await res.json().catch(() => ({}))) as {
      code?: string
      expiresAt?: string
      error?: string
      ok?: boolean
    }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
      )
    }
    if (!res.ok || !data.code) {
      throw new Error(
        typeof data.error === 'string' && data.error
          ? data.error
          : `rotate failed (${res.status})`,
      )
    }
    return { code: data.code, expiresAt: data.expiresAt }
  },

  async renameHost(this: TransportCore, hostId: string, hostName: string): Promise<void> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持修改 Host')
    const res = await this.fetch(`${this.apiBase()}/api/hosts/${encodeURIComponent(hostId)}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostName }),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
      )
    }
    if (!res.ok || data.ok === false) {
      throw new Error(
        typeof data.error === 'string' && data.error
          ? data.error
          : `rename failed (${res.status})`,
      )
    }
  },

  async unpairHost(this: TransportCore, hostId: string): Promise<void> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持删除 Host')
    const res = await this.fetch(`${this.apiBase()}/api/hosts/${encodeURIComponent(hostId)}`, {
      method: 'DELETE',
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
      )
    }
    if (!res.ok || data.ok === false) {
      throw new Error(
        typeof data.error === 'string' && data.error
          ? data.error
          : `unpair failed (${res.status})`,
      )
    }
  },

  async getPrefs(this: TransportCore): Promise<HubPrefsDoc> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持置顶/待办持久化')
    const res = await this.fetch(`${this.apiBase()}/api/prefs`)
    const data = (await res.json().catch(() => ({}))) as {
      prefs?: HubPrefsDoc
      error?: string
      ok?: boolean
    }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
      )
    }
    if (!res.ok || data.ok === false) {
      throw new Error(
        typeof data.error === 'string' && data.error
          ? data.error
          : `prefs read failed (${res.status})`,
      )
    }
    return data.prefs ?? {}
  },

  async putPrefs(this: TransportCore, prefs: HubPrefsDoc): Promise<void> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持置顶/待办持久化')
    const res = await this.fetch(`${this.apiBase()}/api/prefs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs }),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
      )
    }
    if (!res.ok || data.ok === false) {
      throw new Error(
        typeof data.error === 'string' && data.error
          ? data.error
          : `prefs write failed (${res.status})`,
      )
    }
  },

  async billing(this: TransportCore, sessionId?: string): Promise<import('../types').BillingConfigResponse> {
    const res = await this.fetch(this.url('/api/billing'), {
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
  },

  async usageReport(this: TransportCore, 
    opts: { cwd?: string; sessionId?: string; from?: number; to?: number } = {},
  ): Promise<import('../types').UsageReportData> {
    const res = await this.fetch(this.url('/api/usage-report'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `usage report failed (${res.status})`)
    }
    const result = data.result ?? {}
    return result && typeof result === 'object' ? result : {}
  },

  async goalSet(this: TransportCore, objective: string, tokenBudget?: number, sessionId?: string) {
    const res = await this.fetch(this.url('/api/goal/set'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective,
        ...(tokenBudget && tokenBudget > 0 ? { tokenBudget } : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'goal set failed')
    return data
  },

  async goalStatus(this: TransportCore, sessionId?: string) {
    const res = await this.fetch(this.url('/api/goal/status'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'goal status failed')
    return data
  },

  async goalPause(this: TransportCore, sessionId?: string) {
    const res = await this.fetch(this.url('/api/goal/pause'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'goal pause failed')
    return data
  },

  async goalResume(this: TransportCore, sessionId?: string) {
    const res = await this.fetch(this.url('/api/goal/resume'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'goal resume failed')
    return data
  },

  async goalClear(this: TransportCore, sessionId?: string) {
    const res = await this.fetch(this.url('/api/goal/clear'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'goal clear failed')
    return data
  },

  async cancelSubagent(this: TransportCore, subagentId: string, sessionId?: string) {
    const res = await this.fetch(this.url('/api/subagent-cancel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subagentId,
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'subagent cancel failed')
    return data
  },

  async killTask(this: TransportCore, taskId: string, sessionId?: string) {
    const res = await this.fetch(this.url('/api/task-kill'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'task kill failed')
    return data
  },

  async listTasks(this: TransportCore): Promise<
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
    const res = await this.fetch(this.url('/api/task-list'), {
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
      .map((t) => parseTaskSnap(t))
      .filter((t) => t.taskId)
  },

  async taskOutput(this: TransportCore, 
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
    const res = await this.fetch(this.url('/api/task-output'), {
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
    return parseTaskSnap((data.task ?? {}) as Record<string, unknown>, taskId)
  },

  async setMode(this: TransportCore, modeId: string, sessionId?: string) {
    const res = await this.fetch(this.url('/api/set-mode'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modeId,
        // 可选：目标会话（缺省 = host active 会话；permission 模式分支
        // 在 host 侧仍是全局 yolo_mode_changed 语义）。
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'set mode failed')
    return data
  },

  async togglePlanMode(this: TransportCore, 
    sessionId?: string,
  ): Promise<{ ok?: boolean; planMode?: boolean }> {
    const res = await this.fetch(this.url('/api/toggle-plan-mode'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'toggle plan mode failed')
    }
    return data
  },

  async permissionsReset(this: TransportCore, sessionId?: string): Promise<void> {
    const res = await this.fetch(this.url('/api/permissions-reset'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'permissions reset failed')
    }
  },

  async queueRemove(this: TransportCore, 
    opts: { id: string; expectedVersion?: number },
    sessionId?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { id: opts.id }
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== 0) {
      body.expectedVersion = opts.expectedVersion
    }
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/remove', body)
  },

  async queueClear(this: TransportCore, sessionId?: string): Promise<void> {
    const body: Record<string, unknown> = {}
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/clear', body)
  },

  async queueReorder(this: TransportCore, opts: { ids: string[] }, sessionId?: string): Promise<void> {
    const body: Record<string, unknown> = {}
    if (opts.ids.length > 0) body.ids = opts.ids
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/reorder', body)
  },

  async queueEdit(this: TransportCore, 
    opts: { id: string; newText: string },
    sessionId?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { id: opts.id, newText: opts.newText }
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/edit', body)
  },

  async queueInterject(this: TransportCore, 
    opts: {
      id: string
      newText?: string
      expectedVersion?: number
    },
    sessionId?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { id: opts.id }
    if (opts.newText) body.newText = opts.newText
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== 0) {
      body.expectedVersion = opts.expectedVersion
    }
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/interject', body)
  },

  async queueHoldEdit(this: TransportCore, opts: { id: string }, sessionId?: string): Promise<void> {
    const body: Record<string, unknown> = { id: opts.id }
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/hold-edit', body)
  },

  async queueReleaseEdit(this: TransportCore, opts: { id: string }, sessionId?: string): Promise<void> {
    const body: Record<string, unknown> = { id: opts.id }
    if (sessionId) body.sessionId = sessionId
    await xaiCall(this, '/api/queue/release-edit', body)
  },

  async queueStatus(this: TransportCore, 
    sessionId: string,
    cwd: string,
  ): Promise<{ queue?: Record<string, unknown> | null }> {
    const res = await this.fetch(this.url('/api/queue/status'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `queue status failed (${res.status})`)
    }
    return data
  },

  async btw(this: TransportCore, opts: { question: string }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/btw', opts))
  },

  async interject(this: TransportCore, opts: { text: string }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/interject', opts))
  },

  async suggest(this: TransportCore, opts: {
    text: string
    cwd?: string
    cursor?: number
    limit?: number
    generation?: number
    includeAi?: boolean
    aiModel?: string
    tokenOnly?: boolean
  }): Promise<unknown> {
    const body: Record<string, unknown> = { text: opts.text }
    if (opts.cwd) body.cwd = opts.cwd
    if (opts.cursor !== undefined) body.cursor = opts.cursor
    if (opts.limit !== undefined) body.limit = opts.limit
    if (opts.generation !== undefined) body.generation = opts.generation
    if (opts.includeAi !== undefined) body.includeAi = opts.includeAi
    if (opts.aiModel) body.aiModel = opts.aiModel
    if (opts.tokenOnly !== undefined) body.tokenOnly = opts.tokenOnly
    return unwrapExtResult(await xaiCall(this, '/api/suggest', body))
  },

  async suggestPrompt(this: TransportCore, opts: { generation?: number } = {}): Promise<unknown> {
    const body: Record<string, unknown> = {}
    if (opts.generation !== undefined) body.generation = opts.generation
    return unwrapExtResult(await xaiCall(this, '/api/suggest-prompt', body))
  },

  async xaiCallGeneric(this: TransportCore, opts: {
    method: string
    params?: Record<string, unknown>
  }): Promise<unknown> {
    const body: Record<string, unknown> = { method: opts.method }
    if (opts.params) body.params = opts.params
    return unwrapExtResult(await xaiCall(this, '/api/xai-call', body))
  }
}

function parseTaskSnap(
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
