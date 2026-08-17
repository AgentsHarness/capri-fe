import { useMemo, useRef } from 'react'
import type { ScrollEntry } from '../../api/types'
import { useFePrefs } from '../../store/historyPins'
import {
  groupingSignature,
  projectDisplayRows,
  scanGroups,
  type DisplayRow,
  type GroupSpan,
} from '../../scrollback/verbGroup'

/**
 * 分组缓存（groupingSignature）。
 * 流式 flush 只改文本、不改分组相关字段：签名命中时跳过全量 scanGroups，
 * span 与 header 行（含 label）直接复用——每帧主成本从 O(n) 分组扫描
 * 降到 O(n) 签名比对。签名/展开集变化（收口、工具状态、折叠切换、新
 * 条目…）或前端偏好变化（collapseToolGroups）时全量重扫并重建缓存。
 */
export function useDisplayRows(
  entries: ScrollEntry[],
  expandedGroups: ReadonlySet<string>,
): { rows: DisplayRow[]; spans: GroupSpan[] } {
  const collapseToolGroups = useFePrefs((s) => s.fePrefs.collapseToolGroups)
  const defaultExpanded = !collapseToolGroups
  const spansCacheRef = useRef<{
    sig: string
    expanded: ReadonlySet<string>
    defaultExpanded: boolean
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
      sig === c.sig
    ) {
      // 分组结构未变（纯流式文本增长）：span 与 header 行（含 label）
      // 复用，跳过 scanGroups 与 label 重算。
      return {
        rows: projectDisplayRows(entries, c.spans, true, c.headers),
        spans: c.spans,
      }
    }
    const spans = scanGroups(entries, expandedGroups, { defaultExpanded })
    const headers = new Map<GroupSpan, DisplayRow>()
    const rows = projectDisplayRows(entries, spans, true, headers)
    spansCacheRef.current = {
      sig,
      expanded: expandedGroups,
      defaultExpanded,
      spans,
      headers,
    }
    return { rows, spans }
  }, [entries, expandedGroups, defaultExpanded])
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
