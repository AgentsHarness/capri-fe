import { useMemo, useRef } from 'react'
import type { ScrollEntry } from '../../api/types'
import { useFePrefs } from '../../store/historyPins'
import { onUiSettingsChange, toolCallDensity } from '../../store/settings'
import { useSyncExternalStore } from 'react'
import {
  groupScopeForDensity,
  groupingSignature,
  projectDisplayRows,
  scanGroups,
  type DisplayRow,
  type GroupScope,
  type GroupSpan,
} from '../../scrollback/verbGroup'

/** `[ui] tool_call_density` 变化时触发重排（分组范围随之改变）。 */
function subscribeDensity(cb: () => void): () => void {
  return onUiSettingsChange(cb)
}
function densitySnapshot(): string {
  return toolCallDensity()
}

/**
 * 分组缓存（groupingSignature）。
 * 流式 flush 只改文本、不改分组相关字段：签名命中时跳过全量 scanGroups，
 * span 与 header 行（含 label）直接复用——每帧主成本从 O(n) 分组扫描
 * 降到 O(n) 签名比对。签名/展开集变化（收口、工具状态、折叠切换、新
 * 条目…）、前端偏好变化（collapseToolGroups）或密度档变化（分组范围）时
 * 全量重扫并重建缓存。
 */
export function useDisplayRows(
  entries: ScrollEntry[],
  expandedGroups: ReadonlySet<string>,
): { rows: DisplayRow[]; spans: GroupSpan[] } {
  const collapseToolGroups = useFePrefs((s) => s.fePrefs.collapseToolGroups)
  const defaultExpanded = !collapseToolGroups
  const density = useSyncExternalStore(subscribeDensity, densitySnapshot)
  const scope = useMemo(() => groupScopeForDensity(density), [density])
  const spansCacheRef = useRef<{
    sig: string
    expanded: ReadonlySet<string>
    defaultExpanded: boolean
    scope: GroupScope
    spans: GroupSpan[]
    headers: Map<GroupSpan, DisplayRow>
  } | null>(null)

  return useMemo(() => {
    const sig = groupingSignature(entries)
    const c = spansCacheRef.current
    if (
      c &&
      c.expanded === expandedGroups &&
      c.defaultExpanded === defaultExpanded &&
      c.scope === scope &&
      sig === c.sig
    ) {
      // 分组结构未变（纯流式文本增长）：span 与 header 行（含 label）
      // 复用，跳过 scanGroups 与 label 重算。
      return {
        rows: projectDisplayRows(entries, c.spans, true, c.headers, scope),
        spans: c.spans,
      }
    }
    const spans = scanGroups(entries, expandedGroups, { defaultExpanded, scope })
    const headers = new Map<GroupSpan, DisplayRow>()
    const rows = projectDisplayRows(entries, spans, true, headers, scope)
    spansCacheRef.current = {
      sig,
      expanded: expandedGroups,
      defaultExpanded,
      scope,
      spans,
      headers,
    }
    return { rows, spans }
  }, [entries, expandedGroups, defaultExpanded, scope])
}

/** 流式思考条目的 id（合并滚动固定需要把它指给父组件的 streamBodyRef）。 */
export function useStreamingThoughtId(entries: ScrollEntry[]): string | null {
  return useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.kind === 'thought' && e.streaming) return e.id
    }
    return null
  }, [entries])
}
