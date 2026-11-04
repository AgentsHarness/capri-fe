import type { ScrollEntry } from '../api/types'

/**
 * 新 entry 块入场动画的判定（纯逻辑，组件层用 useEnteringEntries 驱动）。
 *
 * 目标是只给「实时回合里新出现的块」播半透明淡入：
 * - 初次挂载 / 切会话 / 刷新历史整批换条目 → 不逐块播（切会话已有
 *   内容区整体淡入）；
 * - loadMoreHistory 的 prepend 新页落在已加载区之前 → 不播；
 * - 历史回放会先清空 entries 再恢复，seenIds 只增不减，旧条目不会被
 *   误判成新块。
 */

/** 一次更新新增超过该数量，视为批量回放（历史页 / 重连补拉），不逐块淡入。 */
export const ENTRY_ENTER_MAX_BATCH = 8

export type EnteringEntryOptions = {
  /** 总开关（FE 偏好 entryFadeIn 且当前回合在输出）。 */
  enabled: boolean
  /** 首帧只播种 seenIds，不返回任何 id。 */
  initialized: boolean
  /** 当前历史批次标识；变化 = 整批替换，不是新块。 */
  historyLoadedAt?: number | null
  /** 上一次 commit 时的历史批次标识。 */
  lastHistoryLoadedAt?: number | null
  historyLoading: boolean
  historyLoadingMore: boolean
}

/**
 * 返回本帧应播入场动画的条目 id（按 entries 顺序）。
 * `seenIds` 是上一次 commit 及更早见过的所有条目 id。
 */
export function enteringEntryIds(
  entries: ScrollEntry[],
  seenIds: ReadonlySet<string>,
  opts: EnteringEntryOptions,
): string[] {
  if (!opts.initialized) return []
  if (opts.historyLoadedAt !== opts.lastHistoryLoadedAt) return []
  if (!opts.enabled || opts.historyLoading || opts.historyLoadingMore) return []

  // 第一个仍存在的旧条目：新页 prepend 会全部落在它之前。
  let firstSeen = -1
  for (let i = 0; i < entries.length; i++) {
    if (seenIds.has(entries[i].id)) {
      firstSeen = i
      break
    }
  }

  const fresh: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const id = entries[i].id
    if (seenIds.has(id)) continue
    if (firstSeen >= 0 && i < firstSeen) continue
    fresh.push(id)
  }
  return fresh.length > ENTRY_ENTER_MAX_BATCH ? [] : fresh
}
