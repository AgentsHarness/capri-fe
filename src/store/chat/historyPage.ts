import type { ScrollEntry } from '../../api/types'
// ── history envelope replay ───────────────────────────────────────
//
// A stored update is the JSONL envelope {timestamp, method, params} with
// params = {sessionId, update}. Mirrors the host's session/update mapping.

/** Updates per history page; older pages load on scroll-up. */
export const HISTORY_PAGE_SIZE = 100

/**
 * 自适应分页的最大翻倍步数：页大小 = HISTORY_PAGE_SIZE << min(chained,
 * MAX_PAGE_DOUBLE_STEPS)，即 100 → 200 → 400 → 800 → 1600 封顶。
 */
export const MAX_PAGE_DOUBLE_STEPS = 4

/**
 * 单次历史加载的自动翻页上限（累计条数）：loadHistory 找首条 user 消息、
 * loadMoreHistory 连续零 user 页自动续翻共用——防止纯工具归档（全会话
 * 无 user 消息）无限翻页。页大小自适应翻倍时按累计条数封顶（等效原
 * 30 页 × 100 条），而不是按页数。
 */
export const MAX_AUTO_FETCH_ENTRIES = 3000

/**
 * loadHistory 首页按「回合」拉取（turnIndex）的参数：始终只拉最后
 * INITIAL_TURNS=1 个 user 回合（不设 limit，避免截断超长回合尾部）。
 * 上一条由用户上滑 loadMoreHistory 按需加载；sticky 在 user 划出视口后
 * 钉当前轮，加载完上一轮后钉新轮。
 */
export const INITIAL_TURNS = 1
/**
 * loadMoreHistory 按轮次窗口的单请求上限。超过则 previousTurnWindow 返回
 * null，退化为按条数 offset 分页 + 自动续翻到上一条 user。
 * 首页 loadHistory 不再使用此上限（见上方）。
 */
export const INITIAL_TURN_LIMIT = 2000

/**
 * 自适应分页页大小：基础 HISTORY_PAGE_SIZE 起步，每次续翻翻倍，封顶
 * HISTORY_PAGE_SIZE << MAX_PAGE_DOUBLE_STEPS。分页目标固定为「加载到
 * 上一条 user 消息为止」——短工具流段一两页即停，长工具流段也只需
 * 少数几次请求（而不是固定 100 条一页地多次续翻）。
 */
export function adaptivePageSize(chained: number): number {
  return HISTORY_PAGE_SIZE << Math.min(chained, MAX_PAGE_DOUBLE_STEPS)
}

/**
 * 分页「还有更早」判定：优先用宿主 totalCount（total > loaded）；totalCount
 * 缺失/为 0 时回退到「整页拉满」（fetched >= 页大小）。否则宿主一旦省略
 * totalCount，hasMore 恒为 false → 按钮不出现、上滑无反应，用户看到的就是
 * 「没有滚动条、点击加载无效」。
 */
export function historyHasMorePage(
  total: number | undefined,
  loaded: number,
  fetched: number,
  pageSize = HISTORY_PAGE_SIZE,
): boolean {
  if (fetched <= 0) return false
  if (total != null && total > 0) return total > loaded
  // 无 totalCount 时回退「整页拉满」判定：必须与本次请求的页大小比较
  // （页大小自适应翻倍后不再固定 HISTORY_PAGE_SIZE）。
  return fetched >= pageSize
}

/**
 * 按轮次分页：取「最老已加载轮次的前一轮」在 live timeline 上的绝对
 * 窗口 [promptStarts[k-1], min(promptStarts[k], loadedStart)）。
 *
 * **必须用绝对 offset**（正数行号），禁止 `start - total` 负 offset：
 * live 追加会抬高 totalCount，负 offset 换算出的窗口整体前移，与已加载
 * 区重叠 → 同一轮条目重复 prepend。绝对 offset 在 append-only 下稳定。
 *
 * `loadedStart`：当前已加载区最老行（钳制 end，防止与已加载区交叉）。
 *
 * 返回 null（调用方退化为按条数绝对 offset 分页）：
 * - promptStarts 缺失 / k 越界 / 无更早轮次；
 * - 窗口为空或超过单请求上限（超长回合 → 按条数分页 + 续翻到上一条 user）。
 */
export function previousTurnWindow(
  promptStarts: number[] | undefined,
  k: number,
  loadedStart: number,
): { offset: number; limit: number } | null {
  if (!promptStarts || promptStarts.length === 0) return null
  if (k <= 0 || k >= promptStarts.length) return null
  if (loadedStart <= 0) return null
  const start = promptStarts[k - 1]
  // 钳到已加载起点：正常 turn 边界 end === loadedStart；offset 兜底半轮后
  // loadedStart 落在回合中间时，只取 [start, loadedStart) 尚未加载的前缀。
  const end = Math.min(promptStarts[k], loadedStart)
  const limit = end - start
  if (limit <= 0 || limit > INITIAL_TURN_LIMIT) return null
  return { offset: start, limit }
}

/**
 * offset 兜底路径上，把旧 promptStarts[oldIdx] 的边界行号映射到刷新后的
 * promptStarts 下标（live 新回合 append 时数组变长，行号不变）。找不到则
 * 保留 oldIdx（钳到新数组范围）。
 */
export function remapTurnIdx(
  oldStarts: number[] | undefined,
  oldIdx: number,
  newStarts: number[] | undefined,
): number {
  if (!newStarts || newStarts.length === 0) return oldIdx
  const boundary = oldStarts?.[oldIdx]
  if (boundary != null) {
    const i = newStarts.indexOf(boundary)
    if (i >= 0) return i
  }
  return Math.min(oldIdx, newStarts.length - 1)
}

export function countUserMessages(entries: ScrollEntry[]): number {
  let n = 0
  for (const e of entries) if (e.kind === 'user') n++
  return n
}
