/**
 * 把退出行按上一帧的锚点插入渲染列表（纯逻辑）。
 *
 * 关键：退出行必须落在动画起点（上一帧该块所在的位置）附近，否则收起
 * 动作看起来会「跳一下才开始」。锚点是上一层给的 display row key
 * （普通行 / 画廊组内任一成员）。新组形成时所有退出行都锚在组头之前的
 * 同一个存活行上，避免组头插入把它们整体顶下去。
 */
import type { AbsorbingEntry } from './absorbEntries'

export function withAbsorbingRows<T>(
  items: readonly T[],
  ghosts: readonly AbsorbingEntry[],
  keysOf: (item: T) => readonly string[],
  ghostItem: (ghost: AbsorbingEntry) => T,
): T[] {
  if (ghosts.length === 0) return [...items]

  const after = new Map<string, AbsorbingEntry[]>()
  const leading: AbsorbingEntry[] = []
  for (const ghost of ghosts) {
    if (ghost.afterKey == null) {
      leading.push(ghost)
      continue
    }
    const list = after.get(ghost.afterKey)
    if (list) list.push(ghost)
    else after.set(ghost.afterKey, [ghost])
  }

  const placed = new Set<string>()
  const out: T[] = []
  for (const ghost of leading) {
    out.push(ghostItem(ghost))
    placed.add(ghost.entry.id)
  }
  for (const item of items) {
    out.push(item)
    for (const key of keysOf(item)) {
      const list = after.get(key)
      if (!list) continue
      for (const ghost of list) {
        if (placed.has(ghost.entry.id)) continue
        out.push(ghostItem(ghost))
        placed.add(ghost.entry.id)
      }
    }
  }
  // 锚点被新分组/回放换掉时兜底：不吞掉已开始的退出动画。
  for (const ghost of ghosts) {
    if (placed.has(ghost.entry.id)) continue
    out.push(ghostItem(ghost))
    placed.add(ghost.entry.id)
  }
  return out
}
