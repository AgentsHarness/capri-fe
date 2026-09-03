import { loadJSON, loadStr, removeKey, saveJSON, saveStr } from '../lib/storage'
import { create } from 'zustand'
import type { FePrefsDoc, HubPrefsDoc, SessionInfo, TodoStatus, WorkspaceGroup } from '../api/types'
import { PrefsConflictError } from '../api/transport'
import { sessionSortRank } from './historyGroups'
import { transport } from '../api/client'
import { KEY } from '../lib/keys'
import {
  alive,
  createSiteId,
  entriesFromView,
  feKey,
  maxAt,
  mergeEntries,
  projectEntries,
  pruneTombstones,
  putEntry,
  sameEntries,
  sessionKey,
  todoKey,
  wsKey,
  type PrefsEntries,
} from './prefsEntries'

/**
 * 浏览器「置顶 + 待办」偏好（对 host 会话）：
 * - pinnedWorkspaces — 置顶的工作目录（cwd 全路径），侧边栏永远排在
 *   非置顶工作区之前（内部仍按活跃度排序）。
 * - pinnedSessions   — 置顶的会话（sessionId），在其所属工作区内永远
 *   排在非置顶会话之前（内部仍按 updatedAt 排序）。
 * - todos            — 待办记录（sessionId → 'todo' | 'completed'），
 *   独立于置顶的追踪状态：待办（未完成）升到会话列表前部，方便用户
 *   盯住没做完的事；完成/取消后徽标消失或保留完成痕迹。
 * - fePrefs          — FE 前端偏好（与置顶/待办同一份 hub 文档）。
 *
 * 以上四个都是**投影**，真相源是 `entries`：按条目的 last-write-wins 集合
 * （每条带写入时刻 + 写入端，删除写成墓碑）。见 prefsEntries.ts。
 *
 * 为什么不再是「整份快照 + 后写覆盖」：快照表达不了删除，一个握着陈旧快照
 * 的端 PUT 一次就把别端刚取消的置顶原样写回 hub——「取消的置顶又复活」正
 * 是这么来的。改成按条目合并后，合并满足交换律/结合律/幂等，收敛与到达
 * 顺序无关，陈旧端**不可能**压过别端较新的删除，于是这套协议里原先用来
 * 猜「本地是否还没推上去」的三件东西（dirty 标记、ops 日志、已同步指纹）
 * 都不需要了——它们既是复杂度，也是那些误判的来源。
 *
 * 持久化与跨端同步：
 * - localStorage 是离线缓存（启动即用），键 capri-fe.historyPins 存
 *   {v:3, entries}。v1/v2 的旧快照物化时 `at = 0`：缓存相对 hub 永远可能
 *   是陈旧的，给 0 等于承认它说的话不作数——只补齐 hub 没有的条目，绝不
 *   覆盖 hub 上任何一次真实写入（含删除）。
 * - hub（持久层 + 合并者）：PUT /api/prefs 带 entries → hub 按条目合并，
 *   回合并后的权威文档 + 新版本；广播 prefs_changed 带同一份。本端收到
 *   就合并，不整份替换、也不因「本地可能没推完」而忽略。
 * - hub 地址取 prefsOrigin()：跨源直连 / host 报的 HUB_URL / 同源部署回退
 *   页面 origin；local 模式无 hub 地址，仅走 localStorage（改动留在本地，
 *   等回到 hub 模式再按条目合并上推）。
 * - 遇到不认 entries 的旧 hub：它的响应不带条目 → 退化成今天的全量覆盖
 *   语义（仍是后写覆盖，但不会像旧协议那样把陈旧快照静默写回——写前总是
 *   先 GET 一次，把 hub 现状并进本地）。
 *
 * 未落地的写入由 PENDING 标记记住（离线 / 缺密钥 / 重试未成），在下一次
 * 本地变更、WS 上线（hub_conn）或一次延迟重试时再推。它只安排「还要再推」，
 * 不参与任何合并判断。
 */

const PIN_KEY = KEY.historyPins
/** 有尚未确认被 hub 接受的本地写入（跨刷新保留，仅用于安排重试）。 */
const PENDING_KEY = KEY.historyPinsDirty
/** hub 文档版本：条目合并用不上，旧 hub 的条件写与排障用。 */
const VER_KEY = KEY.historyPinsVer
/** 本浏览器源的身份（同 at 时的定序裁决），持久化以跨刷新稳定。 */
const SITE_KEY = KEY.historyPinsSite
/** 变更后延迟多久统一回写 hub（合并连续点击）。 */
const HUB_PUSH_DEBOUNCE_MS = 500
/** 一次推送失败后兜底重试的间隔。 */
const HUB_PUSH_RETRY_MS = 5000

// ── 内存态与本地缓存 ──────────────────────────────────────────────────

/** FE 前端偏好默认值；改动经 hub prefs 同步到所有在线浏览器。 */
export type FePrefs = {
  /** scrollback 中 toolcall 分组默认折叠（false = 分组默认展开）。 */
  collapseToolGroups: boolean
  /**
   * 精简回放：历史分页请求带 detail=lite，idle 后再拉 full 填正文。
   * 只在走 hub 中转时生效（见 historyViaHubRelay）；直连本机 / 纯 local
   * 始终拉 full。没显式选过时默认随是否中转现算。
   */
  liteReplay: boolean
}

/** entries 投影出的内存态（组件只认这份，不感知条目模型）。 */
type PrefsView = {
  pinnedWorkspaces: Set<string>
  pinnedSessions: Set<string>
  todos: Record<string, TodoStatus>
  fePrefs: FePrefs
}

/**
 * 这条历史请求会不会绕 hub 中转。纯 local、以及 hub 模式下选中本机近路
 * （isLocalDirect）都是直连 host，不必 lite+full。
 */
export function historyViaHubRelay(): boolean {
  if (transport.getConnectionMode?.() !== 'hub') return false
  return transport.isLocalDirect?.() !== true
}

/** 没显式选过时：中转开、直连关。 */
function defaultLiteReplay(): boolean {
  return historyViaHubRelay()
}

/**
 * 投影 entries → 内存态。没被任何端写过的 fePrefs 字段取默认值；
 * liteReplay 的「没选过」在读取处现算（见 currentLiteReplay），因为部署
 * 模式在建店之后才判定出来。
 */
function project(entries: PrefsEntries): PrefsView {
  const v = projectEntries(entries)
  const todos: Record<string, TodoStatus> = {}
  for (const [id, status] of Object.entries(v.todos)) {
    if (status === 'todo' || status === 'completed') todos[id] = status
  }
  return {
    pinnedWorkspaces: new Set(v.pinnedWorkspaces),
    pinnedSessions: new Set(v.pinnedSessions),
    todos,
    fePrefs: {
      collapseToolGroups: v.fePrefs.collapseToolGroups !== false,
      liteReplay:
        typeof v.fePrefs.liteReplay === 'boolean' ? v.fePrefs.liteReplay : defaultLiteReplay(),
    },
  }
}

/** 内存态 → 文档里的 fePrefs 快照：没被显式选过的 liteReplay 不写出去。 */
function fePrefsView(entries: PrefsEntries, fePrefs: FePrefs): FePrefsDoc {
  const out: FePrefsDoc = { collapseToolGroups: fePrefs.collapseToolGroups }
  if (alive(entries, feKey('liteReplay'))) out.liteReplay = fePrefs.liteReplay
  return out
}

function toStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function toTodoMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (val === 'todo' || val === 'completed') out[k] = val
  }
  return out
}

function toBoolMap(v: unknown): Record<string, boolean> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, boolean> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'boolean') out[k] = val
  }
  return out
}

/** 来路不明的 entries 先过类型闸（手改存储 / 半截写入都不能进内存）。 */
function sanitizeEntries(v: unknown): PrefsEntries {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: PrefsEntries = {}
  for (const [k, raw] of Object.entries(v)) {
    if (!k || !raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    if (typeof e.v !== 'string' || typeof e.at !== 'number' || !Number.isFinite(e.at)) continue
    if (typeof e.site !== 'string' || e.site === '') continue
    out[k] =
      e.d === true
        ? { v: e.v, at: e.at, site: e.site, d: true }
        : { v: e.v, at: e.at, site: e.site }
  }
  return out
}

/** 本浏览器源标识；缺失即新生成（每个 origin 一份，互不相干）。 */
function loadSiteId(): string {
  const cur = loadStr(SITE_KEY)
  if (cur) return cur
  const fresh = createSiteId()
  saveStr(SITE_KEY, fresh)
  return fresh
}

/**
 * 读本地缓存：v3（{v:3, entries}）直接用；v2（带 todos 的快照）与 v1（只有
 * 置顶的 {workspaces, sessions}）物化成条目并标 `at = 0`（理由见文件头）。
 */
function load(): { entries: PrefsEntries; site: string } {
  const site = loadSiteId()
  const parsed = loadJSON<Record<string, unknown>>(PIN_KEY, {})
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { entries: {}, site }
  if (parsed.v === 3) return { entries: sanitizeEntries(parsed.entries), site }
  const view =
    'todos' in parsed
      ? {
          pinnedWorkspaces: toStringList(parsed.pinnedWorkspaces),
          pinnedSessions: toStringList(parsed.pinnedSessions),
          todos: toTodoMap(parsed.todos),
          fePrefs: toBoolMap(parsed.fePrefs),
        }
      : {
          // v1：{ workspaces, sessions } —— 旧版置顶本来就是全 host 共享的。
          pinnedWorkspaces: toStringList(parsed.workspaces),
          pinnedSessions: toStringList(parsed.sessions),
          todos: {},
          fePrefs: {},
        }
  return { entries: entriesFromView(view, 0, `${site}-legacy`), site }
}

function persist(entries: PrefsEntries): void {
  saveJSON(PIN_KEY, { v: 3, entries: pruneTombstones(entries) })
}

// ── hub 文档 ↔ 条目 ──────────────────────────────────────────────────

/** 内存态 → 上推的 hub 文档（投影 + 条目一起给，旧 hub 只看得懂投影）。 */
function toWire(view: PrefsView, entries: PrefsEntries): HubPrefsDoc {
  return {
    pinnedWorkspaces: [...view.pinnedWorkspaces].sort(),
    pinnedSessions: [...view.pinnedSessions].sort(),
    todos: view.todos,
    fePrefs: fePrefsView(entries, view.fePrefs),
    entries: pruneTombstones(entries),
  }
}

/** 文档是否带条目（带 = hub 会按条目合并；不带 = 旧 hub / 旧 FE）。 */
function docHasEntries(doc?: HubPrefsDoc): boolean {
  return !!doc?.entries && Object.keys(doc.entries).length > 0
}

/**
 * hub 文档 → 条目。带 entries 就原样收下；只给投影（旧 hub、或 hub 刚升级
 * 还没有条目）就按快照物化，时间戳用 `at`（调用方给一个「晚于本地已知一切」
 * 的值，让 hub 现状压过本地陈旧缓存，符合「以 hub 为准」的方向）。
 */
function entriesFromDoc(doc: HubPrefsDoc, snapshotAt: number, site: string): PrefsEntries {
  if (docHasEntries(doc)) return sanitizeEntries(doc.entries)
  return entriesFromView(
    {
      pinnedWorkspaces: toStringList(doc.pinnedWorkspaces),
      pinnedSessions: toStringList(doc.pinnedSessions),
      todos: toTodoMap(doc.todos),
      fePrefs: toBoolMap(doc.fePrefs),
    },
    snapshotAt,
    site,
  )
}

// ── store ────────────────────────────────────────────────────────────

/** 置顶/待办 + 前端偏好 + 动作的完整 store 形态。 */
export type HubPrefsState = PrefsView & {
  /** 真相源：按条目的 LWW 集合（含墓碑）。 */
  entries: PrefsEntries
  /** 本浏览器源标识。 */
  site: string
  toggleWorkspacePin: (cwd: string) => void
  toggleSessionPin: (sessionId: string) => void
  /** 设置/清除会话待办状态：'todo' | 'completed' | null（清除）。 */
  setTodoStatus: (sessionId: string, status: TodoStatus | null) => void
  /** 更新 FE 前端偏好（与置顶/待办同一 hub prefs 文档同步）。 */
  setFePrefs: (patch: Partial<FePrefs>) => void
  /** 把一份 hub 文档按条目并进本地（广播 / GET / PUT 响应共用）。 */
  absorb: (doc: HubPrefsDoc | undefined, siteTag?: string) => void
  /** 从 hub 拉取并对齐（启动 / WS 重连时）。 */
  syncPrefsFromHub: () => Promise<void>
}

export const usePins = create<HubPrefsState>((set, get) => {
  const { entries: initial, site } = load()

  /** 收到一份外部文档并按条目合并；返回合并后本地是否还领先于该文档。 */
  const mergeDoc = (doc: HubPrefsDoc | undefined, siteTag: string): boolean => {
    if (!doc) return false
    const cur = get().entries
    const incoming = entriesFromDoc(doc, maxAt(cur) + 1, siteTag)
    const merged = pruneTombstones(mergeEntries(cur, incoming))
    if (!sameEntries(merged, cur)) {
      persist(merged)
      set({ entries: merged, ...project(merged) })
    }
    return !sameEntries(merged, incoming)
  }

  return {
    entries: initial,
    site,
    ...project(initial),

    toggleWorkspacePin: (cwd) =>
      write((entries, stamp) => {
        const k = wsKey(cwd)
        return putEntry(entries, k, alive(entries, k) ? null : '1', stamp)
      }),
    toggleSessionPin: (sessionId) =>
      write((entries, stamp) => {
        const k = sessionKey(sessionId)
        return putEntry(entries, k, alive(entries, k) ? null : '1', stamp)
      }),
    setTodoStatus: (sessionId, status) =>
      write((entries, stamp) => putEntry(entries, todoKey(sessionId), status, stamp)),
    setFePrefs: (patch) =>
      write((entries, stamp) => {
        let next = entries
        for (const [field, val] of Object.entries(patch)) {
          if (typeof val === 'boolean') next = putEntry(next, feKey(field), String(val), stamp)
        }
        return next
      }),

    absorb: (doc, siteTag = 'hub') => {
      mergeDoc(doc, siteTag)
    },

    syncPrefsFromHub: async () => {
      if (!transport.prefsOrigin()) return
      await runHubSync(mergeDoc)
    },
  }

  /** 一次本地写入：落到条目 → 重投影 → 写缓存 → 安排回写。 */
  function write(mutate: (e: PrefsEntries, s: { at: number; site: string }) => PrefsEntries) {
    const s = get()
    const at = Math.max(Date.now(), maxAt(s.entries) + 1)
    const next = pruneTombstones(mutate(s.entries, { at, site: s.site }))
    persist(next)
    set({ entries: next, ...project(next) })
    scheduleHubPush()
  }
})

// ── hub 同步 ─────────────────────────────────────────────────────────

/** 防抖/重试定时器。 */
let hubPushTimer: ReturnType<typeof setTimeout> | null = null
/** 是否有一轮回写在跑（串行：同时最多一个 PUT 在飞）。 */
let hubPushRunning = false
/** 跑动期间又有推送请求：本轮结束后再推一轮最新状态。 */
let hubPushAgain = false
/** 最后一轮回写的完成信号。 */
let hubPushDone: Promise<void> = Promise.resolve()
/** 进行中的启动/重连同步（去重：StrictMode 双挂载 + 相邻触发共享一次）。 */
let syncInFlight: Promise<void> | null = null

/** 变更后安排回写（合并连续点击）。 */
function scheduleHubPush(): void {
  setPending(true)
  if (hubPushTimer != null) clearTimeout(hubPushTimer)
  hubPushTimer = setTimeout(() => {
    hubPushTimer = null
    void pushToHub()
  }, HUB_PUSH_DEBOUNCE_MS)
}

/** 失败兜底：只要还有未落地的写入，过一会儿再试一轮。 */
function armPushRetry(): void {
  // 无 hub 地址（local 模式）时不空转：改动已在本地与 PENDING 里，回到
  // hub 模式的启动同步、WS 上线或下一次本地变更都会再来一次。
  if (!transport.prefsOrigin()) return
  if (hubPushTimer != null || !isPending()) return
  hubPushTimer = setTimeout(() => {
    hubPushTimer = null
    void pushToHub()
  }, HUB_PUSH_RETRY_MS)
}

function isPending(): boolean {
  return loadStr(PENDING_KEY) === '1'
}

function setPending(v: boolean): void {
  if (v) saveStr(PENDING_KEY, '1')
  else removeKey(PENDING_KEY)
}

/** hub 文档版本；null = 未知 / hub 不支持版本 → 不发 baseVersion。 */
function hubBaseVersion(): number | null {
  const raw = loadStr(VER_KEY)
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

function setHubBaseVersion(v: number | null): void {
  if (v == null) removeKey(VER_KEY)
  else saveStr(VER_KEY, String(v))
}

/**
 * 回写 hub（推「当前」文档，串行执行）。
 *
 * 带 entries 的写入在 hub 侧是**合并**而非覆盖，收敛不再依赖条件写；仍把
 * 已知版本当 base 带上——新 hub 对带条目的写忽略它（合并就好），旧 hub 用
 * 它做今天的 409 保护。
 *
 * 收口判据（决定要不要清 PENDING）：
 * - hub 回了带条目的文档 → 它是合并后的权威状态，本端的写入必然已在其中，
 *   收口；
 * - hub 没回条目（旧版，整份覆盖语义）→ 只有「这一轮在飞期间本地没再改」
 *   才算收口，否则落盘的是旧内容，保留 PENDING 等下一轮。
 */
function pushToHub(): Promise<void> {
  if (hubPushRunning) {
    hubPushAgain = true
    return hubPushDone
  }
  hubPushRunning = true
  hubPushDone = (async () => {
    let settled = false
    try {
      do {
        hubPushAgain = false
        if (!transport.prefsOrigin()) {
          // 无 hub 地址（local 模式）：改动留在本地 + PENDING，等回到 hub
          // 模式的启动同步或下一次变更再按条目合并上推（不空转重试）。
          break
        }
        const before = usePins.getState().entries
        let res: { version?: number; prefs?: HubPrefsDoc }
        try {
          const s = usePins.getState()
          res = await transport.putPrefs(toWire(s, s.entries), hubBaseVersion() ?? undefined)
        } catch (err) {
          if (!(err instanceof PrefsConflictError)) throw err
          // 旧 hub 的条件写拒绝：把它的文档并进本地（按条目，谁新听谁的），
          // 下一轮带新 base 再推。
          if (typeof err.version === 'number') setHubBaseVersion(err.version)
          usePins.getState().absorb(err.prefs, 'hub')
          settled = false
          continue
        }
        if (typeof res?.version === 'number') setHubBaseVersion(res.version)
        const echoed = res?.prefs
        const authoritative = docHasEntries(echoed)
        if (echoed) usePins.getState().absorb(echoed, 'hub')
        settled = authoritative || sameEntries(before, usePins.getState().entries)
      } while (hubPushAgain)
    } catch (err) {
      // 写失败（网络 / 缺密钥 / 旧 hub 持续冲突）：本地状态与 PENDING 都保留。
      console.warn('[pins] hub 持久化失败（本地已保留，稍后重试）', err)
      settled = false
    } finally {
      hubPushRunning = false
    }
    if (settled) setPending(false)
    else armPushRetry()
  })()
  return hubPushDone
}

/**
 * 启动 / WS 重连的对齐：GET → 按条目合并 → 本地若仍领先则该次上推。
 * 合并而不是替换，是这套协议不再需要「本地干净与否」判定的根本原因：
 * 拉到的文档再新，也只是它在那些 key 上更晚的一条记录而已。
 */
async function runHubSync(mergeDoc: (doc: HubPrefsDoc | undefined, site: string) => boolean): Promise<void> {
  if (syncInFlight) return syncInFlight
  syncInFlight = (async () => {
    try {
      const pull = await transport.getPrefs()
      if (typeof pull.version === 'number') setHubBaseVersion(pull.version)
      const localAhead = mergeDoc(pull.prefs, docHasEntries(pull.prefs) ? 'hub' : 'hub-snapshot')
      if (localAhead) {
        setPending(true)
        await pushToHub()
      } else {
        // 本地完全被 hub 文档覆盖：还有 PENDING 说明上一轮没确认落地，
        // 现在既然已与 hub 一致，可以清掉。
        setPending(false)
      }
    } catch (err) {
      // 拉取失败（hub 未升级 / 网络 / 缺密钥）：保留本地，功能照常；
      // 有未落地的写入就照常试一次上推（可能是拉取失败而非写失败）。
      console.warn('[pins] hub 同步失败（保留本地）', err)
      if (isPending()) await pushToHub()
    } finally {
      syncInFlight = null
    }
  })()
  return syncInFlight
}

// 模块级注册：hub 广播的是**合并后**的权威文档，本浏览器合并即可，无需
// 刷新，也不必再问「我本地是不是还没推」——合并对所有顺序都安全。
transport.onEvent((ev) => {
  if (ev.type === 'hub_conn') {
    if (ev.online) void usePins.getState().syncPrefsFromHub()
    return
  }
  if (ev.type !== 'prefs_changed') return
  const params = (ev as { params?: { prefs?: HubPrefsDoc; version?: number } }).params
  const raw = params?.prefs
  if (!raw) return
  if (typeof params?.version === 'number') setHubBaseVersion(params.version)
  usePins.getState().absorb(raw, 'hub')
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

/** liteReplay 是否被任一端的条目记录显式选过（没选过按部署模式取默认）。 */
export function isLiteReplayChosen(): boolean {
  return alive(usePins.getState().entries, feKey('liteReplay'))
}

/**
 * 非 hook 同步读取「精简回放」生效值：直连永远 false；中转才看开关
 * （没选过按中转默认开）。
 */
export function currentLiteReplay(): boolean {
  if (!historyViaHubRelay()) return false
  const s = usePins.getState()
  return liteReplayOf(s.entries, s.fePrefs.liteReplay)
}

function liteReplayOf(entries: PrefsEntries, stored: boolean): boolean {
  return alive(entries, feKey('liteReplay')) ? stored : defaultLiteReplay()
}

/** 响应式读取（hub 广播 / 本地 toggle 后即时重渲染）。直连恒为关。 */
export function useLiteReplay(): boolean {
  return usePins((s) => historyViaHubRelay() && liteReplayOf(s.entries, s.fePrefs.liteReplay))
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
