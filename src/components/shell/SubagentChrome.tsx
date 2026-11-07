import type { ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import { formatTurnDuration } from '../../store/chat'
import { fmtTok } from '../../format'
import { ProgressBar } from '../ui/ProgressBar'
import { contextUrgencyColor } from '../../theme/contextColor'
import { SPINNER_FRAMES } from '../../theme/glyphs'
import type { ScrollEntry } from '../../api/types'
import { subagentMeta } from '../../format'

interface SubagentMetaSegment {
  text: string
  tone: 'muted' | 'gutter' | 'error'
}

/**
 * 子代理标题栏：
 * - 首行：状态图标（spinner / ✓ / ✗）+ 状态标签（着色）+ 加粗任务描述 + 右侧耗时与关闭按钮
 * - 次行（按需渲染）：去重后的角色/类型与模型 + 回合/工具/token/错误计数 + 当前运行工具 + 上下文进度条
 */
export function subagentChrome(
  e: Extract<ScrollEntry, { kind: 'subagent' }>,
  now: number,
  spinnerFrame: number,
): {
  icon: ReactNode
  label: string
  statusColor: string
  description?: string
  elapsed?: string
  metaSegments: SubagentMetaSegment[]
  contextGauge: ReactNode
  hasSecondRow: boolean
} {
  const running = !!e.running
  const label = running
    ? 'Agent running'
    : e.status === 'completed'
      ? 'Agent done'
      : e.status === 'cancelled'
        ? 'Agent cancelled'
        : 'Agent failed'
  const statusColor = running
    ? 'text-gn-accent-running'
    : e.status === 'completed'
      ? 'text-gn-green'
      : e.status === 'cancelled'
        ? 'text-gn-yellow'
        : 'text-gn-red'
  const icon = running ? (
    <span
      className="flex w-[13px] shrink-0 items-center justify-center text-gn-accent-running"
      aria-hidden
    >
      {SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}
    </span>
  ) : (
    <span
      className={`flex w-[13px] shrink-0 items-center justify-center ${statusColor}`}
      aria-hidden
    >
      {e.status === 'completed' ? (
        <Check size={13} strokeWidth={2.5} />
      ) : (
        <X size={13} strokeWidth={2.5} />
      )}
    </span>
  )

  const rawTitle = e.title?.trim() ?? ''
  const description =
    rawTitle && rawTitle !== e.subagentId ? rawTitle : undefined

  const elapsedMs = running
    ? e.startedAt != null
      ? Math.max(0, now - e.startedAt)
      : e.durationMs
    : e.durationMs
  const elapsed =
    elapsedMs != null ? formatTurnDuration(elapsedMs) : undefined

  const cleanType = e.subagentType?.trim()
  const fallbackRole =
    !e.persona?.trim() &&
    !e.role?.trim() &&
    cleanType &&
    cleanType.toLowerCase() !== 'general-purpose' &&
    cleanType.toLowerCase() !== description?.toLowerCase()
      ? cleanType
      : e.role
  const rawMeta = subagentMeta(
    e.persona,
    fallbackRole,
    e.model,
    e.reasoningEffort,
  ).trim()
  const identity =
    rawMeta.startsWith('(') && rawMeta.endsWith(')')
      ? rawMeta.slice(1, -1)
      : rawMeta

  const hasContextGauge =
    running &&
    e.contextWindowTokens != null &&
    e.contextWindowTokens > 0

  const metaSegments: SubagentMetaSegment[] = []
  if (identity) {
    metaSegments.push({ text: identity, tone: 'muted' })
  }
  if (e.turns != null && e.turns > 0) {
    metaSegments.push({
      text: `${e.turns} ${e.turns === 1 ? 'turn' : 'turns'}`,
      tone: 'gutter',
    })
  }
  if (e.toolCalls != null && e.toolCalls > 0) {
    metaSegments.push({
      text: `${e.toolCalls} ${e.toolCalls === 1 ? 'tool' : 'tools'}`,
      tone: 'gutter',
    })
  }
  if (!hasContextGauge && e.tokensUsed != null && e.tokensUsed > 0) {
    metaSegments.push({
      text: `${fmtTok(e.tokensUsed)} tok`,
      tone: 'gutter',
    })
  }
  if (e.errorCount != null && e.errorCount > 0) {
    metaSegments.push({
      text: `${e.errorCount} ${e.errorCount === 1 ? 'error' : 'errors'}`,
      tone: 'error',
    })
  }
  if (running && e.toolsUsed?.length) {
    metaSegments.push({
      text: `Running: ${e.toolsUsed[e.toolsUsed.length - 1]}`,
      tone: 'muted',
    })
  }

  const pct = e.contextUsagePct
  const gaugeColor =
    pct == null ? undefined : contextUrgencyColor(Math.min(100, pct))
  const contextGauge = hasContextGauge ? (
    <span className="ml-auto inline-flex items-center gap-2">
      <span
        className={`inline-flex items-center gap-1 leading-none ${pct == null ? 'text-gn-gutter' : ''}`}
        style={gaugeColor ? { color: gaugeColor } : undefined}
        title={`上下文 ${Math.round(pct ?? 0)}%`}
      >
        <ProgressBar pct={pct ?? 0} cols={10} />
        <span>{Math.round(pct ?? 0)}%</span>
      </span>
      <span>
        {e.tokensUsed != null
          ? `${fmtTok(e.tokensUsed)} / ${fmtTok(e.contextWindowTokens!)} tok`
          : `${fmtTok(e.contextWindowTokens!)} tok`}
      </span>
    </span>
  ) : null

  return {
    icon,
    label,
    statusColor,
    description,
    elapsed,
    metaSegments,
    contextGauge,
    hasSecondRow: metaSegments.length > 0 || hasContextGauge,
  }
}
