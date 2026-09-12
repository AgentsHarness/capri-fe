import { create } from 'zustand'
import { loadJSON, saveJSON } from '../lib/storage'
import { KEY } from '../lib/keys'
import type { WorkspaceGroup } from '../api/types'

/**
 * 会话列表的「粘性排序锚」：sessionId → 排序用时间（epoch ms）。
 *
 * 为什么需要它：host/agent 返回的 `updatedAt` 就是 agent 的
 * `last_active_at`，每落一条 update 都会往前推；列表若直接按它排序，
 * 一个在后台跑的会话会把它整组顶到最前（组序 = 组内最新活动），行也会
 * 随状态翻转上下窜——用户看到的「点一下别的会话，整个目录跳到最顶上」
 * 就是这么来的。列表固定按这份锚点排：会话**首次进入列表**时记一次时间，
 * 之后刷新只更新显示数据、不动锚点。锚点整体重记（= 回到活跃度序）只发生在
 * - 用户点头部刷新按钮（requestReanchor）
 * - 切换 host（hostScope 变化，不同机器的时间戳没有可比性）
 */

/** 锚点条数上限：超出按锚点时间裁最旧的（已删除/再没出现的会话）。 */
const ANCHOR_CAP = 2000

const ANCHOR_KEY = KEY.historyOrder
const COLLAPSE_KEY = KEY.historyGroupCollapse

export type AnchorMap = Record<string, number>

/** 一条排序种子：会话 id + 该会话本次的活动时间（0 = 无时间戳，不记锚）。 */
export type OrderSeed = { sessionId: string; ms: number }

type HistoryOrderState = {
  /** sessionId → 排序锚（epoch ms）。 */
  anchors: AnchorMap
  /** 用户明确折叠/展开过的分组：组 key（cwd 或 marked 分区 key）→ 是否收起。 */
  collapse: Record<string, boolean>
  /** 下一次 seed 整表重锚（用户点了刷新按钮）。 */
  pendingReanchor: boolean
  /** 锚点所属的 host 作用域；'' = 尚未定过，变化即作废（换机器 = 换一份时间线）。 */
  hostScope: string
  /**
   * 用本次落地的一批会话行对齐锚点：无锚的补记；pendingReanchor 时整表
   * 重写；hostScope 变化时先清空再整表重写。无变化则不 setState（避免
   * 每次刷新都多渲染一轮）。
   */
  seed: (rows: OrderSeed[], hostScope: string) => void
  /** 请求下一次落地时整表重锚（显式刷新）。 */
  requestReanchor: () => void
  /** 记录/清除某分组的折叠偏好。 */
  setCollapse: (key: string, collapsed: boolean) => void
}

function sameAnchors(a: AnchorMap, b: AnchorMap): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) if (a[k] !== b[k]) return false
  return true
}

/** 超上限时按锚点时间保留最新的 ANCHOR_CAP 条。 */
function prune(anchors: AnchorMap): AnchorMap {
  const keys = Object.keys(anchors)
  if (keys.length <= ANCHOR_CAP) return anchors
  const keep = keys
    .sort((x, y) => anchors[y] - anchors[x])
    .slice(0, ANCHOR_CAP)
  const out: AnchorMap = {}
  for (const k of keep) out[k] = anchors[k]
  return out
}

function loadAnchors(): AnchorMap {
  const raw = loadJSON<unknown>(ANCHOR_KEY, {})
  if (!raw || typeof raw !== 'object') return {}
  const out: AnchorMap = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // 只收数字值：localStorage 被人手改过/旧结构残留时不污染排序。
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

function loadCollapse(): Record<string, boolean> {
  const raw = loadJSON<unknown>(COLLAPSE_KEY, {})
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v
  }
  return out
}

export const useHistoryOrder = create<HistoryOrderState>((set, get) => ({
  anchors: loadAnchors(),
  collapse: loadCollapse(),
  pendingReanchor: false,
  hostScope: '',
  seed: (rows, hostScope) => {
    const cur = get()
    // hostScope 初值 '' = 还没定过：首次 seed 不能当成「换了 host」，
    // 否则 localStorage 里存着的锚点每次刷新页面都被抹掉重来。
    const scopeChanged = cur.hostScope !== '' && cur.hostScope !== hostScope
    const fresh: AnchorMap = {}
    for (const r of rows) if (r.ms > 0) fresh[r.sessionId] = r.ms
    let next: AnchorMap
    if (scopeChanged) {
      // 换 host：不同机器/不同 agent 的时间线没有可比性，整表重记。
      next = { ...fresh }
    } else if (cur.pendingReanchor) {
      // 整表重写，但保住本次没出现的旧锚：分页模式下一次落地只有当前
      // 已加载的那部分行，把没看到的会话锚点丢掉会让它下次冒到最前。
      next = { ...cur.anchors, ...fresh }
    } else {
      next = { ...cur.anchors }
      for (const [sid, ms] of Object.entries(fresh)) {
        if (next[sid] === undefined) next[sid] = ms
      }
    }
    next = prune(next)
    if (!scopeChanged && !cur.pendingReanchor && sameAnchors(next, cur.anchors)) return
    saveJSON(ANCHOR_KEY, next)
    set({ anchors: next, hostScope, pendingReanchor: false })
  },
  requestReanchor: () => {
    if (!get().pendingReanchor) set({ pendingReanchor: true })
  },
  setCollapse: (key, collapsed) => {
    const cur = get().collapse
    if (cur[key] === collapsed) return
    const next = { ...cur, [key]: collapsed }
    saveJSON(COLLAPSE_KEY, next)
    set({ collapse: next })
  },
}))

/**
 * 一行的活动时间（epoch ms）；无 `updatedAt` 或时间戳不可解析 = 0。
 * host/agent 给的是 ISO 串（agent 的 last_active_at ?? updated_at）。
 */
export function activityMs(row: { updatedAt?: string }): number {
  const t = row.updatedAt ? Date.parse(row.updatedAt) : NaN
  return Number.isFinite(t) ? t : 0
}

/**
 * 一行在 frozen 形态下的排序时间：有锚用锚，没锚（首次见到）退回本次
 * 的活动时间——新会话因此照旧出现在最前，随后被 seed 钉住。
 */
export function rowOrderMs(
  anchors: AnchorMap,
  row: { sessionId: string; updatedAt?: string },
): number {
  const anchored = anchors[row.sessionId]
  return anchored != null ? anchored : activityMs(row)
}

/**
 * frozen 形态的组序：组内最大排序锚降序（同分按 label），与
 * `groupWorkspaces` 唯一的区别是「时间取自锚点而非本次响应的
 * updatedAt」——后台会话继续产出活动时，它所在目录不再整组往上窜。
 * 置顶工作目录仍由调用方的 sortWorkspacesWithPins 顶到最前。
 */
export function sortGroupsByOrderMs<T extends WorkspaceGroup>(
  groups: T[],
  anchors: AnchorMap,
): T[] {
  const key = (g: T): number =>
    g.sessions.reduce((m, s) => Math.max(m, rowOrderMs(anchors, s)), 0)
  return [...groups].sort((a, b) => {
    const d = key(b) - key(a)
    return d !== 0 ? d : a.label.localeCompare(b.label)
  })
}
