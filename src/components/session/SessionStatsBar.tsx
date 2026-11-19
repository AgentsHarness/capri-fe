import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Database, Timer } from 'lucide-react'
import { useChatStore } from '../../store/chat'
import { formatTurnDuration } from '../../store/chat'
import { turnIsLive } from '../../store/chat/turnStatus'
import { fmtTok } from '../../format'
import { COLUMN_PAD_X_CLASS, CONTENT_COLUMN_CLASS } from '../../theme/layout'
import { ChipDropdown } from '../ui/ChipDropdown'
import type { SessionStats } from '../../api/types'

/** 回合进行中的统计刷新周期：host 只在 updates.jsonl 变化时重扫（32 MB
 * 会话约 0.2 s），5 s 能跟上步数/工具耗时变化，又不让长会话频繁全量扫描。 */
const LIVE_POLL_MS = 5000
/** 回合刚开始时文件里还没多少内容，首拍稍晚一点。 */
const LIVE_POLL_FIRST_MS = 3000

/**
 * 统计条的读数口径（桌面长条与移动端 chips 共用）：缺数据的指标为
 * null，由调用方决定是隐藏分段还是显示 '—'。
 */
type StatsReadout = {
  turnsSteps: string
  llm: string | null
  tool: string | null
  firstToken: string | null
  tokRate: string | null
  hitPct: number | null
  totalTokens: number
  uncachedInput: number
}

function readStats(stats: SessionStats): StatsReadout {
  const dur = (ms: number | undefined): string | null =>
    ms != null && ms > 0 ? formatTurnDuration(ms) : null
  const tokRate = (tps: number | undefined): string | null => {
    if (tps == null || tps <= 0) return null
    return tps >= 1000 ? `${(tps / 1000).toFixed(1)}K tok/s` : `${Math.round(tps)} tok/s`
  }
  return {
    turnsSteps: `${stats.turns} 轮 ${stats.steps} 步`,
    llm: dur(stats.llmDurationMs),
    tool: dur(stats.toolDurationMs),
    firstToken:
      stats.firstTokenAvgMs != null && stats.firstTokenAvgMs > 0
        ? `${Math.round(stats.firstTokenAvgMs / 1000)} s`
        : null,
    tokRate: tokRate(stats.tokensPerSec),
    hitPct: stats.cacheHitRate > 0 ? Math.round(stats.cacheHitRate * 100) : null,
    // 老 host 可能只给 input/output；total 缺失时按二者之和兜底。
    totalTokens: stats.totalTokens || stats.inputTokens + stats.outputTokens,
    uncachedInput: Math.max(0, stats.inputTokens - stats.cachedReadTokens),
  }
}

/** 弹窗里的 token 数用精确值（带千分位），与条形 chip 的紧凑值区分。 */
function fmtExact(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** 移动端摘要 chip：与桌面统计行同字号/行高，靠透明外扩命中区保证可点。 */
function statChipClass(active: boolean): string {
  return `relative flex min-w-0 items-center gap-1 rounded px-1 font-mono text-[10.5px] leading-[1.4] tabular-nums transition-colors after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] ${
    active
      ? 'bg-gn-bg-highlight text-gn-fg'
      : 'bg-gn-bg-highlight/60 text-gn-fg2 hover:bg-gn-bg-highlight'
  }`
}

/** 明细弹窗的标题行 + 指标行（参考 TUI 的 stats 面板：标题与汇总同排）。 */
function StatDetail({
  icon,
  title,
  summary,
  rows,
}: {
  icon: ReactNode
  title: string
  summary: string
  rows: Array<[string, string]>
}) {
  return (
    <>
      <div className="flex items-center gap-1 border-b border-gn-prompt-border/60 px-2.5 py-1.5">
        <span className="shrink-0 text-gn-muted" aria-hidden>
          {icon}
        </span>
        <span className="text-[11.5px] font-medium leading-[1.3] text-gn-fg">{title}</span>
        <span className="ml-auto whitespace-nowrap font-mono text-[11.5px] leading-[1.3] tabular-nums text-gn-fg">
          {summary}
        </span>
      </div>
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="flex items-baseline justify-between gap-2 px-2.5 py-1 leading-[1.3]"
        >
          <span className="text-[11.5px] text-gn-muted">{label}</span>
          <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-gn-fg2">
            {value}
          </span>
        </div>
      ))}
    </>
  )
}

/**
 * 统计条的保底底距：无数据 / 无活动历史时只渲染它，取值与有数据时的
 * `pb-4` 等量。访客壳不拉会话统计，也用这个占位保持同样的底距。
 */
export function SessionStatsSpacer() {
  return <div className="pb-4 touch-pan-x overscroll-none" aria-hidden="true" />
}

/** 回合 live 期间按固定周期拉统计；请求返回后才排下一拍。 */
function useLiveStatsRefresh(active: boolean, refresh: () => Promise<void>) {
  useEffect(() => {
    if (!active) return
    let stopped = false
    let timer: number | undefined

    const tick = async () => {
      timer = undefined
      if (stopped) return
      // 后台标签页不请求；回到前台由 visibilitychange 立即补一拍。
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        // 串行排拍：请求返回后才安排下一拍，慢 host 不会叠请求。
        await refresh()
      }
      if (!stopped) timer = window.setTimeout(tick, LIVE_POLL_MS)
    }

    timer = window.setTimeout(tick, LIVE_POLL_FIRST_MS)
    const onVisible = () => {
      if (stopped || timer == null) return
      if (document.visibilityState !== 'visible') return
      window.clearTimeout(timer)
      void tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      if (timer != null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [active, refresh])
}

/**
 * Composer 下方会话统计条（host 侧聚合，前端只展示）：
 *   `3 轮 3 步 | LLM 3m3s 工具调用 2m1s | 首 token 平均 3 s · 5711 tok/s
 *    | 缓存命中 98 % | 输入 1.7M tok · 输出 24K tok`
 *
 * 桌面显示完整单行；窄屏（<sm）单行放不下，改为两枚摘要 chip
 * （会话统计 / Token 用量），点开后用 ChipDropdown 在 chip 上方展示
 * 完整明细，避免统计条横向溢出。
 *
 * 数据源：POST /api/session-stats（capri-host bridge_ext_stats.go 扫描
 * 该会话 updates.jsonl 聚合）。哪个指标有数据就显示哪个段，缺省段
 * 隐藏（老数据无 _meta 毫秒时间戳时耗时类指标缺失）。会话无任何
 * 活动历史（0 轮 0 步 0 token）时整条隐藏。刷新时机：会话切换 /
 * 回合终态（continueSession / finalizeTurn / cancelled / host 切换
 * 已触发），本组件在挂载与会话锚点变化时兜底拉取；回合进行中按
 * LIVE_POLL_MS 定时拉取，让长回合的步数/耗时/用量持续更新。
 */
export function SessionStatsBar() {
  const stats = useChatStore((s) => s.sessionStats)
  const sessionId = useChatStore((s) => s.sessionId)
  const cwd = useChatStore((s) => s.cwd)
  const refreshSessionStats = useChatStore((s) => s.refreshSessionStats)
  const live = useChatStore(turnIsLive)
  /** 移动端当前展开的明细面板（同一时刻只开一个）。 */
  const [panel, setPanel] = useState<'session' | 'token' | null>(null)
  const sessionAnchorRef = useRef<HTMLDivElement>(null)
  const tokenAnchorRef = useRef<HTMLDivElement>(null)

  // 挂载 + 会话锚点变化时兜底拉取（覆盖初始挂载与 newSession 场景；
  // 其余刷新点已在 store 动作里触发）。
  const lastKey = useRef<string>('')
  useEffect(() => {
    const key = `${sessionId ?? ''}|${cwd ?? ''}`
    if (key !== lastKey.current) {
      lastKey.current = key
      void refreshSessionStats()
    }
  }, [sessionId, cwd, refreshSessionStats])

  // 回合进行中定时刷新：首轮/长回合里步数与工具耗时持续变化，不能等到
  // 收口才更新。无会话锚点时 refreshSessionStats 自身会清空并返回。
  useLiveStatsRefresh(live && !!sessionId && !!cwd, refreshSessionStats)

  // 无数据 / 无任何活动历史（空会话）→ 不渲染内容。但保留底部间距
  // 占位（与 stats 显示时 pb-4 等量）：composer 直接贴底会显得局促。
  const bottomSpacer = <SessionStatsSpacer />
  if (
    !stats ||
    (stats.turns === 0 &&
      stats.steps === 0 &&
      stats.llmDurationMs === 0 &&
      stats.inputTokens === 0 &&
      stats.outputTokens === 0)
  ) {
    return bottomSpacer
  }

  const r = readStats(stats)
  const hitRate = r.hitPct != null ? `${r.hitPct} %` : null

  const segments: Array<string | null> = [
    r.turnsSteps,
    (() => {
      if (!r.llm && !r.tool) return null
      return [r.llm ? `LLM ${r.llm}` : null, r.tool ? `工具调用 ${r.tool}` : null]
        .filter(Boolean)
        .join(' ')
    })(),
    (() => {
      if (!r.firstToken && !r.tokRate) return null
      return [r.firstToken ? `首 token 平均 ${r.firstToken}` : null, r.tokRate]
        .filter(Boolean)
        .join(' · ')
    })(),
    hitRate ? `缓存命中 ${hitRate}` : null,
    (() => {
      if (stats.inputTokens === 0 && stats.outputTokens === 0) return null
      return `输入 ${fmtTok(stats.inputTokens)} tok · 输出 ${fmtTok(stats.outputTokens)} tok`
    })(),
  ].filter((s): s is string => !!s)

  if (segments.length === 0) return bottomSpacer

  // 移动端摘要：一行放不下完整统计，只留每组的头条指标；点 chip 看明细。
  const sessionChipText = [r.turnsSteps, r.tokRate].filter(Boolean).join(' · ')
  const tokenChipText = [
    r.totalTokens > 0 ? `${fmtTok(r.totalTokens)} tok` : null,
    r.hitPct != null ? `缓存命中 ${r.hitPct}%` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const sessionRows: Array<[string, string]> = [
    ['模型用时', r.llm ?? '—'],
    ['工具调用用时', r.tool ?? '—'],
    ['首 token 平均（TTFT）', r.firstToken ?? '—'],
    ['输出速度（TPS）', r.tokRate ?? '—'],
  ]
  const tokenRows: Array<[string, string]> = [
    ['缓存命中', r.hitPct != null ? `${r.hitPct}%` : '—'],
    ['未缓存输入', `${fmtExact(r.uncachedInput)} tok`],
    ['缓存读取', `${fmtExact(stats.cachedReadTokens)} tok`],
    ['输出', `${fmtExact(stats.outputTokens)} tok`],
  ]

  return (
    <div
      className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} mt-1 pb-4 touch-pan-x overscroll-none`}
      title={`回合 ${stats.turns} · 步 ${stats.steps} · LLM 总耗时 ${stats.llmDurationMs}ms${
        stats.toolDurationMs != null ? ` · 工具耗时 ${stats.toolDurationMs}ms` : ''
      }${
        stats.firstTokenAvgMs != null
          ? ` · 首 token 平均 ${stats.firstTokenAvgMs}ms`
          : ''
      } · 吞吐 ${stats.tokensPerSec != null ? stats.tokensPerSec.toFixed(1) : '—'} tok/s · 输入 ${stats.inputTokens} / 输出 ${stats.outputTokens} tok（缓存读 ${stats.cachedReadTokens}）`}
    >
      {/* 桌面：完整长条。横向滚动容器：内容超出时滑动（滚动条隐藏），
          不足时整体居中。mx-auto + w-max 解决 flex 居中的溢出问题
          （超宽时左侧可达）。 */}
      <div className="hidden gn-no-scrollbar overflow-x-auto sm:block">
        <div className="mx-auto w-max select-none">
          <span className="block whitespace-nowrap font-mono text-[10.5px] leading-[1.4] text-gn-muted">
            {segments.map((seg, i) => (
              <span key={i}>
                {i > 0 && <span className="mx-1.5 text-gn-gutter">|</span>}
                {seg}
              </span>
            ))}
          </span>
        </div>
      </div>

      {/* 移动端：两枚摘要 chip 单行排布（不换行、不额外占高），
          点开在 chip 上方弹出明细。 */}
      <div className="flex flex-nowrap items-center justify-center gap-1.5 sm:hidden">
        <div className="relative shrink-0" ref={sessionAnchorRef}>
          <button
            type="button"
            onClick={() => setPanel((p) => (p === 'session' ? null : 'session'))}
            aria-expanded={panel === 'session'}
            aria-label={`会话统计：${sessionChipText} · 点击查看明细`}
            title="会话统计明细"
            className={statChipClass(panel === 'session')}
          >
            <Timer size={11} strokeWidth={2} className="shrink-0 text-gn-muted" aria-hidden />
            <span className="whitespace-nowrap">{sessionChipText}</span>
          </button>
          <ChipDropdown
            open={panel === 'session'}
            onClose={() => setPanel(null)}
            widthClass="w-64"
            anchorRef={sessionAnchorRef}
          >
            <StatDetail
              icon={<Timer size={11} strokeWidth={2} />}
              title="会话统计"
              summary={r.turnsSteps}
              rows={sessionRows}
            />
          </ChipDropdown>
        </div>
        {tokenChipText ? (
          <div className="relative min-w-0" ref={tokenAnchorRef}>
            <button
              type="button"
              onClick={() => setPanel((p) => (p === 'token' ? null : 'token'))}
              aria-expanded={panel === 'token'}
              aria-label={`Token 用量：${tokenChipText} · 点击查看明细`}
              title="Token 用量明细"
              className={`${statChipClass(panel === 'token')} max-w-full`}
            >
              <Database size={11} strokeWidth={2} className="shrink-0 text-gn-muted" aria-hidden />
              <span className="min-w-0 truncate">{tokenChipText}</span>
            </button>
            <ChipDropdown
              open={panel === 'token'}
              onClose={() => setPanel(null)}
              widthClass="w-64"
              anchorRef={tokenAnchorRef}
            >
              <StatDetail
                icon={<Database size={11} strokeWidth={2} />}
                title="Token 用量"
                summary={`${fmtExact(r.totalTokens)} tok`}
                rows={tokenRows}
              />
            </ChipDropdown>
          </div>
        ) : null}
      </div>
    </div>
  )
}
