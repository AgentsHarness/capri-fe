import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import { transport } from '../api/client'
import type { BillingConfigResponse, UsageReportData } from '../api/types'
import { fmtTok } from '../format'

/**
 * /usage modal — 宿主侧 token 用量聚合（POST /api/usage-report）+
 * billing credits（POST /api/billing）。打开时同时拉取；时间窗口切换只
 * 重拉用量聚合；每次打开都发新请求，数字以打开时刻为准（loading /
 * error / retry 状态齐全）。
 *
 * 聚合口径（宿主侧实现，非 x.ai 直通）：按窗口聚合各 session 回合终态
 * 的真实 usage（rewind 死分支照常计入），cacheHitRate = cachedRead /
 * input；billing 展示 creditUsagePercent 配额 + prepaidBalance 余额。
 */
export function UsageModal() {
  const open = useChatStore((s) => s.usageOpen)
  const close = useChatStore((s) => s.closeUsage)
  const panelRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)

  // ── billing credits ──────────────────────────────────────────────
  const [billing, setBilling] = useState<BillingConfigResponse>()
  const [billingLoading, setBillingLoading] = useState(false)
  const [billingError, setBillingError] = useState<string>()

  // ── usage-report 聚合 ─────────────────────────────────────────────
  const [windowKey, setWindowKey] = useState<WindowKey>('all')
  const [usage, setUsage] = useState<UsageReportData>()
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageError, setUsageError] = useState<string>()

  const fetchBilling = useCallback(async () => {
    setBillingLoading(true)
    setBillingError(undefined)
    try {
      setBilling(await transport.billing())
    } catch (e) {
      setBilling(undefined)
      setBillingError(e instanceof Error ? e.message : String(e))
    } finally {
      setBillingLoading(false)
    }
  }, [])

  const fetchUsage = useCallback(async (win: WindowKey) => {
    const seq = ++reqSeq.current
    setUsageLoading(true)
    setUsageError(undefined)
    try {
      const opts: { from?: number } = {}
      if (win !== 'all') opts.from = Math.floor(Date.now() / 1000) - WINDOW_SECONDS[win]
      const r = await transport.usageReport(opts)
      if (seq === reqSeq.current) setUsage(r)
    } catch (e) {
      if (seq === reqSeq.current) {
        setUsage(undefined)
        setUsageError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (seq === reqSeq.current) setUsageLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setBilling(undefined)
    setBillingError(undefined)
    setUsage(undefined)
    setUsageError(undefined)
    void fetchBilling()
    void fetchUsage(windowKey)
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
    // 窗口切换走 onWindow 按钮（不重挂本 effect，避免重拉 billing）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fetchBilling, fetchUsage, close])

  const switchWindow = (key: WindowKey) => {
    setWindowKey(key)
    void fetchUsage(key)
  }

  if (!open) return null

  const total = usage?.total
  const models = usage?.byModel
    ? Object.entries(usage.byModel).sort(
        (a, b) => (b[1].totalTokens ?? 0) - (a[1].totalTokens ?? 0),
      )
    : []
  const billingConfig = billing?.config

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="usage"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="mt-8 w-full max-w-[620px] rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl outline-none"
      >
        <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
          <span className="font-mono text-[13px] font-bold text-gn-fg">/usage</span>
          <button
            type="button"
            onClick={() => {
              void fetchBilling()
              void fetchUsage(windowKey)
            }}
            disabled={billingLoading || usageLoading}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
            title="重新拉取 billing + 用量聚合"
          >
            {billingLoading || usageLoading ? '刷新中…' : '刷新'}
          </button>
          <button
            type="button"
            onClick={close}
            className="rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            esc
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto py-1">
          {/* ── billing credits ─────────────────────────────────────── */}
          <Section title="credits" hint="x.ai/billing">
            {billingLoading ? (
              <div className="px-4 py-3 text-[12px] text-gn-muted">加载中…</div>
            ) : billingError ? (
              <div className="px-4 py-3">
                <div className="text-[12px] text-gn-red">{billingError}</div>
                <button
                  type="button"
                  onClick={() => void fetchBilling()}
                  className="mt-2 rounded border border-gn-prompt-border px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                >
                  重试
                </button>
              </div>
            ) : (
              <CreditsRows config={billingConfig} tier={billing?.subscriptionTier} onDemand={billing?.onDemandEnabled} />
            )}
          </Section>

          {/* ── token 用量聚合 ──────────────────────────────────────── */}
          <Section
            title="usage"
            hint={`POST /api/usage-report · 全会话真实 usage · rewind 分支照常计入`}
          >
            {/* 时间窗口 segmented control */}
            <div className="flex items-center gap-1 px-4 pt-3">
              <span className="mr-1 text-[10px] uppercase tracking-wider text-gn-gutter">窗口</span>
              {WINDOWS.map((w) => (
                <button
                  key={w.key}
                  type="button"
                  disabled={usageLoading}
                  onClick={() => switchWindow(w.key)}
                  className={`rounded px-2 py-0.5 text-[11px] disabled:opacity-50 ${
                    windowKey === w.key
                      ? 'bg-gn-bg-highlight text-gn-fg border border-gn-prompt-border'
                      : 'text-gn-muted border border-transparent hover:border-gn-prompt-border hover:text-gn-fg'
                  }`}
                >
                  {w.label}
                </button>
              ))}
              <span className="ml-auto text-[10px] text-gn-gutter">
                {usage ? `${usage.sessions ?? 0} 会话 · ${fmtTok(total?.turns ?? 0)} 回合` : ''}
              </span>
            </div>

            {usageLoading && !usage ? (
              <div className="px-4 py-6 text-center text-[12px] text-gn-muted">加载中…</div>
            ) : usageError ? (
              <div className="px-4 py-5 text-center">
                <div className="text-[12px] text-gn-red">{usageError}</div>
                <button
                  type="button"
                  onClick={() => void fetchUsage(windowKey)}
                  className="mt-2 rounded border border-gn-prompt-border px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                >
                  重试
                </button>
              </div>
            ) : !usage || !total ? (
              <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
                暂无数据（窗口内没有回合终态 usage）
              </div>
            ) : (
              <>
                {/* 总览：token 计量 + 命中率条 */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-4 pt-3 sm:grid-cols-3">
                  <Stat label="总 token" value={fmtTok(total.totalTokens ?? 0)} />
                  <Stat label="输入" value={fmtTok(total.inputTokens ?? 0)} />
                  <Stat label="输出" value={fmtTok(total.outputTokens ?? 0)} />
                  <Stat label="缓存命中读" value={fmtTok(total.cachedReadTokens ?? 0)} />
                  <Stat label="缓存写入" value={fmtTok(total.cacheCreationTokens ?? 0)} />
                  <Stat label="思考 token" value={fmtTok(total.reasoningTokens ?? 0)} />
                  <Stat label="模型调用" value={String(total.modelCalls ?? 0)} />
                  <Stat label="回合数" value={String(total.turns ?? 0)} />
                  <Stat label="会话数" value={String(usage.sessions ?? 0)} />
                </div>
                <HitRateBar rate={total.cacheHitRate} label="缓存命中率" />

                {/* 按模型表格 */}
                <div className="px-4 pb-2 pt-3">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-gn-gutter">
                    按模型
                  </div>
                  {models.length === 0 ? (
                    <div className="py-2 text-[12px] text-gn-muted">无模型分组数据</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-[11.5px]">
                        <thead>
                          <tr className="text-left text-[10px] uppercase tracking-wider text-gn-gutter">
                            <th className="py-1 pr-2 font-normal">model</th>
                            <th className="py-1 pr-2 text-right font-normal">input</th>
                            <th className="py-1 pr-2 text-right font-normal">output</th>
                            <th className="py-1 pr-2 text-right font-normal">total</th>
                            <th className="py-1 pr-2 text-right font-normal">cached</th>
                            <th className="py-1 pr-2 text-right font-normal">hit</th>
                            <th className="py-1 text-right font-normal">calls</th>
                          </tr>
                        </thead>
                        <tbody>
                          {models.map(([model, st]) => (
                            <tr key={model} className="border-t border-gn-prompt-border/40">
                              <td className="py-1 pr-2 font-mono text-gn-cyan">{model}</td>
                              <td className="py-1 pr-2 text-right font-mono text-gn-fg2">{fmtTok(st.inputTokens ?? 0)}</td>
                              <td className="py-1 pr-2 text-right font-mono text-gn-fg2">{fmtTok(st.outputTokens ?? 0)}</td>
                              <td className="py-1 pr-2 text-right font-mono text-gn-fg">{fmtTok(st.totalTokens ?? 0)}</td>
                              <td className="py-1 pr-2 text-right font-mono text-gn-fg2">{fmtTok(st.cachedReadTokens ?? 0)}</td>
                              <td className="py-1 pr-2 text-right font-mono text-gn-green">{fmtPct(st.cacheHitRate)}</td>
                              <td className="py-1 text-right font-mono text-gn-fg2">{st.modelCalls ?? 0}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}

const WINDOW_SECONDS: Record<Exclude<WindowKey, 'all'>, number> = {
  '24h': 24 * 3600,
  '7d': 7 * 24 * 3600,
  '30d': 30 * 24 * 3600,
}

const WINDOWS = [
  { key: 'all', label: '全部' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7天' },
  { key: '30d', label: '30天' },
] as const

type WindowKey = (typeof WINDOWS)[number]['key']

/** 区块容器：标题行 + 内容。 */
function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-gn-prompt-border/60 pb-3 last:border-b-0">
      <div className="flex items-baseline gap-2 px-4 pt-3">
        <span className="text-[10px] uppercase tracking-wider text-gn-gutter">{title}</span>
        <span className="text-[10.5px] text-gn-muted/80">{hint}</span>
      </div>
      {children}
    </section>
  )
}

/** 总览格子。 */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-gn-gutter">{label}</div>
      <div className="font-mono text-[13px] text-gn-fg">{value}</div>
    </div>
  )
}

/** 命中率进度条（0–1 → 百分比宽度；无数据时整条灰）。 */
function HitRateBar({ rate, label }: { rate?: number; label: string }) {
  const pct = rate != null && Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) * 100 : null
  const color = pct == null ? 'bg-gn-muted/40' : pct >= 90 ? 'bg-gn-green' : pct >= 70 ? 'bg-gn-yellow' : 'bg-gn-red'
  return (
    <div className="px-4 pt-3">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-gn-gutter">{label}</span>
        <span className="font-mono text-[12px] text-gn-fg">{fmtPct(rate)}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gn-bg-highlight">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct ?? 0}%` }} />
      </div>
    </div>
  )
}

/** billing credits 行（字段防御性解析，缺啥不显示啥）。 */
function CreditsRows({
  config,
  tier,
  onDemand,
}: {
  config?: BillingConfigResponse['config']
  tier?: string
  onDemand?: boolean
}) {
  if (!config || Object.keys(config).length === 0) {
    return <div className="px-4 py-3 text-[12px] text-gn-muted">无 billing 配置（未登录或旧 agent）</div>
  }
  const usagePct = num(config.creditUsagePercent)
  const balance = num(config.prepaidBalance?.val)
  const period = config.currentPeriod
  const rows: Array<{ label: string; value: React.ReactNode }> = []
  if (usagePct != null) {
    rows.push({
      label: '已用配额',
      value: (
        <span className="flex items-center gap-2">
          <span className="font-mono text-gn-fg">{usagePct.toFixed(1)}%</span>
          <span className="h-1.5 w-28 overflow-hidden rounded-full bg-gn-bg-highlight">
            <span
              className={`block h-full rounded-full ${usagePct >= 90 ? 'bg-gn-red' : usagePct >= 70 ? 'bg-gn-yellow' : 'bg-gn-green'}`}
              style={{ width: `${Math.max(0, Math.min(100, usagePct))}%` }}
            />
          </span>
        </span>
      ),
    })
  }
  if (balance != null) {
    rows.push({ label: '余额', value: <span className="font-mono text-gn-fg">{fmtUsd(balance)}</span> })
  }
  if (tier) rows.push({ label: '订阅层级', value: tier })
  if (onDemand != null) rows.push({ label: '按需计费', value: onDemand ? '已开启' : '未开启' })
  if (period?.start || period?.end) {
    rows.push({
      label: '周期',
      value: (
        <span className="font-mono text-gn-fg2">
          {period.start ? new Date(period.start).toLocaleDateString() : '—'}
          {' ~ '}
          {period.end ? new Date(period.end).toLocaleDateString() : '—'}
        </span>
      ),
    })
  }
  if (rows.length === 0) {
    return <div className="px-4 py-3 text-[12px] text-gn-muted">billing 响应无可用字段</div>
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-4 pt-2 sm:grid-cols-3">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="text-[10px] uppercase tracking-wider text-gn-gutter">{r.label}</div>
          <div className="text-[13px] text-gn-fg">{r.value}</div>
        </div>
      ))}
    </div>
  )
}

/** 0–1 → "xx.x%"；缺失 → "—"。 */
function fmtPct(v?: number): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(1)}%`
}

/** 美分 → "$x.xx"；缺失 → "—"。 */
function fmtUsd(cents?: number): string {
  if (cents == null || !Number.isFinite(cents)) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

/** Finite number helper（可选字段防御）。 */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
