import { loadJSON, loadStr, removeKey, saveJSON, saveStr } from '../lib/storage'
import { create } from 'zustand'
import type { FePrefsDoc, HubPrefsDoc, SessionInfo, TodoStatus, WorkspaceGroup } from '../api/types'
import { PrefsConflictError } from '../api/transport'
import { sessionSortRank } from './historyGroups'
import { transport } from '../api/client'
import { KEY } from '../lib/keys'

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
 * - localStorage（离线缓存，启动即用，key = capri-fe.historyPins）；
 * - hub（持久层 + 同步中枢）：Hub 模式启动时 GET /api/prefs **以 hub
 *   为准整体替换**本地（含删除）；之后每次变更防抖 500ms 全量 PUT 回写，
 *   hub 随即广播 prefs_changed——所有在线浏览器实时应用同一份文档，
 *   一端的置顶/待办（含取消）改动直接同步到另一端，无需刷新。
 *   hub 地址取 prefsOrigin()：跨源直连 / host 报的 HUB_URL /
 *   同源部署回退页面 origin；local 模式无 hub 地址，仅走 localStorage。
 *
 * 版本与冲突（hub 支持 version 时）：hub 给文档维护单调递增版本，
 * 回写带 baseVersion 条件写；版本过旧 hub 回 409 + 当前文档，本地把
 * 待推「操作」（自上次成功同步以来的 ops 日志）重放到该文档上再重试
 * ——全量覆盖会踩掉别端在该版本窗口里的删除，重放不会。旧 hub 无
 * 版本概念 → 无条件写（退化为后写覆盖）。
 *
 * 并发语义：同一时刻只有一端在写（单用户多浏览器、低频操作），后写
 * 覆盖收敛一致。本地未推送（dirty）期间收到的 prefs_changed 一律
 * 忽略、保本地，由随后的回写落地（不做并集合并——并集表达不了删除，
 * 会把别端刚删的置顶/待办复活再写回 hub）；曾同步过的端再次同步时
 * 以 hub 文档为准（含删除），只有从未同步过的端（迁移 / 首连）才把
 * 本地条目并集补齐上推。WS 重连（hub_conn）补拉一次对齐断线缺口。
 *
 * 通过 zustand 暴露，保证组件在 toggle 后立即重渲染。
 */

const PIN_KEY = KEY.historyPins
/** 上次成功与 hub 对齐的文档快照（判断「本地有未推送改动」）。 */
const SYNC_KEY = KEY.historyPinsSynced
/** 本地有尚未 PUT 成功的变更（跨刷新保留，避免启动时被 hub 覆盖）。 */
const DIRTY_KEY = KEY.historyPinsDirty
/** hub 文档版本（CAS base；无此键 = hub 不支持版本 / 未知）。 */
const VER_KEY = KEY.historyPinsVer
/** 自上次成功同步以来的本地操作日志（冲突重放用，跨刷新保留）。 */
const OPS_KEY = KEY.historyPinsOps
/** 变更后延迟多久统一回写 hub（合并连续点击）。 */
const HUB_PUSH_DEBOUNCE_MS = 500
/** 版本冲突重放上限：超过说明竞争异常激烈，保留 dirty/ops 待下次再推。 */
const HUB_CONFLICT_RETRIES = 4

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
  /**
   * 精简回放：历史分页请求带 detail=lite，host 只裁工具正文，展开时再
   * 按需补全。默认值随部署模式而变（见 defaultLiteReplay）——hub 模式
   * 整页历史要跨源走 hub，默认开；local 直连本机，默认关。
   */
  liteReplay: boolean
}

/**
 * liteReplay 默认值按部署模式取（不是硬编码字符串比较：模式由
 * transport.detectMode 判定，见 api/localTransport.ts）。可选调用：单测里
 * 常见的精简 transport mock 没带这个方法，一律按 local 默认（关）。
 */
function defaultLiteReplay(): boolean {
  return transport.getConnectionMode?.() === 'hub'
}

function defaultFePrefs(): FePrefs {
  return { collapseToolGroups: true, liteReplay: defaultLiteReplay() }
}

/**
 * fePrefs → 落盘/上推的文档：未被显式选过的 liteReplay 不写出去——它是
 * 按当前模式现算的默认值，写死就会把「本端模式下的默认」变成「所有端的
 * 显式偏好」（同一 hub 下 local / hub 两端各自默认不同）。
 */
function fePrefsToDoc(p: FePrefs): FePrefsDoc {
  return liteReplayChosen ? { ...p } : { collapseToolGroups: p.collapseToolGroups }
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

/**
 * liteReplay 是否被「显式选过」（文档带该键 / 用户在设置里 toggle）。
 * 默认值取决于部署模式，而建店发生在 transport.detectMode 之前（那时模式
 * 还是初始的 local），所以未显式选过的值不作数——读取时按当前模式现算
 * （见 currentLiteReplay / useLiteReplay），避免把「启动时的猜测」固化成
 * 用户偏好。
 */
let liteReplayChosen = false

/** hub 文档中的 fePrefs 段 → 内存态（缺省字段按默认值）。 */
function fromFePrefsDoc(v: unknown): FePrefs {
  const d = v && typeof v === 'object' && !Array.isArray(v) ? (v as FePrefsDoc) : {}
  if (typeof d.liteReplay === 'boolean') liteReplayChosen = true
  return {
    collapseToolGroups: d.collapseToolGroups !== false,
    liteReplay: typeof d.liteReplay === 'boolean' ? d.liteReplay : defaultLiteReplay(),
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
    fePrefs: fePrefsToDoc(pins.fePrefs),
  })
}

// ── hub 同步 ──────────────────────────────────────────────────────────

/** 内存态 → hub 文档（Set → 数组）。 */
function toWire(p: HistoryPins): HubPrefsDoc {
  return {
    pinnedWorkspaces: [...p.pinnedWorkspaces],
    pinnedSessions: [...p.pinnedSessions],
    todos: p.todos,
    fePrefs: fePrefsToDoc(p.fePrefs),
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

// ── 版本（CAS base）与操作日志（冲突重放） ─────────────────────────────
// 两者都从 localStorage 读穿（无内存缓存）：多标签页共享同一份存储，
// 测试间 clear 也能自动复位。

/** hub 文档版本；null = hub 不支持版本 / 未知 → 无条件写。 */
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

/** 自上次成功同步以来的本地操作（重放到任意 hub 文档都保持语义：删除不会复活、新增不会丢失）。 */
export type PrefsOp =
  | { kind: 'workspacePin'; cwd: string; on: boolean }
  | { kind: 'sessionPin'; sessionId: string; on: boolean }
  | { kind: 'todo'; sessionId: string; status: TodoStatus | null }
  | { kind: 'fePrefs'; patch: Partial<FePrefs> }

function sanitizeOps(v: unknown): PrefsOp[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is PrefsOp => {
    if (!x || typeof x !== 'object') return false
    const op = x as Record<string, unknown>
    switch (op.kind) {
      case 'workspacePin':
        return typeof op.cwd === 'string' && typeof op.on === 'boolean'
      case 'sessionPin':
        return typeof op.sessionId === 'string' && typeof op.on === 'boolean'
      case 'todo':
        return (
          typeof op.sessionId === 'string' &&
          (op.status == null || op.status === 'todo' || op.status === 'completed')
        )
      case 'fePrefs':
        return !!op.patch && typeof op.patch === 'object' && !Array.isArray(op.patch)
      default:
        return false
    }
  })
}

function pendingOps(): PrefsOp[] {
  return sanitizeOps(loadJSON(OPS_KEY, []))
}

function recordOp(op: PrefsOp): void {
  saveJSON(OPS_KEY, [...pendingOps(), op])
}

function clearOps(): void {
  removeKey(OPS_KEY)
}

/** 把操作日志按原顺序重放到任意基础文档上（基础里别端的删除得以保留）。 */
function replayOps(base: HistoryPins, ops: PrefsOp[]): HistoryPins {
  let next = base
  for (const op of ops) {
    switch (op.kind) {
      case 'workspacePin': {
        const ws = new Set(next.pinnedWorkspaces)
        if (op.on) ws.add(op.cwd)
        else ws.delete(op.cwd)
        next = { ...next, pinnedWorkspaces: ws }
        break
      }
      case 'sessionPin': {
        const ss = new Set(next.pinnedSessions)
        if (op.on) ss.add(op.sessionId)
        else ss.delete(op.sessionId)
        next = { ...next, pinnedSessions: ss }
        break
      }
      case 'todo': {
        const todos = { ...next.todos }
        if (op.status == null) delete todos[op.sessionId]
        else todos[op.sessionId] = op.status
        next = { ...next, todos }
        break
      }
      case 'fePrefs':
        if (typeof op.patch.liteReplay === 'boolean') liteReplayChosen = true
        next = { ...next, fePrefs: { ...next.fePrefs, ...op.patch } }
        break
    }
  }
  return next
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
 * 广播时据此决定「忽略广播保本地」还是「以 hub 为准替换」——dirty
 * 期间不并集合并（并集表达不了删除，会把别端刚删的置顶/待办复活，
 * 再随防抖 PUT 写死到 hub），待推改动由随后的回写以后写覆盖落地。
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

/** 是否有一轮回写在跑（串行执行，见 pushToHub）。 */
let hubPushRunning = false
/** 跑动期间又有推送请求：本轮结束后再推一轮最新状态。 */
let hubPushAgain = false
/** 最后一轮回写的完成信号（syncPrefsFromHub 等待用）。 */
let hubPushDone: Promise<void> = Promise.resolve()

/**
 * 回写 hub（推「当前」状态）；尚无 hub 地址 / 失败都静默降级（本地
 * 状态不丢，dirty 保留）。串行执行：同时最多一个 PUT 在飞，跑动期间
 * 到来的请求只标记「再来一轮」，避免两个 PUT 乱序落地把旧文档写回
 * hub。带 baseVersion 条件写：409 时 hub 已在冲突响应带回当前文档，
 * 把本地待推「操作」重放到上面再重试——全量覆盖会踩掉别端在该版本
 * 窗口里的删除。PUT 成功后仅当所推快照仍等于当前状态才清 dirty /
 * markSynced / 清 ops——在飞期间的新编辑保持 dirty（其防抖定时器已
 * armed，下一轮收敛），否则自己 PUT 的回声广播到达时会以 hub 为准
 * 整体替换，把尚未推送的编辑冲掉。dirty / markSynced / ops 的收敛
 * 只在这里发生（syncPrefsFromHub 的上推分支也复用本函数）。
 */
function pushToHub(): Promise<void> {
  if (hubPushRunning) {
    hubPushAgain = true
    return hubPushDone
  }
  hubPushRunning = true
  hubPushDone = (async () => {
    try {
      // 外层 do-while：串行排队（跑动期间到来的请求标记「再来一轮」，
      // 推最新状态）；内层 for：单轮内的版本冲突重放重试。
      do {
        hubPushAgain = false
        for (let attempt = 0; ; attempt++) {
          const s = usePins.getState()
          let okVersion: number | undefined
          try {
            const res = await transport.putPrefs(toWire(s), hubBaseVersion() ?? undefined)
            okVersion = res?.version
          } catch (err) {
            if (err instanceof PrefsConflictError && attempt < HUB_CONFLICT_RETRIES) {
              // baseVersion 过期：重放待推操作到 hub 当前文档再重试。
              // 无操作记录（异常场景）时重放结果即 hub 文档，等价于
              // 放弃本地陈旧内容（dirty/ops 保留，正常流程不会走到）。
              if (typeof err.version === 'number') setHubBaseVersion(err.version)
              applyPrefs(replayOps(fromWire(err.prefs ?? {}), pendingOps()))
              continue
            }
            throw err
          }
          if (typeof okVersion === 'number') setHubBaseVersion(okVersion)
          if (snapshot(usePins.getState()) === snapshot(s)) {
            setDirty(false)
            markSynced(s)
            clearOps()
          }
          break
        }
      } while (hubPushAgain)
    } catch (err) {
      // 写失败（无 hub 地址 / 网络 / 重放超限）：保留本地状态与 dirty，
      // 下次变更或启动再推。
      console.warn('[pins] hub 持久化失败（已保留本地）', err)
    } finally {
      hubPushRunning = false
    }
  })()
  return hubPushDone
}

/** 以一份权威文档替换本地（写 localStorage + 内存）。 */
function applyPrefs(next: HistoryPins): void {
  persist(next)
  usePins.setState(next)
}

// 模块级注册：hub 广播 prefs_changed（任意一端 PUT 成功后）→ 本浏览器
// 实时应用，无需刷新。dirty（自己的变更还没推上去）时忽略本次广播、
// 保本地不动——并集合并会把刚删除的置顶/待办复活，随后防抖 PUT 把
// 复活后的文档写死到 hub；待推改动由随后的回写（含冲突重放）落地。
// 干净时以 hub 为准整体替换（含删除），并跟随广播推进 CAS base——
// dirty 时故意不推进，让下一次推送 409 → 重放，而不是拿旧 base
// 静默覆盖别端改动。
// hub_conn 上线（WS 连接/重连成功）：断线期间可能错过广播，补一次
// syncPrefsFromHub——干净时应用别端改动（含删除），dirty 时重试上推。
transport.onEvent((ev) => {
  if (ev.type === 'hub_conn') {
    if (ev.online) void usePins.getState().syncPrefsFromHub()
    return
  }
  if (ev.type !== 'prefs_changed') return
  const params = (ev as { params?: { prefs?: HubPrefsDoc; version?: number } }).params
  const raw = params?.prefs
  if (!raw) return
  if (hubDirty) return
  if (typeof params?.version === 'number') setHubBaseVersion(params.version)
  applyPrefs(applyHubPreservingFePrefs(raw, fromWire(raw), usePins.getState()))
})

/** 置顶/待办 + 前端偏好 + 动作的完整 store 形态。 */
export type HubPrefsState = HistoryPins & {
  toggleWorkspacePin: (cwd: string) => void
  toggleSessionPin: (sessionId: string) => void
  /** 设置/清除会话待办状态：'todo' | 'completed' | null（清除）。 */
  setTodoStatus: (sessionId: string, status: TodoStatus | null) => void
  /** 更新 FE 前端偏好（与置顶/待办同一 hub prefs 文档同步）。 */
  setFePrefs: (patch: Partial<FePrefs>) => void
  /** 从 hub 拉取对齐（启动 / WS 重连时）：本地有未推送改动则整份上推，曾同步过的干净本地以 hub 为准（含删除）。 */
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
        recordOp({ kind: 'workspacePin', cwd, on: next.has(cwd) })
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
        recordOp({ kind: 'sessionPin', sessionId, on: next.has(sessionId) })
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
        recordOp({ kind: 'todo', sessionId, status })
        scheduleHubPush()
        return { todos }
      }),
    setFePrefs: (patch) =>
      usePins.setState((s) => {
        if (typeof patch.liteReplay === 'boolean') liteReplayChosen = true
        const fePrefs = { ...s.fePrefs, ...patch }
        persist({ ...s, fePrefs })
        recordOp({ kind: 'fePrefs', patch })
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
          // 拉取期间自己的防抖 PUT 可能落地并清掉 dirty，GET 响应于是
          // 成了旧文档：进入时先记下 dirty，届时仍走整份上推（重推同一
          // 文档无害），不能拿旧响应整体替换本地。
          const dirtyAtStart = hubDirty || localUnsynced(usePins.getState())
          const pull = await transport.getPrefs()
          const raw = pull.prefs ?? {}
          // 版本随文档一起来：无版本 = 旧 hub → 无条件写（后写覆盖）。
          setHubBaseVersion(typeof pull.version === 'number' ? pull.version : null)
          const hub = fromWire(raw)
          const s = usePins.getState()
          if (dirtyAtStart || hubDirty || localUnsynced(s)) {
            // 本地有未推送的改动：把待推「操作」重放到最新 hub 文档上
            // 再条件上推（经 pushToHub：别端在线期间的删除不丢、本地
            // 改动也不丢）；无操作记录（旧版本升级遗留的 dirty）退回
            // 整份本地上推。
            const ops = pendingOps()
            applyPrefs(ops.length > 0 ? replayOps(hub, ops) : s)
            await pushToHub()
          } else if (loadStr(SYNC_KEY) == null && hasLocalExtras(s, hub)) {
            // 从未与 hub 同步过（v1 迁移 / local 模式攒下的数据）且本地
            // 有 hub 没有的条目：并集补齐后上推。曾同步过的端不走这里
            // ——「本地干净但比 hub 多」只可能是别端删了，必须以 hub
            // 为准整体替换，否则刷新一次就把别端刚删的置顶/待办复活
            // 并写回 hub（删到最后一条时 hub 文档即为空）。
            applyPrefs(mergeLocalOverHub(hub, s))
            await pushToHub()
          } else {
            // 本地干净（曾同步过 / 本地本就为空）：以 hub 为准整体替换
            // （含删除，含删空后的空文档）；旧 hub 未带 fePrefs 时保留
            // 本地偏好不被空默认覆盖。
            const next = applyHubPreservingFePrefs(raw, hub, s)
            applyPrefs(next)
            markSynced(next)
            clearOps()
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
 * 非 hook 同步读取「精简回放」生效值：文档没带过该键时按当前部署模式现算
 * （hub 开 / local 关）——建店早于 transport.detectMode，存下来的默认值不作数。
 */
export function currentLiteReplay(): boolean {
  const s = usePins.getState().fePrefs.liteReplay
  return liteReplayChosen ? s : defaultLiteReplay()
}

/** 响应式读取（hub 广播 / 本地 toggle 后即时重渲染）。 */
export function useLiteReplay(): boolean {
  return usePins((s) => currentLiteReplaySelector(s.fePrefs.liteReplay))
}

function currentLiteReplaySelector(stored: boolean): boolean {
  return liteReplayChosen ? stored : defaultLiteReplay()
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
