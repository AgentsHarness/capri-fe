export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: string; [k: string]: unknown }



/** Per-session todo status (hub-persisted UI prefs; absence = no record). */
export type TodoStatus = 'todo' | 'completed'

/**
 * 单条偏好的 last-write-wins 记录（合并规则见 store/prefsEntries.ts）：
 * key 形如 `ws:<cwd>` / `se:<sessionId>` / `todo:<sessionId>` /
 * `fe:<field>`，`v` 是值（引脚 "1"、待办 "todo"|"completed"、
 * fe 偏好 "true"|"false"），`at` 是写入时刻（epoch ms），`site` 是写入端
 * 标识（同时钟下按它定序），`d` = 墓碑（该条目已被删除）。
 *
 * hub 与浏览器都以此为准，`HubPrefsDoc` 里那四个集合字段只是它的投影——
 * 旧 FE / 旧 hub 读投影即可继续工作。
 */
export type PrefsEntry = {
  v: string
  at: number
  site: string
  d?: boolean
}

export type PrefsEntries = Record<string, PrefsEntry>

/**
 * The FE's durable UI preferences for host conversations: pinned
 * workspaces (cwd paths), pinned sessions, per-session todo status, and
 * FE-side appearance prefs (fePrefs). Persisted by the hub
 * (GET/PUT /api/prefs, one shared doc in prefs.json); localStorage
 * mirrors it as the offline cache. Keys are sessionId/cwd only — session
 * ids are host-assigned UUIDs, so a doc is effectively per host
 * conversation without an explicit hostId scope.
 */
export type HubPrefsDoc = {
  /** 以下四项是 entries 的投影（兼容不认 entries 的旧 FE / 旧 hub）。 */
  pinnedWorkspaces?: string[]
  pinnedSessions?: string[]
  todos?: Record<string, TodoStatus>
  /** FE 前端偏好（无 host 对应项，如 scrollback 分组折叠）。 */
  fePrefs?: FePrefsDoc
  /** 真相源：按条目的 LWW 集合（含删除墓碑）。 */
  entries?: PrefsEntries
}

/**
 * FE 前端偏好，随 prefs 文档跨端同步（与置顶/待办同一条 hub 通道）。
 * 缺省字段 = 默认值，字段可扩展。
 */
export type FePrefsDoc = {
  /** scrollback 中 toolcall 分组默认折叠（false = 分组默认展开、逐条显示）。 */
  collapseToolGroups?: boolean
  /** 精简回放（历史只裁工具正文）。缺省 = 未显式选过 = 按部署模式取默认。 */
  liteReplay?: boolean
}



/** One completion toast (ToastStack) — session finished while away. */
export type Toast = {
  id: string
  text: string
}

