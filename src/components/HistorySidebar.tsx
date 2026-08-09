import { useEffect } from 'react'
import { useChatStore } from '../store/chat'
import { SessionHistoryList } from './SessionHistoryList'

/**
 * Desktop (lg+) history sidebar — persistent, grouped by workspace
 * (cwd). The list itself is the shared {@link SessionHistoryList}, the
 * same one the mobile top-bar history dropdown renders, so both ends
 * stay in sync (分组 / 折叠 / 加载更多 / 重命名 / 删除 / 上下文进度条).
 *
 * The list is fetched on mount (and kept fresh by the host's
 * sessions_changed notifications). The aside is always mounted — hidden
 * below lg — so the mount refresh also serves the mobile dropdown.
 */
export function HistorySidebar() {
  const refreshSessions = useChatStore((s) => s.refreshSessions)
  const refreshWorkspaces = useChatStore((s) => s.refreshWorkspaces)

  useEffect(() => {
    void refreshSessions()
    void refreshWorkspaces()
  }, [refreshSessions, refreshWorkspaces])

  return (
    <aside className="hidden w-72 shrink-0 flex-col bg-gn-bg-base lg:flex">
      <div className="gn-no-scrollbar flex-1 overflow-y-auto">
        <SessionHistoryList />
      </div>
    </aside>
  )
}
