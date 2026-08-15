import { transport } from '../../../api/client'
import { repoNameFromCwd } from '../../historyGroups'
import type { WorkspaceGroup, WorkspaceSummary } from '../../../api/types'
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

export function sessionActions(set: SetState, get: () => ChatState) {
  return {
  refreshSessions: async (retry = 1) => {
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
    } catch {
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
    set({ workspaceLoading: true })
    try {
      const workspaces = await transport.workspaceList()
      set({ workspaces, workspaceLoading: false })
    } catch {
      // 启动窗口容错：host 刚重启时 agent 预热 boot 可能超过 fetch
      // 超时（502），重试一次再降级，避免首屏侧边栏空白。
      if (retry > 0) {
        await new Promise((r) => setTimeout(r, 4000))
        return get().refreshWorkspaces(retry - 1)
      }
      // 降级：workspace-list 不可用时按现有 sessions 的 cwd 分组，
      // 保证侧边栏永不白屏。
      const byCwd = new Map<string, WorkspaceSummary[]>()
      for (const s of get().sessions) {
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
      const workspaces: WorkspaceGroup[] = [...byCwd.entries()].map(
        ([cwd, sessions]) => ({
          cwd,
          label: repoNameFromCwd(cwd),
          sessions,
        }),
      )
      set({ workspaces, workspaceLoading: false })
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
