import { rowOrderMs } from '../store/historyOrder'

/** 根据 data-gkey 属性在根容器下查找指定工作区分组元素。 */
export function findGroupEl(root: HTMLElement | null, key: string): HTMLElement | null {
  if (!root) return null
  const all = root.querySelectorAll<HTMLElement>('[data-gkey]')
  for (let i = 0; i < all.length; i++) {
    if (all[i].getAttribute('data-gkey') === key) return all[i]
  }
  return null
}

/**
 * 组内比较器：比「排序锚」而不是本次响应的 updatedAt。
 * 无锚的首次出现退回活动时间（新会话照旧排最前），之后钉住不动；
 * 时间缺失（0）垫底，同分按 id，保证顺序可复现。
 */
export function byAnchoredDesc<T extends { sessionId: string; updatedAt?: string }>(
  anchors: Record<string, number>,
) {
  return (a: T, b: T): number => {
    const d = rowOrderMs(anchors, b) - rowOrderMs(anchors, a)
    if (d !== 0) return d
    return a.sessionId.localeCompare(b.sessionId)
  }
}
