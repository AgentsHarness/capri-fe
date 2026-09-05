import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { transport } from '../api/client'
import type { SessionInfoExt } from '../api/types'
import { fmtTok, fmtTokBig } from '../format'
import { contextUrgencyColor } from '../theme/contextColor'
import { UsageInfoTabs } from './UsageInfoTabs'

/**
 * /context modal — web counterpart of the TUI `/context` command
 * (ContextInfoBlock). Every open issues a fresh `x.ai/session/info` call
 * (agent-side full snapshot with the context breakdown — the host's
 * thinner /api/session-info does not carry it), so the numbers are
 * authoritative at open time (loading / error / retry states included).
 *
 * Layout mirrors the TUI block: at-a-glance totals (two-decimal percent),
 * model name, categorical bar (system / messages / reasoning-overhead /
 * free), legend + tool-definition / category rows, the auto-compact
 * estimate line, and the `Turns · Tool calls · Compactions` footer. Unlike
 * the TUI's `precise_usage_percent` (which is not
 * clamped), the percent here is clamped to 100 to stay consistent with
 * the context chip and /session-info.
 */
export function ContextModal() {
  const open = useChatStore((s) => s.contextOpen)
  const close = useChatStore((s) => s.closeContext)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [data, setData] = useState<SessionInfoExt>()
  const panelRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)

  const fetchInfo = useCallback(async () => {
    const seq = ++reqSeq.current
    setLoading(true)
    setError(undefined)
    try {
      // 锁定打开弹窗时正在查看的会话：省略 sessionId 时 host 会填自己的
      // 活动会话（Bridge.XaiCall），多 tab / 查看别的会话时模型和数字都会
      // 取自那个会话。
      const raw = await transport.sessionInfoExt({
        sessionId: useChatStore.getState().sessionId ?? undefined,
      })
      const o =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {}
      const num = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
      const str = (v: unknown): string | undefined =>
        typeof v === 'string' && v ? v : undefined
      const ctxRaw = o.context
      const ctx =
        ctxRaw && typeof ctxRaw === 'object' && !Array.isArray(ctxRaw)
          ? (ctxRaw as Record<string, unknown>)
          : undefined
      const cats = Array.isArray(ctx?.usageCategories)
        ? (ctx!.usageCategories as Array<Record<string, unknown>>)
            .map((c) => ({
              label: str(c.label) ?? '—',
              tokens: num(c.tokens) ?? 0,
              detail: str(c.detail),
            }))
            .filter((c) => c.tokens > 0)
        : []
      const info: SessionInfoExt = {
        sessionId: str(o.sessionId),
        cwd: str(o.cwd),
        model: str(o.model),
        modelDisplayName: str(o.modelDisplayName),
        resolvedModelId: str(o.resolvedModelId),
        apiBackend: str(o.apiBackend),
        agentName: str(o.agentName),
        turns: num(o.turns),
        turnIndex: num(o.turnIndex),
      }
      if (ctx) {
        info.context = {
          used: num(ctx.used) ?? 0,
          total: num(ctx.total) ?? 0,
          systemPromptTokens: num(ctx.systemPromptTokens) ?? 0,
          toolDefinitionsCount: num(ctx.toolDefinitionsCount) ?? 0,
          toolDefinitionsTokens: num(ctx.toolDefinitionsTokens) ?? 0,
          compactionCount: num(ctx.compactionCount) ?? 0,
          turnCount: num(ctx.turnCount) ?? 0,
          toolCallCount: num(ctx.toolCallCount) ?? 0,
          messageCount: num(ctx.messageCount) ?? 0,
          messageTokens: num(ctx.messageTokens) ?? 0,
          freeTokens: num(ctx.freeTokens) ?? 0,
          usagePct: num(ctx.usagePct) ?? 0,
          autoCompactThresholdPercent: num(ctx.autoCompactThresholdPercent) ?? 85,
          usageCategories: cats,
        }
      }
      if (seq === reqSeq.current) setData(info)
    } catch (e) {
      if (seq === reqSeq.current) {
        setData(undefined)
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void fetchInfo()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, fetchInfo, close])

  if (!open) return null

  const ctx = data?.context
  const hasCtx = !!ctx && ctx.total > 0
  const used = ctx?.used ?? 0
  const total = ctx?.total ?? 0
  // TUI precise_usage_percent: two decimals from used/total — clamped to
  // 100 here (see header comment) — never render >100% transiently.
  const pct2 = hasCtx ? Math.min(100, (used / total) * 100) : undefined
  const modelLabel =
    data?.modelDisplayName || data?.model || 'unknown'

  // Category slices of the 100%-wide bar (TUI ContextInfoBlock cells):
  // system gray · messages primary · reasoning/overhead violet · free dim.
  const systemTokens = ctx?.systemPromptTokens ?? 0
  const messageTokens = ctx?.messageTokens ?? 0
  const overheadTokens = hasCtx ? Math.max(0, used - systemTokens - messageTokens) : 0
  const freeTokens = ctx?.freeTokens ?? 0
  const pctOf = (t: number) => (hasCtx ? Math.min(100, (t / total) * 100) : 0)
  const seg = (t: number) => ({ w: pctOf(t), show: t > 0 })

  const autoCompact = ctx
    ? (() => {
        const threshold = ctx.autoCompactThresholdPercent
        const thresholdTokens = Math.ceil((total * threshold) / 100)
        const remaining = Math.max(0, thresholdTokens - used)
        const triggered = ctx.usagePct >= threshold
        return { threshold, remaining, triggered }
      })()
    : undefined

  const legendRows: Array<{
    label: string
    tokens: number
    color: string
    detail?: string
  }> = [
    { label: 'System prompt', tokens: systemTokens, color: 'var(--color-gn-gray)' },
    { label: 'Messages', tokens: messageTokens, color: 'var(--color-gn-fg)' },
  ]
  if (overheadTokens > 0) {
    legendRows.push({
      label: 'Reasoning & overhead',
      tokens: overheadTokens,
      color: 'var(--color-gn-accent-verify)',
    })
  }
  legendRows.push({ label: 'Free', tokens: freeTokens, color: 'var(--color-gn-gray-dim)' })
  const infoRows: Array<{ label: string; tokens: number; color: string; detail?: string }> = [
    {
      label: 'Tool definitions',
      tokens: ctx?.toolDefinitionsTokens ?? 0,
      color: 'var(--color-gn-accent-skill)',
      detail:
        ctx && ctx.toolDefinitionsCount > 0
          ? `${ctx.toolDefinitionsCount} ${ctx.toolDefinitionsCount === 1 ? 'tool' : 'tools'}`
          : undefined,
    },
    ...(ctx?.usageCategories ?? []).map((c) => ({
      label: c.label,
      tokens: c.tokens,
      color: 'var(--color-gn-accent-skill)',
      detail: c.detail,
    })),
  ].filter((r) => r.tokens > 0)

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center gn-modal-dim p-4"
      role="dialog"
      aria-modal="true"
      aria-label="context usage"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="mt-8 w-full max-w-[480px] gn-modal-panel"
      >
        <header className="gn-modal-header">
          <span className="font-mono text-[13px] font-bold text-gn-fg">/context</span>
          <button
            type="button"
            onClick={close}
            className="ml-auto rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            <X size={14} aria-hidden />
          </button>
        </header>
        <UsageInfoTabs active="context" />

        <div className="py-1">
          {loading ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              加载中…
            </div>
          ) : error ? (
            <div className="px-4 py-5 text-center">
              <div className="text-[12px] text-gn-red">{error}</div>
              <button
                type="button"
                onClick={() => void fetchInfo()}
                className="mt-2 rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
              >
                重试
              </button>
            </div>
          ) : !hasCtx ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              暂无上下文明细（会话未就绪或宿主未返回 context）
            </div>
          ) : (
            <div className="space-y-3 px-4 py-3">
              {/* At-a-glance totals: fmt_tok_big + two-decimal percent. */}
              <div
                className="font-mono text-[12.5px] leading-none tabular-nums"
                style={{ color: contextUrgencyColor(pct2 ?? 0) }}
              >
                {fmtTokBig(used)} / {fmtTokBig(total)} tokens (
                {(pct2 ?? 0).toFixed(2)}%)
              </div>
              <div className="font-mono text-[10.5px] leading-none text-gn-gray-dim">
                {modelLabel}
                {ctx.compactionCount > 0 ? ` · compacted ×${ctx.compactionCount}` : ''}
              </div>

              {/* Categorical bar: system · messages · overhead · free. */}
              <div
                aria-hidden
                className="flex h-2 w-full overflow-hidden rounded-sm bg-gn-bg-highlight"
              >
                {seg(systemTokens).show && (
                  <span style={{ width: `${seg(systemTokens).w}%`, background: 'var(--color-gn-gray)' }} />
                )}
                {seg(messageTokens).show && (
                  <span style={{ width: `${seg(messageTokens).w}%`, background: 'var(--color-gn-fg)' }} />
                )}
                {seg(overheadTokens).show && (
                  <span
                    style={{
                      width: `${seg(overheadTokens).w}%`,
                      background: 'var(--color-gn-accent-verify)',
                    }}
                  />
                )}
                {seg(freeTokens).show && (
                  <span
                    style={{
                      width: `${seg(freeTokens).w}%`,
                      background: 'var(--color-gn-gray-dim)',
                    }}
                  />
                )}
              </div>

              {/* Legend rows (bar categories) + info rows (tools/categories). */}
              {[...legendRows, ...infoRows].map((r) => (
                <div
                  key={r.label}
                  className="flex items-baseline gap-2 font-mono text-[11px] leading-snug"
                >
                  <span
                    aria-hidden
                    className="inline-block h-[7px] w-[7px] shrink-0 translate-y-[-1px] rounded-[1px]"
                    style={{ background: r.color }}
                  />
                  <span className="min-w-0 flex-1 truncate text-gn-fg2">{r.label}</span>
                  {r.detail && (
                    <span className="shrink-0 text-[10px] text-gn-gutter">{r.detail}</span>
                  )}
                  <span className="shrink-0 tabular-nums text-gn-muted">
                    {fmtTok(r.tokens)} tokens · {pctOf(r.tokens).toFixed(1)}%
                  </span>
                </div>
              ))}

              {/* Auto-compact estimate (TUI ContextInfoBlock footer). */}
              {autoCompact && (
                <div
                  className={`border-t border-gn-prompt-border/50 pt-2 font-mono text-[11px] leading-snug ${
 autoCompact.triggered ? 'text-gn-warning' : 'text-gn-muted'
                  }`}
                >
                  {autoCompact.triggered
                    ? `Auto-compact triggers next turn (at ${autoCompact.threshold}%)`
                    : `Auto-compact at ${autoCompact.threshold}% · ~${fmtTokBig(autoCompact.remaining)} tokens remaining`}
                </div>
              )}

              {/* Footer stats — TUI ContextInfoBlock's last line. */}
              <div className="font-mono text-[11px] leading-snug text-gn-gutter">
                Turns: {ctx.turnCount} · Tool calls: {ctx.toolCallCount} · Compactions:{' '}
                {ctx.compactionCount}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
