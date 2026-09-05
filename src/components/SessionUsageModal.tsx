import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { transport } from '../api/client'
import type { SessionUsageData, SessionUsageModel } from '../api/types'
import { formatTurnDuration } from '../store/chat/format'
import { UsageInfoTabs } from './UsageInfoTabs'

/** Server cost scale: 1 USD is 10^10 ticks (TUI `USD_TICKS_PER_USD`). */
const USD_TICKS_PER_USD = 1e10

/**
 * /usage modal — web counterpart of the TUI `/usage` session-usage block
 * (`session_usage_block_text`). Distinct from the TopBar host-aggregate
 * UsageModal. Every open fetches `x.ai/session/usage` for the locked-in
 * sessionId (loading / error / retry included). Totals cover the ledger
 * lifetime (since session start, or since the last /resume).
 */
export function SessionUsageModal() {
  const open = useChatStore((s) => s.sessionUsageOpen)
  const close = useChatStore((s) => s.closeSessionUsage)
  const sessionId = useChatStore((s) => s.sessionId)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [data, setData] = useState<SessionUsageData>()
  const panelRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)

  const fetchUsage = useCallback(async () => {
    const sid = useChatStore.getState().sessionId
    if (!sid) {
      setData(undefined)
      setError(undefined)
      setLoading(false)
      return
    }
    const seq = ++reqSeq.current
    setLoading(true)
    setError(undefined)
    try {
      const usage = await transport.sessionUsage({ sessionId: sid })
      if (seq === reqSeq.current) setData(usage)
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
    setData(undefined)
    setError(undefined)
    void fetchUsage()
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
  }, [open, fetchUsage, close])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center gn-modal-dim p-4"
      role="dialog"
      aria-modal="true"
      aria-label="session usage"
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
          <span className="font-mono text-[13px] font-bold text-gn-fg">/usage</span>
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
        <UsageInfoTabs active="session-usage" />

        <div className="py-1">
          {!sessionId ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              暂无活动会话
            </div>
          ) : loading ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              加载中…
            </div>
          ) : error ? (
            <div className="px-4 py-5 text-center">
              <div className="text-[12px] text-gn-red">{error}</div>
              <button
                type="button"
                onClick={() => void fetchUsage()}
                className="mt-2 rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
              >
                重试
              </button>
            </div>
          ) : isEmptyUsage(data) ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              {data?.usageIsIncomplete
                ? '尚未记录用量，但追踪不完整，可能少计'
                : '本会话尚未产生模型调用'}
            </div>
          ) : (
            <SessionUsageBody data={data!} />
          )}
        </div>
      </div>
    </div>
  )
}

function SessionUsageBody({ data }: { data: SessionUsageData }) {
  const cached = data.cachedReadTokens ?? 0
  const reasoning = data.reasoningTokens ?? 0
  const models = data.modelUsage ? Object.entries(data.modelUsage) : []
  const rows: Array<{ label: string; value: string }> = [
    {
      label: 'input tokens',
      value: `${fmtCount(data.inputTokens ?? 0)} (${fmtCount(cached)} cached)`,
    },
    {
      label: 'output tokens',
      value: `${fmtCount(data.outputTokens ?? 0)} (${fmtCount(reasoning)} reasoning)`,
    },
    { label: 'total tokens', value: fmtCount(data.totalTokens ?? 0) },
    {
      label: 'model calls',
      value: `${fmtCount(data.modelCalls ?? 0)} · API time: ${formatTurnDuration(data.apiDurationMs ?? 0)}`,
    },
    { label: 'cost', value: fmtCost(data) },
  ]

  return (
    <>
      <div className="px-4 pb-1 pt-3 text-[10px] uppercase tracking-wider text-gn-gutter">
        Session usage (since start or last resume)
      </div>
      {rows.map((r, i) => (
        <div
          key={r.label}
          className={`flex items-start gap-3 px-4 py-2 ${i < rows.length - 1 || models.length > 1 || data.usageIsIncomplete ? 'border-b border-gn-prompt-border/50' : ''}`}
        >
          <span className="w-28 shrink-0 pt-px text-[10px] uppercase tracking-wider text-gn-gutter">
            {r.label}
          </span>
          <span className="min-w-0 flex-1 font-mono text-[12px] leading-snug text-gn-fg">
            {r.value}
          </span>
        </div>
      ))}
      {models.length > 1 && (
        <div className="px-4 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-gn-gutter">
            by model
          </div>
          {models.map(([model, m]) => (
            <div
              key={model}
              className="flex items-baseline gap-2 py-0.5 font-mono text-[12px] leading-snug"
            >
              <span className="min-w-0 flex-1 truncate text-gn-cyan">{model}</span>
              <span className="shrink-0 text-gn-fg2">
                {fmtCount(m.inputTokens ?? 0)} in / {fmtCount(m.outputTokens ?? 0)} out ·{' '}
                {fmtCost(m)}
              </span>
            </div>
          ))}
        </div>
      )}
      {data.usageIsIncomplete && (
        <div className="px-4 py-2 text-[10.5px] leading-snug text-gn-warning">
          用量不完整，可能少计
        </div>
      )}
    </>
  )
}

function isEmptyUsage(u?: SessionUsageData): boolean {
  if (!u) return true
  const calls = u.modelCalls ?? 0
  const models = u.modelUsage ? Object.keys(u.modelUsage).length : 0
  return calls === 0 && models === 0
}

function fmtCount(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** Absent cost is unknown, never free. Partial bills are labeled as such. */
function fmtCost(m: SessionUsageModel): string {
  if (m.costUsdTicks != null && Number.isFinite(m.costUsdTicks)) {
    return `$${(m.costUsdTicks / USD_TICKS_PER_USD).toFixed(4)}`
  }
  if (m.costIsPartial) return 'not available (not reported for some calls)'
  return 'not available (not reported)'
}
