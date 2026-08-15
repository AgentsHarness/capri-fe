import { useEffect, useRef } from 'react'
import { useChatStore } from '../store/chat'
import { formatTurnDuration } from '../store/chat'
import { fmtTok } from '../format'
import { COLUMN_PAD_X_CLASS, CONTENT_COLUMN_CLASS } from '../theme/layout'

/**
 * Composer 下方会话统计条（host 侧聚合，前端只展示）：
 *   `3 轮 3 步 | LLM 3m3s 工具调用 2m1s | 首 token 平均 3 s · 5711 tok/s
 *    | 缓存命中 98 % | 输入 1.7M tok · 输出 24K tok`
 *
 * 数据源：POST /api/session-stats（capri-host bridge_ext_stats.go 扫描
 * 该会话 updates.jsonl 聚合）。哪个指标有数据就显示哪个段，缺省段
 * 隐藏（老数据无 _meta 毫秒时间戳时耗时类指标缺失）。会话无任何
 * 活动历史（0 轮 0 步 0 token）时整条隐藏。刷新时机：会话切换 /
 * 回合终态（continueSession / finalizeTurn / cancelled / host 切换
 * 已触发），本组件只在挂载与会话锚点变化时兜底拉取。
 */
export function SessionStatsBar() {
  const stats = useChatStore((s) => s.sessionStats)
  const sessionId = useChatStore((s) => s.sessionId)
  const cwd = useChatStore((s) => s.cwd)
  const refreshSessionStats = useChatStore((s) => s.refreshSessionStats)

  // 挂载 + 会话锚点变化时兜底拉取（覆盖初始挂载与 newSession 场景；
  // 其余刷新点已在 store 动作里触发，这里不做轮询）。
  const lastKey = useRef<string>('')
  useEffect(() => {
    const key = `${sessionId ?? ''}|${cwd ?? ''}`
    if (key !== lastKey.current) {
      lastKey.current = key
      void refreshSessionStats()
    }
  }, [sessionId, cwd, refreshSessionStats])

  // 无数据 / 无任何活动历史（空会话）→ 不渲染内容。但保留底部间距
  // 占位（与 stats 显示时 pb-4 等量）：composer 直接贴底会显得局促。
  const bottomSpacer = <div className="pb-4" aria-hidden="true" />
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

  const dur = (ms: number | undefined): string | null =>
    ms != null && ms > 0 ? formatTurnDuration(ms) : null
  const tokRate = (tps: number | undefined): string | null => {
    if (tps == null || tps <= 0) return null
    return tps >= 1000 ? `${(tps / 1000).toFixed(1)}K tok/s` : `${Math.round(tps)} tok/s`
  }
  const firstToken = stats.firstTokenAvgMs != null && stats.firstTokenAvgMs > 0
    ? `${Math.round(stats.firstTokenAvgMs / 1000)} s`
    : null
  const hitRate =
    stats.cacheHitRate > 0 ? `${Math.round(stats.cacheHitRate * 100)} %` : null

  const segments: Array<string | null> = [
    `${stats.turns} 轮 ${stats.steps} 步`,
    (() => {
      const llm = dur(stats.llmDurationMs)
      const tool = dur(stats.toolDurationMs)
      if (!llm && !tool) return null
      return [llm ? `LLM ${llm}` : null, tool ? `工具调用 ${tool}` : null]
        .filter(Boolean)
        .join(' ')
    })(),
    (() => {
      const ft = firstToken
      const tr = tokRate(stats.tokensPerSec)
      if (!ft && !tr) return null
      return [ft ? `首 token 平均 ${ft}` : null, tr].filter(Boolean).join(' · ')
    })(),
    hitRate ? `缓存命中 ${hitRate}` : null,
    (() => {
      if (stats.inputTokens === 0 && stats.outputTokens === 0) return null
      return `输入 ${fmtTok(stats.inputTokens)} tok · 输出 ${fmtTok(stats.outputTokens)} tok`
    })(),
  ].filter((s): s is string => !!s)

  if (segments.length === 0) return bottomSpacer

  return (
    <div
      className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} mt-1 pb-4`}
      title={`回合 ${stats.turns} · 步 ${stats.steps} · LLM 总耗时 ${stats.llmDurationMs}ms${
        stats.toolDurationMs != null ? ` · 工具耗时 ${stats.toolDurationMs}ms` : ''
      }${
        stats.firstTokenAvgMs != null
          ? ` · 首 token 平均 ${stats.firstTokenAvgMs}ms`
          : ''
      } · 吞吐 ${stats.tokensPerSec != null ? stats.tokensPerSec.toFixed(1) : '—'} tok/s · 输入 ${stats.inputTokens} / 输出 ${stats.outputTokens} tok（缓存读 ${stats.cachedReadTokens}）`}
    >
      {/* 横向滚动容器：内容超出时滑动（滚动条隐藏），不足时整体居中。
          mx-auto + w-max 解决 flex 居中的溢出问题（超宽时左侧可达）。 */}
      <div className="gn-no-scrollbar overflow-x-auto">
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
    </div>
  )
}
