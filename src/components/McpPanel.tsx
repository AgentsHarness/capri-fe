import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore, type McpServerInfo } from '../store/chat'
import type { McpListServer } from '../api/localTransport'

/**
 * MCP server panel (x.ai/mcp/server_status + host /api/mcp/*) — web
 * counterpart of the TUI /mcps modal.
 *
 * Upper half: 服务器状态 — the event-stream rows (mcp_server_status),
 * patched in place as notifications arrive; mcpVersion (tools_changed /
 * servers_updated) shows as a "已更新" hint in the footer.
 *
 * Lower half: 管理 — GET /api/mcp/list merges the configured servers into
 * the display (rows marked `agent-list`); per-row 启用/禁用 toggle
 * (/api/mcp-toggle), 删除 (/api/mcp-remove, window.confirm), 认证
 * (/api/mcp-auth-trigger — url/code shown inline), plus a collapsible
 * 添加服务器 form (/api/mcp-add). Merge rule: the event stream wins for
 * status, the list supplements config/source. Every host call degrades to
 * an inline error line — the read-only 服务器状态 view is never affected.
 */
export function McpPanel({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const mcpServers = useChatStore((s) => s.mcpServers)
  const mcpVersion = useChatStore((s) => s.mcpVersion)
  const mcpList = useChatStore((s) => s.mcpList)
  const mcpToggle = useChatStore((s) => s.mcpToggle)
  const mcpAdd = useChatStore((s) => s.mcpAdd)
  const mcpRemove = useChatStore((s) => s.mcpRemove)
  const mcpAuthTrigger = useChatStore((s) => s.mcpAuthTrigger)
  const panelRef = useRef<HTMLDivElement>(null)

  // ── 管理 section state ──────────────────────────────────────────────
  const [list, setList] = useState<McpListServer[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string>()
  const [busy, setBusy] = useState<{ name: string; action: 'toggle' | 'remove' | 'auth' } | null>(null)
  const [actionError, setActionError] = useState<string>()
  const [authResult, setAuthResult] = useState<{ name: string; url?: string; code?: string; message?: string } | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState({ name: '', command: '', args: '', env: '' })
  const [formError, setFormError] = useState<string>()
  const [adding, setAdding] = useState(false)
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
   * Merge rule: event-stream rows (mcp_server_status) win for status;
   * the agent-list result supplements config/source and adds rows the
   * stream has not reported yet.
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
    if (busy) return
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

  const removeServer = (name: string) => {
    if (busy) return
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
            {mcpServers.length} 个服务器
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
          {/* ── 上半区: 服务器状态（事件流，只读） ─────────────────── */}
          <div className="px-4 pt-2.5 pb-1 text-[10px] uppercase tracking-wider text-gn-gutter">
            服务器状态 · x.ai/mcp/server_status
          </div>
          {mcpServers.length === 0 ? (
            <div className="px-4 py-3 text-center text-[12px] text-gn-muted">
              尚未收到服务器状态通知
            </div>
          ) : (
            mcpServers.map((s) => (
              <div
                key={s.name}
                className="flex items-start gap-2.5 border-b border-gn-prompt-border/50 px-4 py-2"
              >
                <span
                  className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${statusDot(s.status)}`}
                  title={s.status ?? 'unknown'}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate font-mono text-[12.5px] text-gn-fg">
                      {s.name}
                    </span>
                    <span className="shrink-0 text-[11px] text-gn-muted">
                      {s.status ?? 'unknown'}
                      {s.source ? ` · ${s.source}` : ''}
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
              没有已配置的服务器（或 host 尚未实现 /api/mcp/list）
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
                        <span className="shrink-0 text-[11px] text-gn-muted">
                          {s.status ?? '未连接'}
                          {s.source ? ` · ${s.source}` : ''}
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
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                      <button
                        type="button"
                        disabled={busy != null}
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
                        disabled={busy != null}
                        onClick={() => void authServer(s.name)}
                        className="rounded border border-gn-prompt-border px-2 py-0.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
                        title="触发 OAuth 认证（/api/mcp-auth-trigger）"
                      >
                        {isBusy('auth') ? '…' : '认证'}
                      </button>
                      <button
                        type="button"
                        disabled={busy != null}
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
        </div>

        <footer className="rounded-b border-t border-gn-prompt-border px-4 py-2 text-[11px] text-gn-gutter">
          {mcpVersion > 0
            ? `工具列表已更新 ${mcpVersion} 次（x.ai/mcp/tools_changed） · `
            : ''}
          增删/启停后需重启会话（或让 agent 重新初始化 MCP）才生效
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
  /** True when this row came (at least in part) from GET /api/mcp/list. */
  fromList: boolean
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
