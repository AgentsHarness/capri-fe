/**
 * 展开折叠分组时的成员入场判定（纯逻辑）。
 *
 * 收起的分组只挂一个聚合头；点开时成员行是这一帧才挂载的。这里对比
 * 前后两帧，找出「因展开而新露出」的条目 id，交给视图层播入场淡入。
 *
 * 只认展开集里新增的锚点：收起分组不产生入场行（退出动画由
 * absorbEntries 的退出快照负责）；原本就可见的成员（手动展开的工具 /
 * 预览停留中的块）不重播，避免已经在屏幕上的行闪一下。
 */
import type { ScrollEntry } from '../api/types'
import type { DisplayRow, GroupSpan } from './verbGroup'

export type GroupEnterSnapshot = {
  expanded: ReadonlySet<string>
  /** 该帧作为独立行渲染的 entry id。 */
  visible: ReadonlySet<string>
}

/** 当前 display rows 里作为独立行出现的条目 id。 */
export function visibleEntryIds(
  rows: readonly DisplayRow[],
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.type === 'entry') ids.add(row.entry.id)
  }
  return ids
}

/**
 * 本帧因展开分组而新露出的条目 id（按 entries 顺序）。
 * `prev` 为 null（首帧）时返回空。
 */
export function newlyExpandedEntryIds(
  entries: readonly ScrollEntry[],
  spans: readonly GroupSpan[],
  prev: GroupEnterSnapshot | null,
  expanded: ReadonlySet<string>,
  visible: ReadonlySet<string>,
): string[] {
  if (!prev || prev.expanded === expanded) return []

  const out: string[] = []
  for (const span of spans) {
    if (!span.expanded) continue
    if (prev.expanded.has(span.anchorId) || !expanded.has(span.anchorId)) continue
    for (let i = span.range.start; i < span.range.end; i++) {
      const e = entries[i]
      if (!e || prev.visible.has(e.id) || !visible.has(e.id)) continue
      out.push(e.id)
    }
  }
  return out
}
