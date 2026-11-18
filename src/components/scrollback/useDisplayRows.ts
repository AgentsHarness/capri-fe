import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { ScrollEntry } from '../../api/types'
import type { ToolCallDensity } from '../../api/transport'
import { onUiSettingsChange, toolCallDensity } from '../../store/settings'
import {
  previewToolIds,
  type PreviewHold,
} from '../../scrollback/groupHold'
import {
  groupScopeForDensity,
  groupingSignature,
  projectDisplayRows,
  scanGroups,
  type DisplayRow,
  type GroupScope,
  type GroupSpan,
} from '../../scrollback/verbGroup'

/** `[ui] tool_call_density` 变化时触发重排（分组范围与默认展开态随之改变）。 */
function subscribeDensity(cb: () => void): () => void {
  return onUiSettingsChange(cb)
}
function densitySnapshot(): ToolCallDensity {
  return toolCallDensity()
}

type GroupedRows = {
  sig: string
  expanded: ReadonlySet<string>
  scope: GroupScope
  spans: GroupSpan[]
  headers: Map<GroupSpan, DisplayRow>
}

/**
 * 新块预览的停留窗口（见 scrollback/groupHold.ts）。
 *
 * 计时的两个来源：
 *  - 条目变化（工具刚完成、组刚成形、密度切换）时按当前时刻重算；
 *  - 最近一个预览窗口到期时用 tick 唤醒一次，让预览补丁撤销、折叠组成员
 *    消失并交给退出动画。
 *
 * 用户手动收起分组时，把该组里已有的工具 id 记进 suppressed：手动折叠
 * 应当立刻生效，不能因为预览停留再把成员留在原地。
 */
function usePreviewHold(
  entries: ScrollEntry[],
  spans: GroupSpan[],
  expandedGroups: ReadonlySet<string>,
  holdMs: number,
  density: ToolCallDensity,
): PreviewHold {
  const [tick, setTick] = useState(0)
  const prevExpandedRef = useRef(expandedGroups)
  const prevDensityRef = useRef(density)
  const suppressedRef = useRef<Map<string, number>>(new Map())

  const held = useMemo(() => {
    void tick // 计时器到点后的版本号：强制用新的 Date.now() 重算。
    const now = Date.now()
    if (prevDensityRef.current !== density) {
      // 密度切换会重置展开锚点，不是用户收起分组——不要把它记成抑制。
      prevDensityRef.current = density
      prevExpandedRef.current = expandedGroups
    } else if (prevExpandedRef.current !== expandedGroups) {
      const prev = prevExpandedRef.current
      if (holdMs > 0) {
        for (const anchor of prev) {
          if (expandedGroups.has(anchor)) continue
          const span = spans.find((s) => s.anchorId === anchor)
          if (!span) continue
          for (let i = span.range.start; i < span.range.end; i++) {
            const e = entries[i]
            if (e?.kind === 'tool') suppressedRef.current.set(e.id, now + holdMs)
          }
        }
      }
      prevExpandedRef.current = expandedGroups
    }
    for (const [id, until] of suppressedRef.current) {
      if (until <= now) suppressedRef.current.delete(id)
    }
    return previewToolIds(
      entries,
      now,
      holdMs,
      density,
      suppressedRef.current,
    )
  }, [entries, spans, expandedGroups, holdMs, density, tick])

  useEffect(() => {
    if (held.nextAt == null) return
    const delay = Math.max(1, held.nextAt - Date.now() + 8)
    const timer = window.setTimeout(() => setTick((v) => v + 1), delay)
    return () => window.clearTimeout(timer)
  }, [held.nextAt])

  return held
}

/**
 * 分组缓存（groupingSignature）。
 * 流式 flush 只改文本、不改分组相关字段：签名命中时跳过全量 scanGroups，
 * span 与 header 行（含 label）直接复用——每帧主成本从 O(n) 分组扫描
 * 降到 O(n) 签名比对。签名/展开集变化（收口、工具状态、折叠切换、新
 * 条目…）或密度档变化（分组范围）时全量重扫并重建缓存。
 *
 * @param holdMs 新块预览停留时长（0 = 关闭预览）。默认折叠的工具运行中
 *   预览，结束后再保留 holdMs；是否入组不影响这个窗口。
 * @param suppressPreviewIds 调用方已有的手动折叠手势（迷你视图的局部
 *   folds）。命中的工具不再参与自动预览/停留。
 */
export function useDisplayRows(
  entries: ScrollEntry[],
  expandedGroups: ReadonlySet<string>,
  holdMs = 0,
  suppressPreviewIds?: ReadonlySet<string>,
): {
  rows: DisplayRow[]
  spans: GroupSpan[]
  scope: GroupScope
  /** 当前处于新块预览停留窗口、需要保持可见的工具 id。 */
  previewIds: ReadonlySet<string>
  /** holdMs > 0 时预览功能开启；具体哪些块处于窗口内看 previewIds。 */
  previewEnabled: boolean
} {
  const density = useSyncExternalStore(subscribeDensity, densitySnapshot)
  const scope = useMemo(() => groupScopeForDensity(density), [density])
  const spansCacheRef = useRef<GroupedRows | null>(null)

  const grouped = useMemo(() => {
    const sig = groupingSignature(entries)
    const c = spansCacheRef.current
    if (c && c.expanded === expandedGroups && c.scope === scope && sig === c.sig) {
      return c
    }
    const spans = scanGroups(entries, expandedGroups, { scope })
    const headers = new Map<GroupSpan, DisplayRow>()
    const next: GroupedRows = {
      sig,
      expanded: expandedGroups,
      scope,
      spans,
      headers,
    }
    spansCacheRef.current = next
    return next
  }, [entries, expandedGroups, scope])

  const previewEnabled = holdMs > 0
  const held = usePreviewHold(entries, grouped.spans, expandedGroups, holdMs, density)
  const previewIds = useMemo(() => {
    if (!suppressPreviewIds?.size || held.ids.size === 0) return held.ids
    let changed = false
    const out = new Set(held.ids)
    for (const id of suppressPreviewIds) {
      if (out.delete(id)) changed = true
    }
    return changed ? out : held.ids
  }, [held.ids, suppressPreviewIds])
  const rows = useMemo(
    () =>
      projectDisplayRows(
        entries,
        grouped.spans,
        true,
        grouped.headers,
        scope,
        previewIds,
      ),
    [entries, grouped, scope, previewIds],
  )

  return {
    rows,
    spans: grouped.spans,
    scope,
    previewIds,
    previewEnabled,
  }
}
