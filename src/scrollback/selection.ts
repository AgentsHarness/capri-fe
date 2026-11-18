/**
 * 选中项落位（纯逻辑）。
 *
 * 新块预览停留结束、折叠组收走成员、密度切换重置展开锚点后，原先选中的
 * 条目可能已经不在显示行里。此时把选中项落到覆盖它的折叠组头；组头也
 * 不存在时落到最近的前一条可见行，避免键盘 j/k 从「已隐藏的 id」跳到
 * 列表首尾。
 */
import type { ScrollEntry } from '../api/types'
import {
  displayRowKey,
  spanContaining,
  type DisplayRow,
  type GroupSpan,
} from './verbGroup'

function sourceIndex(id: string, entries: readonly ScrollEntry[]): number {
  if (id.startsWith('gh_')) {
    return entries.findIndex((e) => e.id === id.slice(3))
  }
  return entries.findIndex((e) => e.id === id)
}

/**
 * 返回 selectedId 应该落到哪一行；条目已删除且没有任何可见行时返回 null。
 * selectedId 本来就可见时原样返回。
 */
export function resolveSelectionId(
  entries: readonly ScrollEntry[],
  rows: readonly DisplayRow[],
  spans: readonly GroupSpan[],
  selectedId: string | null,
): string | null {
  if (!selectedId) return null
  const visible = new Set(rows.map(displayRowKey))
  if (visible.has(selectedId)) return selectedId

  const idx = sourceIndex(selectedId, entries)
  if (idx < 0) return null

  const span = spanContaining(spans, idx)
  if (span) {
    const header = `gh_${span.anchorId}`
    if (visible.has(header)) return header
  }

  // 最近的前一条可见行（组头 / 上一个独立块）。
  let best: string | null = null
  let bestIndex = -Infinity
  for (const row of rows) {
    const rowIndex =
      row.type === 'group_header' ? row.span.range.start : row.index
    if (rowIndex < idx && rowIndex > bestIndex) {
      best = displayRowKey(row)
      bestIndex = rowIndex
    }
  }
  if (best != null) return best
  return rows.length > 0 ? displayRowKey(rows[0]) : null
}
