import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sliders,
  Terminal,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import { useChatStore, type McpServerInfo } from '../store/chat'
import { transport, type McpListServer, type McpToolInfo } from '../api/client'

/**
 * MCP server panel (x.ai/mcp/server_status + host /api/mcp/*) — web
 * counterpart of the TUI /mcps modal.
 *
 * Renders `rows` — the merged view of the event stream (mcp_server_status)
 * and GET /api/mcp/list. Single unified card list with real-time status,
 * server actions, configuration details, tool management, and debug console.
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
  const [copiedCode, setCopiedCode] = useState(false)

  // ── 交互/折叠状态 ──
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedTools, setCollapsedTools] = useState<Record<string, boolean>>({})

  // ── 添加服务器表单 ──
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

  const seenMcpVersion = useRef(mcpVersion)
  useEffect(() => {
    if (seenMcpVersion.current === mcpVersion) return
    seenMcpVersion.current = mcpVersion
    if (open) void refreshList()
  }, [open, mcpVersion, refreshList])

  /**
   * Merge rule: event-stream rows (mcp_server_status) win for status;
   * the agent-list result supplements config/source and adds rows the
   * stream has not reported yet. Single unified row list.
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
          displayName: l.displayName,
          sourceLabel: l.sourceLabel,
          authRequired: l.authRequired,
          setupRequired: l.setupRequired,
          toolCount: l.toolCount,
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

  // 统计数值
  const stats = useMemo(() => {
    let connected = 0
    let totalTools = 0
    for (const r of rows) {
      const st = rowStatus(r)
      if (st === 'ready' || st === 'connected') connected++
      totalTools += toolCountOf(r) ?? 0
    }
    return { connected, totalTools }
  }, [rows])

  // 搜索过滤
  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => {
      if (r.name.toLowerCase().includes(q)) return true
      if (r.displayName?.toLowerCase().includes(q)) return true
      if (r.command?.toLowerCase().includes(q)) return true
      if (r.url?.toLowerCase().includes(q)) return true
      if (r.tools?.some((t) => t.name.toLowerCase().includes(q) || t.displayName?.toLowerCase().includes(q))) {
        return true
      }
      return false
    })
  }, [rows, searchQuery])

  const runAction = async (
    name: string,
    action: 'toggle' | 'remove' | 'auth',
    fn: () => Promise<unknown>,
  ) => {
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
      setList((prev) => prev.map((s) => (s.name === name ? { ...s, enabled } : s)))
      useChatStore.setState({ statusText: `已${enabled ? '启用' : '禁用'} MCP 服务器 ${name}` })
    })

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
                tools: s.tools?.map((t) => (t.name === tool ? { ...t, enabled } : t)),
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
      const url =
        typeof r.url === 'string' && /^https?:\/\//i.test(r.url) ? r.url : undefined
      setAuthResult({ name, ...r, url })
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
      void refreshList()
    } catch (e) {
      setFormError(`添加失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAdding(false)
    }
  }

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

  /** 快捷调用某个工具：打开调用工具表单并预填参数 */
  const quickCallTool = (server: string, tool: string) => {
    setCallForm({ server, tool, args: '' })
    setCallError(undefined)
    setCallResult(undefined)
    setAddOpen(false)
    setReadOpen(false)
    setCallOpen(true)
  }

  const [copiedResult, setCopiedResult] = useState(false)

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center gn-modal-dim p-4"
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
        className="mt-6 flex w-full max-w-[680px] max-h-[85vh] flex-col gn-modal-panel shadow-2xl"
      >
        {/* ── 顶部 Header ────────────────────────────────────── */}
        <header className="gn-modal-header justify-between py-2.5">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-1.5">
              <Wrench size={15} className="text-gn-blue" aria-hidden />
              <span className="text-[13px] font-bold tracking-tight text-gn-fg">MCP servers</span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-gn-muted">
              <span className="rounded bg-gn-bg-highlight px-1.5 py-0.5 font-medium text-gn-fg2">
                {rows.length} 个服务器
              </span>
              {rows.length > 0 && (
                <span className="hidden sm:inline">
                  · {stats.connected} 就绪 · {stats.totalTools} 工具
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshList()}
              disabled={listLoading}
              className="flex items-center gap-1 rounded border border-gn-prompt-border/70 bg-gn-bg-dark/60 px-2 py-1 text-[11px] text-gn-muted transition-colors hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
              title="重新读取 host 的 MCP 配置"
            >
              <RefreshCw size={12} className={listLoading ? 'animate-spin' : ''} aria-hidden />
              <span>{listLoading ? '刷新中…' : '刷新列表'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
              aria-label="关闭"
              title="关闭 (Esc)"
            >
              <X size={15} aria-hidden />
            </button>
          </div>
        </header>

        {/* ── 连接中进度横幅 ─────────────────────────────────── */}
        {mcpInit && !(mcpInit.total > 0 && mcpInit.connected >= mcpInit.total) ? (
          <div className="border-b border-gn-prompt-border/50 bg-gn-bg-dark/80 px-4 py-2">
            <div className="flex items-center justify-between text-[11.5px]">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-gn-yellow animate-pulse" />
                <span className="font-medium text-gn-fg2">
                  {mcpInit.total > 0
                    ? `MCP 初始化中 · ${mcpInit.connected}/${mcpInit.total} 已连接`
                    : 'MCP 初始化中…（等待服务器计数）'}
                </span>
              </div>
              {mcpInit.total > 0 && (
                <span className="font-mono text-[10.5px] text-gn-muted">
                  {Math.round((mcpInit.connected / mcpInit.total) * 100)}%
                </span>
              )}
            </div>
            {mcpInit.total > 0 && (
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-gn-bg-highlight">
                <div
                  className="h-full rounded-full bg-gn-yellow transition-[width] duration-300"
                  style={{
                    width: `${Math.min(100, Math.round((mcpInit.connected / mcpInit.total) * 100))}%`,
                  }}
                />
              </div>
            )}
          </div>
        ) : null}

        {/* ── 全局错误/提示条 ───────────────────────────────── */}
        {listError ? (
          <div className="border-b border-gn-prompt-border/50 bg-gn-diff-del-bg/30 px-4 py-2 text-[11px] text-gn-red">
            {listError}
          </div>
        ) : null}

        {actionError ? (
          <div className="border-b border-gn-prompt-border/50 bg-gn-diff-del-bg/30 px-4 py-2 text-[11px] text-gn-red">
            {actionError}
          </div>
        ) : null}

        {/* ── 快速搜索过滤栏（多服务器时显示） ──────────────── */}
        {rows.length > 2 && (
          <div className="border-b border-gn-prompt-border/40 bg-gn-bg-dark/30 px-4 py-1.5">
            <div className="relative flex items-center">
              <Search size={12} className="absolute left-2 text-gn-muted" aria-hidden />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索 MCP 服务器名称、命令或工具…"
                className="w-full rounded border border-gn-prompt-border/60 bg-gn-bg-base/70 py-1 pr-7 pl-6.5 text-[11px] text-gn-fg placeholder:text-gn-muted/70 outline-none focus:border-gn-prompt-border-active"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 text-gn-muted hover:text-gn-fg"
                  title="清空搜索"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── 服务器卡片列表区 ───────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {!listError && rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Sliders size={32} className="text-gn-muted/40 mb-2" aria-hidden />
              <div className="text-[12.5px] font-medium text-gn-fg2">没有已配置的服务器</div>
              <div className="mt-1 text-[11px] text-gn-muted">
                点击下方「＋ 添加服务器」配置首个 MCP
              </div>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-gn-muted">
              未找到匹配「{searchQuery}」的 MCP 服务器
            </div>
          ) : (
            filteredRows.map((s) => {
              const busyThis = busy?.name === s.name
              const isBusy = (a: 'toggle' | 'remove' | 'auth') => busyThis && busy.action === a
              const enabled = s.enabled !== false
              const status = rowStatus(s)
              const source = rowSource(s)
              const toolCount = toolCountOf(s)
              const isToolsCollapsed = collapsedTools[s.name] ?? false

              return (
                <div
                  key={s.name}
                  className={`group rounded-lg border transition-all ${
                    enabled
                      ? 'border-gn-prompt-border/70 bg-gn-bg-dark/40 hover:border-gn-prompt-border'
                      : 'border-gn-prompt-border/40 bg-gn-bg-dark/20 opacity-80'
                  }`}
                >
                  {/* 卡片头部行 */}
                  <div className="flex items-start justify-between gap-3 p-3 pb-2.5">
                    <div className="min-w-0 flex-1">
                      {/* 第一行: 状态指示灯 + 名称 + 标签 + 状态文本 */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${statusDot(status)}`}
                          title={status ?? 'unknown'}
                        />
                        <span className="font-mono text-[13px] font-semibold text-gn-fg tracking-tight">
                          {s.name}
                        </span>

                        {s.displayName && s.displayName !== s.name && (
                          <span className="text-[11.5px] text-gn-fg2">
                            ({s.displayName})
                          </span>
                        )}

                        {s.fromList && (
                          <span
                            className="shrink-0 rounded border border-gn-prompt-border/80 bg-gn-bg-base/60 px-1.5 py-px text-[9.5px] leading-[13px] text-gn-cyan"
                            title="来自 GET /api/mcp/list（host 配置），非事件流"
                          >
                            agent-list
                          </span>
                        )}

                        <McpFlags row={s} />

                        <span className="ml-0.5 shrink-0 font-mono text-[10.5px] text-gn-muted">
                          {status ?? '未连接'}
                          {source ? ` · ${source}` : ''}
                        </span>
                      </div>

                      {/* 命令行 / URL / 环境变量展示 */}
                      <div className="mt-1.5 space-y-1">
                        {s.command ? (
                          <div
                            className="flex items-center gap-1.5 font-mono text-[11px] text-gn-muted bg-gn-bg-base/60 px-2 py-0.5 rounded border border-gn-prompt-border/40"
                            title={s.command}
                          >
                            <Terminal size={11} className="shrink-0 text-gn-gutter" aria-hidden />
                            <span className="truncate">
                              {s.command}
                              {s.args?.length ? ` ${s.args.join(' ')}` : ''}
                            </span>
                          </div>
                        ) : null}

                        {s.url ? (
                          <div
                            className="flex items-center gap-1.5 font-mono text-[11px] text-gn-muted bg-gn-bg-base/60 px-2 py-0.5 rounded border border-gn-prompt-border/40"
                            title={s.url}
                          >
                            <span className="text-gn-gutter">🌐</span>
                            <span className="truncate">{s.url}</span>
                          </div>
                        ) : null}

                        {s.env && Object.keys(s.env).length > 0 ? (
                          <div
                            className="truncate font-mono text-[10.5px] text-gn-gutter"
                            title={Object.keys(s.env).join(', ')}
                          >
                            env: {Object.keys(s.env).join(', ')}
                          </div>
                        ) : null}
                      </div>

                      {/* 错误与原因诊断 */}
                      {s.reason ? (
                        <div className="mt-1.5 rounded border border-gn-diff-del-bg/50 bg-gn-diff-del-bg/20 px-2 py-1 text-[11px] text-gn-red">
                          <span className="font-semibold">原因:</span> {s.reason}
                        </div>
                      ) : null}

                      {s.detail ? (
                        <div className="mt-1 whitespace-pre-wrap break-words rounded bg-gn-bg-base/80 p-2 font-mono text-[10.5px] leading-snug text-gn-muted border border-gn-prompt-border/30">
                          {s.detail}
                        </div>
                      ) : null}
                    </div>

                    {/* 右上角服务器操作按钮组 */}
                    <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                      <button
                        type="button"
                        disabled={busy != null || toolBusy != null}
                        onClick={() => void toggleServer(s.name, !enabled)}
                        className={`rounded border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                          enabled
                            ? 'border-gn-prompt-border bg-gn-bg-base/80 text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg'
                            : 'border-gn-green/40 bg-gn-green/10 text-gn-green hover:bg-gn-green/20'
                        }`}
                        title={enabled ? '禁用该服务器（/api/mcp-toggle）' : '启用该服务器（/api/mcp-toggle）'}
                      >
                        {isBusy('toggle') ? '…' : enabled ? '禁用' : '启用'}
                      </button>

                      <button
                        type="button"
                        disabled={busy != null || toolBusy != null}
                        onClick={() => void authServer(s.name)}
                        className={`rounded border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                          s.authRequired || status === 'needs_auth'
                            ? 'border-gn-orange/50 bg-gn-orange/10 text-gn-orange hover:bg-gn-orange/20'
                            : 'border-gn-prompt-border bg-gn-bg-base/80 text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
                        }`}
                        title="触发 OAuth 认证（/api/mcp-auth-trigger）"
                      >
                        {isBusy('auth') ? '…' : '认证'}
                      </button>

                      <button
                        type="button"
                        disabled={busy != null || toolBusy != null}
                        onClick={() => removeServer(s.name)}
                        className="rounded border border-gn-prompt-border/60 bg-gn-bg-base/60 p-1 text-gn-muted transition-colors hover:border-gn-red/50 hover:bg-gn-diff-del-bg/30 hover:text-gn-red disabled:opacity-50"
                        title="删除该服务器（/api/mcp-remove）"
                      >
                        {isBusy('remove') ? '…' : <Trash2 size={13} aria-hidden />}
                        <span className="sr-only">删除</span>
                      </button>
                    </div>
                  </div>

                  {/* 认证结果横幅展示 */}
                  {authResult && authResult.name === s.name && (
                    <div className="mx-3 mb-2.5 rounded border border-gn-cyan/30 bg-gn-cyan/5 p-2.5 text-[11.5px] leading-snug">
                      <div className="flex items-center gap-1.5 font-medium text-gn-cyan mb-1">
                        <ExternalLink size={12} />
                        <span>OAuth 认证信息</span>
                      </div>
                      {authResult.url ? (
                        <div className="break-all mt-1 flex items-center justify-between gap-2">
                          <span className="text-gn-muted">认证链接:</span>
                          <a
                            href={authResult.url}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate text-gn-cyan underline font-mono text-[11px] hover:text-gn-link"
                          >
                            {authResult.url}
                          </a>
                        </div>
                      ) : null}
                      {authResult.code ? (
                        <div className="mt-1 flex items-center justify-between gap-2">
                          <div className="break-all font-mono">认证码: {authResult.code}</div>
                          <button
                            type="button"
                            onClick={() => {
                              void navigator.clipboard?.writeText(authResult.code || '')
                              setCopiedCode(true)
                              setTimeout(() => setCopiedCode(false), 2000)
                            }}
                            className="flex items-center gap-1 rounded border border-gn-prompt-border bg-gn-bg-base px-1.5 py-0.5 text-[10px] text-gn-muted hover:text-gn-fg"
                            title="复制认证码"
                          >
                            {copiedCode ? <Check size={11} className="text-gn-green" /> : <Copy size={11} />}
                            <span>{copiedCode ? '已复制' : '复制'}</span>
                          </button>
                        </div>
                      ) : null}
                      {authResult.message ? (
                        <div className="mt-1 text-gn-fg2 break-all">{authResult.message}</div>
                      ) : null}
                      {!authResult.url && !authResult.code && !authResult.message ? (
                        <div className="text-gn-muted">已触发认证流程（无额外信息）</div>
                      ) : null}
                    </div>
                  )}

                  {/* 工具管理区域 */}
                  <div className="border-t border-gn-prompt-border/40 bg-gn-bg-base/40 px-3 py-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Wrench size={11} className="text-gn-muted" aria-hidden />
                        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-gn-fg2">
                          工具
                          {toolCount != null ? ` (${toolCount})` : ''}
                        </span>
                        {s.tools == null ? (
                          <span className="text-[11px] text-gn-muted">
                            无工具信息
                            {s.authRequired
                              ? '（需要认证后才会拉取工具）'
                              : s.setupRequired
                                ? '（需要配置后才会拉取工具）'
                                : ''}
                          </span>
                        ) : s.tools.length === 0 ? (
                          <span className="text-[11px] text-gn-muted">
                            该服务器没有工具
                          </span>
                        ) : null}
                      </div>

                      {s.tools && s.tools.length > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsedTools((prev) => ({ ...prev, [s.name]: !isToolsCollapsed }))
                          }
                          className="flex items-center gap-1 text-[10.5px] text-gn-muted hover:text-gn-fg"
                        >
                          <span>{isToolsCollapsed ? `展开 (${s.tools.length})` : '收起'}</span>
                          {isToolsCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                        </button>
                      )}
                    </div>

                    {/* 工具具体条目 */}
                    {s.tools && s.tools.length > 0 && !isToolsCollapsed && (
                      <div className="mt-2 max-h-64 overflow-y-auto divide-y divide-gn-prompt-border/20 rounded border border-gn-prompt-border/40 bg-gn-bg-dark/40">
                        {s.tools.map((t) => {
                          const tEnabled = t.enabled !== false
                          const isToolItemBusy = toolBusy?.server === s.name && toolBusy?.tool === t.name

                          return (
                            <div
                              key={t.name}
                              className="flex items-center justify-between gap-2 px-2.5 py-1.5 hover:bg-gn-bg-highlight/30 transition-colors"
                            >
                              <div className="flex items-center gap-2 min-w-0 flex-1">
                                <span
                                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                    tEnabled ? 'bg-gn-green' : 'bg-gn-gutter'
                                  }`}
                                  title={tEnabled ? '已启用' : '已禁用'}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <span
                                      className="font-mono text-[11px] font-medium text-gn-fg truncate"
                                      title={t.description ? `${t.name} — ${t.description}` : t.name}
                                    >
                                      {t.displayName ?? t.name}
                                    </span>
                                    {t.displayName && t.displayName !== t.name && (
                                      <span className="font-mono text-[10px] text-gn-muted truncate">
                                        ({t.name})
                                      </span>
                                    )}
                                  </div>
                                  {t.description && (
                                    <div className="text-[10px] text-gn-muted truncate leading-tight mt-0.5">
                                      {t.description}
                                    </div>
                                  )}
                                </div>
                              </div>

                              <div className="flex shrink-0 items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => quickCallTool(s.name, t.name)}
                                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                                  title={`在下方调试窗口中调试工具 ${t.name}`}
                                >
                                  <Play size={10} />
                                  <span>调试</span>
                                </button>
                                <button
                                  type="button"
                                  disabled={busy != null || toolBusy != null}
                                  onClick={() => void toggleTool(s.name, t.name, !tEnabled)}
                                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10.5px] transition-colors disabled:opacity-50 ${
                                    tEnabled
                                      ? 'text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
                                      : 'bg-gn-bg-highlight text-gn-fg'
                                  }`}
                                  title={`${tEnabled ? '禁用' : '启用'}工具 ${t.name}（/api/mcp/toggle-tool）`}
                                >
                                  {isToolItemBusy ? '…' : tEnabled ? '禁用' : '启用'}
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* ── 底部调试与添加工具栏 ───────────────────────────── */}
        <footer className="gn-modal-footer flex flex-col gap-2 bg-gn-bg-dark/40">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setAddOpen((v) => {
                    const next = !v
                    if (next) {
                      setCallOpen(false)
                      setReadOpen(false)
                    }
                    return next
                  })
                  setFormError(undefined)
                }}
                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  addOpen
                    ? 'bg-gn-bg-highlight text-gn-fg'
                    : 'text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
                }`}
              >
                <Plus size={12} className={addOpen ? 'rotate-45 transition-transform' : 'transition-transform'} />
                <span>{addOpen ? '收起添加表单' : '添加服务器'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setCallOpen((v) => {
                    const next = !v
                    if (next) {
                      setAddOpen(false)
                      setReadOpen(false)
                    }
                    return next
                  })
                  setCallError(undefined)
                  setCallResult(undefined)
                }}
                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  callOpen
                    ? 'bg-gn-bg-highlight text-gn-fg'
                    : 'text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
                }`}
              >
                <Play size={11} />
                <span>{callOpen ? '收起调用工具' : '调用工具'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setReadOpen((v) => {
                    const next = !v
                    if (next) {
                      setAddOpen(false)
                      setCallOpen(false)
                    }
                    return next
                  })
                  setReadError(undefined)
                  setReadResult(undefined)
                }}
                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  readOpen
                    ? 'bg-gn-bg-highlight text-gn-fg'
                    : 'text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
                }`}
              >
                <Terminal size={11} />
                <span>{readOpen ? '收起读取资源' : '读取资源'}</span>
              </button>
            </div>
          </div>

          {/* ── 展开: 添加服务器面板 ── */}
          {addOpen && (
            <div className="mt-1 max-h-[50vh] overflow-y-auto rounded-lg border border-gn-prompt-border/70 bg-gn-bg-base p-3 space-y-2.5">
              <div className="text-[11.5px] font-bold text-gn-fg">添加 MCP 服务器</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">name *</span>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="filesystem"
                    className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">command *</span>
                  <input
                    type="text"
                    value={form.command}
                    onChange={(e) => setForm({ ...form, command: e.target.value })}
                    placeholder="npx"
                    className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-gn-gutter">args</span>
                <input
                  type="text"
                  value={form.args}
                  onChange={(e) => setForm({ ...form, args: e.target.value })}
                  placeholder='空格分隔，或 JSON 数组，如 ["-y","pkg"]'
                  className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-gn-gutter">env</span>
                <textarea
                  value={form.env}
                  onChange={(e) => setForm({ ...form, env: e.target.value })}
                  placeholder={"每行 KEY=value"}
                  rows={2}
                  className="mt-0.5 w-full resize-y rounded border border-gn-prompt-border bg-gn-bg-dark px-2.5 py-1 font-mono text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                />
              </label>
              {formError ? (
                <div className="rounded border border-gn-diff-del-bg px-2 py-1 text-[11px] text-gn-red">
                  {formError}
                </div>
              ) : null}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={adding}
                  onClick={() => {
                    setAddOpen(false)
                    setFormError(undefined)
                  }}
                  className="rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={adding}
                  onClick={() => void submitAdd()}
                  className="rounded border border-gn-prompt-border bg-gn-bg-highlight px-3 py-1 text-[11px] font-medium text-gn-fg hover:bg-gn-bg-hover hover:border-gn-prompt-border-active disabled:opacity-50"
                >
                  {adding ? '添加中…' : '添加'}
                </button>
              </div>
            </div>
          )}

          {/* ── 展开: 调用工具面板 ── */}
          {callOpen && (
            <div className="mt-1 max-h-[50vh] overflow-y-auto rounded-lg border border-gn-prompt-border/70 bg-gn-bg-base p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="text-[11.5px] font-bold text-gn-fg">调试 MCP 工具调用</div>
                <button
                  type="button"
                  onClick={() => {
                    setCallOpen(false)
                    setCallError(undefined)
                    setCallResult(undefined)
                  }}
                  className="text-gn-muted hover:text-gn-fg"
                >
                  <X size={13} />
                </button>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">server *</span>
                  <select
                    value={callForm.server}
                    onChange={(e) => {
                      const server = e.target.value
                      setCallForm((f) => ({ ...f, server, tool: '' }))
                    }}
                    className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
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
                    className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-prompt-border-active"
                  />
                  <datalist id="mcp-call-tools">
                    {list
                      .find((s) => s.name === callForm.server)
                      ?.tools?.map((t) => <option key={t.name} value={t.name} />)}
                  </datalist>
                </label>
              </div>

              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-gn-gutter">arguments（可选 JSON）</span>
                <textarea
                  value={callForm.args}
                  onChange={(e) => setCallForm({ ...callForm, args: e.target.value })}
                  placeholder='{"path": "/tmp/x"}'
                  rows={2}
                  className="mt-0.5 w-full resize-y rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[11.5px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-prompt-border-active"
                />
              </label>

              {callError ? (
                <div className="rounded border border-gn-diff-del-bg px-2 py-1 text-[11px] text-gn-red">
                  {callError}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={calling}
                  onClick={() => {
                    setCallOpen(false)
                    setCallError(undefined)
                    setCallResult(undefined)
                  }}
                  className="rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={calling}
                  onClick={() => void submitCall()}
                  className="rounded border border-gn-prompt-border bg-gn-bg-highlight px-3 py-1 text-[11px] font-medium text-gn-fg hover:bg-gn-bg-hover hover:border-gn-prompt-border-active disabled:opacity-50"
                >
                  {calling ? '调用中…' : '调用'}
                </button>
              </div>

              {callResult ? (
                <div className="mt-2">
                  <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gn-gutter mb-1">
                    <span>调用结果</span>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(callResult)
                        setCopiedResult(true)
                        setTimeout(() => setCopiedResult(false), 2000)
                      }}
                      className="flex items-center gap-1 text-gn-muted hover:text-gn-fg"
                    >
                      {copiedResult ? <Check size={11} className="text-gn-green" /> : <Copy size={11} />}
                      <span>{copiedResult ? '已复制' : '复制结果'}</span>
                    </button>
                  </div>
                  <pre className="gn-no-scrollbar max-h-44 overflow-auto whitespace-pre-wrap break-all rounded border border-gn-prompt-border bg-gn-bg-dark p-2 font-mono text-[10.5px] leading-snug text-gn-fg2">
                    {callResult}
                  </pre>
                </div>
              ) : null}
            </div>
          )}

          {/* ── 展开: 读取资源面板 ── */}
          {readOpen && (
            <div className="mt-1 max-h-[50vh] overflow-y-auto rounded-lg border border-gn-prompt-border/70 bg-gn-bg-base p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="text-[11.5px] font-bold text-gn-fg">读取 MCP 资源</div>
                <button
                  type="button"
                  onClick={() => {
                    setReadOpen(false)
                    setReadError(undefined)
                    setReadResult(undefined)
                  }}
                  className="text-gn-muted hover:text-gn-fg"
                >
                  <X size={13} />
                </button>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">server *</span>
                  <select
                    value={readForm.server}
                    onChange={(e) => setReadForm((f) => ({ ...f, server: e.target.value }))}
                    className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
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
                    className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-prompt-border-active"
                  />
                </label>
              </div>

              {readError ? (
                <div className="rounded border border-gn-diff-del-bg px-2 py-1 text-[11px] text-gn-red">
                  {readError}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={reading}
                  onClick={() => {
                    setReadOpen(false)
                    setReadError(undefined)
                    setReadResult(undefined)
                  }}
                  className="rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={reading}
                  onClick={() => void submitRead()}
                  className="rounded border border-gn-prompt-border bg-gn-bg-highlight px-3 py-1 text-[11px] font-medium text-gn-fg hover:bg-gn-bg-hover hover:border-gn-prompt-border-active disabled:opacity-50"
                >
                  {reading ? '读取中…' : '读取'}
                </button>
              </div>

              {readResult ? (
                <div className="mt-2">
                  <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gn-gutter mb-1">
                    <span>资源内容</span>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(readResult)
                        setCopiedResult(true)
                        setTimeout(() => setCopiedResult(false), 2000)
                      }}
                      className="flex items-center gap-1 text-gn-muted hover:text-gn-fg"
                    >
                      {copiedResult ? <Check size={11} className="text-gn-green" /> : <Copy size={11} />}
                      <span>{copiedResult ? '已复制' : '复制内容'}</span>
                    </button>
                  </div>
                  <pre className="gn-no-scrollbar max-h-44 overflow-auto whitespace-pre-wrap break-all rounded border border-gn-prompt-border bg-gn-bg-dark p-2 font-mono text-[10.5px] leading-snug text-gn-fg2">
                    {readResult}
                  </pre>
                </div>
              ) : null}
            </div>
          )}
        </footer>
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
  displayName?: string
  sourceLabel?: string
  authRequired?: boolean
  setupRequired?: boolean
  toolCount?: number
  tools?: McpToolInfo[]
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
          className="shrink-0 rounded border border-gn-orange/60 bg-gn-orange/10 px-1.5 py-px text-[9.5px] leading-[13px] text-gn-orange"
          title="该服务器需要认证（agent session.authRequired）"
        >
          需要认证
        </span>
      ) : null}
      {row.setupRequired ? (
        <span
          className="shrink-0 rounded border border-gn-yellow/60 bg-gn-yellow/10 px-1.5 py-px text-[9.5px] leading-[13px] text-gn-yellow"
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
    case 'connected':
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
