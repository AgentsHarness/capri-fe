import type { TransportCore } from '../transport'
import { AccessTokenError, AgentTurnError, PrefsConflictError } from '../transport'
import { assertRpcOk, findArrayField, readRpcJson, unwrapExtResult, xaiCall } from './core'
import type { ContentBlock, HostInfo, HubPrefsDoc, PermissionScope } from '../types'

/**
 * POST /api/prompt 的超时上限（受理即返回后实际毫秒级；旧 host 阻塞式
 * 回合最长 30min）。调用方可按需用 prompt({ timeoutMs }) 覆盖。
 */
const PROMPT_TIMEOUT_MS = 30 * 60_000

export const miscRpc = {
  /**
   * POST /api/prompt — host 已改为"受理即返回"：校验通过（含显式会话
   * 存在性）立即回 200 {ok:true}，不再等到回合结束。回合结果（成功 /
   * 失败 / 取消 + meta）全部经 live 通道（SSE/WS）的 done / error /
   * cancelled 事件送达，本响应不再携带 stopReason/meta（旧 host 才会在
   * 响应里透传 session/prompt 的 `_meta`，这里保留解析兼容）。
   *
   * `sessionId`（可选，缺省 = host 的 active 会话）：按会话发 prompt。
   * host bridge 是多会话的——带着目标 sessionId 的 prompt 会在那个会话
   * 里跑（可与当前 active 会话的回合并行），用于后台队列投递。
   *
   * `promptId`（可选，server-authoritative 队列）：有则作为 HTTP body
   * 的 `meta.promptId` 发出（host `promptBody.Meta` json:"meta"；host 再
   * 把它写成 agent 侧 session/prompt 的 `_meta.promptId`）。agent 从
   * promptId 提取 queue_meta 插进权威队列（busy 排队、回合结束自动 pop；
   * idle 直接运行），经 x.ai/queue/changed 广播回显。TUI pager 同款
   * wire（prompt_request_meta）。注意：HTTP 层键名是 `meta`（不是
   * `_meta`）——错写成 `_meta` 会被 host 静默丢弃，agent 自造 id，本地
   * 乐观行与广播行对不上就会在队列里显示成两条。旧 host 忽略该字段；
   * busy 时仍可能 409（竞态）——调用方（promptQueue.enqueue）渲染错误
   * 行、行保留手动重发（legacy 降级自动重发已移除）。
   *
   * 失败分类：新 host 下本响应只携带"受理前"的错误——参数校验 400、
   * 显式未知会话 404、网络级失败（fetch 拒绝 = host 不可达，保持普通
   * Error）。回合级失败（agent 拒绝如模型 API 400、传输中断）不再走
   * HTTP，由 live 通道的 error 事件（带 sessionId + source）送达。
   * 例外：旧 host（阻塞到回合结束）仍可能返回反代超时（524 Cloudflare /
   * 504 nginx / 408）——抛 AgentTurnError，store 依据 status 识别并走
   * live 通道兜底（不渲染错误行）。
   */
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

  /**
   * Cancel the running turn (POST /api/cancel). The agent defaults
   * `_meta.cancelSubagents` to TRUE when the flag is absent — a bare
   * cancel would silently stop every running subagent. Like the TUI
   * (xai-grok-pager always serializes the flag on session/cancel), the
   * FE sends it explicitly: `true` stops subagents too (cancel panel
   * "Stop running" / rewind), `false` keeps them running (send-now,
   * Ctrl+C, "Always continue" preference).
   */
  async cancel(this: TransportCore, opts: { cancelSubagents?: boolean } = {}, sessionId?: string): Promise<void> {
    const res = await this.fetch(this.url('/api/cancel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cancelSubagents: opts.cancelSubagents ?? false,
        // 可选：指定目标会话（缺省 = host active 会话）。
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    const data = await readRpcJson(res)
    // Empty/invalid success bodies remain valid for this command-style RPC;
    // non-2xx and explicit {ok:false} responses must still reach callers.
    assertRpcOk(res, data, 'cancel failed')
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
    // hubLevel：host 列表是 hub 级数据（不带 ?host=），与选中 host
    // 无关——host 切换的 abort 风暴（setHost → abortInflight）不能打断
    // 它，否则 hosts_changed 广播触发的 refreshHosts 会静默失败、列表
    // 不更新；StrictMode 双挂载的 disconnect 同样不能 abort 它。
    const res = await this.fetch(`${this.apiBase()}/api/hosts`, {}, { hubLevel: true })
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

  /**
   * POST /api/agent-restart — 用户显式重启当前选中 host 的 agent
   * 进程：杀旧进程、清 host 状态、重新 boot、恢复上次会话。host 从不
   * 自动重启 agent（假设 agent 可靠，传输/扫描失败只报错）——这是
   * 唯一的重启通道。mode-aware：local 模式同源本机；hub 模式经
   * ?host= 中继到选中 host。
   * 杀进程 + boot（host 侧 2min 上限）+ 恢复会话可能超过默认 30s
   * fetch 超时，这里给足 120s。在飞回合会被中断且不重试。
   */
  async restartAgent(this: TransportCore): Promise<void> {
    const res = await this.fetch(
      this.url('/api/agent-restart'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      { timeoutMs: 120_000 },
    )
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
          : `agent restart failed (${res.status})`,
      )
    }
  },

  /**
   * GET /api/prefs — 拉取置顶/待办文档 + 当前版本（版本是 PUT 条件
   * 写入的 base；旧 hub 不带 version 字段 → undefined，调用方退回
   * 无条件写）。
   */
  async getPrefs(this: TransportCore): Promise<{ prefs: HubPrefsDoc; version?: number }> {
    const origin = this.prefsOrigin()
    if (!origin) throw new Error('仅 Hub 模式支持置顶/待办持久化')
    // hubLevel：hub 级请求，不参与 host 切换的 abortInflight 风暴——
    // 否则启动时与 refreshHosts（自动选中 host → setHost → abort）并发
    // 的 prefs 拉取每次都被中止，置顶/待办永远同步不过来。
    const res = await this.fetch(`${origin}/api/prefs`, {}, { hubLevel: true })
    const data = (await res.json().catch(() => ({}))) as {
      prefs?: HubPrefsDoc
      version?: number
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
        typeof data.error === 'string' && data.error ? data.error : `prefs read failed (${res.status})`,
      )
    }
    return {
      prefs: data.prefs ?? {},
      version: typeof data.version === 'number' ? data.version : undefined,
    }
  },

  /**
   * PUT /api/prefs {prefs, baseVersion?} — 全量替换置顶/待办文档。
   * baseVersion（新 hub）使写入成为条件写：版本过旧时 hub 回 409 +
   * 当前文档（抛 PrefsConflictError，调用方重放待推操作后重试）；
   * 不带 baseVersion 为无条件写（旧 hub / 旧 FE 兼容）。成功响应带
   * 新版本。
   */
  async putPrefs(
    this: TransportCore,
    prefs: HubPrefsDoc,
    baseVersion?: number,
  ): Promise<{ version?: number }> {
    const origin = this.prefsOrigin()
    if (!origin) throw new Error('仅 Hub 模式支持置顶/待办持久化')
    const body: Record<string, unknown> = { prefs }
    if (baseVersion != null) body.baseVersion = baseVersion
    const res = await this.fetch(
      `${origin}/api/prefs`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      // hubLevel：同上，回写不被 host 切换的 abort 风暴打断。
      { hubLevel: true },
    )
    const data = (await res.json().catch(() => ({}))) as {
      error?: string
      ok?: boolean
      version?: number
      prefs?: HubPrefsDoc
    }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
      )
    }
    if (res.status === 409) {
      throw new PrefsConflictError(
        typeof data.error === 'string' && data.error ? data.error : '置顶/待办版本冲突',
        typeof data.version === 'number' ? data.version : undefined,
        data.prefs,
      )
    }
    if (!res.ok || data.ok === false) {
      throw new Error(
        typeof data.error === 'string' && data.error ? data.error : `prefs write failed (${res.status})`,
      )
    }
    return { version: typeof data.version === 'number' ? data.version : undefined }
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
    const data = await readRpcJson(res)
    assertRpcOk(res, data, 'subagent cancel failed')
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
    const data = await readRpcJson(res)
    assertRpcOk(res, data, 'task kill failed')
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

  /**
   * POST /api/search/content — workspace file content search (agent
   * `x.ai/search/content`, ripgrep). Body passes through flat: the host
   * forwards verbatim per the agent's ContentSearchRequest flatten
   * convention (camelCase: pattern / caseInsensitive / isRegex /
   * includeGlobs / excludeGlobs / maxMatches / maxFiles …). Result:
   * {files: [{name, path, matches: [{line, content, matchStart?,
   * matchEnd?}]}], totalMatches, totalFiles, truncated}.
   */
  async searchContent(this: TransportCore, opts: {
    pattern: string
    cwd?: string
    sessionId?: string
    caseInsensitive?: boolean
    wholeWord?: boolean
    isRegex?: boolean
    includeGlobs?: string[]
    excludeGlobs?: string[]
    maxMatches?: number
    maxFiles?: number
  }): Promise<unknown> {
    const body: Record<string, unknown> = { pattern: opts.pattern }
    if (opts.cwd) body.cwd = opts.cwd
    if (opts.sessionId) body.sessionId = opts.sessionId
    if (opts.caseInsensitive !== undefined) body.caseInsensitive = opts.caseInsensitive
    if (opts.wholeWord !== undefined) body.wholeWord = opts.wholeWord
    if (opts.isRegex !== undefined) body.isRegex = opts.isRegex
    if (opts.includeGlobs?.length) body.includeGlobs = opts.includeGlobs
    if (opts.excludeGlobs?.length) body.excludeGlobs = opts.excludeGlobs
    if (opts.maxMatches !== undefined) body.maxMatches = opts.maxMatches
    if (opts.maxFiles !== undefined) body.maxFiles = opts.maxFiles
    return unwrapExtResult(await xaiCall(this, '/api/search/content', body))
  },

  /**
   * POST /api/search/fuzzy/{open,change,close} — fuzzy file search
   * (agent `x.ai/search/fuzzy/*`). Results do NOT ride the change
   * response: the workspace streams full match snapshots per generation
   * via the `search_fuzzy_status` SSE event until `done`. change requires
   * a non-empty query (host 400s otherwise).
   */
  async searchFuzzyOpen(
    this: TransportCore,
    opts: { cwd?: string; root?: string } = {},
  ): Promise<{ sessionId?: string; searchId?: string }> {
    const body: Record<string, unknown> = {}
    if (opts.cwd) body.cwd = opts.cwd
    if (opts.root) body.root = opts.root
    return unwrapExtResult(await xaiCall(this, '/api/search/fuzzy/open', body))
  },

  async searchFuzzyChange(this: TransportCore, opts: {
    searchId: string
    query: string
    dirsOnly?: boolean
    limit?: number
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      searchId: opts.searchId,
      query: opts.query,
      dirsOnly: opts.dirsOnly ?? false,
    }
    if (opts.limit !== undefined) body.limit = opts.limit
    return unwrapExtResult(await xaiCall(this, '/api/search/fuzzy/change', body))
  },

  async searchFuzzyClose(this: TransportCore, opts: {
    searchId: string
  }): Promise<{ closed?: boolean } | undefined> {
    return unwrapExtResult(
      await xaiCall(this, '/api/search/fuzzy/close', { searchId: opts.searchId }),
    )
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
