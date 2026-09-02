import type { ScrollEntry } from '../../api/types'
import { captureAsyncScope, isAsyncScopeCurrent } from './globals'
import type { ChatState, SetState } from './types'

/**
 * 目录跳转单次循环的页数上限（防御）：一页一轮，300 轮足以覆盖绝大多数
 * 会话；超出后中止并给出就地可见的原因，绝不死循环拉爆内存/流量。
 */
const MAX_JUMP_PAGES = 300

/** 跳转状态的 statusText 前缀（恢复判断用：期间被别的路径改写则不覆盖）。 */
const JUMP_STATUS_PREFIX = '跳转中'

/** 跳转进度文案：轮序号从 1 计（与目录序号一致），钳到总数。 */
function jumpStatusText(n: number, total: number): string {
  return `${JUMP_STATUS_PREFIX}：已加载到第 ${Math.min(Math.max(n, 1), total)}/${total} 轮`
}

/**
 * 解析目标轮的滚动区条目 id：优先 msgSeq === seq 的第一条（该轮 user 行，
 * 图块 run 则是同一信封派生出的 image 行）；找不到（目标轮已被隐藏/幽灵
 * run）时放宽到其后最近一条 msgSeq > seq 的条目——跳转到可见的下一行。
 */
function resolveTurnEntryId(entries: ScrollEntry[], seq: number): string | null {
  let nearest: { id: string; seq: number } | null = null
  for (const e of entries) {
    if (e.msgSeq == null) continue
    if (e.msgSeq === seq) return e.id
    if (e.msgSeq > seq && (nearest == null || e.msgSeq < nearest.seq)) {
      nearest = { id: e.id, seq: e.msgSeq }
    }
  }
  return nearest?.id ?? null
}

/**
 * 目录跳转（未加载轮）：循环 loadMoreHistory 每次向前加载一轮，直到目标轮
 * （seq = 该轮首条信封的 msgSeq）进入已加载区，然后解析目标条目 id 返回
 * （滚动由调用方执行）。
 *
 * - 目标已在已加载区 → 直接解析（目录点击已加载轮的快速路径）。
 * - 失败 / 中止 / 目标不存在 → 返回 null：失败原因由 loadMoreHistory 写入
 *   historyLoadError（滚动区顶部按钮就地显示），单页上限中止时自行补一条。
 * - 会话切走 / rewind 重载 → 异步作用域守卫，循环即刻放弃。
 */
export async function jumpToPrompt(
  set: SetState,
  get: () => ChatState,
  seq: number,
): Promise<string | null> {
  const s0 = get()
  if (!s0.historySessionId || !s0.historyCwd || !s0.historyPromptStarts) return null
  if (s0.historyLoading || s0.historyLoadingMore) return null
  if (s0.historyLoadedStart != null && s0.historyLoadedStart <= seq) {
    return resolveTurnEntryId(s0.entries, seq)
  }
  const sid = s0.historySessionId
  const cwd = s0.historyCwd
  const scope = captureAsyncScope(get, sid, cwd)
  const isCurrent = () =>
    isAsyncScopeCurrent(get, scope) &&
    get().historySessionId === sid &&
    get().historyCwd === cwd
  // 循环期间竖起跳转旗帜：翻页的位置恢复（锚点捕捉 / prepend settle）整体
  // 让路——跳转的终点是目标轮，恢复会在跳转滚动落地后把视口拉回原处。
  // 进度同时写 statusText（status · 行）与 historyJumpProgress（TopBar 的
  // lite 补全芯片：跳转中显示「跳转 N/M」，落地后同芯片无缝接「◇N 待补全」）。
  const total = s0.historyTurnIdx + 1 // 计划加载到的轮序号（从 1 计）
  const prevStatus = s0.statusText
  const applyProgress = (current: number) => {
    set({
      statusText: jumpStatusText(current, total),
      historyJumpProgress: { current: Math.min(Math.max(current, 1), total), total },
    })
  }
  set({ historyJumpSeq: seq })
  try {
    for (let page = 0; page < MAX_JUMP_PAGES; page++) {
      if (!isCurrent()) return null
      const s = get()
      if (s.historyLoading || s.historyLoadingMore) return null
      const loadedStart = s.historyLoadedStart
      if (loadedStart == null || loadedStart <= seq) break
      if (!s.historyHasMore) break
      // 每页开始前更新进度（点击后立即可见，不必等第一页落地）。
      applyProgress(s.historyTurnIdx + 1)
      const before = loadedStart
      await s.loadMoreHistory(undefined)
      if (!isCurrent()) return null
      // 回放期间把 statusText 写成 Responding… 之类，重写进度拿回所有权
      // （否则收尾的前缀判断会把状态停在回放残留上）。
      applyProgress(get().historyTurnIdx + 1)
      const after = get().historyLoadedStart
      if (after == null || after >= before) {
        // 没前进：翻页失败（错误已就地显示）/ 空页 / 被并发守卫拦下——
        // 中止，绝不死循环。
        break
      }
    }
    const s = get()
    if (s.historyLoadedStart == null || s.historyLoadedStart > seq) {
      if (s.historyHasMore && !s.historyLoadError) {
        set({
          historyLoadError: `目录跳转中止：目标轮次间隔超过 ${MAX_JUMP_PAGES} 页，请继续上滑加载`,
        })
      }
      return null
    }
    return resolveTurnEntryId(s.entries, seq)
  } finally {
    if (get().historyJumpSeq === seq) {
      set({ historyJumpSeq: undefined, historyJumpProgress: undefined })
    }
    // 只恢复我们自己写的文案；循环期间别的路径改过（发消息 / live 状态）
    // 就保留对方的值。
    if (get().statusText?.startsWith(JUMP_STATUS_PREFIX)) {
      set({ statusText: prevStatus })
    }
  }
}
