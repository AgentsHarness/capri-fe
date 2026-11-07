import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Globe,
  Play,
  Terminal,
  Trash2,
  Wrench,
} from 'lucide-react'
import { mcpTone } from '../../../../store/chat/mcpStatus'
import {
  rowSource,
  rowStatus,
  toolCountOf,
  toolMatchesQuery,
  type McpRow,
} from '../../../../lib/mcpPanel'

type McpServerCardProps = {
  row: McpRow
  busy: { name: string; action: 'toggle' | 'remove' | 'auth' } | null
  toolBusy: { server: string; tool: string } | null
  authResult: { name: string; url?: string; code?: string; message?: string } | null
  copiedCode: boolean
  onCopyCode: (code: string) => void
  collapsedTools: Record<string, boolean>
  onToggleTools: (name: string, collapsed: boolean) => void
  query: string
  onToggleServer: (name: string, enabled: boolean) => void
  onAuthServer: (name: string) => void
  onRemoveServer: (name: string) => void
  onToggleTool: (server: string, tool: string, enabled: boolean) => void
  onQuickCallTool: (server: string, tool: string) => void
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
  const tone = mcpTone(status)
  if (tone === 'ok') return 'bg-gn-green shadow-[0_0_6px_rgba(158,206,106,.5)]'
  if (tone === 'auth') return 'bg-gn-orange'
  if (tone === 'error') return 'bg-gn-red'
  if (tone === 'unknown') return 'bg-gn-gutter'
  // pending：握手中闪烁，待配置常亮。
  return status === 'setup_required' || status === 'setuprequired'
    ? 'bg-gn-yellow'
    : 'bg-gn-yellow animate-pulse'
}

/** 单个 MCP 服务器卡片：状态、配置、操作按钮、认证结果与工具列表。 */
export function McpServerCard({
  row: s,
  busy,
  toolBusy,
  authResult,
  copiedCode,
  onCopyCode,
  collapsedTools,
  onToggleTools,
  query,
  onToggleServer,
  onAuthServer,
  onRemoveServer,
  onToggleTool,
  onQuickCallTool,
}: McpServerCardProps) {
              const busyThis = busy?.name === s.name
              const isBusy = (a: 'toggle' | 'remove' | 'auth') => busyThis && busy.action === a
              const enabled = s.enabled !== false
              const status = rowStatus(s)
              const tone = mcpTone(status)
              // 诊断框只跟档位走：健康行的 `reason` 是成功原因码
              // （initialized / config_changed / restart_succeeded），不是错误。
              const diagTone: 'error' | 'auth' | 'none' =
                tone === 'error' || tone === 'auth' ? tone : 'none'
              const source = rowSource(s)
              const toolCount = toolCountOf(s)
              // 工具列表默认收起；搜索命中工具名相当于点名要看它，自动展开该
              // 行（用户手动展开/收起过该行后以手动结果为准）。
              const toolQueryHit =
                query.length > 0 && (s.tools?.some((t) => toolMatchesQuery(t, query)) ?? false)
              const isToolsCollapsed = collapsedTools[s.name] ?? !toolQueryHit

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
                          title={
                            s.reason
                              ? `${status ?? 'unknown'} · ${s.reason}`
                              : (status ?? 'unknown')
                          }
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
                            <Globe size={11} className="shrink-0 text-gn-gutter" aria-hidden />
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

                      {/* 诊断：只有异常态才报红（reason 是转移原因码，成功也带） */}
                      {diagTone !== 'none' && s.reason ? (
                        <div
                          className={`mt-1.5 rounded border px-2 py-1 text-[11px] ${
                            diagTone === 'error'
                              ? 'border-gn-diff-del-bg/50 bg-gn-diff-del-bg/20 text-gn-red'
                              : 'border-gn-orange/40 bg-gn-orange/10 text-gn-orange'
                          }`}
                        >
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
                        onClick={() => void onToggleServer(s.name, !enabled)}
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
                        onClick={() => void onAuthServer(s.name)}
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
                        onClick={() => onRemoveServer(s.name)}
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
                            onClick={() => onCopyCode(authResult.code || '')}
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
                            onToggleTools(s.name, !isToolsCollapsed)
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
                                  onClick={() => onQuickCallTool(s.name, t.name)}
                                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                                  title={`在下方调试窗口中调试工具 ${t.name}`}
                                >
                                  <Play size={10} />
                                  <span>调试</span>
                                </button>
                                <button
                                  type="button"
                                  disabled={busy != null || toolBusy != null}
                                  onClick={() => void onToggleTool(s.name, t.name, !tEnabled)}
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
}
