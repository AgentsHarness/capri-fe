import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
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
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
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

  const fetchUsage = useCallback(async (win: WindowKey, custom?: CustomRange) => {
    const seq = ++reqSeq.current
    setUsageLoading(true)
    setUsageError(undefined)
    try {
      const opts: { from?: number; to?: number } = {}
      if (win === 'custom') {
        if (custom?.from) opts.from = custom.from
        if (custom?.to) opts.to = custom.to
      } else if (win !== 'all') {
        opts.from = Math.floor(Date.now() / 1000) - WINDOW_SECONDS[win]
      }
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
    if (key === 'custom') {
      const now = Date.now()
      const from = customFrom || toDateInput(now - 30 * 24 * 3600 * 1000)
      const to = customTo || toDateInput(now)
      setCustomFrom(from)
      setCustomTo(to)
      void fetchUsage(key, { from: dateInputToSec(from), to: endOfDaySec(to) })
      return
    }
    void fetchUsage(key)
  }

  // refetchCurrent 按当前窗口重拉：自定窗口要带上输入框里的区间，否则刷新/
  // 重试会退化成「全量」，与界面上显示的窗口不一致。
  const refetchCurrent = useCallback(() => {
    if (windowKey === 'custom') {
      void fetchUsage('custom', { from: dateInputToSec(customFrom), to: endOfDaySec(customTo) })
      return
    }
    void fetchUsage(windowKey)
  }, [windowKey, customFrom, customTo, fetchUsage])

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
      className="fixed inset-0 z-50 flex items-start justify-center gn-modal-dim p-4"
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
        className="mt-8 w-full max-w-[620px] gn-modal-panel"
      >
        <header className="gn-modal-header">
          <span className="font-mono text-[13px] font-bold text-gn-fg">/usage</span>
          <button
            type="button"
            onClick={() => {
              void fetchBilling()
              refetchCurrent()
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
            className="rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto">
          {/* ── billing credits ─────────────────────────────────────── */}
          <Section title="credits">
            {billingLoading ? (
              <div className="px-4 py-3 text-[12px] text-gn-muted">加载中…</div>
            ) : billingError ? (
              <div className="px-4 py-3">
                <div className="text-[12px] text-gn-red">{billingError}</div>
                <button
                  type="button"
                  onClick={() => void fetchBilling()}
                  className="mt-2 rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
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
            hint={`rewind 分支照常计入`}
          >
            {/* 时间窗口 segmented control */}
            <div className="flex flex-wrap items-center gap-1 px-4 pt-3">
              <span className="mr-1 text-[10px] uppercase tracking-wider text-gn-gutter">窗口</span>
              {WINDOWS.map((w) => (
                <button
                  key={w.key}
                  type="button"
                  disabled={usageLoading}
                  onClick={() => switchWindow(w.key)}
                  className={`rounded px-2 py-0.5 text-[11px] disabled:opacity-50 ${ windowKey === w.key ? 'bg-gn-bg-highlight text-gn-fg' : 'text-gn-muted hover:text-gn-fg' }`}
                >
                  {w.label}
                </button>
              ))}
              <span className="ml-auto text-[10px] text-gn-gutter">
                {usage ? `${usage.sessions ?? 0} 会话 · ${fmtTok(total?.turns ?? 0)} 回合` : ''}
              </span>
            </div>

            {/* 自定义区间：任意起止日期（宿主按事件时刻过滤，不受会话清理期限影响） */}
            {windowKey === 'custom' && (
              <div className="flex flex-wrap items-center gap-2 px-4 pt-2">
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || undefined}
                  disabled={usageLoading}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="rounded border border-gn-prompt-border bg-gn-bg px-1.5 py-0.5 text-[11px] text-gn-fg disabled:opacity-50"
                  aria-label="起始日期"
                />
                <span className="text-[11px] text-gn-muted">~</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  disabled={usageLoading}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="rounded border border-gn-prompt-border bg-gn-bg px-1.5 py-0.5 text-[11px] text-gn-fg disabled:opacity-50"
                  aria-label="结束日期"
                />
                <button
                  type="button"
                  disabled={usageLoading || !customFrom}
                  onClick={() => void fetchUsage('custom', { from: dateInputToSec(customFrom), to: endOfDaySec(customTo) })}
                  className="rounded px-2 py-0.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
                >
                  查询
                </button>
              </div>
            )}

            {/* 覆盖区间：窗口是「要的范围」，覆盖是「数据实际到哪」。台账之前的
                版本里两者都会被 agent 的 30 天会话清理截断，"全部"因此名不副实，
                这里如实标注让数字可被正确解读。 */}
            {usage && usage.coverageFrom ? (
              <div className="px-4 pt-1.5 text-[10px] text-gn-gutter">
                数据覆盖 {fmtDay(usage.coverageFrom)}
                {usage.coverageTo ? ` ~ ${fmtDay(usage.coverageTo)}` : ''}
                {isCleanupBoundary(usage.coverageFrom)
                  ? '（更早的会话文件已被 agent 的 30 天清理删除）'
                  : ''}
              </div>
            ) : null}

            {usageLoading && !usage ? (
              <div className="px-4 py-6 text-center text-[12px] text-gn-muted">加载中…</div>
            ) : usageError ? (
              <div className="px-4 py-5 text-center">
                <div className="text-[12px] text-gn-red">{usageError}</div>
                <button
                  type="button"
                  onClick={refetchCurrent}
                  className="mt-2 rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
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

const WINDOW_SECONDS: Record<Exclude<WindowKey, 'all' | 'custom'>, number> = {
  '24h': 24 * 3600,
  '7d': 7 * 24 * 3600,
  '30d': 30 * 24 * 3600,
}

const WINDOWS = [
  { key: 'all', label: '全部' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7天' },
  { key: '30d', label: '30天' },
  { key: 'custom', label: '自定' },
] as const

type WindowKey = (typeof WINDOWS)[number]['key']

/** 自定义区间（unix 秒；缺省端由宿主按「无下限 / 当前时刻」处理）。 */
type CustomRange = { from?: number; to?: number }

/** Date → `<input type="date">` 要的 YYYY-MM-DD（本地时区）。 */
function toDateInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** YYYY-MM-DD（本地零点）→ unix 秒；空串/非法 → undefined。 */
function dateInputToSec(v: string): number | undefined {
  if (!v) return undefined
  const ms = new Date(`${v}T00:00:00`).getTime()
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/** YYYY-MM-DD 的当天末尾（本地 23:59:59）→ unix 秒，让区间含结束日全天。 */
function endOfDaySec(v: string): number | undefined {
  const start = dateInputToSec(v)
  return start == null ? undefined : start + 86400 - 1
}

/** unix 秒 → "YYYY-MM-DD"（覆盖区间标注用）。 */
function fmtDay(sec: number): string {
  return toDateInput(sec * 1000)
}

/**
 * 最早的用量数据是否正好卡在 agent 的 30 天清理边界上（29~31 天前）。
 *
 * 这是「旧数据被清理过」的可观测特征：数据起点落在清理期限附近，而不是
 * 恰好等于用户开始使用的日期。命中才提示清理，避免在数据本来就只这么长
 * 的情况下编造「已被删除」——那种说法无法从响应里证实。
 */
function isCleanupBoundary(coverageFromSec: number): boolean {
  const ageDays = (Date.now() / 1000 - coverageFromSec) / 86400
  return ageDays >= 29 && ageDays <= 31
}

/** 区块容器：标题行 + 内容。 */
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-gn-prompt-border/60 pb-3 last:border-b-0">
      <div className="flex items-baseline gap-2 px-4 pt-3">
        <span className="text-[10px] uppercase tracking-wider text-gn-gutter">{title}</span>
        {hint && <span className="text-[10.5px] text-gn-muted/80">{hint}</span>}
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
