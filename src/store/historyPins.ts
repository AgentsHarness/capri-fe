import { loadJSON, loadStr, removeKey, saveJSON, saveStr } from '../lib/storage'
import { create } from 'zustand'
import type { FePrefsDoc, HubPrefsDoc, SessionInfo, TodoStatus, WorkspaceGroup } from '../api/types'
import { sessionSortRank } from './historyGroups'
import { transport } from '../api/client'

/**
 * 浏览器「置顶 + 待办」偏好（对 host 会话）：
 * - pinnedWorkspaces — 置顶的工作目录（cwd 全路径），侧边栏永远排在
 *   非置顶工作区之前（内部仍按活跃度排序）。
 * - pinnedSessions   — 置顶的会话（sessionId），在其所属工作区内永远
 *   排在非置顶会话之前（内部仍按 updatedAt 排序）。
 * - todos            — 待办记录（sessionId → 'todo' | 'completed'），
 *   独立于置顶的追踪状态：待办（未完成）升到会话列表前部，方便用户
 *   盯住没做完的事；完成/取消后徽标消失或保留完成痕迹。
 *
 * 持久化与跨端同步（hub 权威）：
 * - localStorage（离线缓存，启动即用，key = acpfe.historyPins）；
 * - hub（持久层 + 同步中枢）：Hub 模式启动时 GET /api/prefs **以 hub
 *   为准整体替换**本地（含删除）；之后每次变更防抖 500ms 全量 PUT 回写，
 *   hub 随即广播 prefs_changed——所有在线浏览器实时应用同一份文档，
 *   一端的置顶/待办（含取消）改动直接同步到另一端，无需刷新。
 *   本机 host 配了 HUB_URL 时，即使当前连接是 local / 本机近路，
 *   也回写该 hub（prefsOrigin）；完全没有 hub 地址才只走 localStorage。
 *
 * 并发语义：同一时刻只有一端在写（单用户多浏览器、低频操作），后写
 * 覆盖收敛一致；毫秒级竞态窗口内本地未推送的变更以「合并（本地优先）」
 * 保留，不丢操作。
 *
 * 通过 zustand 暴露，保证组件在 toggle 后立即重渲染。
 */

const PIN_KEY = 'acpfe.historyPins'
/** 上次成功与 hub 对齐的文档快照（判断「本地有未推送改动」）。 */
const SYNC_KEY = 'acpfe.historyPins.synced'
/** 本地有尚未 PUT 成功的变更（跨刷新保留，避免启动时被 hub 覆盖）。 */
const DIRTY_KEY = 'acpfe.historyPins.dirty'
/** 变更后延迟多久统一回写 hub（合并连续点击）。 */
const HUB_PUSH_DEBOUNCE_MS = 500

export type HistoryPins = {
  pinnedWorkspaces: Set<string>
  pinnedSessions: Set<string>
  /** sessionId → todo 状态；缺失 = 无待办记录。 */
  todos: Record<string, TodoStatus>
  /** FE 前端偏好（与置顶/待办同一 hub prefs 文档，跨端同步）。 */
  fePrefs: FePrefs
}

/** FE 前端偏好默认值；改动经 hub prefs 同步到所有在线浏览器。 */
export type FePrefs = {
  /** scrollback 中 toolcall 分组默认折叠（false = 分组默认展开）。 */
  collapseToolGroups: boolean
}

function defaultFePrefs(): FePrefs {
  return { collapseToolGroups: true }
}

/** fePrefs 全为默认值（对 isEmptyPrefs 无贡献）。 */
function fePrefsIsDefault(p: FePrefs): boolean {
  return p.collapseToolGroups === true
}

function toStringSet(v: unknown): Set<string> {
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
}

function toTodoMap(v: unknown): Record<string, TodoStatus> {
  if (!v || typeof v !== 'object') return {}
  const out: Record<string, TodoStatus> = {}
  for (const [k, val] of Object.entries(v)) {
    if (val === 'todo' || val === 'completed') out[k] = val
  }
  return out
}

/** hub 文档中的 fePrefs 段 → 内存态（缺省字段按默认值）。 */
function fromFePrefsDoc(v: unknown): FePrefs {
  const d = v && typeof v === 'object' && !Array.isArray(v) ? (v as FePrefsDoc) : {}
  return {
    collapseToolGroups: d.collapseToolGroups !== false,
  }
}

/**
 * localStorage 读取（v2）＋ 旧版（v1：只有置顶的全局
 * {workspaces, sessions}）迁移。迁移目标放入当前 store 的全局字段——
 * 旧版置顶本来就是全 host 共享的，迁移后语义不变。
 */
function load(): HistoryPins {
  const parsed = loadJSON<Record<string, unknown>>(PIN_KEY, {})
  // loadJSON 只兜 JSON 语法损坏;值若是合法 JSON 的原始类型
  // （如字面 "null"）会原样穿透,先挡一道,脏数据一律按空偏好
  // 处理——否则 v1 分支的 `parsed.workspaces` 会抛 TypeError。
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if ('todos' in parsed) {
      // v2：{ pinnedWorkspaces, pinnedSessions, todos }（+fePrefs）
      return {
        pinnedWorkspaces: toStringSet(parsed.pinnedWorkspaces),
        pinnedSessions: toStringSet(parsed.pinnedSessions),
        todos: toTodoMap(parsed.todos),
        fePrefs: fromFePrefsDoc(parsed.fePrefs),
      }
    }
    // v1：{ workspaces, sessions } → 迁移成 v2。
    return {
      pinnedWorkspaces: toStringSet(parsed.workspaces),
      pinnedSessions: toStringSet(parsed.sessions),
      todos: {},
      fePrefs: defaultFePrefs(),
    }
  }
  return {
    pinnedWorkspaces: new Set(),
    pinnedSessions: new Set(),
    todos: {},
    fePrefs: defaultFePrefs(),
  }
}

function persist(pins: HistoryPins): void {
  saveJSON(PIN_KEY, {
    pinnedWorkspaces: [...pins.pinnedWorkspaces],
    pinnedSessions: [...pins.pinnedSessions],
    todos: pins.todos,
    fePrefs: pins.fePrefs,
  })
}

// ── hub 同步 ──────────────────────────────────────────────────────────

/** 内存态 → hub 文档（Set → 数组）。 */
function toWire(p: HistoryPins): HubPrefsDoc {
  return {
    pinnedWorkspaces: [...p.pinnedWorkspaces],
    pinnedSessions: [...p.pinnedSessions],
    todos: p.todos,
    fePrefs: p.fePrefs,
  }
}

/** hub 文档 → 内存态（缺省字段按空处理）。 */
function fromWire(doc: HubPrefsDoc): HistoryPins {
  return {
    pinnedWorkspaces: toStringSet(doc.pinnedWorkspaces),
    pinnedSessions: toStringSet(doc.pinnedSessions),
    todos: toTodoMap(doc.todos),
    fePrefs: fromFePrefsDoc(doc.fePrefs),
  }
}

/**
 * 旧版 hub 不认 fePrefs 字段（解码时丢弃未知 JSON 键）：收到不带
 * fePrefs 的权威文档时保留本地 fePrefs，否则每次 prefs_changed 广播
 * 都会把用户刚设的偏好打回默认。hub 升级后文档带上 fePrefs，才整体替换。
 */
function applyHubPreservingFePrefs(
  raw: HubPrefsDoc,
  hub: HistoryPins,
  local: HistoryPins,
): HistoryPins {
  const hasFePrefs =
    raw.fePrefs != null &&
    typeof raw.fePrefs === 'object' &&
    !Array.isArray(raw.fePrefs)
  return hasFePrefs ? hub : { ...hub, fePrefs: local.fePrefs }
}

function isEmptyPrefs(p: HistoryPins): boolean {
  return (
    p.pinnedWorkspaces.size === 0 &&
    p.pinnedSessions.size === 0 &&
    Object.keys(p.todos).length === 0 &&
    fePrefsIsDefault(p.fePrefs)
  )
}

function snapshot(p: HistoryPins): string {
  return JSON.stringify({
    pinnedWorkspaces: [...p.pinnedWorkspaces].sort(),
    pinnedSessions: [...p.pinnedSessions].sort(),
    todos: p.todos,
    fePrefs: p.fePrefs,
  })
}

function markSynced(p: HistoryPins): void {
  saveStr(SYNC_KEY, snapshot(p))
}

function localUnsynced(p: HistoryPins): boolean {
  const last = loadStr(SYNC_KEY)
  return last != null && last !== snapshot(p)
}

/** 本地有 hub 没有的置顶/待办（或待办状态不同）——未推送的新增。 */
function hasLocalExtras(local: HistoryPins, hub: HistoryPins): boolean {
  for (const w of local.pinnedWorkspaces) if (!hub.pinnedWorkspaces.has(w)) return true
  for (const s of local.pinnedSessions) if (!hub.pinnedSessions.has(s)) return true
  for (const [id, st] of Object.entries(local.todos)) {
    if (hub.todos[id] !== st) return true
  }
  return false
}

function mergeLocalOverHub(hub: HistoryPins, local: HistoryPins): HistoryPins {
  return {
    pinnedWorkspaces: new Set([...hub.pinnedWorkspaces, ...local.pinnedWorkspaces]),
    pinnedSessions: new Set([...hub.pinnedSessions, ...local.pinnedSessions]),
    todos: { ...hub.todos, ...local.todos },
    // fePrefs 是标量偏好：竞态窗口内以本地为准（同 pins 的本地优先）。
    fePrefs: { ...hub.fePrefs, ...local.fePrefs },
  }
}

let hubPushTimer: ReturnType<typeof setTimeout> | null = null
/**
 * 本地有尚未推送成功的变更（防抖等待中 / 上次 PUT 失败）。收到他人
 * 广播时据此决定「合并保留本地」还是「以 hub 为准替换」——只有毫秒级
 * 竞态窗口内会合并，正常流一律替换（删除才能同步）。
 * 跨刷新持久化到 DIRTY_KEY，避免 local 模式跳过推送后重启被 hub 覆盖。
 */
let hubDirty = loadStr(DIRTY_KEY) === '1'

function setDirty(v: boolean): void {
  hubDirty = v
  if (v) saveStr(DIRTY_KEY, '1')
  else removeKey(DIRTY_KEY)
}

/**
 * 进行中的 syncPrefsFromHub（去重）：StrictMode 双挂载 + init 延迟
 * 可能让两次调用相邻触发，共享同一次拉取避免重复请求。
 */
let syncInFlight: Promise<void> | null = null

/** 防抖回写 hub；尚无 hub 地址 / 失败都静默降级（本地状态不丢，dirty 保留）。 */
function scheduleHubPush(): void {
  setDirty(true)
  if (hubPushTimer != null) clearTimeout(hubPushTimer)
  hubPushTimer = setTimeout(() => {
    hubPushTimer = null
    void pushToHub()
  }, HUB_PUSH_DEBOUNCE_MS)
}

async function pushToHub(): Promise<void> {
  try {
    const s = usePins.getState()
    await transport.putPrefs(toWire(s))
    setDirty(false)
    markSynced(s)
  } catch (err) {
    // 写失败（无 hub 地址 / 网络）：保留本地状态与 dirty，下次变更或启动再推。
    console.warn('[pins] hub 持久化失败（已保留本地）', err)
  }
}

/** 以一份权威文档替换本地（写 localStorage + 内存）。 */
function applyPrefs(next: HistoryPins): void {
  persist(next)
  usePins.setState(next)
}

// 模块级注册：hub 广播 prefs_changed（任意一端 PUT 成功后）→ 本浏览器
// 实时应用，无需刷新。dirty（自己的变更还没推上去）时合并本地优先，
// 避免刚点的操作被他人文档冲掉；否则以 hub 为准整体替换（含删除）。
transport.onEvent((ev) => {
  if (ev.type !== 'prefs_changed') return
  const params = (ev as { params?: { prefs?: HubPrefsDoc } }).params
  const raw = params?.prefs
  if (!raw) return
  const hub = fromWire(raw)
  const s = usePins.getState()
  if (hubDirty) {
    const merged: HistoryPins = {
      pinnedWorkspaces: new Set([...s.pinnedWorkspaces, ...hub.pinnedWorkspaces]),
      pinnedSessions: new Set([...s.pinnedSessions, ...hub.pinnedSessions]),
      todos: { ...hub.todos, ...s.todos },
      fePrefs: { ...hub.fePrefs, ...s.fePrefs },
    }
    applyPrefs(merged)
  } else {
    applyPrefs(applyHubPreservingFePrefs(raw, hub, s))
  }
})

/** 置顶/待办 + 前端偏好 + 动作的完整 store 形态。 */
export type HubPrefsState = HistoryPins & {
  toggleWorkspacePin: (cwd: string) => void
  toggleSessionPin: (sessionId: string) => void
  /** 设置/清除会话待办状态：'todo' | 'completed' | null（清除）。 */
  setTodoStatus: (sessionId: string, status: TodoStatus | null) => void
  /** 更新 FE 前端偏好（与置顶/待办同一 hub prefs 文档同步）。 */
  setFePrefs: (patch: Partial<FePrefs>) => void
  /** 启动时从 hub 拉取，以 hub 为准替换本地（hub 模式；首次无数据时上推本地）。 */
  syncPrefsFromHub: () => Promise<void>
}

export const usePins = create<HubPrefsState>(() => {
  const initial = load()
  return {
    ...initial,
    toggleWorkspacePin: (cwd) =>
      usePins.setState((s) => {
        const next = new Set(s.pinnedWorkspaces)
        if (next.has(cwd)) next.delete(cwd)
        else next.add(cwd)
        const prefs = { pinnedWorkspaces: next, pinnedSessions: s.pinnedSessions, todos: s.todos, fePrefs: s.fePrefs }
        persist(prefs)
        scheduleHubPush()
        return { pinnedWorkspaces: next }
      }),
    toggleSessionPin: (sessionId) =>
      usePins.setState((s) => {
        const next = new Set(s.pinnedSessions)
        if (next.has(sessionId)) next.delete(sessionId)
        else next.add(sessionId)
        const prefs = { pinnedWorkspaces: s.pinnedWorkspaces, pinnedSessions: next, todos: s.todos, fePrefs: s.fePrefs }
        persist(prefs)
        scheduleHubPush()
        return { pinnedSessions: next }
      }),
    setTodoStatus: (sessionId, status) =>
      usePins.setState((s) => {
        const todos = { ...s.todos }
        if (status == null) delete todos[sessionId]
        else todos[sessionId] = status
        const prefs = { pinnedWorkspaces: s.pinnedWorkspaces, pinnedSessions: s.pinnedSessions, todos, fePrefs: s.fePrefs }
        persist(prefs)
        scheduleHubPush()
        return { todos }
      }),
    setFePrefs: (patch) =>
      usePins.setState((s) => {
        const fePrefs = { ...s.fePrefs, ...patch }
        persist({ ...s, fePrefs })
        scheduleHubPush()
        return { fePrefs }
      }),
    syncPrefsFromHub: async () => {
      if (!transport.prefsOrigin()) return
      // 去重：进行中的拉取复用同一 promise（StrictMode 双挂载 / init
      // 延迟后的相邻调用只发一次请求）。
      if (syncInFlight) return syncInFlight
      syncInFlight = (async () => {
        try {
          const raw = await transport.getPrefs()
          const hub = fromWire(raw)
          const s = usePins.getState()
          // 本地有未推送的改动：不能以 hub 覆盖（否则 local 模式改的
          // 置顶/待办会在下次进 hub 时被抹掉）。dirty / 快照不一致
          // → 整份本地上推（含删除）；仅 extras（首次补齐）→ 合并后上推。
          if (hubDirty || localUnsynced(s) || hasLocalExtras(s, hub)) {
            const next = hubDirty || localUnsynced(s) ? s : mergeLocalOverHub(hub, s)
            applyPrefs(next)
            await transport.putPrefs(toWire(next))
            setDirty(false)
            markSynced(next)
          } else if (isEmptyPrefs(hub) && !isEmptyPrefs(s)) {
            // 首次部署 / hub 数据被清：hub 还没有任何记录，把本地上推。
            applyPrefs(s)
            await transport.putPrefs(toWire(s))
            markSynced(s)
          } else {
            // 本地干净：以 hub 为准整体替换（含删除）；旧 hub 未带
            // fePrefs 时保留本地偏好不被空默认覆盖。
            const next = applyHubPreservingFePrefs(raw, hub, s)
            applyPrefs(next)
            markSynced(next)
          }
        } catch (err) {
          // 拉取失败（hub 未升级 / 网络）：保留本地状态，功能照常。
          console.warn('[pins] hub 同步失败（保留本地）', err)
        } finally {
          syncInFlight = null
        }
      })()
      return syncInFlight
    },
  }
})

// ── FE 前端偏好访问 ───────────────────────────────────────────────────

/**
 * FE 前端偏好选择器钩子（zustand 订阅，跨端同步后即时重渲染）。
 * 用法：useFePrefs((s) => s.fePrefs.collapseToolGroups)
 */
export function useFePrefs<T>(selector: (s: HubPrefsState) => T): T {
  return usePins(selector)
}

/** 非 hook 同步读取（store action / 纯函数路径，选中态计算等）。 */
export function currentCollapseToolGroups(): boolean {
  return usePins.getState().fePrefs.collapseToolGroups
}

/**
 * 工作区排序：置顶的工作目录永远在最前（内部按原 groupWorkspaces 的
 * 活跃度顺序），非置顶保持原顺序。
 */
export function sortWorkspacesWithPins<T extends WorkspaceGroup>(
  workspaces: T[],
  pinned: Set<string>,
): T[] {
  const pinnedList = workspaces.filter((g) => pinned.has(g.cwd))
  const rest = workspaces.filter((g) => !pinned.has(g.cwd))
  return [...pinnedList, ...rest]
}

/**
 * 会话排序：置顶的会话永远最前；随后是待办（未完成）的会话——待办是
 * 独立于置顶的追踪状态，升到其余会话之前方便用户盯住没做完的事；再
 * 按状态优先级 → 最新活动降序（状态优先级见 historyGroups.sessionSortRank：
 * 待处理 → 完成对勾 → 运行中+后台任务 → 运行中 → 后台任务运行中 → 空闲）。
 * 已完成的待办不升位（徽标保留完成痕迹，排序回到正常优先级）。
 */
export function sortSessionsWithPins<T extends SessionInfo>(
  sessions: T[],
  pinned: Set<string>,
  completedNotices: Record<string, number> | null,
  cmp: (a: T, b: T) => number,
  todos: Record<string, TodoStatus> = {},
): T[] {
  const byPriority = (a: T, b: T): number => {
    const ta = todos[a.sessionId] === 'todo' ? 0 : 1
    const tb = todos[b.sessionId] === 'todo' ? 0 : 1
    if (ta !== tb) return ta - tb
    const ra = sessionSortRank(a, completedNotices)
    const rb = sessionSortRank(b, completedNotices)
    if (ra !== rb) return ra - rb
    return cmp(a, b)
  }
  const pinnedList = sessions.filter((s) => pinned.has(s.sessionId)).sort(byPriority)
  const rest = sessions.filter((s) => !pinned.has(s.sessionId)).sort(byPriority)
  return [...pinnedList, ...rest]
}
