import { transport } from '../../../api/client'
import { repoNameFromCwd } from '../../historyGroups'
import { loadStr, saveStr } from '../../../lib/storage'
import type { SessionInfo, WorkspaceGroup, WorkspaceSummary } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import {
  clearContinueSessionTimer,
  clearPeerSessionLoad,
  runtime,
} from '../globals'
import { permissionSeedMeta } from '../modeFlags'
import { clearSuppressedTools } from '../tools'
import { resetSessionState } from '../reset'
import { clearStreamBuf } from '../stream'

/** workspace-list-recent 每页条数（初始 limit，「加载更多」每次 +50）。 */
const WORKSPACE_RECENT_PAGE = 50

/** 会话列表展示模式偏好的 localStorage 键（'recent' | 'full'，缺省 recent）。 */
const WORKSPACE_MODE_KEY = 'capri-fe-workspace-mode'

/**
 * recent 增量合并：新响应（top-N 摘要）与现有列表按 sessionId 合并——
 * 已有行用新数据原位更新（列表不闪动、不重排），新出现的行 append 到
 * 对应 cwd 分组末尾（分组不存在则新建）；已有而新响应缺失的行按
 * freshLimit 是否覆盖当前展示范围（freshLimit >= currentLimit）决定：
 * 覆盖 → 视为已删除，移除；未覆盖 → 保留（刷新响应晚于加载更多到达
 * 时的竞态保护，避免把更大 limit 的行误删）。
 */
function mergeRecentWorkspaces(
  prev: WorkspaceGroup[],
  fresh: WorkspaceGroup[],
  freshLimit: number,
  currentLimit: number,
): WorkspaceGroup[] {
  const authoritative = freshLimit >= currentLimit
  const freshById = new Map<string, WorkspaceSummary>()
  for (const g of fresh) {
    for (const s of g.sessions) freshById.set(s.sessionId, s)
  }
  const out: WorkspaceGroup[] = []
  for (const g of prev) {
    const rows: WorkspaceSummary[] = []
    for (const s of g.sessions) {
      const f = freshById.get(s.sessionId)
      if (f) {
        rows.push(f)
        freshById.delete(s.sessionId)
      } else if (!authoritative) {
        rows.push(s)
      }
    }
    if (rows.length > 0) out.push({ ...g, sessions: rows })
  }
  // 新增行 append 到对应分组（保持 fresh 的 recent 顺序）；渲染层
  // groupWorkspaces 会重排分组顺序，组内顺序影响有限。
  const byCwd = new Map(out.map((g) => [g.cwd, g]))
  for (const row of freshById.values()) {
    const g = byCwd.get(row.cwd)
    if (g) {
      g.sessions.push(row)
    } else {
      const ng: WorkspaceGroup = { cwd: row.cwd, label: row.cwd, sessions: [row] }
      byCwd.set(row.cwd, ng)
      out.push(ng)
    }
  }
  return out
}

// 统计分组总会话数：recent 分页的终止判定。agent 返回的是前缀超集
// （limit 增大 → 结果只增不减），翻页后总数不再增长即已到顶。
function totalSessions(groups: WorkspaceGroup[]): number {
  return groups.reduce((n, g) => n + g.sessions.length, 0)
}

/** 兜底分组：按现有 sessions 的 cwd 分组（workspace-list 与 recent 都不可用时）。 */
function fallbackGroupsFromSessions(sessions: SessionInfo[]): WorkspaceGroup[] {
  const byCwd = new Map<string, WorkspaceSummary[]>()
  for (const s of sessions) {
    if (!s.cwd) continue
    const list = byCwd.get(s.cwd) ?? []
    list.push({
      sessionId: s.sessionId,
      cwd: s.cwd,
      ...(s.title ? { title: s.title } : {}),
      ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
    })
    byCwd.set(s.cwd, list)
  }
  return [...byCwd.entries()].map(([cwd, sessions]) => ({
    cwd,
    label: repoNameFromCwd(cwd),
    sessions,
  }))
}

export function sessionActions(set: SetState, get: () => ChatState) {
  return {
  refreshSessions: async (retry = 1) => {
    // hub 模式未选中 host：host 级请求没有 ?host= 会打到 hub 根路径
    // 404（数据不在 hub），且选中后（switchHost）自会重新拉取——跳过，
    // 避免启动期无效请求与 4 秒后的冗余重试。
    if (transport.getConnectionMode() === 'hub' && !transport.getHost()) return
    try {
      const { sessions } = await transport.listSessions()
      set({ sessions })
      // Busy 转变检测（完成提醒兜底）：某会话从 busy → idle 且不是
      // 当前会话 → 通知 + ✓。第一次拉取只建基线，不误报。
      let next: Record<string, boolean> = {}
      for (const s of sessions) next[s.sessionId] = s.status?.busy === true
      const cur = get()
      for (const [sid, wasBusy] of Object.entries(runtime.lastBusySnapshot)) {
        if (wasBusy && next[sid] === false && sid !== cur.sessionId) {
          cur.noteSessionCompleted(sid)
        }
      }
      // 上限：会话数过多时放弃本轮对比、重置为空基线（下轮重新建基线），
      // 防止模块级快照无上限增长。
      if (Object.keys(next).length > 100) next = {}
      runtime.lastBusySnapshot = next
    } catch (e) {
      // 主动 abort（StrictMode 双挂载的 disconnect / host 切换）：请求
      // 作废而非失败，不重试——新一轮挂载/切换自会重新拉取，否则 dev
      // 下每次加载都会多一次 4 秒后的冗余请求。
      if (e instanceof Error && e.name === 'AbortError') return
      // 启动窗口容错：host 刚重启时 agent 预热 boot（initialize +
      // authenticate）可能超过 fetch 超时，重试一次再放弃，避免首屏
      // 会话列表为空。
      if (retry > 0) {
        await new Promise((r) => setTimeout(r, 4000))
        return get().refreshSessions(retry - 1)
      }
    }
  },

  refreshWorkspaces: async (retry = 1) => {
    // hub 模式未选中 host：同上（refreshSessions），跳过并复位 loading，
    // 避免无效 404 请求与转圈卡死。
    if (transport.getConnectionMode() === 'hub' && !transport.getHost()) {
      set({ workspaceLoading: false })
      return
    }
    set({ workspaceLoading: true })
    // 本地记忆的展示模式偏好：full → 直接全量；recent（默认）→ 分页。
    if (loadStr(WORKSPACE_MODE_KEY) === 'full') {
      try {
        const workspaces = await transport.workspaceList()
        set({
          workspaces,
          workspaceLoading: false,
          workspaceListMode: 'full',
          workspaceRecentHasMore: false,
        })
        return
      } catch {
        if (retry > 0) {
          await new Promise((r) => setTimeout(r, 4000))
          return get().refreshWorkspaces(retry - 1)
        }
        set({
          workspaces: fallbackGroupsFromSessions(get().sessions),
          workspaceLoading: false,
          workspaceListMode: 'full',
          workspaceRecentHasMore: false,
        })
        return
      }
    }
    try {
      const limit = get().workspaceRecentLimit
      const { groups, count } = await transport.workspaceListRecent(limit)
      const merged = mergeRecentWorkspaces(get().workspaces, groups, limit, limit)
      set({
        workspaces: merged,
        workspaceLoading: false,
        workspaceListMode: 'recent',
        // count < limit 不代表没有更多：候选里可能混入被过滤的隐藏
        // 会话（subagent），导致实际返回 < limit。只要还有数据就乐观
        // 置位，真到末尾由 workspaceLoadMore 的总数增长判定终止。
        workspaceRecentHasMore: count > 0,
      })
    } catch (e) {
      // 主动 abort（StrictMode 双挂载的 disconnect / host 切换）：作废
      // 而非失败，不重试不降级（新一轮挂载/切换自会重新拉取）。恢复
      // loading，避免刷新按钮/中央加载态卡住。
      if (e instanceof Error && e.name === 'AbortError') {
        set({ workspaceLoading: false })
        return
      }
      // 启动窗口容错：host 刚重启时 agent 预热 boot 可能超过 fetch
      // 超时（502），重试一次再降级，避免首屏侧边栏空白。
      if (retry > 0) {
        await new Promise((r) => setTimeout(r, 4000))
        return get().refreshWorkspaces(retry - 1)
      }
      // 降级 1：全量 workspace-list（旧 agent 无 workspace-list-recent）。
      try {
        const workspaces = await transport.workspaceList()
        set({
          workspaces,
          workspaceLoading: false,
          workspaceListMode: 'full',
          workspaceRecentHasMore: false,
        })
        return
      } catch {
        // 降级 2：按现有 sessions 的 cwd 分组，保证侧边栏永不白屏。
        set({
          workspaces: fallbackGroupsFromSessions(get().sessions),
          workspaceLoading: false,
          workspaceListMode: 'full',
          workspaceRecentHasMore: false,
        })
      }
    }
  },

  workspaceLoadMore: async () => {
    const cur = get()
    // 仅 recent 分页模式可加载更多（全量模式 hasMore 恒 false，双保险）。
    if (cur.workspaceListMode !== 'recent') return
    if (cur.workspaceRecentLoadingMore || !cur.workspaceRecentHasMore) return
    set({ workspaceRecentLoadingMore: true })
    try {
      const nextLimit = cur.workspaceRecentLimit + WORKSPACE_RECENT_PAGE
      const { groups } = await transport.workspaceListRecent(nextLimit)
      const prev = get().workspaces
      const merged = mergeRecentWorkspaces(
        prev,
        groups,
        nextLimit,
        cur.workspaceRecentLimit,
      )
      set({
        workspaces: merged,
        workspaceRecentLimit: nextLimit,
        // recent 响应是前缀超集：翻页后总数不再增长 = 新页里没有可见
        // 会话 = 已到顶（count 本身受隐藏会话过滤，不能作为判定依据）。
        workspaceRecentHasMore: totalSessions(merged) > totalSessions(prev),
        workspaceRecentLoadingMore: false,
      })
    } catch {
      // 加载更多失败：保留原 limit / hasMore，按钮恢复可重试。
      set({ workspaceRecentLoadingMore: false })
    }
  },

  switchWorkspaceListMode: async (mode) => {
    if (get().workspaceListMode === mode) return
    set({ workspaceLoading: true })
    try {
      if (mode === 'full') {
        const workspaces = await transport.workspaceList()
        saveStr(WORKSPACE_MODE_KEY, 'full')
        set({
          workspaces,
          workspaceLoading: false,
          workspaceListMode: 'full',
          workspaceRecentHasMore: false,
        })
      } else {
        // 切回最近：直接用当前 limit 拉取（不再叠加 50）。
        const limit = get().workspaceRecentLimit
        const { groups, count } = await transport.workspaceListRecent(limit)
        saveStr(WORKSPACE_MODE_KEY, 'recent')
        const merged = mergeRecentWorkspaces(
          get().workspaces,
          groups,
          limit,
          limit,
        )
        set({
          workspaces: merged,
          workspaceRecentLimit: limit,
          workspaceLoading: false,
          workspaceListMode: 'recent',
          workspaceRecentHasMore: count > 0,
        })
      }
    } catch {
      // 切换失败（旧 agent 无 recent / 全量失败）：保持原模式与数据，
      // 恢复可重试。
      set({ workspaceLoading: false })
    }
  },

  refreshSessionStats: async () => {
    const s = get()
    // 无会话锚点 → 无统计可拉（newSession 后 resetSessionState 已清空）。
    if (!s.sessionId || !s.cwd) {
      if (s.sessionStats) set({ sessionStats: undefined })
      return
    }
    try {
      const stats = await transport.sessionStats(s.sessionId, s.cwd)
      // 拉取期间可能已切换会话（async 竞态）：结果只对发起时的会话有效。
      if (get().sessionId === s.sessionId && get().cwd === s.cwd) {
        set({ sessionStats: stats })
      }
    } catch {
      // 旧 host 无此端点 / 瞬断：保留旧值，状态条自然退化为上次快照。
    }
  },

  refreshGitInfo: async () => {
    const s = get()
    if (!s.sessionId || !s.cwd) return
    try {
      const info = await transport.gitInfo(s.sessionId, s.cwd)
      // Empty branch = not a git repo (or detached without a name) — hide
      // the status-bar branch entirely rather than showing "(detached)".
      set({
        gitInfo: info.branch
          ? {
              branch: info.branch,
              isWorktree: !!info.isWorktree,
              mainRepo: info.mainRepo ?? null,
            }
          : { branch: null, isWorktree: false, mainRepo: null },
      })
    } catch {
      /* ignore — keep whatever git_head_changed delivered */
    }
  },

  newSession: async (cwd?: string) => {
    // Any in-flight session switch (grace-window callback / async loads)
    // must not re-anchor after a fresh session starts.
    runtime.sessionSwitchGen += 1
    clearContinueSessionTimer()
    clearPeerSessionLoad()
    get().stopTopTaskPolling()
    clearSuppressedTools()
    clearStreamBuf()
    // A new session inherits the LIVE global permission mode (what the
    // agent is actually running — badge / yolo_mode_changed), not the
    // unread config.toml default. Capture before the reset. Plan mode
    // is per-session on the agent side and always starts fresh.
    const cur = get()
    const inheritMeta = permissionSeedMeta({
      yoloMode: cur.yoloMode,
      autoMode: cur.autoMode,
    })
    // 权限模式是进程级全局状态：复位不清（删除场景同样保留），store
    // 现值即继承值，无需经 flags 回灌。
    resetSessionState(set)
    // New session lands in the CURRENT conversation's workspace: inherit
    // its cwd so "new" starts in the same directory (captured above, before
    // the anchor reset clears it). An explicit cwd (sidebar group
    // right-click "新建会话") wins; empty cwd (no session yet) → host default.
    const startCwd = cwd ?? cur.cwd
    // 窗口期标记：resetSessionState 清锚（sessionId=null）后到 POST 响应
    // 回填前，宿主的 hello/busy 广播（hub 双连接 SSE 重连 / WS 缺口回放）
    // 会穿过所有会话守卫——hello handler 凭此标志只吸收快照、不重锚。
    runtime.newSessionInFlight = true
    let res: unknown
    try {
      res = await transport.newSession({
        ...(startCwd ? { cwd: startCwd } : {}),
        ...(inheritMeta ? { meta: inheritMeta } : {}),
      })
    } finally {
      runtime.newSessionInFlight = false
    }
    // POST /api/session 响应直接携带新会话 id（host Snapshot）——提前
    // 锚定 sessionId，不等 SSE ready（ready 到达时幂等覆盖）。空状态
    // 发送消息时依赖这一点：newSession 返回后即可继续发 prompt。
    const sid = (res as { sessionId?: unknown } | null)?.sessionId
    if (typeof sid === 'string' && sid) {
      // session/new 响应是权威：新会话必然 idle + 空。POST 窗口期内
      // 可能被旧 hello/busy 污染（conn='busy'、turnStartedAt 残留、
      // loadHistory(S1) 在飞）——锚定时整体复位回合状态，杜绝
      // turnIsLive() 对新会话误判成忙（否则第一条消息会走 enqueue
      // 排队而不是直发，且可能被双 Enter 再次发送）。
      set({
        sessionId: sid,
        cwd: startCwd || undefined,
        conn: 'ready',
        statusText: '就绪',
        awaitingNext: false,
        turnStartedAt: undefined,
        currentPromptId: undefined,
        genRate: undefined,
        // 全新会话无历史可载：上个会话残留的加载失败提示不适用。
        historyLoadError: undefined,
        historyLoading: false,
        historyLoadingMore: false,
        pendingOptimisticUserId: undefined,
        openAssistantId: undefined,
        openThoughtId: undefined,
        liveStream: null,
      })
    }
  },

  resetToEmpty: () => {
    get().stopTopTaskPolling()
    clearSuppressedTools()
    clearStreamBuf()
    resetSessionState(set)
  },

  setEmptyCwd: (cwd) => {
    // 目录属于具体某台 host 的文件系统：按当前 hostId 记忆，切换 host
    // 时互不污染。local 模式 hostId 为空 → 'default' 单键，语义不变。
    const hostKey = get().hostId ?? 'default'
    set((st) => ({
      emptyCwd: cwd,
      emptyCwdByHost: { ...(st.emptyCwdByHost ?? {}), [hostKey]: cwd },
    }))
  },
  } satisfies Partial<ChatState>
}
