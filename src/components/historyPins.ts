import { create } from 'zustand'
import type { SessionInfo, WorkspaceGroup } from '../api/types'
import { sessionSortRank } from './historyGroups'

/**
 * 浏览器本地"置顶"偏好（localStorage，不写回宿主）：
 * - pinnedWorkspaces — 置顶的工作目录（cwd 全路径），侧边栏永远排在
 *   非置顶工作区之前（内部仍按活跃度排序）。
 * - pinnedSessions   — 置顶的会话（sessionId），在其所属工作区内永远
 *   排在非置顶会话之前（内部仍按 updatedAt 排序）。
 *
 * 纯粹的 UI 排序偏好，存于浏览器本地即可——多端/换浏览器不回传，
 * 符合"在浏览器本地支持"的语义。通过 zustand 暴露，保证组件在
 * toggle 后立即重渲染。
 */

const PIN_KEY = 'acpfe.historyPins'

export type HistoryPins = {
  pinnedWorkspaces: Set<string>
  pinnedSessions: Set<string>
}

function empty(): HistoryPins {
  return { pinnedWorkspaces: new Set(), pinnedSessions: new Set() }
}

function load(): HistoryPins {
  try {
    const raw = window.localStorage.getItem(PIN_KEY)
    if (!raw) return empty()
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      pinnedWorkspaces: new Set(
        Array.isArray(parsed.workspaces)
          ? (parsed.workspaces as unknown[]).filter(
              (v): v is string => typeof v === 'string',
            )
          : [],
      ),
      pinnedSessions: new Set(
        Array.isArray(parsed.sessions)
          ? (parsed.sessions as unknown[]).filter(
              (v): v is string => typeof v === 'string',
            )
          : [],
      ),
    }
  } catch {
    return empty()
  }
}

function persist(pins: HistoryPins): void {
  try {
    window.localStorage.setItem(
      PIN_KEY,
      JSON.stringify({
        workspaces: [...pins.pinnedWorkspaces],
        sessions: [...pins.pinnedSessions],
      }),
    )
  } catch {
    /* persistence is best-effort */
  }
}

export const usePins = create<
  HistoryPins & {
    toggleWorkspacePin: (cwd: string) => void
    toggleSessionPin: (sessionId: string) => void
  }
>(() => {
  const initial = load()
  return {
    ...initial,
    toggleWorkspacePin: (cwd) =>
      usePins.setState((s) => {
        const next = new Set(s.pinnedWorkspaces)
        if (next.has(cwd)) next.delete(cwd)
        else next.add(cwd)
        persist({ pinnedWorkspaces: next, pinnedSessions: s.pinnedSessions })
        return { pinnedWorkspaces: next }
      }),
    toggleSessionPin: (sessionId) =>
      usePins.setState((s) => {
        const next = new Set(s.pinnedSessions)
        if (next.has(sessionId)) next.delete(sessionId)
        else next.add(sessionId)
        persist({ pinnedWorkspaces: s.pinnedWorkspaces, pinnedSessions: next })
        return { pinnedSessions: next }
      }),
  }
})

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
 * 会话排序：置顶的会话永远最前（内部按状态优先级 → 最新活动降序），
 * 非置顶保持状态优先级 → 最新活动降序。状态优先级见
 * historyGroups.sessionSortRank：待处理 → 完成对勾 → 运行中+后台任务 →
 * 运行中 → 后台任务运行中 → 空闲。
 */
export function sortSessionsWithPins<T extends SessionInfo>(
  sessions: T[],
  pinned: Set<string>,
  completedNotices: Record<string, number> | null,
  cmp: (a: T, b: T) => number,
): T[] {
  const byPriority = (a: T, b: T): number => {
    const ra = sessionSortRank(a, completedNotices)
    const rb = sessionSortRank(b, completedNotices)
    if (ra !== rb) return ra - rb
    return cmp(a, b)
  }
  const pinnedList = sessions.filter((s) => pinned.has(s.sessionId)).sort(byPriority)
  const rest = sessions.filter((s) => !pinned.has(s.sessionId)).sort(byPriority)
  return [...pinnedList, ...rest]
}
