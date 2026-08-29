import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore, type McpServerInfo } from '../store/chat'
import { transport, type McpListServer, type McpToolInfo } from '../api/client'

/**
 * MCP server panel (x.ai/mcp/server_status + host /api/mcp/*) — web
 * counterpart of the TUI /mcps modal.
 *
 * Both halves render `rows` — the merged view of the event stream
 * (mcp_server_status) and GET /api/mcp/list. `mcp_server_status` is an
 * incremental notification (only fired on status change, never replayed
 * when the panel opens), so the event stream alone is usually empty;
 * the list is what makes the panel informative on first open.
 *
 * Upper half: 服务器状态 — read-only status rows plus the aggregate MCP
 * init progress (mcp_init_progress: `MCP (connected/total)` bar while
 * connecting).
 *
 * Lower half: 管理 — the same rows with their config (rows marked
 * `agent-list` came in from the list response); per-row 启用/禁用 toggle
 * (/api/mcp-toggle), per-tool 启用/禁用 toggle (/api/mcp-toggle-tool —
 * the tool list comes from the list response's session.tools, degraded to
 * 无工具信息 when absent), 删除 (/api/mcp-remove, window.confirm), 认证
 * (/api/mcp-auth-trigger — url/code shown inline), plus a collapsible
 * 添加服务器 form (/api/mcp-add). Merge rule: the event stream wins for
 * status, the list supplements config/source. Every host call degrades to
 * an inline error line — the read-only 服务器状态 view is never affected.
 * mcp_tools_changed / mcp_servers_updated bump mcpVersion, which
 * re-triggers the list fetch while the panel is open.
 */
export function McpPanel({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const mcpServers = useChatStore((s) => s.mcpServers)
  const mcpInit = useChatStore((s) => s.mcpInit)
  /** Bumped by mcp_tools_changed / mcp_servers_updated (no payload data). */
  const mcpVersion = useChatStore((s) => s.mcpVersion)
  const mcpList = useChatStore((s) => s.mcpList)
  const mcpToggle = useChatStore((s) => s.mcpToggle)
  const mcpToggleTool = useChatStore((s) => s.mcpToggleTool)
  const mcpAdd = useChatStore((s) => s.mcpAdd)
  const mcpRemove = useChatStore((s) => s.mcpRemove)
  const mcpAuthTrigger = useChatStore((s) => s.mcpAuthTrigger)
  const panelRef = useRef<HTMLDivElement>(null)

  // ── 管理 section state ──────────────────────────────────────────────
  const [list, setList] = useState<McpListServer[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string>()
  const [busy, setBusy] = useState<{ name: string; action: 'toggle' | 'remove' | 'auth' } | null>(null)
  /** In-flight per-tool toggle ({server, tool}); exclusive with `busy`. */
  const [toolBusy, setToolBusy] = useState<{ server: string; tool: string } | null>(null)
  const [actionError, setActionError] = useState<string>()
  const [authResult, setAuthResult] = useState<{ name: string; url?: string; code?: string; message?: string } | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState({ name: '', command: '', args: '', env: '' })
  const [formError, setFormError] = useState<string>()
  const [adding, setAdding] = useState(false)
  // ── 调用工具 / 读取资源（x.ai/mcp/call · x.ai/mcp/read_resource）──
  const [callOpen, setCallOpen] = useState(false)
  const [callForm, setCallForm] = useState({ server: '', tool: '', args: '' })
  const [callResult, setCallResult] = useState<string>()
  const [callError, setCallError] = useState<string>()
  const [calling, setCalling] = useState(false)
  const [readOpen, setReadOpen] = useState(false)
  const [readForm, setReadForm] = useState({ server: '', uri: '' })
  const [readResult, setReadResult] = useState<string>()
  const [readError, setReadError] = useState<string>()
  const [reading, setReading] = useState(false)
  const reqSeq = useRef(0)

  /** GET /api/mcp/list — keep the previous list on failure, show error line. */
  const refreshList = useCallback(async () => {
    const seq = ++reqSeq.current
    setListLoading(true)
    setListError(undefined)
    try {
      const servers = await mcpList()
      if (seq === reqSeq.current) setList(servers)
    } catch (e) {
      if (seq === reqSeq.current) {
        setListError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (seq === reqSeq.current) setListLoading(false)
    }
  }, [mcpList])

  useEffect(() => {
    if (!open) return
    void refreshList()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose, refreshList])

  /**
   * mcp_tools_changed / mcp_servers_updated only bump mcpVersion — the
   * notification carries no server data — so re-fetch the list while the
   * panel is open. The mount/open fetch above covers the first value;
   * refreshList's reqSeq guard keeps a late response from overwriting.
   */
  const seenMcpVersion = useRef(mcpVersion)
  useEffect(() => {
    if (seenMcpVersion.current === mcpVersion) return
    seenMcpVersion.current = mcpVersion
    if (open) void refreshList()
  }, [open, mcpVersion, refreshList])

  /**
   * Merge rule: event-stream rows (mcp_server_status) win for status;
   * the agent-list result supplements config/source and adds rows the
   * stream has not reported yet. `rows` is the panel's single source of
   * truth — both halves render it (the stream alone is empty on a fresh
   * open, since status events are only pushed on change).
   */
  const rows = useMemo(() => {
    const map = new Map<string, McpRow>()
    for (const e of mcpServers) map.set(e.name, { ...e, fromList: false })
    for (const l of list) {
      const existing = map.get(l.name)
      if (existing) {
        map.set(l.name, {
          ...existing,
          status: existing.status ?? l.status,
          source: existing.source ?? l.source,
          command: existing.command ?? l.command,
          args: existing.args ?? l.args,
          env: existing.env ?? l.env,
          url: existing.url ?? l.url,
          enabled: l.enabled,
          // Config-only fields the event stream never carries.
          displayName: l.displayName,
          sourceLabel: l.sourceLabel,
          authRequired: l.authRequired,
          setupRequired: l.setupRequired,
          toolCount: l.toolCount,
          // Tool list comes from the agent list only (event-stream rows
          // carry no tools). `??` keeps the last-known list when the
          // fresh response omits it.
          tools: l.tools ?? existing.tools,
          fromList: true,
        })
      } else {
        map.set(l.name, {
          name: l.name,
          source: l.source,
          status: l.status,
          reason: undefined,
          detail: undefined,
          command: l.command,
          args: l.args,
          env: l.env,
          url: l.url,
          enabled: l.enabled,
          displayName: l.displayName,
          sourceLabel: l.sourceLabel,
          authRequired: l.authRequired,
          setupRequired: l.setupRequired,
          toolCount: l.toolCount,
          tools: l.tools,
          fromList: true,
        })
      }
    }
    return [...map.values()]
  }, [mcpServers, list])

  const runAction = async (
    name: string,
    action: 'toggle' | 'remove' | 'auth',
    fn: () => Promise<unknown>,
  ) => {
    // Server-level actions are exclusive with per-tool toggles too.
    if (busy || toolBusy) return
    setBusy({ name, action })
    setActionError(undefined)
    setAuthResult(null)
    try {
      await fn()
    } catch (e) {
      setActionError(`${actionLabel(action)}「${name}」失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const toggleServer = (name: string, enabled: boolean) =>
    void runAction(name, 'toggle', async () => {
      await mcpToggle(name, enabled)
      // Success → update the local list state only.
      setList((prev) => prev.map((s) => (s.name === name ? { ...s, enabled } : s)))
      useChatStore.setState({ statusText: `已${enabled ? '启用' : '禁用'} MCP 服务器 ${name}` })
    })

  /**
   * Per-tool enable/disable (POST /api/mcp-toggle-tool — TUI /mcps tool
   * row toggle → x.ai/mcp/toggle_tool). Optimistic local flip + silent
   * refresh so the list converges with the agent (the tools_changed
   * notification also bumps mcpVersion, which re-fetches on its own).
   */
  const toggleTool = async (server: string, tool: string, enabled: boolean) => {
    if (busy || toolBusy) return
    setToolBusy({ server, tool })
    setActionError(undefined)
    try {
      await mcpToggleTool(server, tool, enabled)
      setList((prev) =>
        prev.map((s) =>
          s.name === server
            ? {
                ...s,
                tools: s.tools?.map((t) =>
                  t.name === tool ? { ...t, enabled } : t,
                ),
              }
            : s,
        ),
      )
      useChatStore.setState({ statusText: `已${enabled ? '启用' : '禁用'}工具 ${tool}（${server}）` })
      void refreshList()
    } catch (e) {
      setActionError(`工具启停「${tool}」失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setToolBusy(null)
    }
  }

  const removeServer = (name: string) => {
    if (busy || toolBusy) return
    if (!window.confirm(`删除 MCP 服务器「${name}」？此操作不可恢复。`)) return
    void runAction(name, 'remove', async () => {
      await mcpRemove(name)
      setList((prev) => prev.filter((s) => s.name !== name))
      useChatStore.setState({ statusText: `已删除 MCP 服务器 ${name}` })
    })
  }

  const authServer = (name: string) =>
    void runAction(name, 'auth', async () => {
      const r = await mcpAuthTrigger(name)
      setAuthResult({ name, ...r })
    })

  const submitAdd = async () => {
    const name = form.name.trim()
    const command = form.command.trim()
    if (!name || !command) {
      setFormError('name 和 command 为必填项')
      return
    }
    const args = parseArgsInput(form.args)
    if (typeof args === 'string') {
      setFormError(args)
      return
    }
    const env = parseEnvInput(form.env)
    if (typeof env === 'string') {
      setFormError(env)
      return
    }
    setFormError(undefined)
    setAdding(true)
    try {
      await mcpAdd({ name, command, args, env })
      useChatStore.setState({ statusText: `已添加 MCP 服务器 ${name}` })
      setAddOpen(false)
      setForm({ name: '', command: '', args: '', env: '' })
      // Pull the fresh config into the list so the row appears immediately.
      void refreshList()
    } catch (e) {
      setFormError(`添加失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAdding(false)
    }
  }

  /** x.ai/mcp/call — 调用一个已配置服务器的工具（arguments 为可选 JSON）。 */
  const submitCall = async () => {
    const server = callForm.server.trim()
    const tool = callForm.tool.trim()
    if (!server || !tool) {
      setCallError('server 和 tool 为必填项')
      return
    }
    let args: unknown
    const raw = callForm.args.trim()
    if (raw) {
      try {
        args = JSON.parse(raw) as unknown
      } catch {
        setCallError('arguments 不是合法 JSON')
        return
      }
    }
    setCallError(undefined)
    setCallResult(undefined)
    setCalling(true)
    try {
      const result = await transport.mcpCall({ server, tool, ...(args !== undefined ? { args } : {}) })
      setCallResult(formatResult(result))
      useChatStore.setState({ statusText: `已调用 MCP 工具 ${server}__${tool}` })
    } catch (e) {
      setCallError(`调用失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setCalling(false)
    }
  }

  /** x.ai/mcp/read_resource — 读取服务器暴露的资源（server + uri）。 */
  const submitRead = async () => {
    const server = readForm.server.trim()
    const uri = readForm.uri.trim()
    if (!server || !uri) {
      setReadError('server 和 uri 为必填项')
      return
    }
    setReadError(undefined)
    setReadResult(undefined)
    setReading(true)
    try {
      const result = await transport.mcpReadResource({ server, uri })
      setReadResult(formatResult(result))
      useChatStore.setState({ statusText: `已读取 MCP 资源 ${uri}` })
    } catch (e) {
      setReadError(`读取失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setReading(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="MCP servers"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="mt-8 w-full max-w-[620px] rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl outline-none"
      >
        <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
          <span className="text-[13px] font-bold text-gn-fg">MCP servers</span>
          <span className="text-[11px] text-gn-muted">
            {rows.length} 个服务器
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            esc
          </button>
        </header>

        <div className="max-h-[62vh] overflow-y-auto">
          {/* ── 上半区: 服务器状态（合并行，只读） ─────────────────── */}
          {(mcpInit || rows.length > 0) && (
            <div className="px-4 pt-2.5 pb-1 text-[10px] uppercase tracking-wider text-gn-gutter">
              服务器状态
            </div>
          )}
          {mcpInit && !(mcpInit.total > 0 && mcpInit.connected >= mcpInit.total) ? (
            <div className="border-b border-gn-prompt-border/50 px-4 py-2">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-gn-yellow animate-pulse" />
                <span className="text-[12px] text-gn-fg2">
                  {mcpInit.total > 0
                    ? `MCP 初始化中 · ${mcpInit.connected}/${mcpInit.total} 已连接`
                    : 'MCP 初始化中…（等待服务器计数）'}
                </span>
              </div>
              {mcpInit.total > 0 ? (
                <div className="mt-1.5 h-1 w-full overflow-hidden rounded bg-gn-bg-highlight">
                  <div
                    className="h-full rounded bg-gn-yellow transition-[width] duration-300"
                    style={{
                      width: `${Math.min(100, Math.round((mcpInit.connected / mcpInit.total) * 100))}%`,
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          {rows.length === 0 ? null : (
            rows.map((s) => (
              <div
                key={s.name}
                className="flex items-start gap-2.5 border-b border-gn-prompt-border/50 px-4 py-2"
              >
                <span
                  className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${statusDot(rowStatus(s))}`}
                  title={rowStatus(s) ?? 'unknown'}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="truncate font-mono text-[12.5px] text-gn-fg">
                      {s.name}
                    </span>
                    {s.displayName && s.displayName !== s.name ? (
                      <span className="min-w-0 truncate text-[11px] text-gn-fg2">
                        {s.displayName}
                      </span>
                    ) : null}
                    <McpFlags row={s} />
                    <span className="shrink-0 text-[11px] text-gn-muted">
                      {rowStatus(s) ?? 'unknown'}
                      {rowSource(s) ? ` · ${rowSource(s)}` : ''}
                    </span>
                  </div>
                  {s.reason ? (
                    <div className="truncate text-[11px] text-gn-gutter">
                      {s.reason}
                    </div>
                  ) : null}
                  {s.detail ? (
                    <div className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-gn-muted">
                      {s.detail}
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )}

          {/* ── 下半区: 管理 ──────────────────────────────────────── */}
          <div className="flex items-center gap-2 px-4 pt-3 pb-1">
            <span className="text-[10px] uppercase tracking-wider text-gn-gutter">
              管理 · /api/mcp/list
            </span>
            <button
              type="button"
              onClick={() => void refreshList()}
              disabled={listLoading}
              className="rounded border border-gn-prompt-border px-2 py-0.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
              title="重新读取 host 的 MCP 配置"
            >
              {listLoading ? '刷新中…' : '刷新列表'}
            </button>
          </div>

          {listError ? (
            <div className="px-4 py-2">
              <div className="rounded border border-gn-diff-del-bg px-2 py-1.5 text-[11px] text-gn-red">
                {listError}
              </div>
            </div>
          ) : null}

          {!listError && rows.length === 0 ? (
            <div className="px-4 py-3 text-center text-[12px] text-gn-muted">
              没有已配置的服务器
            </div>
          ) : (
            rows.map((s) => {
              const busyThis = busy?.name === s.name
              const isBusy = (a: 'toggle' | 'remove' | 'auth') =>
                busyThis && busy.action === a
              const enabled = s.enabled !== false
              return (
                <div
                  key={s.name}
                  className="border-b border-gn-prompt-border/50 px-4 py-2"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="truncate font-mono text-[12.5px] text-gn-fg">
                          {s.name}
                        </span>
                        {s.fromList && (
                          <span
                            className="shrink-0 rounded border border-gn-prompt-border px-1 text-[9px] leading-[14px] text-gn-cyan"
                            title="来自 GET /api/mcp/list（host 配置），非事件流"
                          >
                            agent-list
                          </span>
                        )}
                        {s.displayName && s.displayName !== s.name ? (
                          <span className="min-w-0 truncate text-[11px] text-gn-fg2">
                            {s.displayName}
                          </span>
                        ) : null}
                        <McpFlags row={s} />
                        <span className="shrink-0 text-[11px] text-gn-muted">
                          {rowStatus(s) ?? '未连接'}
                          {rowSource(s) ? ` · ${rowSource(s)}` : ''}
                        </span>
                      </div>
                      {s.command ? (
                        <div className="mt-0.5 truncate font-mono text-[11px] text-gn-muted" title={s.command}>
                          {s.command}
                          {s.args?.length ? ` ${s.args.join(' ')}` : ''}
                        </div>
                      ) : null}
                      {s.url ? (
                        <div className="mt-0.5 truncate font-mono text-[11px] text-gn-muted" title={s.url}>
                          {s.url}
                        </div>
                      ) : null}
                      {s.env && Object.keys(s.env).length > 0 ? (
                        <div className="mt-0.5 truncate font-mono text-[11px] text-gn-gutter" title={Object.keys(s.env).join(', ')}>
                          env: {Object.keys(s.env).join(', ')}
                        </div>
                      ) : null}
                      {/* 工具列表 — agent wire session.tools（camelCase）。
                          三态区分：有列表 → 计数+可启停；列表为空 → 该服务器
                          没有工具；wire 未带列表 → 退回 toolCount，仍无则
                          无工具信息（优雅降级，不报错）。 */}
                      <div className="mt-1.5">
                        <span className="text-[10px] uppercase tracking-wider text-gn-gutter">
                          工具
                          {toolCountOf(s) != null ? ` (${toolCountOf(s)})` : ''}
                        </span>
                        {s.tools == null ? (
                          <span className="ml-2 text-[11px] text-gn-muted">
                            无工具信息
                            {s.authRequired
                              ? '（需要认证后才会拉取工具）'
                              : s.setupRequired
                                ? '（需要配置后才会拉取工具）'
                                : ''}
                          </span>
                        ) : s.tools.length === 0 ? (
                          <span className="ml-2 text-[11px] text-gn-muted">
                            该服务器没有工具
                          </span>
                        ) : (
                          <div className="mt-1 space-y-0.5">
                            {s.tools.map((t) => (
                              <div key={t.name} className="flex items-center gap-2">
                                <span
                                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                    t.enabled !== false ? 'bg-gn-green' : 'bg-gn-gutter'
                                  }`}
                                  title={t.enabled !== false ? '已启用' : '已禁用'}
                                />
                                <span
                                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-gn-fg2"
                                  title={t.description ? `${t.name} — ${t.description}` : t.name}
                                >
                                  {t.displayName ?? t.name}
                                </span>
                                <button
                                  type="button"
                                  disabled={busy != null || toolBusy != null}
                                  onClick={() =>
                                    void toggleTool(s.name, t.name, t.enabled !== false)
                                  }
                                  className={`shrink-0 rounded border px-1.5 py-px text-[10.5px] disabled:opacity-50 ${
                                    t.enabled !== false
                                      ? 'border-gn-prompt-border text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
                                      : 'border-gn-prompt-border-active bg-gn-bg-highlight text-gn-fg'
                                  }`}
                                  title={`${t.enabled !== false ? '禁用' : '启用'}工具 ${t.name}（/api/mcp/toggle-tool）`}
                                >
                                  {toolBusy?.server === s.name && toolBusy?.tool === t.name
                                    ? '…'
                                    : t.enabled !== false
                                      ? '禁用'
                                      : '启用'}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                      <button
                        type="button"
                        disabled={busy != null || toolBusy != null}
                        onClick={() => void toggleServer(s.name, !enabled)}
                        className={`rounded border px-2 py-0.5 text-[11px] disabled:opacity-50 ${
                          enabled
                            ? 'border-gn-prompt-border text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
                            : 'border-gn-prompt-border-active bg-gn-bg-highlight text-gn-fg'
                        }`}
                        title={enabled ? '禁用该服务器（/api/mcp-toggle）' : '启用该服务器（/api/mcp-toggle）'}
                      >
                        {isBusy('toggle') ? '…' : enabled ? '禁用' : '启用'}
                      </button>
                      <button
                        type="button"
                        disabled={busy != null || toolBusy != null}
                        onClick={() => void authServer(s.name)}
                        className="rounded border border-gn-prompt-border px-2 py-0.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
                        title="触发 OAuth 认证（/api/mcp-auth-trigger）"
                      >
                        {isBusy('auth') ? '…' : '认证'}
                      </button>
                      <button
                        type="button"
                        disabled={busy != null || toolBusy != null}
                        onClick={() => removeServer(s.name)}
                        className="rounded border border-gn-diff-del-bg px-2 py-0.5 text-[11px] text-gn-red hover:bg-gn-diff-del-bg disabled:opacity-50"
                        title="删除该服务器（/api/mcp-remove）"
                      >
                        {isBusy('remove') ? '…' : '删除'}
                      </button>
                    </div>
                  </div>
                  {authResult && authResult.name === s.name && (
                    <div className="mt-1.5 rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1.5 text-[11px] leading-snug text-gn-muted">
                      {authResult.url ? (
                        <div className="break-all">
                          认证链接:{' '}
                          <a
                            href={authResult.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-gn-cyan underline"
                          >
                            {authResult.url}
                          </a>
                        </div>
                      ) : null}
                      {authResult.code ? (
                        <div className="break-all font-mono">认证码: {authResult.code}</div>
                      ) : null}
                      {authResult.message ? (
                        <div className="break-all">{authResult.message}</div>
                      ) : null}
                      {!authResult.url && !authResult.code && !authResult.message ? (
                        <div>已触发认证流程（无额外信息）</div>
                      ) : null}
                    </div>
                  )}
                </div>
              )
            })
          )}

          {actionError ? (
            <div className="px-4 py-2">
              <div className="rounded border border-gn-diff-del-bg px-2 py-1.5 text-[11px] text-gn-red">
                {actionError}
              </div>
            </div>
          ) : null}

          {/* ── 添加服务器 ───────────────────────────────────────── */}
          <div className="border-t border-gn-prompt-border/50 px-4 py-2">
            <button
              type="button"
              onClick={() => {
                setAddOpen((v) => !v)
                setFormError(undefined)
              }}
              className="rounded border border-gn-prompt-border px-2 py-0.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
            >
              {addOpen ? '− 收起添加表单' : '＋ 添加服务器'}
            </button>
            {addOpen && (
              <div className="mt-2 space-y-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">name *</span>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="filesystem"
                    className="mt-0.5 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[12px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">command *</span>
                  <input
                    type="text"
                    value={form.command}
                    onChange={(e) => setForm({ ...form, command: e.target.value })}
                    placeholder="npx"
                    className="mt-0.5 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[12px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">args</span>
                  <input
                    type="text"
                    value={form.args}
                    onChange={(e) => setForm({ ...form, args: e.target.value })}
                    placeholder='空格分隔，或 JSON 数组，如 ["-y","pkg"]'
                    className="mt-0.5 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[12px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">env</span>
                  <textarea
                    value={form.env}
                    onChange={(e) => setForm({ ...form, env: e.target.value })}
                    placeholder={"每行 KEY=value"}
                    rows={2}
                    className="mt-0.5 w-full resize-y rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[12px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                  />
                </label>
                {formError ? (
                  <div className="rounded border border-gn-diff-del-bg px-2 py-1.5 text-[11px] text-gn-red">
                    {formError}
                  </div>
                ) : null}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={adding}
                    onClick={() => void submitAdd()}
                    className="rounded border border-gn-prompt-border-active bg-gn-bg-highlight px-3 py-1 text-[11px] text-gn-fg hover:bg-gn-bg-highlight disabled:opacity-50"
                  >
                    {adding ? '添加中…' : '添加'}
                  </button>
                  <button
                    type="button"
                    disabled={adding}
                    onClick={() => {
                      setAddOpen(false)
                      setFormError(undefined)
                    }}
                    className="rounded border border-gn-prompt-border px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ── 调用工具 / 读取资源（x.ai/mcp/call · x.ai/mcp/read_resource）── */}
          <div className="border-t border-gn-prompt-border/50 px-4 py-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setCallOpen((v) => !v)
                  setCallError(undefined)
                  setCallResult(undefined)
                }}
                className="rounded border border-gn-prompt-border px-2 py-0.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
              >
                {callOpen ? '− 收起调用工具' : '＋ 调用工具'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setReadOpen((v) => !v)
                  setReadError(undefined)
                  setReadResult(undefined)
                }}
                className="rounded border border-gn-prompt-border px-2 py-0.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
              >
                {readOpen ? '− 收起读取资源' : '＋ 读取资源'}
              </button>
            </div>

            {callOpen && (
              <div className="mt-2 space-y-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">server *</span>
                  <select
                    value={callForm.server}
                    onChange={(e) => {
                      const server = e.target.value
                      setCallForm((f) => ({ ...f, server, tool: '' }))
                    }}
                    className="mt-0.5 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[12px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                  >
                    <option value="">— 选择服务器 —</option>
                    {rows.map((r) => (
                      <option key={r.name} value={r.name}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">tool *</span>
                  <input
                    type="text"
                    list="mcp-call-tools"
                    value={callForm.tool}
                    onChange={(e) => setCallForm({ ...callForm, tool: e.target.value })}
                    placeholder="工具名（可从已连接服务器的工具列表选择）"
                    className="mt-0.5 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[12px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-prompt-border-active"
                  />
                  <datalist id="mcp-call-tools">
                    {list
                      .find((s) => s.name === callForm.server)
                      ?.tools?.map((t) => <option key={t.name} value={t.name} />)}
                  </datalist>
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">arguments（可选 JSON）</span>
                  <textarea
                    value={callForm.args}
                    onChange={(e) => setCallForm({ ...callForm, args: e.target.value })}
                    placeholder='{"path": "/tmp/x"}'
                    rows={2}
                    className="mt-0.5 w-full resize-y rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[12px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-prompt-border-active"
                  />
                </label>
                {callError ? (
                  <div className="rounded border border-gn-diff-del-bg px-2 py-1.5 text-[11px] text-gn-red">
                    {callError}
                  </div>
                ) : null}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={calling}
                    onClick={() => void submitCall()}
                    className="rounded border border-gn-prompt-border-active bg-gn-bg-highlight px-3 py-1 text-[11px] text-gn-fg hover:bg-gn-bg-highlight disabled:opacity-50"
                  >
                    {calling ? '调用中…' : '调用'}
                  </button>
                  <button
                    type="button"
                    disabled={calling}
                    onClick={() => {
                      setCallOpen(false)
                      setCallError(undefined)
                      setCallResult(undefined)
                    }}
                    className="rounded border border-gn-prompt-border px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>
                {callResult ? (
                  <pre className="gn-no-scrollbar max-h-44 overflow-auto whitespace-pre-wrap break-all rounded border border-gn-prompt-border bg-gn-bg-dark p-2 font-mono text-[10.5px] leading-snug text-gn-fg2">
                    {callResult}
                  </pre>
                ) : null}
              </div>
            )}

            {readOpen && (
              <div className="mt-2 space-y-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">server *</span>
                  <select
                    value={readForm.server}
                    onChange={(e) => setReadForm((f) => ({ ...f, server: e.target.value }))}
                    className="mt-0.5 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[12px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                  >
                    <option value="">— 选择服务器 —</option>
                    {rows.map((r) => (
                      <option key={r.name} value={r.name}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">uri *</span>
                  <input
                    type="text"
                    value={readForm.uri}
                    onChange={(e) => setReadForm({ ...readForm, uri: e.target.value })}
                    placeholder="file:///… 或 mcp://… 等资源 URI"
                    className="mt-0.5 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[12px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-prompt-border-active"
                  />
                </label>
                {readError ? (
                  <div className="rounded border border-gn-diff-del-bg px-2 py-1.5 text-[11px] text-gn-red">
                    {readError}
                  </div>
                ) : null}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={reading}
                    onClick={() => void submitRead()}
                    className="rounded border border-gn-prompt-border-active bg-gn-bg-highlight px-3 py-1 text-[11px] text-gn-fg hover:bg-gn-bg-highlight disabled:opacity-50"
                  >
                    {reading ? '读取中…' : '读取'}
                  </button>
                  <button
                    type="button"
                    disabled={reading}
                    onClick={() => {
                      setReadOpen(false)
                      setReadError(undefined)
                      setReadResult(undefined)
                    }}
                    className="rounded border border-gn-prompt-border px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>
                {readResult ? (
                  <pre className="gn-no-scrollbar max-h-44 overflow-auto whitespace-pre-wrap break-all rounded border border-gn-prompt-border bg-gn-bg-dark p-2 font-mono text-[10.5px] leading-snug text-gn-fg2">
                    {readResult}
                  </pre>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Merged display row: event stream + agent-list supplement. */
type McpRow = McpServerInfo & {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  enabled?: boolean
  /** Agent list `displayName` — human label next to the stable name. */
  displayName?: string
  /** Agent list `sourceLabel` — display overlay for the `source` enum. */
  sourceLabel?: string
  /** Session flags: OAuth pending / required config missing. */
  authRequired?: boolean
  setupRequired?: boolean
  /** Agent-side tool count (present even when `tools` is not). */
  toolCount?: number
  /** Tool list from the agent list response (session.tools); undefined
   *  when the wire carried none (→ 无工具信息). */
  tools?: McpToolInfo[]
  /** True when this row came (at least in part) from GET /api/mcp/list. */
  fromList: boolean
}

/** Status for display: the event stream wins; the session flags explain a
 *  list-only row that never reported a status. Undefined → 未连接/unknown. */
function rowStatus(row: McpRow): string | undefined {
  if (row.status) return row.status
  if (row.setupRequired) return 'setup_required'
  if (row.authRequired) return 'needs_auth'
  return undefined
}

/** Source for display: `sourceLabel` (e.g. "plugin: foo") over wire `source`. */
function rowSource(row: McpRow): string | undefined {
  return row.sourceLabel ?? row.source
}

/** Tool count of a row: the list when present, else the agent's count. */
function toolCountOf(row: McpRow): number | undefined {
  return row.tools ? row.tools.length : row.toolCount
}

/** 需要认证 / 需要配置 badges — why a server shows no tools. */
function McpFlags({ row }: { row: McpRow }) {
  return (
    <>
      {row.authRequired ? (
        <span
          className="shrink-0 rounded border border-gn-prompt-border px-1 text-[9px] leading-[14px] text-gn-orange"
          title="该服务器需要认证（agent session.authRequired）"
        >
          需要认证
        </span>
      ) : null}
      {row.setupRequired ? (
        <span
          className="shrink-0 rounded border border-gn-prompt-border px-1 text-[9px] leading-[14px] text-gn-yellow"
          title="该服务器缺少必填配置（agent session.setupRequired）"
        >
          需要配置
        </span>
      ) : null}
    </>
  )
}

function statusDot(status?: string): string {
  if (!status) return 'bg-gn-gutter'
  switch (status) {
    case 'ready':
      return 'bg-gn-green shadow-[0_0_6px_rgba(158,206,106,.5)]'
    case 'initializing':
      return 'bg-gn-yellow animate-pulse'
    case 'needs_auth':
      return 'bg-gn-orange'
    case 'setup_required':
    case 'setuprequired':
      return 'bg-gn-yellow'
    default:
      return 'bg-gn-red'
  }
}

function actionLabel(action: 'toggle' | 'remove' | 'auth'): string {
  switch (action) {
    case 'toggle':
      return '启停'
    case 'remove':
      return '删除'
    case 'auth':
      return '认证'
  }
}

/**
 * args input: space-separated words OR a JSON array of strings.
 * Returns the parsed array, undefined for empty input, or an error string.
 */
function parseArgsInput(raw: string): string[] | undefined | string {
  const t = raw.trim()
  if (!t) return undefined
  try {
    const parsed = JSON.parse(t) as unknown
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed
    }
  } catch {
    /* not JSON — fall through to whitespace split */
  }
  const parts = t.split(/\s+/).filter(Boolean)
  return parts.length > 0 ? parts : undefined
}

/**
 * env input: one KEY=value per line. Returns the map, {} for empty input,
 * or an error string for a malformed line.
 */
function parseEnvInput(raw: string): Record<string, string> | string {
  const t = raw.trim()
  if (!t) return {}
  const env: Record<string, string> = {}
  for (const line of t.split('\n')) {
    const l = line.trim()
    if (!l) continue
    const eq = l.indexOf('=')
    if (eq <= 0) return `环境变量行格式错误: ${l}（应为 KEY=value）`
    env[l.slice(0, eq).trim()] = l.slice(eq + 1).trim()
  }
  return env
}

/** MCP call/read result → display text（JSON 缩进；超长截断）。 */
const MCP_RESULT_MAX_CHARS = 6000
function formatResult(result: unknown): string {
  if (result === undefined) return '（空结果）'
  let text: string
  try {
    text =
      typeof result === 'string'
        ? result
        : JSON.stringify(result, null, 2) ?? String(result)
  } catch {
    text = String(result)
  }
  if (text.length > MCP_RESULT_MAX_CHARS) {
    text = `${text.slice(0, MCP_RESULT_MAX_CHARS)}\n…（截断，共 ${text.length} 字符）`
  }
  return text
}
