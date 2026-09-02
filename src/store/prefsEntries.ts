/**
 * 置顶/待办偏好的**条目模型**——hub 与浏览器之间的真相源。
 *
 * 为什么要有这个文件：偏好文档原本是一整份「集合快照」（pinnedSessions /
 * pinnedWorkspaces / todos / fePrefs），写入是**整份替换**。快照表达不了
 * 「删除」：一个握着陈旧快照的端 PUT 一次，就把别端刚取消的置顶原样写回
 * hub，且没有任何痕迹能判断谁更新——这就是「取消的置顶又复活」的根因。
 *
 * 这里把文档换成 **LWW-Element-Set**：每个条目（一条置顶、一个待办状态、
 * 一个前端偏好字段）独立带「写入时刻 at + 写入端 site」，删除写成墓碑。
 * 合并按条目取较新者，满足交换律 / 结合律 / 幂等：
 * - 合并顺序无关（广播迟到、重试、断线补拉都安全）；
 * - 陈旧快照不可能复活别端较新的删除（那条删除的 at 更大）；
 * - 因此不再需要「本地是否 dirty」「待推 ops 日志」「已同步指纹」这套
 *   猜测式协议，也不需要靠条件写来避免踩人。
 *
 * 线格式（hub 侧对应 internal/hub 的 PrefsEntry）：
 *   entries: { "se:<sessionId>": {v:"1", at:1735..., site:"a1b2", d?:true} }
 *   key  : ws:<cwd> | se:<sessionId> | todo:<sessionId> | fe:<field>
 *   v    : 引脚 "1"；待办 "todo"|"completed"；fe 偏好 "true"|"false"
 *   at   : 写入时刻（epoch ms；写入方按 maxAt+1 兜住时钟回退）
 *   site : 每浏览器源一个随机串，at 相同时的定序裁决
 *   d    : 墓碑（删除）
 *
 * `pinnedSessions` 等快照字段继续随文档往返：它只是 entries 的**投影**，
 * 供旧 FE / 旧 hub 读取（hub 升级前也能正常工作，退化为今天的后写覆盖）。
 */

// 条目与线格式的类型定义在 api/types/core.ts（hub 侧对应 internal/hub 的
// PrefsEntry），这里只实现合并/投影逻辑。
import type { PrefsEntry, PrefsEntries } from '../api/types'

export type { PrefsEntry, PrefsEntries }

/** 条目 key 前缀（与 hub 侧 projectPrefs / parseKey 对齐）。 */
export const PREFS_KEY = {
  workspace: 'ws:',
  session: 'se:',
  todo: 'todo:',
  fe: 'fe:',
} as const

export const wsKey = (cwd: string): string => `${PREFS_KEY.workspace}${cwd}`
export const sessionKey = (sessionId: string): string => `${PREFS_KEY.session}${sessionId}`
export const todoKey = (sessionId: string): string => `${PREFS_KEY.todo}${sessionId}`
export const feKey = (field: string): string => `${PREFS_KEY.fe}${field}`

/** 较新者胜出：先比 at，再比 site（site 唯一 → 全序）。 */
export function entryWins(a: PrefsEntry, b: PrefsEntry): boolean {
  if (a.at !== b.at) return a.at > b.at
  return a.site > b.site
}

/** 合并两份条目集（src 覆盖 dst 中落败的条目），返回新对象。 */
export function mergeEntries(dst: PrefsEntries, src: PrefsEntries): PrefsEntries {
  const out: PrefsEntries = { ...dst }
  for (const [k, e] of Object.entries(src)) {
    const cur = out[k]
    if (!cur || entryWins(e, cur)) out[k] = e
  }
  return out
}

/** 该 key 当前是否存活（存活 = 有非墓碑条目）。 */
export function alive(entries: PrefsEntries, key: string): boolean {
  const e = entries[key]
  return !!e && !e.d
}

/** 写入 / 删除一个条目（不可变）。val 为 null 写墓碑。 */
export function putEntry(
  entries: PrefsEntries,
  key: string,
  val: string | null,
  stamp: { at: number; site: string },
): PrefsEntries {
  return {
    ...entries,
    [key]: val == null ? { v: '', at: stamp.at, site: stamp.site, d: true } : { v: val, at: stamp.at, site: stamp.site },
  }
}

export function maxAt(entries: PrefsEntries): number {
  let m = 0
  for (const e of Object.values(entries)) if (e.at > m) m = e.at
  return m
}

/** 墓碑回收：删除记录只需活到「所有端都见过它」，之后可安全丢弃。 */
export const TOMBSTONE_HORIZON_MS = 60 * 24 * 60 * 60 * 1000

export function pruneTombstones(
  entries: PrefsEntries,
  now = Date.now(),
  horizon = TOMBSTONE_HORIZON_MS,
): PrefsEntries {
  const cut = now - horizon
  let touched = false
  const out: PrefsEntries = {}
  for (const [k, e] of Object.entries(entries)) {
    if (e.d && e.at < cut) {
      touched = true
      continue
    }
    out[k] = e
  }
  return touched ? out : entries
}

// ── 投影（entries → 集合快照） ────────────────────────────────────────

/** 投影出的集合快照：就是文档里那四个老字段。 */
export type PrefsSnapshot = {
  pinnedWorkspaces: string[]
  pinnedSessions: string[]
  todos: Record<string, string>
  fePrefs: Record<string, boolean>
}

export function projectEntries(entries: PrefsEntries): PrefsSnapshot {
  const view: PrefsSnapshot = {
    pinnedWorkspaces: [],
    pinnedSessions: [],
    todos: {},
    fePrefs: {},
  }
  for (const [k, e] of Object.entries(entries)) {
    if (e.d) continue
    if (k.startsWith(PREFS_KEY.workspace)) {
      view.pinnedWorkspaces.push(k.slice(PREFS_KEY.workspace.length))
    } else if (k.startsWith(PREFS_KEY.session)) {
      view.pinnedSessions.push(k.slice(PREFS_KEY.session.length))
    } else if (k.startsWith(PREFS_KEY.todo)) {
      view.todos[k.slice(PREFS_KEY.todo.length)] = e.v
    } else if (k.startsWith(PREFS_KEY.fe)) {
      view.fePrefs[k.slice(PREFS_KEY.fe.length)] = e.v === 'true'
    }
  }
  view.pinnedWorkspaces.sort()
  view.pinnedSessions.sort()
  return view
}

/**
 * 快照 → 条目（用于：旧版 localStorage 迁移、旧 FE 写的文档物化）。
 * `at` 由调用方决定：
 * - 本地陈旧缓存传 0（任何 hub 侧的真实写入都压得住它）；
 * - 旧 FE 的全量写传「到达时刻」（它本来就是后写覆盖语义）。
 * 未出现在快照里的 key 不生成墓碑——快照无从表达删除，是否补墓碑由
 * 调用方按「与上一份的差异」决定（见 hub 侧 bridgeLegacyDoc / 本地迁移）。
 */
export function entriesFromView(
  view: Partial<PrefsSnapshot>,
  at: number,
  site: string,
): PrefsEntries {
  const out: PrefsEntries = {}
  const stamp = { at, site }
  for (const cwd of view.pinnedWorkspaces ?? []) {
    out[wsKey(cwd)] = { v: '1', ...stamp }
  }
  for (const id of view.pinnedSessions ?? []) {
    out[sessionKey(id)] = { v: '1', ...stamp }
  }
  for (const [id, status] of Object.entries(view.todos ?? {})) {
    out[todoKey(id)] = { v: status, ...stamp }
  }
  for (const [field, val] of Object.entries(view.fePrefs ?? {})) {
    out[feKey(field)] = { v: String(val), ...stamp }
  }
  return out
}

/** 两份条目集是否等价（用于「这次同步有没有真的改变本地」）。 */
export function sameEntries(a: PrefsEntries, b: PrefsEntries): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    const x = a[k]
    const y = b[k]
    if (!y || x.v !== y.v || x.at !== y.at || x.site !== y.site || !!x.d !== !!y.d) return false
  }
  return true
}

/** 本浏览器源的身份标识（at 相同时的裁决者）；缺失则新生成并持久化。 */
export function createSiteId(): string {
  const rnd =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8)
  return `${Date.now().toString(36)}-${rnd}`
}
