import type { TransportCore } from '../transport'
import { findArrayField, findField, findObjectField, unwrapExtResult, xaiCall } from './core'
import type { AgentSkill, CustomModelConfig, ExtensionHook, WorkflowInfo } from '../types'
import type { ExtensionsPayload, McpListServer, McpToolInfo, SettingsPatch, SettingsPayload, TerminalOutput } from '../transport'

export const toolsRpc = {
  async mcpList(this: TransportCore): Promise<{ servers: McpListServer[] }> {
    const res = await this.fetch(this.url('/api/mcp/list'))
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
          ...(typeof s.displayName === 'string' && s.displayName
            ? { displayName: s.displayName }
            : {}),
          ...(typeof s.command === 'string' && s.command ? { command: s.command } : {}),
          ...(Array.isArray(s.args) ? { args: s.args.map(String) } : {}),
          ...(env && Object.keys(env).length > 0 ? { env } : {}),
          ...(typeof s.enabled === 'boolean'
            ? { enabled: s.enabled }
            : typeof sess.enabled === 'boolean'
              ? { enabled: sess.enabled }
              : {}),
          ...(typeof s.source === 'string' && s.source ? { source: s.source } : {}),
          // Human-readable source overlay (agent `sourceLabel`, e.g.
          // "plugin: foo"); the bare `source` enum stays as fallback.
          ...(typeof s.sourceLabel === 'string' && s.sourceLabel
            ? { sourceLabel: s.sourceLabel }
            : {}),
          ...(typeof s.url === 'string' && s.url ? { url: s.url } : {}),
          ...(typeof s.status === 'string' && s.status
            ? { status: s.status }
            : typeof sess.status === 'string' && sess.status
              ? { status: sess.status }
              : {}),
          // Why the server has no tools (agent skips these when false):
          // OAuth pending / setup not filled in yet.
          ...(typeof sess.authRequired === 'boolean'
            ? { authRequired: sess.authRequired }
            : {}),
          ...(typeof sess.setupRequired === 'boolean'
            ? { setupRequired: sess.setupRequired }
            : {}),
          // Agent-side count, useful when the wire omitted the tool list.
          ...(typeof s.toolCount === 'number'
            ? { toolCount: s.toolCount }
            : typeof sess.toolCount === 'number'
              ? { toolCount: sess.toolCount }
              : {}),
          // Only attach the tools array when the wire actually carried one
          // (empty array = a connected server with zero tools; undefined =
          // no tool info at all).
          ...(Array.isArray(sess.tools) ? { tools } : {}),
        }
      })
      .filter((s) => s.name)
    return { servers }
  },

  async mcpToggleTool(this: TransportCore, 
    serverName: string,
    toolName: string,
    enabled: boolean,
  ): Promise<Record<string, unknown>> {
    const res = await this.fetch(this.url('/api/mcp/toggle-tool'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverName, toolName, enabled }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `mcp toggle tool failed (${res.status})`)
    }
    return data
  },

  async mcpToggle(this: TransportCore, 
    name: string,
    enabled: boolean,
  ): Promise<Record<string, unknown>> {
    const res = await this.fetch(this.url('/api/mcp-toggle'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, enabled }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `mcp toggle failed (${res.status})`)
    }
    return data
  },

  async mcpAdd(this: TransportCore, server: {
    name: string
    command: string
    args?: string[]
    env?: Record<string, string>
  }): Promise<Record<string, unknown>> {
    const res = await this.fetch(this.url('/api/mcp-add'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `mcp add failed (${res.status})`)
    }
    return data
  },

  async mcpRemove(this: TransportCore, name: string): Promise<Record<string, unknown>> {
    const res = await this.fetch(this.url('/api/mcp-remove'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `mcp remove failed (${res.status})`)
    }
    return data
  },

  async mcpAuthTrigger(this: TransportCore, name: string): Promise<Record<string, unknown>> {
    const res = await this.fetch(this.url('/api/mcp-auth-trigger'), {
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
  },

  async mcpCall(this: TransportCore, opts: {
    sessionId?: string
    server: string
    serverUrl?: string
    tool: string
    args?: unknown
  }): Promise<unknown> {
    const body: Record<string, unknown> = { server: opts.server, tool: opts.tool }
    if (opts.sessionId) body.sessionId = opts.sessionId
    if (opts.serverUrl) body.serverUrl = opts.serverUrl
    if (opts.args !== undefined) body.arguments = opts.args
    return unwrapExtResult(await xaiCall(this, '/api/mcp/call', body))
  },

  async mcpReadResource(this: TransportCore, opts: { server: string; uri: string }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/mcp/read-resource', opts))
  },

  async mcpSetup(this: TransportCore, opts: { serverName: string; values: Record<string, string> }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/mcp/setup', opts))
  },

  async mcpAuthStatus(this: TransportCore, opts: { sessionId?: string } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/mcp/auth-status', opts))
  },

  async memoryFlush(this: TransportCore, sessionId: string) {
    const res = await this.fetch(this.url('/api/memory-flush'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `memory flush failed (${res.status})`)
    }
    return data
  },

  async memoryRewrite(this: TransportCore, sessionId: string, rawText: string, contextSummary?: string) {
    const res = await this.fetch(this.url('/api/memory-rewrite'), {
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
  },

  async terminalCreate(this: TransportCore, params: {
    command: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    outputByteLimit?: number
  }): Promise<{ terminalId: string }> {
    const res = await this.fetch(this.url('/api/terminal/create'), {
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
  },

  async terminalOutput(this: TransportCore, terminalId: string): Promise<TerminalOutput> {
    const res = await this.fetch(this.url('/api/terminal/output'), {
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
  },

  async terminalRelease(this: TransportCore, terminalId: string): Promise<void> {
    const res = await this.fetch(this.url('/api/terminal/release'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `terminal release failed (${res.status})`)
    }
  },

  async terminalBackground(this: TransportCore, terminalId: string): Promise<void> {
    const res = await this.fetch(this.url('/api/terminal/background'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `terminal background failed (${res.status})`)
    }
  },

  async terminalWaitForExit(this: TransportCore, 
    terminalId: string,
  ): Promise<{ exitCode?: number | null; signal?: string }> {
    const raw = unwrapExtResult<unknown>(
      await xaiCall(this, '/api/terminal/wait-for-exit', { terminalId }),
    )
    const o =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
    const code = o.exitCode ?? o.exit_code
    return {
      ...(code != null ? { exitCode: code as number | null } : {}),
      ...(typeof o.signal === 'string' && o.signal ? { signal: o.signal } : {}),
    }
  },

  async skillsList(this: TransportCore, opts: { cwd?: string } = {}): Promise<AgentSkill[]> {
    const raw = unwrapExtResult<unknown>(await xaiCall(this, '/api/skills/list', opts))
    const list = Array.isArray(raw) ? raw : findArrayField(raw, 'skills')
    return (list as Record<string, unknown>[])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => ({
        name: typeof s.name === 'string' ? s.name : '',
        ...(typeof s.enabled === 'boolean' ? { enabled: s.enabled } : {}),
        ...(typeof s.scope === 'string' && s.scope ? { scope: s.scope } : {}),
        ...(typeof s.description === 'string' && s.description
          ? { description: s.description }
          : {}),
      }))
      .filter((s) => s.name)
  },

  async skillsToggle(this: TransportCore, opts: { name: string; enabled: boolean; cwd?: string }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/skills/toggle', opts))
  },

  async skillsAdd(this: TransportCore, params: Record<string, unknown> = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/skills/add', params))
  },

  async skillsRemove(this: TransportCore, opts: { name: string; cwd?: string }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/skills/remove', opts))
  },

  async skillsRefreshBaseline(this: TransportCore): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/skills/refresh-baseline', {}))
  },

  async skillsReset(this: TransportCore, opts: { cwd?: string } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/skills/reset', opts))
  },

  async skillsConfig(this: TransportCore, opts: { cwd?: string } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/skills/config', opts))
  },

  async pluginsList(this: TransportCore, opts: { sessionId?: string } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/plugins/list', opts))
  },

  async pluginsAction(this: TransportCore, opts: { sessionId?: string; action: unknown }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/plugins/action', opts))
  },

  async pluginsReload(this: TransportCore): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/plugins/reload', {}))
  },

  async pluginsNotifyUpdates(this: TransportCore, opts: { sessionId?: string; updates: unknown[] }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/plugins/notify-updates', opts))
  },

  /**
   * POST /api/hooks/list — the agent's LIVE hook registry
   * (x.ai/hooks/list, the same source as the TUI /hooks modal): hooks
   * mirroring the TUI HookInfo shape plus projectTrusted / loadErrors.
   * The host fills the active session; on agent failure it falls back to
   * the local disk scan (legacy fields only) without an error.
   */
  async hooksList(this: TransportCore, opts: { sessionId?: string } = {}): Promise<{
    hooks: ExtensionHook[]
    projectTrusted?: boolean
    loadErrors?: string[]
  }> {
    const result = (await unwrapExtResult(
      await xaiCall(this, '/api/hooks/list', opts),
    )) as Record<string, unknown>
    const hooks = (findArrayField(result, 'hooks') as Record<string, unknown>[])
      .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
      .map((h) => ({
        name: typeof h.name === 'string' ? h.name : '',
        ...(typeof h.event === 'string' && h.event ? { event: h.event } : {}),
        ...(typeof h.handlerType === 'string' && h.handlerType ? { handlerType: h.handlerType } : {}),
        ...(typeof h.matcher === 'string' && h.matcher ? { matcher: h.matcher } : {}),
        ...(typeof h.command === 'string' && h.command ? { command: h.command } : {}),
        ...(typeof h.url === 'string' && h.url ? { url: h.url } : {}),
        ...(typeof h.timeoutMs === 'number' && h.timeoutMs > 0 ? { timeoutMs: h.timeoutMs } : {}),
        ...(typeof h.sourceDir === 'string' && h.sourceDir ? { sourceDir: h.sourceDir } : {}),
        ...(typeof h.disabled === 'boolean' ? { disabled: h.disabled } : {}),
        ...(typeof h.pinned === 'boolean' ? { pinned: h.pinned } : {}),
        // Legacy local-scan fields ride the fallback payload.
        ...(typeof h.enabled === 'boolean' ? { enabled: h.enabled } : {}),
        ...(typeof h.source === 'string' && h.source ? { source: h.source } : {}),
      }))
      .filter((h) => h.name)
    return {
      hooks,
      ...(typeof result.projectTrusted === 'boolean'
        ? { projectTrusted: result.projectTrusted }
        : {}),
      ...(Array.isArray(result.loadErrors)
        ? { loadErrors: (result.loadErrors as unknown[]).map(String) }
        : {}),
    }
  },

  /**
   * POST /api/hooks/action — forward a hooks management action to the
   * agent (x.ai/hooks/action, {action:{type:"reload"}}). A reload makes
   * the agent re-discover ~/.grok/hooks mid-session without a restart;
   * the agent broadcasts hooks_changed afterwards, which auto-refreshes
   * an open extensions modal (hooksVersion bump). Host merge: sessionId
   * + action; the active session is filled when absent.
   */
  async hooksAction(this: TransportCore, opts: { sessionId?: string; action: unknown }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/hooks/action', opts))
  },

  async marketplaceList(this: TransportCore): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/marketplace/list', {}))
  },

  async marketplaceAction(this: TransportCore, opts: { action: unknown }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/marketplace/action', opts))
  },

  /** x.ai/workflows/list — 已安装 workflow 目录（会话级注册表）。
   *  Resolves to `{ workflows: [...] }`（ext wrapper 的 result 已解包）。 */
  async workflowsList(this: TransportCore, opts: { sessionId?: string } = {}): Promise<{ workflows?: WorkflowInfo[] }> {
    return unwrapExtResult(await xaiCall(this, '/api/workflows/list', opts))
  },

  async listCustomModels(this: TransportCore): Promise<CustomModelConfig[]> {
    const res = await this.fetch(this.url('/api/custom-models'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'list custom models failed')
    return Array.isArray(data.models) ? (data.models as CustomModelConfig[]) : []
  },

  async upsertCustomModel(this: TransportCore, cfg: CustomModelConfig) {
    const { id, ...values } = cfg
    const res = await this.fetch(this.url('/api/custom-model'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, values }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'save custom model failed')
    return data
  },

  async deleteCustomModel(this: TransportCore, id: string) {
    const res = await this.fetch(this.url('/api/custom-model-delete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'delete custom model failed')
    return data
  },

  async setModel(this: TransportCore, modelId: string, reasoningEffort?: string, sessionId?: string) {
    const res = await this.fetch(this.url('/api/set-model'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'set model failed')
    return data
  },

  async setDefaultModel(this: TransportCore, modelId: string, reasoningEffort?: string, sessionId?: string) {
    const res = await this.fetch(this.url('/api/set-default-model'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'set default model failed')
    return data
  },

  async extensions(this: TransportCore): Promise<ExtensionsPayload> {
    const res = await this.fetch(this.url('/api/extensions'))
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
  },

  async settings(this: TransportCore): Promise<SettingsPayload> {
    const res = await this.fetch(this.url('/api/settings'))
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `settings failed (${res.status})`)
    }
    return {
      ui: findObjectField(data, 'ui'),
      session: findObjectField(data, 'session'),
      models: findObjectField(data, 'models'),
      cli: findObjectField(data, 'cli'),
      toolset: findObjectField(data, 'toolset'),
    }
  },

  async updateSettings(
    this: TransportCore,
    patch: SettingsPatch,
  ): Promise<SettingsPayload> {
    const res = await this.fetch(this.url('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `update settings failed (${res.status})`)
    }
    return {
      ui: findObjectField(data, 'ui'),
      session: findObjectField(data, 'session'),
      models: findObjectField(data, 'models'),
      cli: findObjectField(data, 'cli'),
      toolset: findObjectField(data, 'toolset'),
    }
  },
}
