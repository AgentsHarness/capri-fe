import type { TransportCore } from '../transport'
import type { SessionHistoryDetail, SessionHistoryPage, SessionHistoryProjected } from '../types'
import { assertRpcOk, findArrayField, findObjectField, pickSummaryActivityAt, readRpcJson, requireRpcObject, unwrapExtResult, xaiCall } from './core'
import type {
  HostStatus,
  RewindMode,
  RewindPoint,
  SessionInfo,
  SessionInfoDetail,
  SessionState,
  SessionStats,
  SessionUsageData,
  WorkspaceGroup,
  WorkspaceSummary,
} from '../types'

/**
 * 解析一条 session summary 的 wire 对象（workspace-list 与
 * workspace-list-recent 共用）。无有效 id 返回 null（跳过该行）。
 * 无 session_summary 时不设 title：列表 UI 按无标题渲染
 * （"New Chat" + 右侧 12 位 id 前缀），而不是把 id 前缀冒充成标题
 * 塞进左侧。
 */
function parseSummaryRow(o: Record<string, unknown>, fallbackCwd: string): WorkspaceSummary | null {
  const info =
    o.info && typeof o.info === 'object' && !Array.isArray(o.info)
      ? (o.info as Record<string, unknown>)
      : {}
  const id =
    (typeof info.id === 'string' && info.id) ||
    (typeof o.session_id === 'string' && o.session_id) ||
    (typeof o.sessionId === 'string' && o.sessionId) ||
    ''
  if (!id) return null
  const summary =
    (typeof o.session_summary === 'string' && o.session_summary.trim()) ||
    (typeof o.sessionSummary === 'string' && o.sessionSummary.trim()) ||
    ''
  // TUI session_picker: last_active_at.unwrap_or(updated_at).
  const activityAt = pickSummaryActivityAt(o)
  return {
    sessionId: id,
    cwd: (typeof info.cwd === 'string' && info.cwd) || fallbackCwd,
    ...(summary ? { title: summary } : {}),
    ...(typeof o.last_turn_summary === 'string' && o.last_turn_summary.trim()
      ? { lastTurnSummary: o.last_turn_summary.trim() }
      : typeof o.lastTurnSummary === 'string' && o.lastTurnSummary.trim()
        ? { lastTurnSummary: o.lastTurnSummary.trim() }
        : {}),
    ...(activityAt ? { updatedAt: activityAt } : {}),
    ...(typeof o.current_model_id === 'string' && o.current_model_id
      ? { currentModelId: o.current_model_id }
      : typeof o.currentModelId === 'string' && o.currentModelId
        ? { currentModelId: o.currentModelId }
        : {}),
    // 持久化的 reasoning_effort（agent summary）—— load 响应
    // models 缺 effort 时用它恢复用户原选档位。
    ...(typeof o.reasoning_effort === 'string' && o.reasoning_effort.trim()
      ? { reasoningEffort: o.reasoning_effort.trim() }
      : typeof o.reasoningEffort === 'string' && o.reasoningEffort.trim()
        ? { reasoningEffort: o.reasoningEffort.trim() }
        : {}),
    ...(typeof o.num_messages === 'number' && Number.isFinite(o.num_messages)
      ? { numMessages: o.num_messages }
      : typeof o.numMessages === 'number' && Number.isFinite(o.numMessages)
        ? { numMessages: o.numMessages }
        : {}),
  }
}

export const sessionsRpc = {
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

  async listSessions(this: TransportCore): Promise<{ sessions: SessionInfo[]; nextCursor?: string; meta?: Record<string, unknown> }> {
    const res = await this.fetch(this.url('/api/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const raw = await readRpcJson(res)
    assertRpcOk(res, raw, 'sessions failed')
    const data = requireRpcObject(raw, '/api/sessions', res.status)
    const out: { sessions: SessionInfo[]; nextCursor?: string; meta?: Record<string, unknown> } = {
      sessions: Array.isArray(data.sessions) ? (data.sessions as SessionInfo[]) : [],
    }
    // 防御性解析：nextCursor 仅字符串时带上；meta 仅 object 时带上。
    if (typeof data.nextCursor === 'string') out.nextCursor = data.nextCursor
    if (data.meta && typeof data.meta === 'object' && !Array.isArray(data.meta)) {
      out.meta = data.meta as Record<string, unknown>
    }
    return out
  },

  async workspaceList(this: TransportCore): Promise<WorkspaceGroup[]> {
    const res = await this.fetch(this.url('/api/session-summaries/workspace-list'), {
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
        const row = parseSummaryRow(s as Record<string, unknown>, cwd)
        if (row) sessions.push(row)
      }
      if (sessions.length > 0) groups.push({ cwd, label: cwd, sessions })
    }
    return groups
  },

  /**
   * POST /api/session-summaries/workspace-list-recent {limit} — 全部
   * workspace 中最近修改的 limit 个会话摘要（agent 按 last_active_at /
   * updated_at 排序；顶层是扁平数组，与 workspace-list 的按 cwd 分组
   * 结构不同，这里按 cwd 重新分组并保持 recent 顺序）。返回
   * { groups, count }：count = 实际返回条数（< limit 即没有更多）。
   */
  async workspaceListRecent(
    this: TransportCore,
    limit: number,
  ): Promise<{ groups: WorkspaceGroup[]; count: number }> {
    const raw = unwrapExtResult(
      await xaiCall(this, '/api/session-summaries/workspace-list-recent', { limit }),
    )
    // 防御：老 agent 没有该 ext 方法时返回空对象而非数组——按失败处理，
    // 让调用方走降级路径（全量 workspace-list），避免把现有列表清空。
    if (!Array.isArray(raw)) {
      throw new Error('workspace list recent: result is not an array')
    }
    const rows: WorkspaceSummary[] = []
    if (Array.isArray(raw)) {
      for (const s of raw) {
        if (!s || typeof s !== 'object') continue
        const row = parseSummaryRow(s as Record<string, unknown>, '')
        if (row) rows.push(row)
      }
    }
    const groups: WorkspaceGroup[] = []
    const byCwd = new Map<string, WorkspaceGroup>()
    for (const row of rows) {
      let g = byCwd.get(row.cwd)
      if (!g) {
        g = { cwd: row.cwd, label: row.cwd, sessions: [] }
        byCwd.set(row.cwd, g)
        groups.push(g)
      }
      g.sessions.push(row)
    }
    return { groups, count: rows.length }
  },

  async loadSession(this: TransportCore, 
    sessionId: string,
    cwd: string,
    meta?: Record<string, unknown>,
  ): Promise<{
    models?: unknown
    modes?: unknown
    configOptions?: unknown
    busy?: boolean
  }> {
    const res = await this.fetch(this.url('/api/session-load'), {
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
  },

  /**
   * POST /api/session-updates — 一页历史信封。`detail` 见
   * {@link SessionHistoryDetail}：缺省 = full = 信封逐字节原样（今天的
   * 行为），lite 只裁工具正文，meta 不回 updates 键。
   */
  async loadSessionHistory(this: TransportCore,
    sessionId: string,
    cwd: string,
    opts: {
      offset?: number
      limit?: number
      turnIndex?: number
      detail?: SessionHistoryDetail
    } = {},
  ): Promise<SessionHistoryPage> {
    const res = await this.fetch(this.url('/api/session-updates'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd, ...opts }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `history failed (${res.status})`)
    }
    // projected / omittedBytes 是能力回显而非权威数据：非约定取值一律按
    // 「旧 host 不支持」处理（丢字段），调用方据此降级 full。原键先剥掉，
    // 免得非法值穿透进类型化结果。
    const {
      projected: rawProjected,
      omittedBytes: rawOmitted,
      promptPreviews: rawPreviews,
      ...rest
    } = data
    const projected =
      rawProjected === 'lite' || rawProjected === 'meta'
        ? (rawProjected as SessionHistoryProjected)
        : undefined
    const omittedBytes =
      typeof rawOmitted === 'number' && Number.isFinite(rawOmitted) ? rawOmitted : undefined
    // promptPreviews 是展示元数据（轮次目录）：非纯字符串数组一律按缺失
    // 处理（旧 host / 透传路径不带该键，FE 回退为已加载轮目录）。
    const promptPreviews = Array.isArray(rawPreviews)
      ? rawPreviews.filter((p): p is string => typeof p === 'string')
      : undefined
    return {
      ...rest,
      ...(projected ? { projected } : {}),
      ...(omittedBytes != null ? { omittedBytes } : {}),
      ...(promptPreviews ? { promptPreviews } : {}),
    }
  },

  async sessionRunningTasks(this: TransportCore, 
    sessionId: string,
    cwd: string,
  ): Promise<{ events?: import('../types').TaskTimelineEvent[] }> {
    const res = await this.fetch(this.url('/api/session-running-tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `running tasks failed (${res.status})`)
    }
    return data
  },

  async status(this: TransportCore): Promise<HostStatus> {
    const res = await this.fetch(this.url('/api/status'))
    const raw = await readRpcJson(res)
    assertRpcOk(res, raw, 'status failed')
    return requireRpcObject(raw, '/api/status', res.status) as HostStatus
  },

  async sessionInfo(this: TransportCore, sessionId?: string): Promise<SessionInfoDetail> {
    const res = await this.fetch(this.url('/api/session-info'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 可选：目标会话（缺省 = host active 会话）。
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `session info failed (${res.status})`)
    }
    // Host wraps the payload in { ok, session: {...} } — same convention as
    // /api/sessions (data.sessions). Unwrap so the fields land on the
    // SessionInfoDetail shape.
    return (data.session ?? data) as SessionInfoDetail
  },

  /**
   * plan 模式的 plan.md 正文（host 直读 agent 写在会话目录里的同一个文件，
   * TUI /view-plan 的数据源）。没有 plan 时返回空串；旧 host 无此端点 →
   * 抛错，调用方回退到滚动区/审批请求里的 plan 正文。
   */
  async sessionPlan(this: TransportCore, sessionId: string, cwd: string): Promise<string> {
    const res = await this.fetch(this.url('/api/session-plan'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `session plan failed (${res.status})`)
    }
    return typeof data.content === 'string' ? data.content : ''
  },

  async forkSession(this: TransportCore, params: Record<string, unknown> = {}, sessionId?: string) {
    const res = await this.fetch(this.url('/api/session-fork'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...params,
        // 可选：源会话（缺省 = host active 会话）。
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'fork failed')
    return data
  },

  async renameSession(this: TransportCore, title: string, sessionId?: string) {
    const res = await this.fetch(this.url('/api/session-rename'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'rename failed')
    return data
  },

  async recap(this: TransportCore, auto = false, sessionId?: string) {
    const res = await this.fetch(this.url('/api/recap'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auto,
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'recap failed')
    return data
  },

  async sessionDelete(this: TransportCore, sessionId: string, cwd: string) {
    const res = await this.fetch(this.url('/api/session-delete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `session delete failed (${res.status})`)
    }
    return data
  },

  async compact(this: TransportCore, sessionId: string, note?: string) {
    const res = await this.fetch(this.url('/api/compact'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ...(note ? { note } : {}) }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'compact failed')
    return data
  },

  async rewindPoints(this: TransportCore, 
    sessionId: string,
    cwd: string,
  ): Promise<{ points: RewindPoint[] }> {
    const res = await this.fetch(this.url('/api/rewind-points'), {
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
  },

  async rewindExecute(this: TransportCore, 
    sessionId: string,
    targetIndex: number,
    mode?: RewindMode,
  ): Promise<import('../types').RewindExecuteResult> {
    const res = await this.fetch(this.url('/api/rewind-execute'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        targetIndex,
        // Omitted when unset — the host defaults to conversation_only
        // (TUI /rewind behavior).
        ...(mode ? { mode } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'rewind failed')
    // The agent reports rewind failure inside `result.success` (TUI
    // RewindResponse.success) — e.g. when the host omits force/mode and
    // the agent declines the rollback. Treat `success: false` as an
    // error so the picker shows the failure instead of pretending the
    // history was rewound (which left the scrollback unchanged).
    const result = data.result
    if (result && typeof result === 'object' && result.success === false) {
      throw new Error(
        (typeof result.error === 'string' && result.error) ||
          `回退失败: 目标点 ${targetIndex} 未被接受`,
      )
    }
    // RewindResponse detail fields (snake_case or camelCase on the wire):
    //   target_prompt_index — 回退目标轮次（本地即时截断用）
    //   prompt_text    — 回退点的 prompt 原文（Composer 恢复用）
    //   reverted_files — 实际还原（写回/删除）的文件
    //   clean_files    — 本就干净的文件
    //   conflicts      — 与外部修改冲突的文件（mode=all 时已被快照覆盖）
    // 全部防御性解析：非字符串数组 / 非对象项直接丢弃。
    const o =
      result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : {}
    const strArr = (snake: string, camel: string): string[] | undefined => {
      const v = o[snake] ?? o[camel]
      return Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string')
        : undefined
    }
    const rawPrompt =
      (typeof o.prompt_text === 'string' && o.prompt_text) ||
      (typeof o.promptText === 'string' && o.promptText)
    const rawConflicts = Array.isArray(o.conflicts) ? o.conflicts : undefined
    const conflicts = rawConflicts
      ?.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({
        path: String(c.path ?? ''),
        conflictType: String(c.conflict_type ?? c.conflictType ?? ''),
      }))
      .filter((c) => c.path)
    let rawTarget: number | undefined
    if (typeof o.target_prompt_index === 'number') rawTarget = o.target_prompt_index
    else if (typeof o.targetPromptIndex === 'number') rawTarget = o.targetPromptIndex
    return {
      ...(rawTarget != null && Number.isFinite(rawTarget)
        ? { targetPromptIndex: rawTarget }
        : {}),
      ...(rawPrompt && rawPrompt.trim() ? { promptText: rawPrompt } : {}),
      ...(strArr('reverted_files', 'revertedFiles')
        ? { revertedFiles: strArr('reverted_files', 'revertedFiles') }
        : {}),
      ...(strArr('clean_files', 'cleanFiles')
        ? { cleanFiles: strArr('clean_files', 'cleanFiles') }
        : {}),
      ...(conflicts && conflicts.length > 0 ? { conflicts } : {}),
    }
  },

  async schedulerDelete(this: TransportCore, sessionId: string, taskId: string) {
    const res = await this.fetch(this.url('/api/scheduler-delete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, taskId }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'scheduler delete failed')
    }
    return data
  },

  async sessionState(this: TransportCore, sessionId: string): Promise<SessionState> {
    const res = await this.fetch(this.url('/api/session-state'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `session state failed (${res.status})`)
    }
    const s = (data.session ?? {}) as Record<string, unknown>
    const busy = s.busy === true
    const awaitingInput = s.awaitingInput === true
    return {
      sessionId: typeof s.sessionId === 'string' && s.sessionId ? s.sessionId : sessionId,
      busy,
      awaitingInput,
      ...(typeof s.cwd === 'string' && s.cwd ? { cwd: s.cwd } : {}),
      ...(typeof s.title === 'string' && s.title ? { title: s.title } : {}),
      ...(typeof s.updatedAt === 'string' && s.updatedAt ? { updatedAt: s.updatedAt } : {}),
      ...(typeof s.lastActiveAt === 'number' && Number.isFinite(s.lastActiveAt)
        ? { lastActiveAt: s.lastActiveAt }
        : {}),
      ...(typeof s.createdAt === 'number' && Number.isFinite(s.createdAt)
        ? { createdAt: s.createdAt }
        : {}),
      ...(typeof s.state === 'string' && s.state
        ? { state: s.state as SessionState['state'] }
        : busy
          ? awaitingInput
            ? { state: 'awaiting' as const }
            : { state: 'active' as const }
          : { state: 'idle' as const }),
    }
  },

  async sessionResume(this: TransportCore, opts: {
    sessionId: string
    cwd: string
    meta?: Record<string, unknown>
  }): Promise<{
    models?: unknown
    modes?: unknown
    configOptions?: unknown
    busy?: boolean
  }> {
    const res = (await unwrapExtResult(await xaiCall(this, '/api/session-resume', opts))) as
      | Record<string, unknown>
      | null
      | undefined
    return {
      models: res?.models,
      modes: res?.modes,
      configOptions: res?.configOptions,
      busy: res?.busy === true,
    }
  },

  async sessionClose(this: TransportCore, opts: { sessionId?: string } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/session-close', opts))
  },

  async sessionImport(this: TransportCore, opts: {
    cwd: string
    state?: Record<string, unknown>
    updates?: unknown[]
  }): Promise<unknown> {
    const body: Record<string, unknown> = { cwd: opts.cwd }
    if (opts.state) body.state = opts.state
    if (opts.updates && opts.updates.length > 0) body.updates = opts.updates
    return unwrapExtResult(await xaiCall(this, '/api/session-import', body))
  },

  async sessionRepair(this: TransportCore, opts: { dryRun?: boolean } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/session-repair', opts))
  },

  async sessionRehydrate(this: TransportCore, opts: {
    sourceCwd: string
    repoRoot: string
    worktreePath?: string
  }): Promise<unknown> {
    const body: Record<string, unknown> = { sourceCwd: opts.sourceCwd, repoRoot: opts.repoRoot }
    if (opts.worktreePath) body.worktreePath = opts.worktreePath
    return unwrapExtResult(await xaiCall(this, '/api/session-rehydrate', body))
  },

  async sessionLoadHistory(this: TransportCore, opts: { beforeId?: string } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/session-load-history', opts))
  },

  async sessionUpdateMcpServers(this: TransportCore, opts: { mcpServers: unknown[] }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/session-update-mcp-servers', opts))
  },

  async sessionAddLocalWorkspace(this: TransportCore, opts: { meta?: Record<string, unknown> } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/session-add-local-workspace', opts))
  },

  async sessionResolveWorktreeResume(this: TransportCore, opts: { cwd: string }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/session-resolve-worktree-resume', opts))
  },

  async sessionInfoExt(this: TransportCore, opts: { sessionId?: string } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/session/info', opts))
  },

  async sessionUsage(this: TransportCore, opts: { sessionId?: string } = {}): Promise<SessionUsageData> {
    const raw = unwrapExtResult<unknown>(await xaiCall(this, '/api/session/usage', opts))
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as SessionUsageData)
      : {}
  },

  async sessionStats(this: TransportCore, sessionId: string, cwd: string): Promise<SessionStats> {
    const res = await this.fetch(this.url('/api/session-stats'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `session stats failed (${res.status})`)
    }
    const s = data.stats
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw new Error('session stats: 响应缺少 stats')
    }
    const o = s as Record<string, unknown>
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined
    return {
      turns: num(o.turns) ?? 0,
      steps: num(o.steps) ?? 0,
      llmDurationMs: num(o.llmDurationMs) ?? 0,
      ...(num(o.toolDurationMs) != null ? { toolDurationMs: num(o.toolDurationMs) } : {}),
      ...(num(o.firstTokenAvgMs) != null ? { firstTokenAvgMs: num(o.firstTokenAvgMs) } : {}),
      ...(num(o.tokensPerSec) != null ? { tokensPerSec: num(o.tokensPerSec) } : {}),
      cacheHitRate: num(o.cacheHitRate) ?? 0,
      inputTokens: num(o.inputTokens) ?? 0,
      outputTokens: num(o.outputTokens) ?? 0,
      totalTokens: num(o.totalTokens) ?? 0,
      cachedReadTokens: num(o.cachedReadTokens) ?? 0,
      modelCalls: num(o.modelCalls) ?? 0,
    }
  },

  async sessionSearch(this: TransportCore, opts: {
    query: string
    cwd?: string
    limit?: number
    offset?: number
    includeContent?: boolean
  }): Promise<unknown> {
    // Agent hard-validates the paging window (session_search.rs
    // validate_search_window, 2026-08 sync): limit 1..=100, offset <=
    // 1000 — out-of-range returns invalid_params. Clamp here so every
    // caller stays on the safe side.
    const body: Record<string, unknown> = { query: opts.query }
    if (opts.cwd) body.cwd = opts.cwd
    if (opts.limit !== undefined) {
      body.limit = Math.min(Math.max(1, Math.floor(opts.limit)), 100)
    }
    if (opts.offset !== undefined) {
      body.offset = Math.max(0, Math.min(Math.floor(opts.offset), 1000))
    }
    if (opts.includeContent !== undefined) body.includeContent = opts.includeContent
    return unwrapExtResult(await xaiCall(this, '/api/session/search', body))
  },

  async sessionShare(this: TransportCore, opts: { sessionId?: string } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/session/share', opts))
  },

  async sessionsListExt(this: TransportCore): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/sessions/list', {}))
  },

  async sessionSummariesSessionList(this: TransportCore, opts: { workspaceDirectory: string }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/session-summaries/session-list', opts))
  },

  async subagentListRunning(this: TransportCore, opts: { sessionId?: string } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/subagent/list-running', opts))
  },

  async subagentGet(this: TransportCore, opts: {
    subagentId: string
    block?: boolean
    timeoutMs?: number
  }): Promise<unknown> {
    const body: Record<string, unknown> = { subagentId: opts.subagentId }
    if (opts.block !== undefined) body.block = opts.block
    if (opts.timeoutMs !== undefined) body.timeoutMs = opts.timeoutMs
    return unwrapExtResult(await xaiCall(this, '/api/subagent/get', body))
  },

  async workspacesList(this: TransportCore, opts: {
    pageSize?: number
    pageToken?: string
    query?: string
    kind?: string
  } = {}): Promise<unknown> {
    const body: Record<string, unknown> = {}
    if (opts.pageSize !== undefined) body.pageSize = opts.pageSize
    if (opts.pageToken !== undefined && opts.pageToken !== '') body.pageToken = opts.pageToken
    if (opts.query !== undefined && opts.query !== '') body.query = opts.query
    if (opts.kind !== undefined && opts.kind !== '') body.kind = opts.kind
    return unwrapExtResult(await xaiCall(this, '/api/workspaces/list', body))
  },

  async promptHistory(this: TransportCore, opts: { cwd?: string; sessionId?: string } = {}): Promise<unknown> {
    const body: Record<string, unknown> = {}
    if (opts.cwd) body.cwd = opts.cwd
    if (opts.sessionId) body.sessionId = opts.sessionId
    return unwrapExtResult(await xaiCall(this, '/api/prompt-history', body))
  },

  async commandsList(this: TransportCore, opts: { sessionId?: string } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/commands-list', opts))
  }
}
